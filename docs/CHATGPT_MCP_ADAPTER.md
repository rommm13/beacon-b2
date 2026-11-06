# ChatGPT MCP Adapter for Beacon

Проект защищённого API-адаптера: **ChatGPT → Cloudflare MCP (прокси/инструменты) → Beacon Worker → Windows Agent → обратно**.

Документ описывает целевой контракт адаптера. Существующие маршруты Beacon **не меняются** этим документом; адаптер реализуется отдельным слоем (новый namespace `/v1/chatgpt/*` или выделенный сервис), который использует уже существующие механизмы Beacon: RBAC (`requireUser`), очередь команд (`commands`), check-in протокол агента, аудит активности и результаты команд/сессий.

## 1. Цели и границы

- Дать ChatGPT (через MCP) безопасный, ограниченный доступ к наблюдаемости и управлению Windows-устройствами Beacon.
- Не обходить существующие контракты Beacon: pull-модель агента, роли `readonly|technician|admin`, подтверждение опасных операций, аудит.
- Не хранить и не возвращать секреты (токены устройств, `ADMIN_SECRET`, ключи шифрования, report/client tokens, пароли RustDesk в открытом виде в логах/ответах MCP).
- Адаптер не выполняет PowerShell сам; он только ставит проверенную команду/запрос в Beacon и читает результат из Beacon.

## 2. Существующие маршруты Beacon (база для адаптера)

Список найденных файлов в `worker/src/routes/` и назначение (по состоянию ветки `feat/backblaze-b2`):

| Файл | Назначение (1 строка) |
|---|---|
| `admin/activity-log.ts` | Серверный фильтрованный/пагинированный журнал активности (аудит действий). |
| `admin/agent-versions.ts` | Управление версиями агента (админские операции с релизами/версиями). |
| `admin/alerts.ts` | Управление алертами/мониторами и связанными настройками. |
| `admin/commands.ts` | Админские операции над командами устройств (просмотр/управление). |
| `admin/companies.ts` | CRUD/настройки компаний (тенантов), включая вложенные ресурсы. |
| `admin/components.ts` | Библиотека компонентов (скрипты/приложения), переменные, файлы, post-conditions. |
| `admin/custom-fields.ts` | Определения пользовательских полей (настройки). |
| `admin/dashboards.ts` | Конфигурация дашбордов/виджетов. |
| `admin/devices.ts` | Админские операции с устройствами: approve/revoke, команды, аудит, custom field values, RustDesk, maintenance, fast-poll. |
| `admin/email-settings.ts` | Настройки email-уведомлений. |
| `admin/groups.ts` | Управление Device Groups. |
| `admin/jobs.ts` | Создание/просмотр/отмена quick/scheduled jobs, резолвинг целей и dispatch команд. |
| `admin/maintenance-policies.ts` | Политики окон обслуживания. |
| `admin/notification-emails.ts` | Получатели уведомлений. |
| `admin/patches.ts` | Просмотр/управление патчами. |
| `admin/patch-policies.ts` | Политики патчинга (таргетинг, режимы, драйверы/Windows Update и т.п.). |
| `admin/policies.ts` | Мониторинговые политики и их таргеты/проверки. |
| `admin/reports.ts` | Отчёты. |
| `admin/rustdesk-settings.ts` | Глобальные настройки RustDesk. |
| `admin/settings.ts` | Общие настройки аккаунта/системы. |
| `admin/sso.ts` | Настройки SSO/аутентификации. |
| `admin/summary.ts` | Сводные данные для админ-интерфейса. |
| `admin/users.ts` | Управление пользователями и ролями. |
| `admin/webhooks.ts` | Управление webhooks. |
| `agent-update.ts` | Endpoint обновления агента (скачивание/проверки обновлений). |
| `audit.ts` | **Agent-facing** приём полного аудита (hardware/software/services/security/patches), сохранение и delta/alert-оценка. |
| `auth.ts` | Аутентификация пользователей (сессии/вход). |
| `auth-microsoft.ts` | OAuth/Microsoft-аутентификация. |
| `branding.ts` | Брендинг/публичные настройки UI. |
| `checkin.ts` | **Agent-facing** check-in: метрики, результаты команд, выдача queued команд, назначения проверок (file_size/ping/process/service/Windows Update drift), fast-poll. |
| `component-files.ts` | Доступ к файлам компонентов для агента (по grant/token-механике). |
| `enroll.ts` | Регистрация/энроллмент устройств. |
| `rustdesk-installer-download.ts` | Выдача установщика RustDesk агенту по grant. |
| `rustdesk-password.ts` | Безопасная выдача/обработка RustDesk-пароля (grant-механика, не через обычный payload команд). |
| `sessions.ts` | Создание remote-сессий (shell/tcp/screen_share), WS relay через DO, consent, displays, switch-monitor, file transfer (browse/download/upload) для Web Remote. |

### Запрошенные категории: фактическое наличие

- **admin**: есть каталог `admin/*` (24 файла).
- **job**: есть `admin/jobs.ts`.
- **device**: есть `admin/devices.ts`.
- **process**: отдельного route-файла `*process*` нет; данные/проверки процессов существуют в check-in/alerts (`pending_process_results`, `process_checks`) и командной модели, но не как выделенный admin CRUD route.
- **service**: отдельного route-файла `*service*` нет; сервисы собираются в аудите (`audit.ts` → `services`), проверяются через `service_checks` в `checkin.ts`.
- **file**: отдельного admin route `*file*` нет; есть file-transfer в `sessions.ts` (Web Remote browse/download/upload) и `component-files.ts`/grants для файлов компонентов.
- **hardware**: отдельного route-файла `*hardware*` нет; hardware приходит в `audit.ts` и доступен через `admin/devices.ts` → `GET /:id/audit/latest`.
- **event**: отдельного route-файла `*event*` нет; ближайшие аналоги — `admin/activity-log.ts` (аудит действий) и `device_audit_changes`/дельты, формируемые в `audit.ts` и читаемые в `admin/devices.ts` (`/audit/changes`).

## 3. Целевые endpoints адаптера ChatGPT

Все endpoints адаптера защищены собственной аутентификацией MCP-слоя + маппингом на Beacon-пользователя/роль. Адаптер **не** использует break-glass `ADMIN_SECRET` для обычных операций.

Базовый префикс: `/v1/chatgpt`.

| Метод | Путь | Назначение | Мин. роль | Опасность |
|---|---|---|---|---|
| GET | `/v1/chatgpt/status` | Статус адаптера, связь с Beacon, версия контракта, права текущего MCP-принципала. | `readonly` | нет |
| GET | `/v1/chatgpt/hardware` | Последний hardware-аудит устройства (прокси к данным Beacon audit/latest). | `readonly` | нет |
| GET | `/v1/chatgpt/processes` | Процессы устройства: последний снимок/результат проверки или on-demand запрос через безопасную команду/assignment. | `readonly`/`technician` для on-demand | низкая/средняя |
| GET | `/v1/chatgpt/services` | Сервисы из последнего аудита/результата проверки. | `readonly` | нет |
| GET | `/v1/chatgpt/files` | Листинг/метаданные/скачивание разрешённых путей через session/file-request механизм; **не** произвольный raw FS без политики. | `technician` | средняя |
| GET | `/v1/chatgpt/events` | События: activity log, audit changes, command/job/device events (нормализованный view). | `readonly` | нет |
| GET | `/v1/chatgpt/jobs` | Список/детали jobs, создание safe jobs; опасные job-компоненты требуют подтверждения и прав. | `readonly` чтение, `technician` создание | зависит от компонента |
| POST | `/v1/chatgpt/exec` | Выполнение PowerShell/system-команды через Beacon command queue (не прямой shell). | `admin` по умолчанию | **высокая** |

> Примечание: прямые `/processes`, `/services`, `/files`, `/hardware`, `/events`, `/jobs` без префикса `/v1/chatgpt` в этом проекте **не вводятся** как публичный контракт ChatGPT; адаптер нормализует их под `/v1/chatgpt/*`.

## 4. Формат запросов/ответов

### Общие правила

- `Content-Type: application/json; charset=utf-8`.
- Время — Unix seconds UTC, если не указано иначе.
- Идентификаторы — UUID/существующие Beacon ID строками.
- Ошибки: `{ "error": "code", "message": "human-readable", "details": {...}? }`.
- Успех: `{ "ok": true, "data": {...}, "audit_id"?: "..." }`.
- Ответы MCP-адаптера не должны содержать: device credentials, raw session report/client tokens, `ADMIN_SECRET`, encryption keys, plaintext RustDesk password (кроме явно разрешённого отдельного reveal-потока, не предназначенного для ChatGPT).

### GET `/v1/chatgpt/status`

Ответ:
```json
{
  "ok": true,
  "data": {
    "adapter": "beacon-chatgpt-mcp",
    "version": "0.1-draft",
    "beacon_reachable": true,
    "principal": { "subject": "chatgpt:<id>", "beacon_role": "readonly" },
    "capabilities": ["status", "hardware", "services", "events", "jobs.read"],
    "dangerous_actions_require_confirmation": true
  }
}
```

### POST `/v1/chatgpt/exec`

Назначение: поставить **PowerShell/system** команду в Beacon как контролируемую операцию. Адаптер не открывает интерактивный shell.

Запрос:
```json
{
  "device_id": "<beacon-device-id>",
  "company_id": "<beacon-company-id>",
  "kind": "powershell",
  "script": "Get-Service | Select-Object -First 5 Name,Status | ConvertTo-Json",
  "timeout_seconds": 120,
  "run_as_system": true,
  "reason": "Диагностика служб по запросу оператора",
  "confirmation": {
    "required": true,
    "confirmed": true,
    "confirmation_id": "<one-time-id>",
    "approved_by": "operator|policy",
    "expires_at": 1760000000
  }
}
```

Ограничения:
- `kind`: `powershell` | `system` (system — только предопределённые действия, не произвольная строка).
- Произвольный `system` shell/командная строка без allowlist — запрещён.
- `run_as_system` по умолчанию только для явно разрешённых сценариев; для опасных действий требуется `admin` + confirmation.
- Максимальный `timeout_seconds`, размер `script`, denylist/allowlist паттернов — политика адаптера.

Ответ (асинхронная постановка):
```json
{
  "ok": true,
  "data": {
    "accepted": true,
    "device_id": "...",
    "command_id": "<beacon-command-id>",
    "status": "queued",
    "poll_after_seconds": 5
  },
  "audit_id": "<adapter-audit-id>"
}
```

Ответ чтения результата (через `GET /v1/chatgpt/jobs`/command-result view):
```json
{
  "ok": true,
  "data": {
    "command_id": "...",
    "status": "completed",
    "exit_code": 0,
    "stdout": "...redacted/truncated...",
    "stderr": "",
    "warning": false,
    "completed_at": 1760000123
  }
}
```

### `/processes`, `/services`, `/hardware`

- `GET /v1/chatgpt/hardware?device_id=...` → нормализует `admin/devices/:id/audit/latest.hardware`.
- `GET /v1/chatgpt/services?device_id=...` → нормализует `audit.latest.services`.
- `GET /v1/chatgpt/processes?device_id=...&mode=latest|check`:
  - `latest` — последний разрешённый результат process-проверки/снимка, если Beacon его хранит/отдаёт.
  - `check` — запрос измерения; требует прав `technician+`, rate limit, аудит; фактическое выполнение происходит после следующего check-in/команды, не синхронно.

### `/files`

- `GET /v1/chatgpt/files?session_id=...&path=...` → browse через session file-request механизм.
- `POST /v1/chatgpt/files/download` → создаёт download request, возвращает request id; отдельный GET забирает готовый результат только если политика разрешает путь/расширение/размер.
- `POST /v1/chatgpt/files/upload` → только в разрешённую цель (например, Desktop через существующий Web Remote upload flow), с лимитом размера и аудитом.
- Запрещено: произвольный доступ к системным секретам, SAM/LSA, credential stores, ключам, токенам Beacon, приватным профилям без явной политики.

### `/events`

`GET /v1/chatgpt/events?device_id=&company_id=&category=&from=&to=&limit=&cursor=`

Нормализует источники:
- `admin/activity-log` (действия пользователей/системы);
- `device_audit_changes` (дельты hardware/software/services/security);
- command/job/device status transitions (где доступны).

### `/jobs`

- `GET /v1/chatgpt/jobs` / `GET /v1/chatgpt/jobs/:id` → чтение job/статусов устройств.
- `POST /v1/chatgpt/jobs` → создание job только из разрешённых компонентов/шаблонов. Компоненты с `requires_admin`, destructive-постусловиями или небезопасными payload требуют `admin` + confirmation + явную политику.

## 5. Опасные операции: подтверждение, права, аудит

### Классификация

- **Read-only (readonly)**: status, hardware/services/events/jobs read, latest process snapshot.
- **Operational (technician)**: безопасные запросы измерений, browse/download в разрешённых зонах, non-destructive jobs по allowlist.
- **Dangerous (admin + confirmation)**: `POST /exec` с `powershell/system`, reboot/uninstall/force update, install/uninstall software, file upload/download вне безопасных зон, jobs с admin-only/destructive компонентами.

### Подтверждение

Опасная операция выполняется только при наличии валидного `confirmation`:
- одноразовый `confirmation_id`, TTL;
- привязка к принципалу, устройству, типу действия и хэшу payload;
- причина (`reason`) обязательна;
- результат подтверждения (approved/denied/expired) пишется в аудит.

MCP-слой не должен silently повышать права. Если подтверждение отсутствует/истекло — `409 confirmation_required`.

### Права

- Адаптер маппит MCP-принципала на Beacon-роль; серверная проверка прав остаётся в Beacon (`requireUser`/существующие guardrails).
- Запрет hand-rolled bearer bypass: адаптер не передаёт `ADMIN_SECRET` вместо пользовательской сессии/RBAC.
- Для `exec` и destructive jobs — отдельный capability flag у MCP-принципала (`chatgpt.exec`, `chatgpt.jobs.write`).

### Аудит

Каждый вызов адаптера логируется:
- кто (MCP subject), от имени какой Beacon-роли;
- что (endpoint, action, target device/company/job/command);
- когда, исход, request fingerprint (без секретов и без полного тела опасного скрипта в открытом виде, если политика требует маскирование);
- `confirmation_id`, `reason`, итоговый `command_id`/`job_id`.

Аудит пишется в выделенный адаптерный журнал и/или в `activityLog` Beacon через контролируемый путь, чтобы событие было видно в существующем admin activity log.

## 6. Ограничения MCP

- **Pull-модель агента**: команда не выполняется мгновенно; результат зависит от `last_seen`, check-in интервала, fast-poll и online/offline состояния устройства.
- **MCP transport/latency**: инструмент должен возвращать короткий accepted/polling ответ, а не ждать долгий shell/установку.
- **Размер контекста**: большие stdout/stderr/аудиты обрезаются, суммаризируются и отдаются с курсором/ссылкой на Beacon ID.
- **Идемпотентность**: повторный вызов опасного действия без нового `confirmation_id` не должен создавать дубликат команды.
- **Отсутствие интерактивности**: PowerShell/system действия — non-interactive; любые prompt/UAC/GUI-зависимые сценарии ненадёжны.
- **Платформа**: `powershell/system` semantics зависят от `os_type`; Windows Agent — основной таргет, non-Windows требуют явной проверки.
- **Секреты**: MCP не получает device credential, session tokens, encryption keys; файлы/пароли выдаются только через существующие grant-механики Beacon с минимальным TTL.
- **Доступность данных**: process/service/file/hardware могут отсутствовать (нет аудита, privacy mode, устройство offline, нет прав, нет session). Ответ должен быть честным `unavailable`/пустым состоянием, не выдуманным.

## 7. Полный маршрут проверки ChatGPT → MCP → Beacon → Agent → обратно

### Сценарий A: безопасное чтение (hardware/services/events)

1. **ChatGPT** вызывает MCP tool `beacon_hardware`/`beacon_events`.
2. **Cloudflare MCP** аутентифицирует запрос, проверяет capability и rate limit.
3. **MCP Adapter** валидирует параметры (`device_id`, scope), маппит принципала на Beacon роль `readonly`.
4. **Beacon Worker** отдаёт данные из существующих источников (`admin/devices/:id/audit/latest`, `admin/activity-log`, audit changes).
5. **MCP Adapter** нормализует ответ, удаляет чувствительные поля, добавляет `audit_id` чтения при необходимости.
6. **Cloudflare MCP → ChatGPT** возвращают структурированный JSON.

### Сценарий B: опасный exec (PowerShell/system)

1. **ChatGPT** предлагает действие и запрашивает подтверждение (вне MCP, через контролируемый операторский flow).
2. Оператор выдаёт одноразовый `confirmation_id` (policy-approved).
3. **ChatGPT** вызывает MCP tool `beacon_exec` с `confirmation`.
4. **Cloudflare MCP** проверяет подпись/идентичность вызова, rate limit, размер payload.
5. **MCP Adapter**:
   - валидирует schema, allowlist/denylist, device scope, роль `admin`, capability `chatgpt.exec`;
   - проверяет `confirmation_id` (TTL, одноразовость, binding к payload/device/principal);
   - пишет audit record `accepted` или `denied`.
6. **Beacon Worker** создаёт команду (через контролируемый admin/adapter path, эквивалентный политике device command/job) со статусом `queued`.
7. **Windows Agent** на следующем check-in получает команду, выполняет PowerShell/system non-interactively с ограниченным `timeout_seconds`.
8. **Agent → Beacon** возвращает `stdout/stderr/exit_code/status` в `pending_command_results`.
9. **Beacon Worker** обновляет command/job state, применяет post-conditions/warning-логику где применимо.
10. **MCP Adapter** по poll/read получает нормализованный результат, обрезает вывод, сохраняет финальный audit outcome.
11. **Cloudflare MCP → ChatGPT** возвращают `command_id`, статус, усечённый результат и ссылку/ID для follow-up.

### Сценарий C: file download через Web Remote/session-механику

1. **ChatGPT** запрашивает browse/download.
2. **MCP Adapter** требует `technician` + policy allowlist путей.
3. **Beacon** создаёт `session_file_request`/использует существующий session file flow.
4. **Agent/screenshare helper** выполняет browse/read в разрешённом контексте и загружает результат/метаданные через grant/report-token механизм.
5. **Beacon** хранит готовый результат (R2/object + request status).
6. **MCP Adapter** отдаёт ChatGPT только разрешённые метаданные/ограниченный контент, без утечки grant/token.

## 8. Критерии приёмки для будущей реализации

- Ни один существующий маршрут Beacon не изменён без отдельного согласованного изменения.
- Все новые endpoints проходят server-side RBAC; UI/MCP-проверки не считаются достаточными.
- Опасные операции невозможны без `admin` + валидного одноразового подтверждения + audit trail.
- Ответы не содержат секретов/токенов/паролей/ключей.
- Для async операций есть `command_id/request_id`, polling-контракт и таймауты.
- Негативные кейсы покрыты: offline device, missing audit, privacy mode, expired confirmation, insufficient role, payload too large, disallowed path/script.
- Проверки: `cd worker && pnpm type-check`, `cd dashboard && pnpm build` (если затронут UI), целевые тесты, и end-to-end прогон сценариев A/B/C на изолированном стенде.
