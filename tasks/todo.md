# X-handle hardening + interactive refine — build plan

Many X handles fail today because the bare handle gets shipped to Exa as a
neural query and the model has no anchor. This update fixes the ingest at the
root (system-driven prevention) and adds a "Wrong person? Refine" recovery
affordance (user-driven correction) — bundled as one deploy.

## Worker (`worker/src/worker.js`)

- [x] `canonicalize(input)` helper → `{kind, url, handle, anchor}` for
      `linkedin | x | unknown`. Replaces `describeTarget` callers.
- [x] `exaContents(env, urls)` helper → POST `/contents`, returns the same
      `{title,url,text}` shape so it merges cleanly with `exaSearch` results.
- [x] Two-pronged evidence in ingest: `exaSearch(URL form)` + `exaContents(URL)`
      in parallel, dedup by URL, slice 8.
- [x] Anchor-aware ingest prompt: system clause + `ANCHOR (verified):` line in
      the user message. Optional `USER HINTS:` block when present.
- [x] Anchor verification after ingest: scan profile source URLs + `x` +
      `linkedin` for the anchor; emit `anchor_unverified` SSE flag + Slack ping.
- [x] Accept `hints: {full_name, employer, known_for, url}` in request body.
      Hints pass through to ingest prompt; URL hint joins the anchor list.
- [x] RL bypass for hint-bearing requests: separate counter `RL:refine:<ip>:<day>`
      capped at 3/day, doesn't decrement the main quota.
- [x] `notifySearch` includes hints when present.

## Frontend (`site/`)

- [x] `index.html`: refine modal markup; "Wrong person?" button slot on results.
- [x] `style.css`: modal styles (matches existing card aesthetic).
- [x] `app.js`: refine button on results, modal open/close, refine submit reuses
      the same SSE flow with `hints` populated; auto-open on `anchor_unverified`.

## Docs

- [x] `README.md`: short section documenting the refine flow + X-handle hardening.

## Verify

- [x] `node --check` on worker.js and app.js — both parse
- [x] Smoke-tested `canonicalize()` against 10 input variants (URLs, handles,
      edge cases) — all classify correctly
- [x] Live smoke: POST `/lookalike` with a gibberish handle + hints body —
      `anchor_unverified` event fired correctly; main quota untouched (refine
      RL counter used instead)

## Deploy

- [x] Source repo: committed (`7ff94b9`) + pushed to `main`
- [x] Worker: `wrangler deploy` → version `cfcb1c96-bcf4-4220-abe0-bb8f9e01d3ad`
      live at `labs-api.canonical.cc`
- [x] Site files synced to `anandiyer.github.io/labs/lookalike/`,
      committed (`33a785b`) + pushed to `master`
- [x] Asset cache busted to `?v=20260523`
- [x] Pages deploy completed successfully (run `26338901624`)
- [x] Confirmed live page serves the new markup (anchor-warning + refine-modal)

## Review

**What shipped:** the bundled X-handle hardening + refine flow, deployed
end-to-end. The root-cause bug (passing the bare handle to Exa as a neural
query) is fixed by canonicalizing input → `https://x.com/<handle>` and running
two-pronged evidence (`/search` for linking pages + `/contents` for the bio).
The model is now told to anchor on the canonical URL/handle. When it fails
to anchor, the user gets an interactive recovery path instead of a Slack
ping we can't act on.

**Closed feedback loop:** every search posts to `#hack-central`. New event
types `:warning: Anchor not verified` and `:repeat: User refined a search`
mean we now see the exact failure mode in real time AND see what the user
*meant* when they refined.

**Cost added per lookup:** ~$0.006 (one extra Exa `/contents` call + an
extra `/search` query for X handles). Latency: ~1–2s added to ingest (parallel).

**Followups worth tracking:**
- Confidence-aware checkpoint (the v2 architecture we deferred) — wait a week
  of Slack data to see if `anchor_unverified` rate justifies the friction
  trade-off.
- Refine analytics: count refines vs initial searches per day → KPI for the
  resolver. If <10% of X-handle searches refine, the hardening is sufficient.
