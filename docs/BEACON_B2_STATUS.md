# Beacon B2 — checkpoint 2026-11-06 (feat/backblaze-b2)

## Code
- Fork: https://github.com/rommm13/beacon-b2 (fork of synertek-cloud-services/beacon, history kept)
- Branch: `feat/backblaze-b2` — NOT merged to main (merge only after B2 + agent tests pass)
- Commits: f1d6bcd (B2 adapter) → 4ff57d6 (deploy config + MCP adapter doc) →
  e8fe2a7 (CI fix) → af330d7 (deploy config fix). CI green on af330d7.
- R2 bindings optional; B2 preferred via `resolveStorage` (SigV4, streaming, multipart).
  Auth checks on all routes preserved; one-time grant marking kept (presigned-URL
  hardening is a planned follow-up, see docs/CHATGPT_MCP_ADAPTER.md).

## Cloudflare (account fb1f75755339a977049e6428dbfc25e4, shelekhovrd@gmail.com)
- Worker: https://beacon-b2-api.iddqd777.workers.dev (version a6972c6f), `GET /health` → `{"ok":true}`
- D1 `beacon-pilot` (aa33fd74-e80a-4dba-8cb3-9a3e54621a39): 86 migrations applied, 65 tables
- Durable Object `SESSION` (SessionRelay) bound; cron `*/2 * * * *`
- Pages: https://beacon-b2-dashboard.pages.dev (Production, source af330d7)
- Secrets in Worker: ADMIN_SECRET, CONFIG_ENCRYPTION_KEY (break-glass copy at
  `C:\Users\Roman\.beacon-b2-secrets\deploy.secrets`, outside repo, gitignored)
- B2 vars are PLACEHOLDERS — file/storage routes fail until B2 is connected (expected)
- Nothing else touched: other Workers/D1s/routes unchanged

## Blocked — needs Roman
1. Backblaze B2 account: browser signup hits `ERR_QUIC_PROTOCOL_ERROR` on
   secure.backblaze.com from ego-browser (curl works, page loads slowly).
   Create manually: https://www.backblaze.com/sign-up/s3 (no card) →
   region EU Central if offered → private bucket `rommm13-beacon-storage` →
   app key scoped to that bucket (read/write/list/delete) →
   `wrangler secret put` B2_APPLICATION_KEY_ID / B2_APPLICATION_KEY
   (never paste keys in chat) → tell me, I update endpoint/bucket vars + redeploy + test.
2. Admin bootstrap: open Pages URL → Emergency administrator access (break-glass
   secret from the file above) → create admin user → sign out of emergency.
3. Agent install: ON HOLD until server + B2 verified and v0.4.0 binary signature
   checked. No agent installed; Defender/SmartScreen untouched; no reboot.

## Not done (honest)
- ChatGPT → MCP → Beacon → Agent path NOT verified (adapter is a design doc only).
- Lifecycle rules / quota alerts / backup runbook pending B2 bucket existence.
- No merge to main, no tag yet.
