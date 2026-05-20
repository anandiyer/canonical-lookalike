# Lookalike Finder — build plan

Lab tool for canonical.cc/labs/lookalike. Paste a LinkedIn URL or X handle → 3–4 people
with similar career DNA, scored on trait axes. Static page on GitHub Pages + Cloudflare
Worker proxy holding Claude + Exa keys, rate-limited 3 lookups/IP/day.

## Architecture
- **Frontend** (`site/`): vanilla HTML/CSS/JS, deploys to `/labs/lookalike/`. Exact
  canonical.cc aesthetic (navy gradient, Aeonik, white cards, electric-blue + pale-blue
  glow accents). Mirrors the dilutionlab folder pattern.
- **Worker** (`worker/`): Cloudflare Worker. One `POST /lookalike` SSE endpoint runs the
  7-step pipeline server-side. Holds `ANTHROPIC_API_KEY` + `EXA_API_KEY` as secrets.
  KV-backed rate limit 3/IP/day.

## Pipeline (server-side, streamed as SSE stages)
1. Ingest + structure profile — Claude w/ web_search → structured JSON (PRD schema)
2. Trait extraction — Claude → trait axes w/ weights
3. Query generation — Claude → neural Exa queries
4. Candidate retrieval — Exa neural search, dedup
5. Score + rank — Claude (w/ web_search enrich) → top 3–4 w/ axis scores + match notes
6. Stream result cards to UI

## Tasks
- [ ] `site/style.css` — canonical design tokens + lookalike components
- [ ] `site/index.html` — page shell, input, stepper, results, key/limit states
- [ ] `site/app.js` — submit, SSE parse, render stepper + profile + trait chips + cards
- [ ] `worker/src/worker.js` — pipeline, Claude/Exa calls, SSE, rate limit, CORS
- [ ] `worker/wrangler.toml` — config + KV binding
- [ ] `README.md` — deploy steps (Worker secrets, KV, GH Pages, endpoint wiring)
- [ ] Verify: lint/parse, walk through flow, confirm aesthetic matches canonical.cc

## Review
- [x] All 6 files built. `site/` (static page) + `worker/` (Cloudflare Worker) + README.
- [x] `node --check` passes on app.js and worker.js (worker as ESM).
- [x] Headless-Chrome screenshot confirms exact canonical.cc aesthetic (gradient,
      Aeonik, white cards, pale-blue glow accents, light section titles).
- Pipeline runs server-side in the Worker, streamed as SSE: ingest → traits →
  queries → retrieve → score. Claude does reasoning + enrichment search; Exa does
  neural candidate retrieval. Rate-limited 3/IP/day via KV.
- **What's verified vs. not:** static shell + design are proven. The live pipeline
  can only be exercised after the user deploys the Worker with their own Anthropic
  + Exa keys (that part is theirs — keys never touch this session). README has the
  full deploy runbook.
- **User TODO before live:** set KV id + secrets, `wrangler deploy`, set `ENDPOINT`
  in app.js to the Worker URL, drop `site/` into Pages at `labs/lookalike/`, add the
  lab-card to the home carousel.
