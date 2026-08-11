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

// ---------------- contract mode ----------------
// Same philosophy: Claude interprets instructions and MAY draft/rewrite contract
// clause LANGUAGE when asked — but never invents facts. There are still no fields
// for bank details, addresses, tax numbers, contract numbers, dates or totals.
const CONTRACT_SYSTEM = `You convert a user's natural-language instruction into structured changes for a commercial-contract editor. You are an interpreter and legal-language drafter, not a source of facts.

Rules:
- Extract ONLY facts the user states (quantities, prices, terms, party names). Never invent, assume, or guess factual/commercial data: no company identities or addresses, bank details, prices, quantities, shipment facts, contract numbers, dates, or totals. The application supplies verified company data and computes all totals. If a needed fact is missing, add a specific request to "needs" and leave the field null.
- You MAY write professional contract clause text (e.g. warranty, force majeure) when the user asks you to draft or rewrite a clause — that is language, not fact. Inside clause text, refer to facts using these placeholders instead of literal values: {{SELLER_NAME}} {{BUYER_NAME}} {{TOTAL}} {{CURRENCY}} {{PAYMENT_TERMS}} {{DELIVERY_TERMS}} {{DELIVERY_PERIOD}} {{INCOTERM}} {{WARRANTY_TERMS}} {{CONTRACT_NUMBER}} {{CONTRACT_DATE}}. The application substitutes verified values.
- contract_type: one of sales, purchase, supply, intl — only when the user indicates it; else null.
- seller_name / buyer_name: the company name exactly as the user refers to it (the app matches it against its database); else null.
- items: only when the user states product lines or changes them. For edits, return the FULL updated item list, reusing current values for unchanged parts. quantity/unit_price ONLY from the instruction; null if unstated (and add to "needs").
- terms: set only the fields the user changes; all others null.
- clause_ops: add / update / remove operations on clauses, matched by title. "update" replaces the clause body with your drafted text; include the full new body. Use "position" (1-based) only when the user asks to move/insert at a place.
- intent: "create" for a new contract, "edit" for changes to the current one.
- "needs": short specific missing facts. "message": one sentence describing what you did.`;

const CONTRACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    intent: { type: "string", enum: ["create", "edit"] },
    contract_type: { type: ["string", "null"], enum: ["sales", "purchase", "supply", "intl", null] },
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
          model: { type: ["string", "null"] },
          quantity: { type: ["number", "null"] },
          unit: { type: ["string", "null"] },
          unit_price: { type: ["number", "null"] },
          origin: { type: ["string", "null"] },
          hs_code: { type: ["string", "null"] },
        },
        required: ["description", "model", "quantity", "unit", "unit_price", "origin", "hs_code"],
      },
    },
    terms: {
      type: ["object", "null"],
      additionalProperties: false,
      properties: {
        payment: { type: ["string", "null"] },
        delivery: { type: ["string", "null"] },
        delivery_period: { type: ["string", "null"] },
        shipping_origin: { type: ["string", "null"] },
        shipping_destination: { type: ["string", "null"] },
        shipping_method: { type: ["string", "null"] },
        incoterm: { type: ["string", "null"] },
        origin_country: { type: ["string", "null"] },
        inspection: { type: ["string", "null"] },
        warranty: { type: ["string", "null"] },
        packaging: { type: ["string", "null"] },
        insurance: { type: ["string", "null"] },
        additional: { type: ["string", "null"] },
      },
      required: ["payment", "delivery", "delivery_period", "shipping_origin", "shipping_destination", "shipping_method", "incoterm", "origin_country", "inspection", "warranty", "packaging", "insurance", "additional"],
    },
    clause_ops: {
      type: ["array", "null"],
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          op: { type: "string", enum: ["add", "update", "remove"] },
          title: { type: "string" },
          body: { type: ["string", "null"] },
          position: { type: ["number", "null"] },
        },
        required: ["op", "title", "body", "position"],
      },
    },
    needs: { type: "array", items: { type: "string" } },
    message: { type: "string" },
  },
  required: ["intent", "contract_type", "seller_name", "buyer_name", "currency", "items", "terms", "clause_ops", "needs", "message"],
};

function userContent(instruction: string, companyNames: string[], currentDraft: unknown, mode: string) {
  const names = companyNames.length ? companyNames.map((n) => "- " + n).join("\n") : "(none yet)";
  const kind = mode === "contract" ? "contract" : "invoice";
  const draftPart = currentDraft
    ? `Current ${kind} draft (for edits):\n` + JSON.stringify(currentDraft)
    : `There is no existing draft; this is a new ${kind}.`;
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
    const mode = body.mode === "contract" ? "contract" : "invoice";

    const anthReq = {
      model: Deno.env.get("ANTHROPIC_MODEL") || "claude-opus-5",
      max_tokens: mode === "contract" ? 4096 : 2048,
      system: mode === "contract" ? CONTRACT_SYSTEM : SYSTEM,
      // effort: low keeps this fast; thinking stays on by default (Opus 5).
      output_config: { effort: "low", format: { type: "json_schema", schema: mode === "contract" ? CONTRACT_SCHEMA : SCHEMA } },
      messages: [{ role: "user", content: userContent(instruction, companyNames, currentDraft, mode) }],
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
