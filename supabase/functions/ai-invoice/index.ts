// =============================================================================
// Supabase Edge Function: ai-invoice
//
// Claude's ONLY job here is to interpret a natural-language instruction into a
// small set of structured invoice fields. It is NOT an authoritative data source:
// the schema below has NO fields for bank details, IBAN, SWIFT/BIC, addresses,
// tax/registration numbers, invoice numbers, totals or tracking numbers — so the
// model cannot invent them. The frontend matches companies against the database,
// loads verified data, validates quantities/prices and computes every total.
//
// SECURITY: the Anthropic API key lives ONLY in this function's environment
// (`supabase secrets set ANTHROPIC_API_KEY=...`). It is never sent to the browser.
// Requests must carry a valid Supabase user JWT (verified below).
//
// Deploy:  supabase functions deploy ai-invoice
// Secret:  supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
// =============================================================================

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, "content-type": "application/json" } });

const SYSTEM = `You convert a user's natural-language instruction into structured invoice fields for a commercial-invoice generator. You are an interpreter, not a data source.

Rules:
- Extract ONLY what the user states. Never invent, assume, or guess values.
- You must NEVER provide bank details, IBAN, SWIFT/BIC, company addresses, tax numbers, registration numbers, invoice numbers, subtotals/totals, shipment or tracking numbers, or legal identities. The application fills those from its own verified database and computes all totals. There are no fields for them here — do not place them anywhere.
- seller_name / buyer_name: return the company name exactly as the user refers to it. The application matches it against its Companies database; you only pass the name string. Do not describe the company.
- currency: one of USD, EUR, GBP, TRY when the user indicates one (symbol or code), otherwise null.
- items: one entry per product line. quantity and unit_price come ONLY from the instruction; if a quantity or a price is not stated, set it to null and add a clear, specific request to "needs" (e.g. "Unit price for automatic yarn winding machines"). "unit" is a free-text unit such as "pcs", "kg", "box" if stated, else null.
- Editing an existing draft: set intent="edit" and populate ONLY the fields that change; leave all others null. For items on an edit, return the FULL updated item list reflecting the change, reusing the current draft's values for the parts that don't change.
- Creating a new invoice: set intent="create".
- "needs": short, specific pieces of information the user must still supply. Empty if nothing is missing.
- "message": one short sentence describing what you interpreted.`;

// Structured-output schema — note the ABSENCE of any bank/tax/number/total field.
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    intent: { type: "string", enum: ["create", "edit"] },
    seller_name: { type: ["string", "null"] },
    buyer_name: { type: ["string", "null"] },
    currency: { type: ["string", "null"] },
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
    needs: { type: "array", items: { type: "string" } },
    message: { type: "string" },
  },
  required: ["intent", "seller_name", "buyer_name", "currency", "items", "shipping_route", "payment_terms", "notes", "needs", "message"],
};

function userContent(instruction: string, companyNames: string[], currentDraft: unknown) {
  const names = companyNames.length ? companyNames.map((n) => "- " + n).join("\n") : "(none yet)";
  const draftPart = currentDraft
    ? "Current draft (for edits):\n" + JSON.stringify(currentDraft)
    : "There is no existing draft; this is a new invoice.";
  return `Instruction:\n${instruction}\n\nKnown companies in the database (match names against these; do not invent others):\n${names}\n\n${draftPart}`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    // --- Authentication: require a valid Supabase user session ---
    const authHeader = req.headers.get("Authorization") || "";
    if (!authHeader.startsWith("Bearer ")) return json({ error: "Unauthorized." }, 401);
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const ANON = Deno.env.get("SUPABASE_ANON_KEY");
    if (SUPABASE_URL && ANON) {
      const who = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { Authorization: authHeader, apikey: ANON } });
      if (!who.ok) return json({ error: "Invalid or expired session." }, 401);
    }

    // --- Server-side key ---
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return json({ error: "Server is missing ANTHROPIC_API_KEY. Set it with: supabase secrets set ANTHROPIC_API_KEY=sk-ant-..." }, 500);

    const body = await req.json().catch(() => ({}));
    const instruction = String(body.instruction || "").slice(0, 4000).trim();
    if (!instruction) return json({ error: "No instruction provided." }, 400);
    const companyNames = Array.isArray(body.companyNames) ? body.companyNames.map(String).slice(0, 300) : [];
    const currentDraft = body.currentDraft || null;

    const anthReq = {
      model: Deno.env.get("ANTHROPIC_MODEL") || "claude-opus-5",
      max_tokens: 2048,
      system: SYSTEM,
      // effort: low keeps this fast; thinking stays on by default (Opus 5).
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      messages: [{ role: "user", content: userContent(instruction, companyNames, currentDraft) }],
    };

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(anthReq),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return json({ error: data?.error?.message || `Claude request failed (${r.status}).` }, 502);
    if (data.stop_reason === "refusal") return json({ error: "The assistant declined this request. Please rephrase." }, 200);

    const textBlock = (data.content || []).find((b: { type: string }) => b.type === "text");
    if (!textBlock) return json({ error: "No structured output returned." }, 502);
    let proposal: unknown;
    try { proposal = JSON.parse(textBlock.text); } catch { return json({ error: "Could not parse the assistant's response." }, 502); }

    return json({ proposal, model: data.model, usage: data.usage });
  } catch (err) {
    return json({ error: String((err as Error)?.message || err) }, 500);
  }
});
