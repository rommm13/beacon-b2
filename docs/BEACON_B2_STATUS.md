# Beacon B2 — checkpoint 2026-11-06 (feat/backblaze-b2)

## Code
- Fork: https://github.com/rommm13/beacon-b2 (fork of synertek-cloud-services/beacon, history kept)
- Branch: `feat/backblaze-b2` — NOT merged to main (merge only after B2 + agent tests pass)
- Commits: f1d6bcd (B2 adapter) → 4ff57d6 (deploy config + MCP adapter doc) →
  e8fe2a7 (CI fix) → af330d7 (deploy config fix) → d8ae3c0 (docs: B2 connected) →
  fix: exec anti-replay via json_extract (D1 rejects long LIKE patterns). CI green on af330d7.
- R2 bindings optional; B2 preferred via `resolveStorage` (SigV4, streaming, multipart).
  Auth checks on all routes preserved; one-time grant marking kept (presigned-URL
  hardening is a planned follow-up, see docs/CHATGPT_MCP_ADAPTER.md).

## Cloudflare (account fb1f75755339a977049e6428dbfc25e4, shelekhovrd@gmail.com)
- Worker: https://beacon-b2-api.iddqd777.workers.dev (version a6972c6f), `GET /health` → `{"ok":true}`
- D1 `beacon-pilot` (aa33fd74-e80a-4dba-8cb3-9a3e54621a39): 86 migrations applied, 65 tables
- Durable Object `SESSION` (SessionRelay) bound; cron `*/2 * * * *`
- Pages: https://beacon-b2-dashboard.pages.dev (Production, source af330d7)
- Secrets in Worker: ADMIN_SECRET, CONFIG_ENCRYPTION_KEY, B2_KEY_ID,
  B2_APPLICATION_KEY_ID, B2_APPLICATION_KEY, CHATGPT_ADAPTER_KEY (break-glass +
  adapter copies at `C:\Users\Roman\.beacon-b2-secrets\`, outside repo, gitignored)
- B2 vars are LIVE (eu-central-003, bucket rommm13-beacon-storage) — redeployed
- Nothing else touched: other Workers/D1s/routes unchanged

## B2 — connected 2026-11-06 (EU, no card)
- Account `a83786628@gmail.com` (id `85dfc0be90b0`), email-verified at login.
  Login notes: direct path to secure.backblaze.com trickles (~30 B/s, unusable);
  everything went through local proxy 127.0.0.1:12334 + internal B2 session API
  (`b2_create_session` → password `b2_present_credentials` → email-code
  `b2_present_credentials`). Password file deleted after use.
- Bucket `rommm13-beacon-storage` (allPrivate, SSE-B2, S3-enabled),
  region **eu-central-003**, `https://s3.eu-central-003.backblazeb2.com`.
- Single-bucket layout: `branding/` logos, `components/` + `rustdesk-installer/`
  files, `sessions/` transfers. Worker `B2Storage` supports `B2_PREFIX`.
- App key `beacon-worker-b2`, bucket-scoped: listFiles/readFiles/writeFiles/
  deleteFiles. Material in protected storage + Worker secrets only.
- Lifecycle: `sessions/` hide 1d → delete 1d after hide; unfinished-multipart
  cancel 1d globally. No lifecycle on `components/`: B2 can't tell live from
  superseded versions, hiding would 404 live installers — cleanup is explicit
  in app code. Deliberate deviation, documented.
- Usage: 0 bytes. Free tier 10 GB / upload free / egress free ≤3x stored avg.
  No hard server-side cap in B2 — check usage manually, consider a daily Cap
  in the B2 web UI.
- Verified: direct S3 PUT 200 / GET identical / HEAD 200 / DELETE 204 /
  GET-after-delete 404; E2E via Worker (break-glass): logo upload 201 →
  download 200 identical → delete 200 → GET 404, DB clean. Adapter live:
  `/v1/chatgpt/status` 200, `/v1/chatgpt/devices` 200 `[]`.

## Blocked — needs Roman
1. ~~B2 account~~ DONE (see B2 section above; login password file deleted).
2. Admin bootstrap: open Pages URL → Emergency administrator access (break-glass
   secret from `C:\Users\Roman\.beacon-b2-secrets\deploy.secrets`) → create
   admin user with YOUR password → sign out of emergency.
3. Agent install: server + B2 verified; next is upstream v0.4.0 binary check
   (SHA-256 + Ed25519) then install with autostart. Say the word.

## Agent on Honor — installed 2026-11-06
- Desktop `install-honor-beacon.cmd` (self-elevating) ran by Roman; UAC consent given.
- Service `BeaconAgent` ("Beacon RMM Agent"), Running, Automatic; agent 0.4.0;
  tray running in user session; install dir `C:\Program Files\Beacon`,
  state `C:\ProgramData\Beacon` (agent.log, credential.json).
- Enrolled + approved: device `c6fff44a-8171-4379-a535-2f6122d5ca05`,
  company "Honor" (`27eb7071-…`), host DESKTOP-QHVKN2K, Win 11 Pro 26300.9818.
- Check-ins live: inventory flows (CPU/mem/disk/Defender). Network note:
  direct Cloudflare connectivity from this laptop is flaky (intermittent
  `wsarecv` timeouts in agent.log), but check-ins get through on retry;
  same IP works instantly via local proxy 127.0.0.1:12334.

## E2E exec round-trip — verified 2026-11-06 (first real device)
- POST `/v1/chatgpt/exec` phase 1 → confirm_id; phase 2 (confirm) → command
  `9fb73624-…` queued → agent picked it up on next check-in (fast-poll),
  executed `run_script` PowerShell, exit 0, stdout stored in
  `commands.result`, status `completed` (verified in D1 + agent.log).
- Replay of the spent confirm_id correctly rejected 409.
- Bug found & fixed en route: exec anti-replay used
  `LIKE '%"adapter_nonce":"<uuid>"%'` on `commands.payload`; D1 fails that
  with `LIKE or GLOB pattern too complex` (500 on every confirmed exec).
  Replaced with `json_extract(payload,'$.adapter_nonce') = nonce` (exact
  match, indexable, stronger). Deployed as version e5686e42.

## Not done (honest)
- Cloudflare MCP is not connected in current OpenCode sessions — Worker
  tail/deploys done via wrangler CLI + OAuth token (refresh works).
- Quota alerts / backup runbook: manual checks for now (B2 has no hard caps).
- No merge to main, no tag yet.
- Agent↔Cloudflare network flakiness on the Honor laptop not root-caused
  (retry mask it for check-ins; could delay command pickup by ~1-2 min).
