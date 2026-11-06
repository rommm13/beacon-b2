-- ChatGPT task bridge (gpt_tasks).
-- ChatGPT writes/reads THIS table via the Cloudflare D1 API; the worker is the
-- only component that may translate a row into a real Beacon command. ChatGPT
-- has raw D1 access, so approval state that the worker must trust never lives
-- in a plain column here -- it is carried in an HMAC token issued out-of-band
-- (see worker/src/lib/gptBridge.ts).
CREATE TABLE gpt_tasks (
  id             TEXT PRIMARY KEY,
  request_id     TEXT NOT NULL UNIQUE,        -- idempotency: same request_id = no duplicate task
  device_id      TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  company_id     TEXT NOT NULL REFERENCES companies(id),
  kind           TEXT NOT NULL DEFAULT 'powershell',  -- powershell | system (worker validates)
  script         TEXT NOT NULL,
  reason         TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending'      -- pending | approved | queued | running | completed | failed | timed_out | cancelled | denied | pending_confirm
                 CHECK (status IN ('pending','approved','queued','running','completed','failed','timed_out','cancelled','denied','pending_confirm')),
  classification TEXT,                                -- readonly | operational | dangerous | blocked (worker decides)
  command_id     TEXT REFERENCES commands(id),        -- filled when dispatched
  confirm_token  TEXT,                                -- HMAC token binding task identity+action hash (dangerous ops)
  result         TEXT,                                -- JSON: {stdout, stderr, exit_code} snapshot from commands.result
  error          TEXT,                                -- denial/timeout/cancel reason for the ChatGPT side
  requested_at   INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  completed_at   INTEGER,
  expires_at     INTEGER NOT NULL                     -- unapproved/unpicked tasks die at this timestamp (cron sweep)
);

CREATE INDEX idx_gpt_tasks_status ON gpt_tasks(status);
CREATE INDEX idx_gpt_tasks_device ON gpt_tasks(device_id, requested_at);
