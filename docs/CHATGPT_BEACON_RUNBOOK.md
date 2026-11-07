# CHATGPT_BEACON_RUNBOOK

Удалённое управление ноутбуком Honor (DESKTOP-QHVKN2K) из чата ChatGPT Plus
через уже подключённый плагин Cloudflare. Никаких MCP, Developer Mode,
кастомных GPT и дополнительных подписок не требуется.

## 0. Инфраструктура (константы)

| Что | Значение |
|---|---|
| Cloudflare account_id | `fb1f75755339a977049e6428dbfc25e4` |
| D1 database_id | `aa33fd74-e80a-4dba-8cb3-9a3e54621a39` |
| D1 database_name | `beacon-pilot` |
| Device ID ноутбука | `c6fff44a-8171-4379-a535-2f6122d5ca05` |
| Company ID | `27eb7071-267e-4847-aea4-c5fe25368c5b` (Honor) |
| Hostname | `DESKTOP-QHVKN2K`, Windows 11 Pro |
| Agent | Beacon 0.4.0, служба `BeaconAgent` (автозапуск) |
| Worker API | https://beacon-b2-api.iddqd777.workers.dev (для оператора, не для ChatGPT) |
| Repo | https://github.com/rommm13/beacon-b2, ветка `feat/backblaze-b2` |

ChatGPT использует ТОЛЬКО:
1. Подключённый плагин Cloudflare (SQL к D1).
2. Таблицу `gpt_tasks`.

Прямые вызовы Worker API ChatGPT НЕ делает. Секретов в этом файле нет:
CF API-токен живёт в подключённом плагине Cloudflare.

## 1. Как это работает (коротко)

```
ChatGPT → INSERT в gpt_tasks (через Cloudflare API)
        → worker классифицирует на ближайшем чек-ине агента (15-90 c)
            diag (из каталога)      → выполняется сразу (текст скрипта — рабочий, не твой)
            powershell (произвольный) → ВСЕГДА ждёт confirm-токен оператора
            blocked                 → отказ (защищённые пути)
        → агент выполняет PowerShell на ноутбуке
        → результат зеркалится в gpt_tasks.result
ChatGPT → SELECT читает stdout/stderr/exit_code
```

Статусы: `pending` → `pending_confirm` → `approved` → `queued` →
`completed` | `failed` | `denied` | `timed_out` | `cancelled`.

## 1.1 Модель безопасности (важно, обновлено 2026-11-07)

Статический анализ PowerShell **не может** гарантировать безопасность —
обход `hostname` + `cmd /c echo …` был исполнен автоматически и доказал это.
Поэтому модель перестроена:

1. **Автоматически исполняется ТОЛЬКО каталог диагностик** (`kind='diag'`):
   в `script` пишется имя операции из списка §3, а реальный PowerShell-текст
   принадлежит воркеру и подменяется им при dispatch. ChatGPT не может
   вплести свой код в diag-вызов — неизвестное имя = denied.
2. **Любой произвольный PowerShell (`kind='powershell'`) требует
   человеческого подтверждения. Всегда.** Без исключений — не для `Get-*`,
   не для `hostname`, ни для чего. Человек — граница безопасности.
3. **`D:\ChatGPT-Disk`** — отказ на упоминание пути. Для произвольных
   скриптов это удобное ускорение, НЕ граница (переменные/конкатенация могут
   спрятать путь) — настоящая граница там пункт 2.
4. **Подмена статуса бесполезна**: `approved` без рабочей классификации
   воркер переклассифицирует заново; произвольный скрипт с подделанным
   `approved` падает в `pending_confirm` и без токена не уйдёт.
5. **Прямой INSERT в `commands` не работает**: чек-ин выдаёт агенту только
   команды с серверной HMAC-подписью происхождения (`origin_sig` в payload),
   которую нельзя вычислить без секрета воркера и нельзя перенести на чужую
   command_id/скрипт. Без подписи команда отклоняется с аудитом
   `[beacon: command rejected - missing or invalid server origin signature]`.

## 2. SQL-шаблоны (единственные запросы, которые нужны ChatGPT)

### 2.1 Отправить команду (INSERT)

```sql
INSERT INTO gpt_tasks
  (id, request_id, device_id, company_id, kind, script, reason, status,
   requested_at, updated_at, expires_at)
VALUES (
  '<uuid>',                     -- любой UUID, сгенерируй сам
  '<traceable-id>',             -- уникальный, напр. 'chatgpt-20261107-01'; повтор = отказ БД
  'c6fff44a-8171-4379-a535-2f6122d5ca05',
  '27eb7071-267e-4847-aea4-c5fe25368c5b',
  'powershell',
  '<PS-скрипт без Go-форматов, до 32000 символов>',
  '<зачем: обязательный человекочитаемый reason>',
  'pending',
  strftime('%s','now'), strftime('%s','now'), strftime('%s','now')+3600
);
```

### 2.2 Прочитать результат

```sql
SELECT status, classification, result, error, completed_at
FROM gpt_tasks WHERE request_id = '<traceable-id>';
```
`result` — JSON-строка: `{"stdout":"...","stderr":"...","exit_code":0}`.

### 2.3 Последние задачи / история

```sql
SELECT request_id, status, classification, reason, requested_at, completed_at
FROM gpt_tasks ORDER BY requested_at DESC LIMIT 20;
```

### 2.4 Инвентаризация (таблица devices, только чтение)

```sql
SELECT hostname, os_version, agent_version, status, last_seen, inventory,
       external_ip
FROM devices WHERE id = 'c6fff44a-8171-4379-a535-2f6122d5ca05';
```
`inventory` — JSON: cpu_percent, memory_percent, disk_free_bytes, av_product,
uptime_seconds и др. `last_seen` — Unix-секунды; отставание > 5 мин = ноутбук
offline/спит.

### 2.5 Отмена зависшей задачи (UPDATE)

```sql
UPDATE gpt_tasks SET status='cancelled', error='cancelled_by_operator',
updated_at=strftime('%s','now')
WHERE request_id='<traceable-id>' AND status IN ('pending','pending_confirm');
```
Если таск уже `queued` (команда ушла агенту) — отменять через оператора:
POST `/v1/gpt-bridge/tasks/<task_id>/cancel` (см. §4). Своим UPDATE отменяй
только до `queued`.

## 3. Каталог диагностик (kind='diag') — единственный авто-путь

В `script` пиши ИМЯ операции. Полный список (2026-11-07):

| op | Что вернёт |
|---|---|
| `system_info` | hostname, whoami, ОС, загрузка CPU, RAM |
| `disk` | тома, свободное место, здоровье дисков |
| `battery` | заряд, статус, оценка времени работы |
| `network` | IP по интерфейсам, TCP-соединения, слушающие порты |
| `processes` | топ-25 процессов по CPU + их количество |
| `services` | работающие службы |
| `startup` | автозагрузка (реестр + Startup-папка) |
| `installed_apps` | установленные приложения (реестр Uninstall) |
| `recent_errors` | последние 20 ошибок из журнала System |
| `security_summary` | Defender, профили файрвола |

INSERT для диагностики: как §2.1, но `kind='diag'` и `script='system_info'`
(имя из таблицы). Неизвестное имя → denied `unknown_kind_or_diag_op`.
Вплести свой код в diag нельзя: текст скрипта подменяется рабочим из каталога.

**blocked — отказ всегда:** любое вхождение `D:\ChatGPT-Disk` (или
`d:/chatgpt-disk`) в script. Диск неприкосновенен без отдельного письменного
разрешения владельца.

## 4. Двухфазное выполнение (произвольный PowerShell — ВСЕГДА)

Любой `kind='powershell'` (даже `hostname`) встаёт в `pending_confirm`:

1. INSERT таска (как в 2.1), жди смены статуса (poll 2.2, 15-20 c).
2. Статус станет `pending_confirm` (классификация `operational`).
3. Скажи Роману: «нужен confirm-токен для таска <task_id>, скрипт: <превью>».
4. Роман даёт токен (один curl с его ключом). ChatGPT записывает его:
```sql
UPDATE gpt_tasks SET confirm_token='<токен от Романа>'
WHERE id='<task_id>' AND status='pending_confirm';
```
5. На следующем чек-ине воркер проверит HMAC-подпись токена (подделка
   невозможна: ключ не покидает воркер; токен привязан к request_id+device+
   хэшу скрипта, TTL = TTL таска). Статус → `approved` → `queued` →
   `completed/failed`.
6. Повторная запись токена ничего не даёт: одноразовость обеспечена
   переходом статуса. Подделка `status='approved'` мимо токена не работает —
   воркер переклассифицирует и вернёт в `pending_confirm`.

Для 90% задач подтверждение не нужно: диагностика — это §3 (diag).

## 5. Ограничения

| Параметр | Значение |
|---|---|
| TTL таска | 1 час (после — `timed_out`) |
| Таймаут скрипта | 300 с (kill, статус failed, stderr дополнен) |
| Максимум скрипта | 32000 символов |
| Параллельные таски на устройство | ≤5 (лишние — denied `too_many_concurrent_tasks`) |
| Задержка исполнения | 15-90 с (один чек-ин; при flaky-сети до ~3 мин) |
| stdout/stderr | возвращаются целиком (проверено на 74 КБ) |
| Повтор request_id | INSERT отклонён (UNIQUE) — дубль невозможен |
| Выполнение | от SYSTEM, окна скрыты (ничего не всплывает) |
| PowerShell | -NoProfile -NonInteractive -ExecutionPolicy Bypass |

## 6. Безопасность (правила для ChatGPT)

1. Никогда не пиши в `commands`, `users`, `devices` и прочие таблицы — только
   `gpt_tasks` (INSERT/UPDATE confirm_token/UPDATE cancel) и SELECT. Прямая
   вставка в `commands` бессмысленна: unsigned команда отклоняется
   origin-guard'ом на чек-ине и не исполняется.
2. Не пытайся выставить `status='approved'` напрямую — воркер
   переклассифицирует: произвольный скрипт вернётся в `pending_confirm`,
   approval только через токен из §4.
3. `D:\ChatGPT-Disk` — запрещённая зона (отказ на упоминание пути).
4. Реестр, службы, сети, VPN, SSH, Windows Update — только произвольный
   PowerShell через §4 с объяснением Роману, зачем. Диагностика — §3 (diag,
   без подтверждений).
5. `reason` всегда заполняй честно — это аудит.
6. Не размещай секреты/пароли в script — они попадут в D1-лог.
7. Русский текст в выводе теперь корректен: воркер оборачивает каждый скрипт
   в UTF-8-пролог (`[Console]::OutputEncoding = UTF8`).

## 7. Восстановление при сбоях

| Симптом | Действие |
|---|---|
| Статус висит `pending` > 3 мин | Ноутбук offline/спит или сеть флапает. Проверь `last_seen` (§2.4). Жди — чек-ины восстанавливаются сами. |
| `timed_out` | TTL истёк. Создай таск заново с новым request_id. |
| `failed`, stderr `[beacon: script killed after ...]` | Превышен таймаут 300 с. Дроби скрипт. |
| `denied protected_path_denied` | Скрипт трогает D:\ChatGPT-Disk. Убери пути. |
| `denied too_many_concurrent_tasks` | >5 незавершённых тасков. Дождись completion или отмени лишние. |
| INSERT падает UNIQUE | Такой request_id уже был. Новый request_id. |
| Агент не оживает >15 мин | Роман: перезапуск службы `Restart-Service BeaconAgent` локально или резервный канал (§8). |

Состояние после сбоя питания/ребута: служба `BeaconAgent` автозапуск,
очередь команд в D1 — ничего не теряется, недоставленное исполнится после
возврата сети. Обновление агента откатывается на предыдущую версию бинарника
(registered version в `/v1/agent/version`).

## 8. Резервный канал (не основной)

Marzban VPS → SSH → Windows существует и не трогается. Использовать, только
если Beacon-канал мёртв (агент не чекинится >30 мин, VPN-путь жив).
Порядок: спросить Романа → он даёт SSH → диагностика вручную. Не переносить
постоянные операции туда.

## 9. Что НЕ умеет (честно)

- Скриншоты, мышь/клавиатура, GUI-автоматизация — НЕТ (это RMM-канал без
  screen-контроля; есть RustDesk-интеграция в Beacon, но не через gpt_tasks).
- Температуры CPU/GPU, SMART-атрибуты — не собираются инвентарём (получишь
  частично через WMI в скриптах: `Get-CimInstance Win32_TemperatureProbe` —
  обычно пусто на ноутбуках Honor).
- Интерактив (Read-Host, ввод паролей) — невозможно: -NonInteractive.
- Заблокированный экран/экран входа: скрипты от SYSTEM работают, но
  everything GUI — нет.
- Файловая передача через gpt_tasks — нет; используй скрипты (Base64 в stdout
  для мелких файлов, до ~100 КБ).

## 10. Инструкция для ChatGPT (вставить в новый чат)

```
Ты управляешь ноутбуком Windows 11 через Beacon. У тебя есть плагин
Cloudflare (SQL к D1). Работай ТОЛЬКО так:

CONST:
account_id=fb1f75755339a977049e6428dbfc25e4
database_id=aa33fd74-e80a-4dba-8cb3-9a3e54621a39
DEVICE_ID=c6fff44a-8171-4379-a535-2f6122d5ca05
COMPANY_ID=27eb7071-267e-4847-aea4-c5fe25368c5b

ДИАГНОСТИКА (авто-исполнение, 15-90 c) — для всего чтения:
INSERT INTO gpt_tasks (id, request_id, device_id, company_id, kind, script,
reason, status, requested_at, updated_at, expires_at)
VALUES ('<uuid>', '<уникальный-id-с-датой>', '<DEVICE_ID>', '<COMPANY_ID>',
'diag', '<имя-операции>', '<зачем>', 'pending',
strftime('%s','now'), strftime('%s','now'), strftime('%s','now')+3600);
Имена операций (только эти): system_info, disk, battery, network, processes,
services, startup, installed_apps, recent_errors, security_summary.
Свободный текст в script при kind='diag' = отказ.

ПРОВЕРИТЬ/ПРОЧЕСТЬ:
SELECT status, classification, result, error FROM gpt_tasks
WHERE request_id='<id>';
result — JSON: {"stdout","stderr","exit_code"}.

ИНВЕНТАРЬ:
SELECT hostname, os_version, agent_version, status, last_seen, inventory
FROM devices WHERE id='<DEVICE_ID>';
(last_seen отстаёт >5 мин = ноутбук offline)

ПРОИЗВОЛЬНЫЙ POWERSHELL (только когда diag-каталога не хватает):
Тот же INSERT, но kind='powershell' и в script — текст скрипта. ЛЮБОЙ такой
скрипт (даже hostname) встанет в pending_confirm. Скажи мне, что нужен
confirm-токен для <task_id> и зачем, я выдам токен, запиши его:
UPDATE gpt_tasks SET confirm_token='<токен>' WHERE id='<task_id>'
AND status='pending_confirm';
После этого команда исполнится автоматически.

ПРАВИЛА:
1. Чтение — ТОЛЬКО через diag-операции, не пиши произвольные скрипты ради
   Get-запросов (их всё равно не пустят без меня).
2. D:\ChatGPT-Disk трогать запрещено — отклонит система.
3. commands/devices/users — НЕ трогай, только gpt_tasks и чтение devices.
   INSERT в commands не работает: unsigned команды отклоняются.
4. Подделка status='approved' не работает — воркер переклассифицирует.
5. Если timed_out — создай заново с новым request_id (повтор request_id
   отклоняется уникальным индексом — дубль невозможен).
6. reason заполняй всегда — это аудит.
7. Скрипты без интерактива (-NonInteractive), таймаут 300 с, до 32000
   символов. Русский текст в stdout читается корректно.
```
