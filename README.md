# Canonical Labs — Lookalike Finder

Paste a LinkedIn URL or X handle → get 3–4 people with similar **career DNA**
(trajectory, archetype, rare skill combos), not just the same job title.

Lives at **`canonical.cc/labs/lookalike`**. Same aesthetic as the other labs
(navy gradient, Aeonik, white cards, electric-blue / pale-blue glow accents).

## How it works

```
 Browser (static, GitHub Pages)              Cloudflare Worker (holds keys)
 ┌────────────────────────────┐   POST       ┌────────────────────────────────┐
 │ paste URL → Find Lookalikes │ ──/lookalike→│ rate-limit 3 / IP / day (KV)   │
 │ live stepper + match cards  │ ←─ SSE ──────│ 1 ingest    CHEAP model + web  │
 └────────────────────────────┘              │ 2 traits    STRONG model       │
                                              │ 3 queries   CHEAP model        │
                                              │ 4 retrieve  Exa neural search  │
                                              │ 5 score     STRONG model       │
                                              └────────────────────────────────┘
```

**Hybrid models, both via OpenRouter** (one key, and no per-org token-rate-limit
tiers to trip over):

- **CHEAP** model (`MODEL_CHEAP`, default `google/gemini-2.5-flash`) → the
  mechanical steps: profile structuring (using OpenRouter's web plugin to
  reconstruct from the open web) + search-query generation.
- **STRONG** model (`MODEL_STRONG`, default `anthropic/claude-sonnet-4.5`) → the
  reasoning steps: trait extraction + candidate scoring.
- **Exa** = neural candidate retrieval.
- Both API keys (OpenRouter + Exa) live **only** in the Worker as secrets — never
  in the static page. 3 lookups per IP per UTC day keeps the lab free to run.

## Layout

```
site/        → static page, deploy to /labs/lookalike/ (index.html, style.css, app.js)
worker/      → Cloudflare Worker (src/worker.js, wrangler.toml)
```

---

## Deploy — Part 1: the Worker (holds the keys)

You need a (free) Cloudflare account, an OpenRouter API key, and an Exa API key.

```bash
cd worker
npm install -g wrangler        # if you don't have it
wrangler login

# 1. Create the KV namespace for rate limiting, then paste the printed id
#    into wrangler.toml ([[kv_namespaces]] id = "...").
wrangler kv namespace create RL

# 2. Store your two API keys as encrypted secrets (you'll be prompted to paste).
wrangler secret put OPENROUTER_API_KEY
wrangler secret put EXA_API_KEY

# 3. Ship it.
wrangler deploy
```

`wrangler deploy` prints the Worker URL, e.g.
`https://lookalike.<your-subdomain>.workers.dev`. Copy it.

**Spend safety:** set a credit/spend limit in your OpenRouter account and on Exa.
The 3/day/IP throttle bounds abuse, but a hard cap is your real backstop.

## Deploy — Part 2: the static page (GitHub Pages)

1. In **`site/app.js`**, set `ENDPOINT` to your Worker URL from above:
   ```js
   const ENDPOINT = "https://lookalike.<your-subdomain>.workers.dev";
   ```
2. Copy the contents of `site/` into your canonical.cc Pages repo at
   `labs/lookalike/` (so it serves at `canonical.cc/labs/lookalike/`).
3. Add the lab to the carousel on the home page — same markup as the others:
   ```html
   <a href="/labs/lookalike/" class="lab-card flex-shrink-0">
     <h3 class="lab-card-title">Lookalike Finder</h3>
     <p class="lab-card-description">
       Paste a LinkedIn URL or X handle and find people with the same career
       DNA — trajectory and archetype, not just job title.
     </p>
     <span class="lab-card-cta">Try it &rarr;</span>
   </a>
   ```
4. Push. Done.

After it's live, lock the Worker to the production origin in `wrangler.toml`:
```toml
ALLOWED_ORIGIN = "https://canonical.cc"
```
then `wrangler deploy` again.

---

## Local testing

Copy the template to `worker/.dev.vars` (gitignored) and fill in your keys:

```bash
cd worker && cp .dev.vars.example .dev.vars   # then edit .dev.vars with real keys
```

Then run both servers:

```bash
cd worker && npx wrangler dev          # Worker at http://localhost:8787
cd site   && python3 -m http.server 8000   # page at http://localhost:8000
```

Open **http://localhost:8000/** — the page auto-targets `localhost:8787` when
served from localhost, so no `?api=` needed (you can still pass `?api=<url>` to
point elsewhere).

## Tuning

| What | Where |
|------|-------|
| Daily lookups per IP | `DAILY_LIMIT` in `wrangler.toml` |
| Cheap model (structuring, query-gen) | `MODEL_CHEAP` in `wrangler.toml` |
| Strong model (traits, scoring) | `MODEL_STRONG` in `wrangler.toml` |
| Allowed origins | `ALLOWED_ORIGIN` (comma-separated) |
| # Exa queries / results | `queries.slice(0, 5)` and `numResults` in `worker.js` |
| Feedback alerts | optional `FEEDBACK_WEBHOOK` secret — POSTs each submission to a Slack/Make/Zapier webhook |
| Search analytics | every search forwarded to Slack; reuses `FEEDBACK_WEBHOOK` (`#hack-central`), or set `SEARCH_WEBHOOK` to split channels |

**Feedback:** every profile (the searched person *and* each result) has a
"Feedback" affordance. Submissions hit `POST /feedback` and are stored in KV under
`fb:<timestamp>:<rand>` for 120 days. Set a `FEEDBACK_WEBHOOK` secret
(`wrangler secret put FEEDBACK_WEBHOOK`) to also forward each one to a webhook.
Read them back later with `wrangler kv key list` / `get` on the `RL` namespace.

**Search analytics:** every search request is forwarded to Slack (the searched
input, IP, and remaining daily quota). By default it reuses the existing
`FEEDBACK_WEBHOOK` (which posts to `#hack-central`), so no extra setup is needed.
Set a separate `SEARCH_WEBHOOK` secret only if you want searches in a different
channel. It's fire-and-forget — if the webhook is unset or fails, the lookup is
unaffected. Three Slack event types fire to the same channel:
- `:mag_right:` *New Lookalike search* — initial searches
- `:warning:` *Anchor not verified* — the reconstructed profile didn't reference
  the input handle/URL (i.e. we likely picked the wrong person — see below)
- `:repeat:` *User refined a search* — user clicked "Wrong person?" and resubmitted
  with structured hints; includes the hints

**X-handle hardening + refine flow.** An X handle alone is ambiguous: bare tokens
don't search well, and many real people share names. The ingest step defends
against this in three layers:

1. **Canonicalize the input** up front (`@handle` → `https://x.com/<handle>`).
2. **Two-pronged Exa evidence:** in parallel, `/search` neural over the
   canonical URL (finds pages that *link to* the profile — Crunchbase, podcast
   guest pages, news) AND `/contents` on the URL itself (extracts the X bio /
   LinkedIn headline directly). Together these give the model real grounding.
3. **Anchor verification:** after ingest, the worker checks whether the
   reconstructed profile actually references the input handle/URL (via the
   model's `source` fields and the `linkedin`/`x` URLs). If not, it emits
   `anchor_unverified` over the SSE stream — the page auto-opens a refine
   modal asking for any name / employer / "known for" / URL the user can give
   us. Submitting re-runs the search with those hints as highest-priority
   ground truth.

Refines bypass the main daily quota but are capped separately at 3/IP/day
(`rl:refine:<ip>:<day>` in KV), so a user can always recover from a wrong
match even when their main quota is spent.

Any [OpenRouter model slug](https://openrouter.ai/models) works for either tier
— e.g. `deepseek/deepseek-chat` (cheaper), `google/gemini-2.5-pro` or
`openai/gpt-5` (stronger scoring).

## Security

- **No secrets live in this repo.** The only keys are the OpenRouter and Exa keys,
  which exist only as (a) Cloudflare Worker secrets set via `wrangler secret put`
  in production, or (b) your local `worker/.dev.vars`, which is **gitignored**.
- `.dev.vars.example` is the committed template (placeholders only). Never put a
  real key in any tracked file — not `wrangler.toml`, not the frontend, nowhere.
- The static page ships **zero** keys: it only knows the Worker URL. All key-bearing
  calls (OpenRouter, Exa) happen server-side in the Worker.
- If a key is ever exposed, rotate it: OpenRouter dashboard → revoke/reissue, and
  Exa dashboard → roll the key, then `wrangler secret put` the new values.

## Notes & limitations

- LinkedIn is auth-walled, so ingestion reconstructs the profile from the open
  web (personal sites, podcasts, Crunchbase, news) — mirroring the manual method.
  Public figures resolve well; low-footprint people may come back thin.
- Quality scales with the source person's web presence and Exa's coverage.
- Each lookup is ~4 model calls (2 cheap + 2 strong) + ~5 Exa searches. Budget
  accordingly; OpenRouter bills per token across both tiers.
