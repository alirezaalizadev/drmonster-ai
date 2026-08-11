// =============================================================================
// Supabase Edge Function: risk-screen  (Company Risk Intelligence)
//
// Provider layer + explainable scoring engine. It NEVER fabricates findings:
//   - Sanctions screening goes to a configurable authoritative provider
//     (OpenSanctions-compatible). Without a key it returns provider_unavailable
//     — which is NOT "no match".
//   - Relationship / country-exposure / adverse-media research uses Claude with
//     the web_search tool (real, cited sources) via the existing ANTHROPIC_API_KEY.
//     Every finding carries a real source URL; if search is unavailable the
//     provider reports provider_unavailable.
//   - The scoring engine is centralised + configurable and returns explainable
//     factors. Direct sanctions vs. sanctions-related exposure are kept distinct.
//
// Secrets live ONLY here. Requests require a valid Supabase user JWT.
//
// Deploy:  supabase functions deploy risk-screen
// Optional secret (real sanctions data): supabase secrets set OPENSANCTIONS_API_KEY=...
// Uses the existing ANTHROPIC_API_KEY for web research.
// =============================================================================

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "content-type": "application/json" } });
const nowISO = () => new Date().toISOString();

// ---- Configurable jurisdiction list (admins can override via RISK_JURISDICTIONS JSON) ----
// program: comprehensive | territorial | sectoral | entity | elevated
const DEFAULT_JURISDICTIONS = [
  { code: "IR", name: "Iran", program: "comprehensive" },
  { code: "KP", name: "North Korea", program: "comprehensive" },
  { code: "SY", name: "Syria", program: "comprehensive" },
  { code: "CU", name: "Cuba", program: "comprehensive" },
  { code: "RU", name: "Russia", program: "sectoral" },
  { code: "BY", name: "Belarus", program: "sectoral" },
  { code: "UA-43", name: "Crimea", program: "territorial" },
  { code: "UA-14", name: "Donetsk", program: "territorial" },
  { code: "UA-09", name: "Luhansk", program: "territorial" },
  { code: "UA-65", name: "Kherson", program: "territorial" },
  { code: "UA-23", name: "Zaporizhzhia", program: "territorial" },
];
function jurisdictions() {
  try { const raw = Deno.env.get("RISK_JURISDICTIONS"); if (raw) { const j = JSON.parse(raw); if (Array.isArray(j) && j.length) return j; } } catch { /* fall through */ }
  return DEFAULT_JURISDICTIONS;
}

// ---- Configurable scoring (weights + thresholds) ----
const SCORING = {
  thresholds: { low: 24, moderate: 49, high: 74 }, // >74 = critical
  weights: {
    confirmed_direct_sanctions: 100,
    confirmed_sanctioned_owner: 90,
    confirmed_sanctioned_relationship: 65,
    comprehensive_relationship_current: 34,
    comprehensive_relationship_historical: 16,
    sectoral_relationship_current: 20,
    sectoral_relationship_historical: 9,
    territorial_relationship_current: 30,
    elevated_relationship_current: 12,
    potential_sanctions_match: 10,
    pep: 8,
    adverse_media_high: 14,
    adverse_media_medium: 7,
    adverse_media_low: 3,
    unresolved_ownership: 6,
  },
};
function levelOf(score: number) {
  const t = SCORING.thresholds;
  if (score > t.high) return "critical";
  if (score > t.moderate) return "high";
  if (score > t.low) return "moderate";
  return "low";
}

// ---- Sanctions provider (authoritative; OpenSanctions-compatible) ----
async function sanctionsProvider(company: string, country: string) {
  const key = Deno.env.get("OPENSANCTIONS_API_KEY");
  const base = Deno.env.get("SANCTIONS_API_URL") || "https://api.opensanctions.org";
  if (!key) {
    return { status: "provider_unavailable", label: "Sanctions screening", reason: "No sanctions provider configured (set OPENSANCTIONS_API_KEY).", matches: [], checkedAt: nowISO() };
  }
  try {
    const body = { queries: { q: { schema: "Company", properties: { name: [company], ...(country ? { country: [country] } : {}) } } } };
    const r = await fetch(`${base}/match/default?algorithm=logic-v1`, {
      method: "POST",
      headers: { "content-type": "application/json", "Authorization": "ApiKey " + key },
      body: JSON.stringify(body),
    });
    if (!r.ok) return { status: "error", label: "Sanctions screening", reason: `Provider error (${r.status}).`, matches: [], checkedAt: nowISO() };
    const d = await r.json();
    const results = (d?.responses?.q?.results) || [];
    const matches = results.slice(0, 20).map((m: any) => {
      const score = typeof m.score === "number" ? m.score : 0;
      const datasets = (m.datasets || []).join(", ");
      // A high score is a POTENTIAL match requiring review; only exact strong matches are flagged higher.
      const matchType = score >= 0.9 ? "manual_review" : score >= 0.7 ? "potential" : "no_match";
      return {
        entity: m.caption || (m.properties?.name?.[0]) || "(unnamed)",
        aliases: (m.properties?.alias || []).slice(0, 8),
        list: datasets, dataset: (m.datasets || [])[0] || null,
        score: Math.round(score * 100) / 100, matchType,
        matchReason: `Name/entity match on ${datasets || "sanctions dataset"} (score ${(score * 100).toFixed(0)}%).`,
        sourceId: m.id || null,
        sourceUrl: m.id ? `https://www.opensanctions.org/entities/${m.id}/` : "https://www.opensanctions.org/",
        country: (m.properties?.country || [])[0] || null,
        topics: (m.properties?.topics || []),
      };
    }).filter((m: any) => m.matchType !== "no_match");
    return { status: "ok", label: "Sanctions screening (OpenSanctions)", matches, checkedAt: nowISO(), dataDate: d?.responses?.q?.status ? nowISO() : null };
  } catch (e) {
    return { status: "error", label: "Sanctions screening", reason: String((e as Error)?.message || e), matches: [], checkedAt: nowISO() };
  }
}

// ---- Web research provider (Claude + web_search: real, cited sources) ----
const RESEARCH_SYSTEM = `You are a compliance research assistant for DrMonster Company Risk Intelligence. You investigate a company's relationships and exposure using web search, and you report ONLY what the retrieved sources actually say.

Absolute rules:
- Use the web_search tool. Base every finding on a source you actually retrieved. Never invent companies, people, owners, shareholders, directors, shipments, relationships, sources, dates or URLs.
- For each finding include the exact source URL from the search results and, when stated, the publication/evidence date. If you cannot find a source, do not create the finding.
- Distinguish current vs historical, and direct vs indirect relationships. Distinguish allegations / investigations / charges / enforcement / judgments — do not state allegations as fact.
- "No relevant relationship identified in the sources checked" is a valid and expected result — never pad it with invented items.
- Do NOT make a sanctions determination here; that is done by an authoritative provider separately. You may note media that discusses sanctions, as adverse_media.
- Keep it concise: at most ~15 findings total, deduplicated, only materially relevant ones.

End your reply with a single fenced JSON block (\`\`\`json ... \`\`\`) matching:
{"findings":[{"category":"relationship|country_exposure|ownership|director|trade","subject":"the company","related_entity":"","country":"ISO name","relationship":"distributor|supplier|subsidiary|parent|shareholder|ubo|director|customer|agent|jv|branch|office|factory|project|government_contract|shipping|banking|other","temporality":"current|historical|unknown","directness":"direct|indirect|unknown","confidence":"very_high|high|medium|low","evidence":"1-2 sentence factual summary","source":"publisher","source_url":"https://...","evidence_date":"YYYY-MM-DD|null"}],
 "people":[{"name":"","role":"director|ubo|executive","nationality":"|null","pep":"yes|no|unknown","confidence":"","source_url":"","evidence":""}],
 "adverse_media":[{"headline":"","category":"sanctions|money_laundering|fraud|corruption|bribery|export_control|enforcement|litigation|other","allegation_stage":"allegation|investigation|charge|enforcement|judgment|unclear","source":"","source_url":"","date":"YYYY-MM-DD|null","confidence":"","summary":""}]}`;

async function researchProvider(company: string, country: string, jur: any[]) {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return { status: "provider_unavailable", label: "Web research (relationships & adverse media)", reason: "ANTHROPIC_API_KEY not set.", findings: [], people: [], adverse_media: [], checkedAt: nowISO() };
  const focus = jur.map((j) => j.name).join(", ");
  const userMsg =
    `Investigate this company and report only source-backed findings.\n\nCompany: ${company}\nCountry / jurisdiction: ${country || "(unknown)"}\n\n` +
    `Search for: sanctions-relevant relationships and exposure involving ${focus}; ownership, shareholders and beneficial owners; directors and key people; distributors, suppliers, subsidiaries, customers, trade and shipping; and adverse media (sanctions, sanctions evasion, money laundering, fraud, corruption, bribery, export-control violations, enforcement).\n` +
    `Run focused queries such as "${company} Russia", "${company} Iran", "${company} sanctions", "${company} OFAC", "${company} distributor", "${company} owner shareholders", "${company} directors", "${company} exports". Deduplicate and keep only materially relevant, source-backed findings.`;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: Deno.env.get("ANTHROPIC_MODEL") || "claude-opus-5",
        max_tokens: 6000,
        system: RESEARCH_SYSTEM,
        tools: [{ type: Deno.env.get("WEB_SEARCH_TOOL") || "web_search_20250305", name: "web_search", max_uses: 12 }],
        messages: [{ role: "user", content: userMsg }],
      }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = d?.error?.message || `Provider error (${r.status})`;
      const unsupported = /web_search|tool|not.*(enabled|available|support)/i.test(msg);
      return { status: unsupported ? "provider_unavailable" : "error", label: "Web research (relationships & adverse media)", reason: msg, findings: [], people: [], adverse_media: [], checkedAt: nowISO() };
    }
    const text = (d.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
    const m = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/(\{[\s\S]*\})\s*$/);
    let parsed: any = { findings: [], people: [], adverse_media: [] };
    if (m) { try { parsed = JSON.parse(m[1]); } catch { /* keep empty */ } }
    // Keep only findings that carry a real http(s) source URL — never trust an uncited claim.
    const httpOnly = (arr: any[], urlKey: string) => (Array.isArray(arr) ? arr : []).filter((x) => typeof x?.[urlKey] === "string" && /^https?:\/\//i.test(x[urlKey]));
    return {
      status: "ok", label: "Web research (relationships & adverse media)",
      findings: httpOnly(parsed.findings, "source_url").slice(0, 30),
      people: (Array.isArray(parsed.people) ? parsed.people : []).slice(0, 20),
      adverse_media: httpOnly(parsed.adverse_media, "source_url").slice(0, 20),
      checkedAt: nowISO(),
    };
  } catch (e) {
    return { status: "error", label: "Web research (relationships & adverse media)", reason: String((e as Error)?.message || e), findings: [], people: [], adverse_media: [], checkedAt: nowISO() };
  }
}

// ---- Scoring engine (explainable) ----
function jurByName(name: string, jur: any[]) {
  if (!name) return null;
  const n = name.toLowerCase();
  return jur.find((j) => n.includes(j.name.toLowerCase())) || null;
}
function scoreInvestigation(sanctions: any, research: any, jur: any[]) {
  const W = SCORING.weights;
  const factors: any[] = []; const mitigating: any[] = []; const breakdown: Record<string, number> = {};
  const add = (cat: string, label: string, pts: number, detail: string) => { factors.push({ category: cat, label, points: pts, detail }); breakdown[cat] = (breakdown[cat] || 0) + pts; };

  // Direct sanctions — only the authoritative provider can drive this; potential ≠ confirmed.
  let directStatus = "unknown";
  if (sanctions.status === "ok") {
    const strong = (sanctions.matches || []).filter((m: any) => m.matchType === "manual_review");
    const potential = (sanctions.matches || []).filter((m: any) => m.matchType === "potential");
    if (strong.length) { directStatus = "potential"; add("direct_sanctions", "Strong potential direct sanctions match (needs manual review)", W.potential_sanctions_match + 8, `${strong.length} high-score match(es) on ${strong.map((m: any) => m.list).join(", ")}`); }
    else if (potential.length) { directStatus = "potential"; add("direct_sanctions", "Potential direct sanctions match", W.potential_sanctions_match, `${potential.length} potential match(es) requiring review`); }
    else { directStatus = "clear"; mitigating.push({ label: "No direct sanctions match identified in the lists checked" }); }
  } else { directStatus = sanctions.status === "provider_unavailable" ? "unavailable" : "unknown"; }

  // Country exposure + relationships (from cited research findings only)
  const findings = (research.status === "ok" ? research.findings : []) || [];
  const byCountry: Record<string, any> = {};
  for (const f of findings) {
    const j = jurByName(f.country || "", jur);
    if (!j) continue; // only score sanctions-relevant jurisdictions here
    const key = `${j.program}_relationship_${f.temporality === "historical" ? "historical" : "current"}` as keyof typeof W;
    const pts = (W as any)[key] ?? W.elevated_relationship_current;
    add("country_exposure", `${j.name} — ${f.relationship || "relationship"} (${f.temporality || "unknown"})`, pts, f.evidence || "");
    const c = (byCountry[j.name] = byCountry[j.name] || { name: j.name, program: j.program, count: 0, relationships: [] as string[], current: false, historical: false });
    c.count++; if (f.relationship && !c.relationships.includes(f.relationship)) c.relationships.push(f.relationship);
    if (f.temporality === "historical") c.historical = true; else c.current = true;
  }
  // Adverse media
  const media = (research.status === "ok" ? research.adverse_media : []) || [];
  for (const a of media) {
    const w = a.confidence === "very_high" || a.confidence === "high" ? W.adverse_media_high : a.confidence === "medium" ? W.adverse_media_medium : W.adverse_media_low;
    add("adverse_media", `Adverse media — ${a.category || "other"} (${a.allegation_stage || "unclear"})`, w, a.headline || "");
  }
  // PEP
  const peps = (research.status === "ok" ? research.people : []).filter((p: any) => p.pep === "yes");
  if (peps.length) add("pep", `${peps.length} politically-exposed person(s) associated`, W.pep, "PEP status is a risk factor, not evidence of wrongdoing.");

  let raw = factors.reduce((s, f) => s + f.points, 0);
  const score = Math.max(0, Math.min(100, Math.round(raw)));
  const level = levelOf(score);

  // Country exposure classification (kept SEPARATE from direct sanctions)
  const exposures = Object.values(byCountry).map((c: any) => {
    let cls = "elevated";
    if (c.program === "comprehensive" || c.program === "territorial") cls = c.current ? "sanctions_relevant" : "elevated";
    else if (c.program === "sectoral") cls = "elevated";
    return { ...c, classification: cls };
  }).sort((a: any, b: any) => b.count - a.count);
  let countryExposure = "clear";
  if (research.status !== "ok") countryExposure = "unavailable";
  else if (exposures.some((e: any) => e.classification === "sanctions_relevant")) countryExposure = "high";
  else if (exposures.length) countryExposure = "moderate";

  return { score, level, factors, mitigating, breakdown, directStatus, countryExposure, exposures };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const authHeader = req.headers.get("Authorization") || "";
    if (!authHeader.startsWith("Bearer ")) return json({ error: "Unauthorized." }, 401);
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL"); const ANON = Deno.env.get("SUPABASE_ANON_KEY");
    if (SUPABASE_URL && ANON) {
      const who = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { Authorization: authHeader, apikey: ANON } });
      if (!who.ok) return json({ error: "Invalid or expired session." }, 401);
    }
    const body = await req.json().catch(() => ({}));
    const company = String(body.company || "").trim();
    if (!company) return json({ error: "Company name is required." }, 400);
    const country = String(body.country || "").trim();
    const jur = jurisdictions();

    // Run providers in parallel (one failing does not fail the investigation).
    const [sanctions, research] = await Promise.all([sanctionsProvider(company, country), researchProvider(company, country, jur)]);

    const scored = scoreInvestigation(sanctions, research, jur);

    // Data coverage: proportion of expected data domains that returned data.
    const domains = [
      { key: "sanctions", label: "Sanctions lists", ok: sanctions.status === "ok" },
      { key: "corporate", label: "Corporate & ownership", ok: research.status === "ok" },
      { key: "directors", label: "Directors & key people", ok: research.status === "ok" && (research.people || []).length >= 0 && research.status === "ok" },
      { key: "trade", label: "Trade & shipping", ok: research.status === "ok" },
      { key: "adverse_media", label: "Adverse media", ok: research.status === "ok" },
    ];
    const covered = domains.filter((d) => d.ok).length;
    const dataCoverage = Math.round((covered / domains.length) * 100);
    const confidence = dataCoverage >= 80 ? "high" : dataCoverage >= 50 ? "medium" : "low";

    // Evidence-based executive summary (assembled deterministically from actual results).
    const relCount = (research.status === "ok" ? research.findings : []).length;
    const sancMatches = sanctions.status === "ok" ? (sanctions.matches || []).length : 0;
    const missing = jur.filter((j) => !scored.exposures.some((e: any) => e.name === j.name)).map((j) => j.name);
    const parts: string[] = [];
    parts.push(sanctions.status !== "ok"
      ? `Direct sanctions screening was ${sanctions.status === "provider_unavailable" ? "not available (no sanctions provider configured)" : "unable to complete"}, so no direct-sanctions determination could be made.`
      : (sancMatches ? `${sancMatches} potential direct sanctions match(es) were returned and require manual review; none are confirmed automatically.` : `No direct sanctions match was identified for ${company} in the lists checked.`));
    if (research.status === "ok") {
      parts.push(scored.exposures.length ? `Business relationships involving ${scored.exposures.map((e: any) => e.name).join(", ")} were identified from cited sources (${relCount} relationship finding(s)).` : `No sanctions-relevant jurisdiction relationships were identified in the sources checked.`);
      if (missing.length) parts.push(`No relevant relationship with ${missing.slice(0, 3).join(", ")} was identified in the sources checked.`);
    } else parts.push(`Relationship and adverse-media research was ${research.status === "provider_unavailable" ? "not available" : "incomplete"}; exposure could not be assessed.`);
    parts.push(`Overall assessment: ${scored.level.toUpperCase()} (${scored.score}/100). Material findings should be independently verified before any decision.`);
    const summary = parts.join(" ");

    const providers = [
      { key: "sanctions", label: sanctions.label, status: sanctions.status, checkedAt: sanctions.checkedAt, reason: sanctions.reason || null, dataDate: (sanctions as any).dataDate || null },
      { key: "research", label: research.label, status: research.status, checkedAt: research.checkedAt, reason: (research as any).reason || null },
    ];

    return json({
      company, country,
      generatedAt: nowISO(),
      score: scored.score, level: scored.level, confidence, dataCoverage,
      directSanctions: scored.directStatus, countryExposure: scored.countryExposure,
      sanctions, research,
      exposures: scored.exposures,
      breakdown: scored.breakdown, factors: scored.factors, mitigating: scored.mitigating,
      coverageDomains: domains, providers, jurisdictions: jur,
      summary,
      config: { thresholds: SCORING.thresholds },
    });
  } catch (err) {
    return json({ error: String((err as Error)?.message || err) }, 500);
  }
});
