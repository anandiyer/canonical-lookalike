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
const EXA_URL = "https://api.exa.ai/search";
// OpenRouter web plugin for the ingestion step (replaces Claude's built-in
// web_search). Few results keeps token volume — and cost — low.
const WEB_PLUGIN = { id: "web", max_results: 3 };

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env);

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const url = new URL(request.url);
    if (request.method !== "POST") return json({ error: "POST only" }, 405, cors);
    if (url.pathname === "/feedback") return handleFeedback(request, env, cors);
    if (url.pathname !== "/lookalike") return json({ error: "not found" }, 404, cors);

    // ── rate limit: N lookups per IP per UTC day ────────────────────────
    const limit = parseInt(env.DAILY_LIMIT || "3", 10);
    const ip = request.headers.get("CF-Connecting-IP") || "anon";
    const day = new Date().toISOString().slice(0, 10);
    const rlKey = `rl:${ip}:${day}`;
    const used = parseInt((await env.RL.get(rlKey)) || "0", 10);
    if (used >= limit)
      return json(
        { error: "rate_limited", resetHint: "your quota resets at midnight UTC" },
        429,
        cors
      );

    let body;
    try { body = await request.json(); } catch { return json({ error: "bad json" }, 400, cors); }
    const input = (body.input || "").trim();
    if (!input) return json({ error: "missing input" }, 400, cors);

    // count this lookup up front (prevents abuse via aborted requests)
    await env.RL.put(rlKey, String(used + 1), { expirationTtl: 60 * 60 * 36 });
    const remaining = Math.max(0, limit - (used + 1));

    // ── stream the pipeline ─────────────────────────────────────────────
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const enc = new TextEncoder();
    const send = (obj) => writer.write(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));

    runPipeline({ input, env, send, remaining })
      .catch((err) => send({ type: "error", message: String(err.message || err) }))
      .finally(() => writer.close());

    return new Response(readable, {
      headers: { ...cors, "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" },
    });
  },
};

// ── pipeline ───────────────────────────────────────────────────────────────
async function runPipeline({ input, env, send, remaining }) {
  send({ type: "quota", remaining });
  // Hybrid: cheap model for mechanical steps, strong model for reasoning.
  const CHEAP = env.MODEL_CHEAP || "google/gemini-2.5-flash";
  const STRONG = env.MODEL_STRONG || "anthropic/claude-sonnet-4.5";
  const notify = (m) => send({ type: "status", text: m });

  // 1 — ingest + structure profile  (CHEAP + web plugin)
  send({ type: "stage", step: "ingest", state: "active" });
  send({ type: "status", text: "Reading the open web to reconstruct the profile…" });
  const target = describeTarget(input);
  const profile = await llmJSON(env, {
    model: CHEAP,
    web: true,
    max_tokens: 2200,
    notify,
    system:
      "You are a meticulous people-research analyst. Use web results to reconstruct a person's full professional profile from public sources (personal site, company pages, podcasts, conference bios, Crunchbase, news). LinkedIn itself is usually auth-walled — reconstruct from everything around it. Capture their LinkedIn and X/Twitter profile URLs if you find them. Return ONLY a JSON object, no prose.",
    prompt:
      `Reconstruct the professional profile for this person: ${target}\n\n` +
      `Return JSON with this exact shape:\n` +
      `{"name":"","current_role":"","current_company":"","company_description":"","location":"",` +
      `"education":[{"school":"","degree":"","field":""}],` +
      `"career_history":[{"company":"","role":"","domain":""}],` +
      `"background_signals":[""],` +
      `"linkedin":"full LinkedIn URL if known else empty",` +
      `"x":"full X/Twitter URL if known else empty",` +
      `"arc":"3-4 sentence narrative of their career arc"}`,
  });
  send({ type: "stage", step: "ingest", state: "done" });

  // 2 — trait extraction  (STRONG — the key reasoning step)
  send({ type: "stage", step: "traits", state: "active" });
  send({ type: "status", text: "Distilling the traits that make this person distinctive…" });
  const traitsObj = await llmJSON(env, {
    model: STRONG,
    max_tokens: 1200,
    notify,
    system:
      "You extract the DEFINING dimensions of a professional archetype — the rare, distinctive axes, not generic job attributes. Return ONLY JSON.",
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
      linkedin: profile.linkedin || sourceLink(input, "linkedin"),
      x: profile.x || sourceLink(input, "x"),
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
function describeTarget(input) {
  if (/linkedin\.com\/in\//i.test(input)) {
    const slug = input.replace(/\/+$/, "").split("/in/")[1]?.split(/[/?]/)[0] || input;
    return `the person at LinkedIn URL ${input} (handle/slug "${slug}")`;
  }
  if (/^@?\w+$/.test(input)) return `the person with X/Twitter handle ${input.replace(/^@?/, "@")}`;
  if (/(twitter|x)\.com\//i.test(input)) return `the person at this X/Twitter profile: ${input}`;
  return input;
}

// Best-effort source profile link derived from whatever the user typed.
function sourceLink(input, kind) {
  const v = (input || "").trim();
  if (kind === "linkedin") return /linkedin\.com\/in\//i.test(v) ? v : "";
  if (kind === "x") {
    if (/(twitter|x)\.com\//i.test(v)) return v;
    if (/^@?\w{1,30}$/.test(v)) return `https://x.com/${v.replace(/^@/, "")}`;
  }
  return "";
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
    try {
      await fetch(env.FEEDBACK_WEBHOOK, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(record),
      });
    } catch { /* non-fatal */ }
  }
  return json({ ok: true }, 200, cors);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One LLM call via OpenRouter (OpenAI-compatible chat completions), returning
// parsed JSON. `web: true` attaches the web plugin for the ingestion step.
async function llmJSON(env, { model, max_tokens, system, prompt, web, notify }) {
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
  const res = await fetch(EXA_URL, {
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
