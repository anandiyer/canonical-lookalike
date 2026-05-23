/* Lookalike Finder — Cloudflare Worker
   ----------------------------------------------------------------------------
   Runs the lookalike pipeline server-side, streaming progress to the browser as
   SSE. Rate-limited per IP/day via Workers KV so the lab stays free for everyone.

   HYBRID MODELS (all via OpenRouter — one key, no per-org TPM tier limits):
     • CHEAP tier  → mechanical steps: profile structuring (with web plugin) +
                     search-query generation.
     • STRONG tier → reasoning steps: trait extraction + candidate scoring.

   Secrets (set with `wrangler secret put`):  OPENROUTER_API_KEY, EXA_API_KEY
   Bindings (wrangler.toml):                   RL (KV namespace)
   Vars: ALLOWED_ORIGIN, MODEL_CHEAP, MODEL_STRONG, DAILY_LIMIT
*/

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const EXA_SEARCH_URL = "https://api.exa.ai/search";
const EXA_CONTENTS_URL = "https://api.exa.ai/contents";
// OpenRouter web plugin for the ingestion step (replaces Claude's built-in
// web_search). More results = more grounding evidence, so the model fills fewer
// fields from parametric memory (the source of "proximity" hallucinations).
const WEB_PLUGIN = { id: "web", max_results: 8 };
// Refine requests (anything with a `hints` body) bypass the daily limit but are
// capped separately to prevent abuse. One refine = one corrected search; three
// per IP per day is plenty.
const REFINE_LIMIT = 3;

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env);

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const url = new URL(request.url);
    if (request.method !== "POST") return json({ error: "POST only" }, 405, cors);
    if (url.pathname === "/feedback") return handleFeedback(request, env, cors);
    if (url.pathname !== "/lookalike") return json({ error: "not found" }, 404, cors);

    let body;
    try { body = await request.json(); } catch { return json({ error: "bad json" }, 400, cors); }
    const input = (body.input || "").trim();
    if (!input) return json({ error: "missing input" }, 400, cors);
    const hints = sanitizeHints(body.hints);
    const isRefine = !!hints;

    // ── rate limit ──────────────────────────────────────────────────────
    // Initial searches: N/IP/day (the public quota).
    // Refine requests (a follow-up with user hints to correct a bad result):
    // separate counter, capped at 3/IP/day so the user can always recover from
    // a wrong-person result even when their main quota is spent.
    const limit = parseInt(env.DAILY_LIMIT || "3", 10);
    const ip = request.headers.get("CF-Connecting-IP") || "anon";
    const day = new Date().toISOString().slice(0, 10);
    const rlKey = isRefine ? `rl:refine:${ip}:${day}` : `rl:${ip}:${day}`;
    const rlCap = isRefine ? REFINE_LIMIT : limit;
    const used = parseInt((await env.RL.get(rlKey)) || "0", 10);
    if (used >= rlCap)
      return json(
        {
          error: "rate_limited",
          resetHint: isRefine
            ? "you've used your refine attempts for today — quota resets at midnight UTC"
            : "your quota resets at midnight UTC",
        },
        429,
        cors
      );

    // count this lookup up front (prevents abuse via aborted requests). For
    // refines the main quota is untouched — `remaining` still reflects it.
    await env.RL.put(rlKey, String(used + 1), { expirationTtl: 60 * 60 * 36 });
    const mainUsed = isRefine
      ? parseInt((await env.RL.get(`rl:${ip}:${day}`)) || "0", 10)
      : used + 1;
    const remaining = Math.max(0, limit - mainUsed);

    // analytics: forward every search to Slack (#hack-central). Fire-and-forget
    // via waitUntil so it never delays or breaks the pipeline.
    notifySearch(env, ctx, { input, ip, day, remaining, hints, isRefine });

    // ── stream the pipeline ─────────────────────────────────────────────
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const enc = new TextEncoder();
    const send = (obj) => writer.write(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));

    runPipeline({ input, hints, env, ctx, send, remaining, ip, day })
      .catch((err) => send({ type: "error", message: String(err.message || err) }))
      .finally(() => writer.close());

    return new Response(readable, {
      headers: { ...cors, "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" },
    });
  },
};

// ── pipeline ───────────────────────────────────────────────────────────────
async function runPipeline({ input, hints, env, ctx, send, remaining, ip, day }) {
  send({ type: "quota", remaining });
  // Hybrid: cheap model for mechanical steps, strong model for reasoning.
  const CHEAP = env.MODEL_CHEAP || "google/gemini-2.5-flash";
  const STRONG = env.MODEL_STRONG || "anthropic/claude-sonnet-4.5";
  const notify = (m) => send({ type: "status", text: m });

  // 1 — ingest + structure profile  (CHEAP + web plugin + Exa grounding)
  send({ type: "stage", step: "ingest", state: "active" });
  send({ type: "status", text: "Reading the open web to reconstruct the profile…" });

  // Identify the verified anchor(s) the user gave us — the canonical URL/handle
  // we will ground every fact against. For X handles this is the single biggest
  // defense against picking the wrong person: instead of shipping a bare token
  // to Exa, we ship the canonical x.com/<handle> URL and fetch its contents.
  const anchors = [canonicalize(input)];
  if (hints?.url) {
    const ha = canonicalize(hints.url);
    if (ha.kind !== "unknown") anchors.push(ha);
  }
  const primary = anchors[0];

  // Two-pronged Exa evidence gathering:
  //   (a) /search neural over each anchor URL → pages that LINK TO the profile
  //       (podcast guests, Crunchbase, news, conference bios — the disambiguators)
  //   (b) /contents on the anchor URLs → the X/LinkedIn page text itself (bio,
  //       headline) which usually carries real name + employer.
  // Running these in parallel adds <2s and produces dramatically better grounding.
  const evidence = await gatherEvidence(env, anchors);

  const profile = await llmJSON(env, {
    model: CHEAP,
    web: true,
    temperature: 0.1,
    max_tokens: 2400,
    notify,
    system:
      "You are a meticulous people-research analyst. Reconstruct a professional profile ONLY from the web results and the SOURCE EVIDENCE provided (personal site, company pages, podcasts, conference bios, Crunchbase, news). LinkedIn itself is usually auth-walled — reconstruct from everything around it. " +
      "ANCHOR: the user identified this person via the ANCHOR(S) listed below — these are the verified canonical identifier(s). Only use evidence that explicitly references one of these anchors (the same handle, the same URL, or a page that links to one of them). If a snippet mentions a different person who happens to share a name but does NOT reference the anchor, IGNORE it. " +
      (hints ? "USER HINTS: the user explicitly told us who this person is. Hints OVERRIDE any ambiguous web signal — trust them as ground truth and use them to disambiguate. " : "") +
      "STRICT GROUNDING RULES: (1) Assert only facts directly supported by the evidence (or the user hints). (2) If a field is not supported, leave it empty (\"\") or an empty array — do NOT fill gaps from prior knowledge or plausible guesses. (3) Never introduce a company, school, role, title, date, or location that does not appear in the evidence or hints. (4) For each career_history and education entry, set \"source\" to the URL it came from. " +
      "Return ONLY a JSON object, no prose.",
    prompt:
      `Reconstruct the professional profile for this person.\n\n` +
      `ANCHOR(S) (verified identifier(s) — every fact must be consistent with these):\n` +
      `${anchors.map((a) => `  • ${a.anchor}${a.url ? ` → ${a.url}` : ""}`).join("\n")}\n\n` +
      (hints ? `USER HINTS (highest priority — overrides any conflicting web signal):\n${JSON.stringify(hints)}\n\n` : "") +
      `SOURCE EVIDENCE (web snippets — treat as ground truth; do not contradict it or go beyond it):\n` +
      `${JSON.stringify(evidence)}\n\n` +
      `Return JSON with this exact shape:\n` +
      `{"name":"","current_role":"","current_company":"","company_description":"","location":"",` +
      `"education":[{"school":"","degree":"","field":"","source":""}],` +
      `"career_history":[{"company":"","role":"","domain":"","source":""}],` +
      `"background_signals":[""],` +
      `"linkedin":"full LinkedIn URL — ALWAYS echo the URL from the ANCHOR(S) above if one was a LinkedIn URL; otherwise the LinkedIn URL from the evidence if any, else empty",` +
      `"x":"full X/Twitter URL — ALWAYS echo the URL from the ANCHOR(S) above if one was an X/Twitter URL or handle; otherwise the X URL from the evidence if any, else empty",` +
      `"arc":"3-4 sentence narrative grounded only in the evidence above"}`,
  });
  send({ type: "stage", step: "ingest", state: "done" });

  // Anchor verification: did the reconstructed profile actually reference the
  // anchor we asked it to? If not, the model picked up cross-talk evidence about
  // a different person. Flag it so the UI can auto-open the refine modal and so
  // the Slack analytics show us the exact failure pattern in real time.
  if (!verifyAnchor(profile, anchors)) {
    send({
      type: "anchor_unverified",
      anchor: primary.anchor,
      reason: "The reconstructed profile does not reference the handle/URL you provided. We may have picked up the wrong person.",
    });
    notifyAnchorMiss(env, ctx, { input, anchor: primary.anchor, ip, day, profile });
  }

  // 2 — trait extraction  (STRONG — the key reasoning step)
  send({ type: "stage", step: "traits", state: "active" });
  send({ type: "status", text: "Distilling the traits that make this person distinctive…" });
  const traitsObj = await llmJSON(env, {
    model: STRONG,
    max_tokens: 1200,
    temperature: 0.2,
    notify,
    system:
      "You extract the DEFINING dimensions of a professional archetype — the rare, distinctive axes, not generic job attributes. " +
      "STRICT GROUNDING: derive every trait ONLY from facts present in the provided profile. Do NOT introduce any company, school, role, title, date, or specific that is not already in the profile, and never assert a career path that doesn't match the profile's career_history exactly. If the profile is thin, return fewer traits rather than inventing detail. Return ONLY JSON.",
    prompt:
      `Given this profile, extract 5–8 distinctive trait dimensions. Capture career trajectory ` +
      `patterns, domain transitions/pivots, rare skill combinations, background characteristics, and ` +
      `current focus specifics. Weight each 0.0–1.0 by how DEFINING it is (1.0 = strongest signal).\n\n` +
      `Profile:\n${JSON.stringify(profile)}\n\n` +
      `Return: {"traits":[{"axis":"career_arc","value":"...","weight":0.9}, ...]}`,
  });
  const traits = traitsObj.traits || [];
  send({ type: "stage", step: "traits", state: "done" });
  send({
    type: "profile",
    profile: {
      name: profile.name,
      current_role: profile.current_role,
      current_company: profile.current_company,
      location: profile.location,
      arc: profile.arc || profile.company_description,
      linkedin: profile.linkedin || anchorURL(anchors, "linkedin"),
      x: profile.x || anchorURL(anchors, "x"),
      traits,
    },
  });

  // 3 — query generation  (CHEAP — mechanical)
  send({ type: "stage", step: "queries", state: "active" });
  send({ type: "status", text: "Generating neural search queries across trait combinations…" });
  const qObj = await llmJSON(env, {
    model: CHEAP,
    max_tokens: 700,
    notify,
    system:
      "You write natural-language search queries for a neural search engine (Exa) that retrieves PEOPLE by career meaning. Combine the strongest traits into 5 distinct queries — you cannot find a lookalike with a single search. Return ONLY JSON.",
    prompt:
      `Source person: ${profile.name} — ${profile.current_role} at ${profile.current_company}.\n` +
      `Traits:\n${JSON.stringify(traits)}\n\n` +
      `Write 5 neural search queries describing OTHER people with a similar career arc (do not name the ` +
      `source person). Phrase them as natural descriptions, e.g. "founder who built real-time data ` +
      `infrastructure after a hardware engineering and crypto background".\n` +
      `Return: {"queries":["...","..."]}`,
  });
  const queries = (qObj.queries || []).slice(0, 5);
  send({ type: "stage", step: "queries", state: "done" });

  // 4 — candidate retrieval (Exa neural search, merged + deduped)
  send({ type: "stage", step: "retrieve", state: "active" });
  send({ type: "status", text: `Searching the web across ${queries.length} trait queries…` });
  const seen = new Set();
  const candidates = [];
  const searches = await Promise.all(queries.map((q) => exaSearch(env, q).catch(() => [])));
  for (const results of searches) {
    for (const r of results) {
      const key = (r.url || r.title || "").toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        title: r.title,
        url: r.url,
        author: r.author,
        text: (r.text || "").slice(0, 400),
      });
    }
  }
  // Cap how much we feed the scorer — keeps input well under tight TPM limits.
  candidates.length = Math.min(candidates.length, 18);
  send({ type: "status", text: `Found ${candidates.length} candidates — scoring against the trait vector…` });
  send({ type: "stage", step: "retrieve", state: "done" });

  // 5 — score + rank  (STRONG — nuanced reasoning over the trait vector)
  send({ type: "stage", step: "score", state: "active" });
  const scored = await llmJSON(env, {
    model: STRONG,
    max_tokens: 3200,
    notify,
    system:
      "You score lookalike candidates against a source person's trait vector, using only the search snippets provided. For each axis, score 0.0–1.0 how well the candidate matches, then compute a weighted total. Be honest about mismatches. Exclude the source person themselves and anyone who isn't a real, distinct individual. Every match MUST include at least one real link the user can open (LinkedIn, X, or the source page it came from) — only use a LinkedIn/X URL that actually appears in the snippets; never invent one. Return ONLY JSON.",
    prompt:
      `SOURCE PERSON: ${profile.name}\nSOURCE TRAITS (with weights):\n${JSON.stringify(traits)}\n\n` +
      `CANDIDATE SEARCH RESULTS (raw web snippets — extract the real people from these):\n` +
      `${JSON.stringify(candidates)}\n\n` +
      `Identify the best 3–4 DISTINCT people who share this career DNA. For each, score every source ` +
      `trait axis and compute a weighted overall score. Sort by score descending.\n` +
      `Return: {"matches":[{"name":"","role":"","company":"",` +
      `"linkedin":"LinkedIn URL if in snippets else empty",` +
      `"x":"X/Twitter URL if in snippets else empty",` +
      `"url":"best source URL for this person (always fill this)",` +
      `"arc":"2-3 sentence career arc","score":0.85,` +
      `"axes":[{"axis":"career_arc","score":0.95}, ...],` +
      `"note":"what's similar and what's different"}]}`,
  });
  let matches = (scored.matches || []).slice(0, 4);
  matches.sort((a, b) => (b.score || 0) - (a.score || 0));
  send({ type: "stage", step: "score", state: "done" });
  send({ type: "results", matches });
  send({ type: "status", text: "" });
}

// ── helpers ─────────────────────────────────────────────────────────────────

// Turn whatever the user typed into a verified canonical anchor. The `anchor`
// string is the canonical identifier shown to the model and used by
// verifyAnchor() to detect when the model grounded on the wrong person. The
// `tokens` array is the lowercase fragments we look for in profile URLs to
// confirm the right person came back.
function canonicalize(input) {
  const v = String(input || "").trim();
  if (!v) return { kind: "unknown", url: "", handle: "", anchor: "", tokens: [] };

  // LinkedIn profile URL
  const li = v.match(/linkedin\.com\/in\/([^/?#\s]+)/i);
  if (li) {
    const slug = li[1].toLowerCase();
    return {
      kind: "linkedin",
      url: v.startsWith("http") ? v : `https://www.linkedin.com/in/${slug}/`,
      handle: slug,
      anchor: `linkedin.com/in/${slug}`,
      tokens: [`linkedin.com/in/${slug}`],
    };
  }

  // X/Twitter URL — normalize to x.com
  const xUrl = v.match(/(?:twitter|x)\.com\/(?:#!\/)?(@?\w{1,30})/i);
  if (xUrl) {
    const handle = xUrl[1].replace(/^@/, "").toLowerCase();
    return {
      kind: "x",
      url: `https://x.com/${handle}`,
      handle,
      anchor: `@${handle}`,
      tokens: [`x.com/${handle}`, `twitter.com/${handle}`, `@${handle}`, handle],
    };
  }

  // Bare or @-prefixed X handle. X handles are 1-15 chars, alphanumeric + _.
  // We require at least 3 chars so common English words don't get misclassified.
  if (/^@?\w{3,15}$/.test(v)) {
    const handle = v.replace(/^@/, "").toLowerCase();
    return {
      kind: "x",
      url: `https://x.com/${handle}`,
      handle,
      anchor: `@${handle}`,
      tokens: [`x.com/${handle}`, `twitter.com/${handle}`, `@${handle}`, handle],
    };
  }

  return { kind: "unknown", url: "", handle: "", anchor: v, tokens: [v.toLowerCase()] };
}

// Pull the URL for a given kind out of the anchor list (used to fall back when
// the model didn't return a LinkedIn/X URL even though we know one exists).
function anchorURL(anchors, kind) {
  const hit = anchors.find((a) => a.kind === kind);
  return hit?.url || "";
}

// Two-pronged Exa evidence gathering. /search finds pages that LINK TO each
// anchor URL (podcast guests, Crunchbase, news, conference bios — the pages
// that disambiguate WHICH person owns this handle). /contents extracts the
// anchor pages themselves (X bio, LinkedIn headline). Together they give the
// model enough signal to correctly identify a person from just an X handle.
async function gatherEvidence(env, anchors) {
  const urls = anchors.map((a) => a.url).filter(Boolean);
  // For X handles, two complementary query phrasings ("url form" finds linking
  // pages; "quoted handle" finds tweets/mentions) maximize disambiguators.
  const searchQueries = anchors.flatMap((a) =>
    a.kind === "x"
      ? [a.url, `"@${a.handle}" twitter profile background`]
      : a.url ? [a.url] : []
  );

  const [contents, ...searches] = await Promise.all([
    urls.length ? exaContents(env, urls).catch(() => []) : Promise.resolve([]),
    ...searchQueries.map((q) => exaSearch(env, q).catch(() => [])),
  ]);

  // Merge: anchor-page contents first (highest signal), then search results.
  // Dedup by URL. Cap text length so we don't blow ingest token budget.
  const seen = new Set();
  const merged = [];
  for (const r of [...contents, ...searches.flat()]) {
    const key = (r.url || r.title || "").toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push({ title: r.title, url: r.url, text: (r.text || "").slice(0, 500) });
    if (merged.length >= 10) break;
  }
  return merged;
}

// Did the reconstructed profile actually represent the person the user asked
// about? We treat this as innocent-until-proven-guilty:
//   (a) FAIL if the model returned a URL of the SAME kind as the anchor but
//       pointing to a DIFFERENT handle/slug — that's positive evidence of
//       wrong-person.
//   (b) FAIL if the result is essentially empty (no name + no career) for an
//       X-handle input — strong signal the handle couldn't be resolved at all.
//   (c) Otherwise PASS. Most LinkedIn inputs can never satisfy a positive
//       check because LinkedIn is auth-walled (Exa returns no LinkedIn URLs
//       in evidence), so requiring positive proof produces false positives
//       on every successful LinkedIn lookup.
function verifyAnchor(profile, anchors) {
  const primary = anchors[0];
  if (!primary || primary.kind === "unknown") return true;

  // (a) contradicting URL of the same kind
  for (const a of anchors) {
    if (a.kind === "linkedin" && profile.linkedin) {
      const p = String(profile.linkedin).toLowerCase();
      if (!p.includes(`linkedin.com/in/${a.handle}`)) return false;
    }
    if (a.kind === "x" && profile.x) {
      const p = String(profile.x).toLowerCase();
      const h = a.handle.toLowerCase();
      if (!p.includes(`/${h}`) && !p.includes(`@${h}`)) return false;
    }
  }

  // (b) total resolution failure for X-handle inputs. (LinkedIn can be thin
  // for low-footprint people and still be the right person — don't trip on
  // sparseness alone.)
  if (primary.kind === "x") {
    const hasName = !!(profile.name || "").trim();
    const hasCareer = (profile.career_history || []).some((c) => c?.company);
    if (!hasName && !hasCareer) return false;
  }

  return true;
}

// Coerce + clamp user-provided refine hints. Returns null if nothing usable.
function sanitizeHints(h) {
  if (!h || typeof h !== "object") return null;
  const out = {};
  for (const key of ["full_name", "employer", "known_for", "url"]) {
    const v = String(h[key] || "").trim().slice(0, 200);
    if (v) out[key] = v;
  }
  return Object.keys(out).length ? out : null;
}

// POST /feedback — store quality feedback durably in KV (+ optional webhook).
async function handleFeedback(request, env, cors) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad json" }, 400, cors); }
  const comment = (body.comment || "").trim();
  if (!comment) return json({ error: "empty comment" }, 400, cors);

  // light anti-spam: cap feedback per IP per day
  const ip = request.headers.get("CF-Connecting-IP") || "anon";
  const day = new Date().toISOString().slice(0, 10);
  const fbKey = `fbc:${ip}:${day}`;
  const n = parseInt((await env.RL.get(fbKey)) || "0", 10);
  if (n >= 30) return json({ error: "rate_limited" }, 429, cors);
  await env.RL.put(fbKey, String(n + 1), { expirationTtl: 60 * 60 * 36 });

  const record = {
    ts: new Date().toISOString(),
    ip,
    input: String(body.input || "").slice(0, 300),
    target: String(body.target || "").slice(0, 120),   // 'source' or a match name
    comment: comment.slice(0, 2000),
  };
  await env.RL.put(
    `fb:${record.ts}:${Math.random().toString(36).slice(2, 8)}`,
    JSON.stringify(record),
    { expirationTtl: 60 * 60 * 24 * 120 } // keep 120 days
  );
  if (env.FEEDBACK_WEBHOOK) {
    // Slack incoming webhooks need a {text|blocks} payload; everything else
    // (Make/Zapier/etc.) accepts the raw record.
    const isSlack = env.FEEDBACK_WEBHOOK.includes("hooks.slack.com");
    const payload = isSlack ? slackMessage(record) : record;
    try {
      await fetch(env.FEEDBACK_WEBHOOK, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch { /* non-fatal */ }
  }
  return json({ ok: true }, 200, cors);
}

// Forward a search request to Slack (#hack-central) for analytics. Reuses the
// existing FEEDBACK_WEBHOOK (both go to #hack-central); set SEARCH_WEBHOOK only
// to split them. A no-op if neither is set. Runs in the background via
// waitUntil so it never blocks or breaks the response.
function notifySearch(env, ctx, { input, ip, day, remaining, hints, isRefine }) {
  const webhook = env.SEARCH_WEBHOOK || env.FEEDBACK_WEBHOOK;
  if (!webhook) return;
  const lines = [
    isRefine ? ":repeat: *User refined a search*" : ":mag_right: *New Lookalike search*",
    `*Searched:* \`${String(input).slice(0, 300)}\``,
  ];
  if (hints) lines.push(`*Hints:* \`${JSON.stringify(hints).slice(0, 400)}\``);
  lines.push(`_${new Date().toISOString()} · IP ${ip} · ${remaining} left today_`);
  postWebhook(ctx, webhook, { text: lines.join("\n") });
}

// Fire when the reconstructed profile didn't reference the anchor. Lets us see
// exactly which inputs the resolver is failing on — closes the feedback loop
// in real time without waiting for the user to submit anything.
function notifyAnchorMiss(env, ctx, { input, anchor, ip, day, profile }) {
  const webhook = env.SEARCH_WEBHOOK || env.FEEDBACK_WEBHOOK;
  if (!webhook) return;
  postWebhook(ctx, webhook, {
    text: [
      ":warning: *Anchor not verified*",
      `*Searched:* \`${String(input).slice(0, 300)}\``,
      `*Expected anchor:* \`${anchor}\``,
      `*Model returned:* \`${String(profile?.name || "—").slice(0, 120)}\` ${profile?.linkedin ? `(${profile.linkedin})` : ""} ${profile?.x ? `(${profile.x})` : ""}`.trim(),
      `_${new Date().toISOString()} · IP ${ip}_`,
    ].join("\n"),
  });
}

// Fire-and-forget Slack/webhook POST via ctx.waitUntil so it never blocks the
// pipeline. Shared by all notify* helpers.
function postWebhook(ctx, webhook, payload) {
  const post = fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => {/* non-fatal */});
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(post);
}

// Format a feedback record as a Slack mrkdwn message.
function slackMessage(r) {
  return {
    text: [
      ":mag: *New Lookalike Finder feedback*",
      `*On:* ${r.target || "—"}`,
      `*Searched:* \`${r.input || "—"}\``,
      `*Comment:* ${r.comment}`,
      `_${r.ts} · IP ${r.ip}_`,
    ].join("\n"),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One LLM call via OpenRouter (OpenAI-compatible chat completions), returning
// parsed JSON. `web: true` attaches the web plugin for the ingestion step.
async function llmJSON(env, { model, max_tokens, system, prompt, web, notify, temperature }) {
  const maxAttempts = 4;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        // Optional attribution headers for OpenRouter's dashboard/rankings.
        "HTTP-Referer": "https://canonical.cc/labs/lookalike",
        "X-Title": "Canonical Lookalike Finder",
      },
      body: JSON.stringify({
        model,
        max_tokens,
        // Low temperature on factual steps reduces creative gap-filling.
        ...(temperature != null ? { temperature } : {}),
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
        // Ask for JSON; harmless if a model ignores it (extractJSON is the backstop).
        ...(web ? { plugins: [WEB_PLUGIN] } : { response_format: { type: "json_object" } }),
      }),
    });

    // 429 (rate limit) / 502 / 503 / 529 (overloaded): wait and retry.
    if ([429, 502, 503, 529].includes(res.status) && attempt < maxAttempts) {
      const ra = parseInt(res.headers.get("retry-after") || "", 10);
      const wait = Math.min(60, Number.isFinite(ra) && ra > 0 ? ra : 10 * attempt);
      if (notify) notify(`Model is rate-limited/busy — pausing ${wait}s, then retrying…`);
      await sleep(wait * 1000);
      continue;
    }
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`OpenRouter ${res.status}: ${t.slice(0, 200)}`);
    }
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || "";
    return extractJSON(text);
  }
}

async function exaSearch(env, query) {
  const res = await fetch(EXA_SEARCH_URL, {
    method: "POST",
    headers: { "x-api-key": env.EXA_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({
      query,
      type: "auto",
      numResults: 6,
      contents: { text: { maxCharacters: 500 } },
    }),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.results || [];
}

// Fetch the page text behind one or more URLs (Exa scrapes + extracts). Used
// to pull the X profile bio or LinkedIn headline directly during ingest — the
// single highest-signal piece of evidence for confirming who the user meant.
async function exaContents(env, urls) {
  const res = await fetch(EXA_CONTENTS_URL, {
    method: "POST",
    headers: { "x-api-key": env.EXA_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({
      urls,
      text: { maxCharacters: 1200 },
    }),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.results || [];
}

function extractJSON(text) {
  // strip code fences and pull the first balanced {...}
  const cleaned = text.replace(/```json|```/g, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("Model returned no JSON");
  return JSON.parse(cleaned.slice(start, end + 1));
}

function corsHeaders(origin, env) {
  const allow = env.ALLOWED_ORIGIN || "*";
  const ok = allow === "*" || allow.split(",").map((s) => s.trim()).includes(origin);
  return {
    "Access-Control-Allow-Origin": ok ? (allow === "*" ? "*" : origin) : allow.split(",")[0].trim(),
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
