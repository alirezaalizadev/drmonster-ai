// =============================================================================
// Supabase Edge Function: ai-document
//
// Reads an uploaded invoice (PDF / image / DOCX-text) with Claude and extracts
// the identifiable fields. Claude TRANSCRIBES what is present and returns null
// for anything absent or unreadable — it never invents values and never computes
// totals (the app recomputes those). For known companies the frontend overrides
// the transcribed party with verified data from the Companies database.
//
// The Anthropic API key lives ONLY in this function's environment. Requests must
// carry a valid Supabase user JWT.
//
// Deploy:  supabase functions deploy ai-document
// Secret:  supabase secrets set ANTHROPIC_API_KEY=sk-ant-...   (shared with ai-invoice)
// =============================================================================

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, "content-type": "application/json" } });

const SYSTEM = `You extract structured fields from an uploaded commercial invoice or similar document. You are a transcriber, not an author.

Rules:
- TRANSCRIBE only what is actually printed in the document. If a field is missing, blank, or unreadable, use null. Never guess, infer, or fill in plausible values.
- Do NOT calculate or "correct" any totals — leave arithmetic to the application. Only transcribe amounts you can literally read.
- doc_date: return ISO format YYYY-MM-DD if the printed date is unambiguous; otherwise return the date exactly as printed as a string, or null.
- currency: one of USD, EUR, GBP, TRY if clearly indicated, else null.
- items: one entry per product line, transcribed. quantity/unit_price are numbers only if clearly printed, else null.
- seller_* / buyer_*: transcribe the names and address blocks as printed.
- is_invoice: false if the document is not an invoice/proforma/quote-like commercial document.
- confidence: your overall confidence in the transcription (high | medium | low).
- warnings: note anything unclear, low-quality, handwritten, partially cut off, or that a regenerated copy may not faithfully reproduce. Be honest — do not claim perfect fidelity.
- summary: one sentence describing the document.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    is_invoice: { type: "boolean" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    doc_number: { type: ["string", "null"] },
    doc_date: { type: ["string", "null"] },
    currency: { type: ["string", "null"] },
    seller_name: { type: ["string", "null"] },
    seller_address: { type: ["string", "null"] },
    seller_tax: { type: ["string", "null"] },
    buyer_name: { type: ["string", "null"] },
    buyer_address: { type: ["string", "null"] },
    buyer_tax: { type: ["string", "null"] },
    items: {
      type: ["array", "null"],
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          description: { type: "string" },
          quantity: { type: ["number", "null"] },
          unit: { type: ["string", "null"] },
          unit_price: { type: ["number", "null"] },
        },
        required: ["description", "quantity", "unit", "unit_price"],
      },
    },
    shipping_route: { type: ["string", "null"] },
    payment_terms: { type: ["string", "null"] },
    notes: { type: ["string", "null"] },
    warnings: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
  },
  required: [
    "is_invoice", "confidence", "doc_number", "doc_date", "currency",
    "seller_name", "seller_address", "seller_tax", "buyer_name", "buyer_address", "buyer_tax",
    "items", "shipping_route", "payment_terms", "notes", "warnings", "summary",
  ],
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization") || "";
    if (!authHeader.startsWith("Bearer ")) return json({ error: "Unauthorized." }, 401);
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const ANON = Deno.env.get("SUPABASE_ANON_KEY");
    if (SUPABASE_URL && ANON) {
      const who = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { Authorization: authHeader, apikey: ANON } });
      if (!who.ok) return json({ error: "Invalid or expired session." }, 401);
    }
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return json({ error: "Server is missing ANTHROPIC_API_KEY." }, 500);

    const body = await req.json().catch(() => ({}));
    const mediaType = String(body.mediaType || "");
    const dataBase64 = typeof body.dataBase64 === "string" ? body.dataBase64 : "";
    const text = typeof body.text === "string" ? body.text.slice(0, 40000) : "";
    const companyNames = Array.isArray(body.companyNames) ? body.companyNames.map(String).slice(0, 300) : [];

    const content: unknown[] = [];
    if (text) {
      content.push({ type: "text", text: "Document text (extracted from a DOCX file) follows:\n\n" + text });
    } else if (mediaType === "application/pdf" && dataBase64) {
      content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: dataBase64 } });
    } else if (mediaType.startsWith("image/") && dataBase64) {
      content.push({ type: "image", source: { type: "base64", media_type: mediaType, data: dataBase64 } });
    } else {
      return json({ error: "No readable document content provided." }, 400);
    }
    const names = companyNames.length ? companyNames.map((n: string) => "- " + n).join("\n") : "(none yet)";
    content.push({ type: "text", text: `Extract the invoice fields from the document above.\n\nKnown companies in the user's database (if a party matches one of these, still transcribe what the document says — the application handles matching):\n${names}` });

    const anthReq = {
      model: Deno.env.get("ANTHROPIC_MODEL") || "claude-opus-5",
      max_tokens: 3072,
      system: SYSTEM,
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      messages: [{ role: "user", content }],
    };

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(anthReq),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return json({ error: data?.error?.message || `Claude request failed (${r.status}).` }, 502);
    if (data.stop_reason === "refusal") return json({ error: "The assistant declined to read this document." }, 200);
    const textBlock = (data.content || []).find((b: { type: string }) => b.type === "text");
    if (!textBlock) return json({ error: "No structured output returned." }, 502);
    let extraction: unknown;
    try { extraction = JSON.parse(textBlock.text); } catch { return json({ error: "Could not parse the extraction." }, 502); }

    return json({ extraction, model: data.model, usage: data.usage });
  } catch (err) {
    return json({ error: String((err as Error)?.message || err) }, 500);
  }
});
