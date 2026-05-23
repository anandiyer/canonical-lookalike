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

- [ ] `node --check` on worker.js and app.js
- [ ] Smoke: curl `/lookalike` with an X handle, confirm `anchor_unverified`
      fires when ingest doesn't reference the handle
- [ ] Smoke: curl `/lookalike` with hints, confirm RL bypass and prompt
      wiring (look for `USER HINTS:` in worker logs / dry-run)
- [ ] Visual: confirm modal renders + opens from results panel

## Deploy

- [ ] `wrangler deploy`
- [ ] Sync `site/` files to anandiyer.github.io `labs/lookalike/`
- [ ] Bump `?v=` query on app.js/style.css to bust Cloudflare edge cache
- [ ] Commit + push both repos

## Review

(to be filled in after implementation)
