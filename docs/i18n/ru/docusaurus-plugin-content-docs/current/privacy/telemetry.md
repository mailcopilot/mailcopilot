---
title: Telemetry
sidebar_position: 2
---

# Телеметрия

MailCopilot собирает небольшое количество анонимных диагностических данных и сведений об использовании, когда вы включаете переключатель **Отправлять анонимную диагностику и сведения об использовании** в Настройки → О программе. На этой странице описано ровно то, что собирается, и — что не менее важно — то, что не собирается никогда.

## Что мы никогда не собираем

Ни при каких обстоятельствах MailCopilot не передаёт следующее:

- Текст ваших писем (тема, тело, вложения, черновики)
- Ваши email-адреса или адреса ваших контактов
- Имена и пути папок на вашем IMAP-сервере
- Имена файлов вложений
- Текст поисковых запросов
- Содержимое чатов с AI или AI-памяти
- Хосты серверов, порты или учётные данные

## Как маршрутизируются данные

Вся телеметрия отправляется в [Sentry](https://sentry.io) — нашу платформу мониторинга ошибок и производительности. Когда вы выключаете переключатель в Настройках, конвейер обходится полностью — ничего не отправляется. Если включить отладочное логирование, те же события дополнительно появляются в локальном `main.log`, чтобы вы могли просмотреть, что именно было бы отправлено.

### Анонимный идентификатор инсталляции

При первом запуске MailCopilot генерирует случайный UUID и сохраняет его в локальном конфигурационном файле. Этот UUID никогда не покидает ваше устройство. Вместо него передаётся SHA-256 хеш — обрезанный до 16 шестнадцатеричных символов — который мы называем `install_id_hash`. Он прикрепляется к каждому телеметрическому событию как Sentry user id, чтобы мы могли отвечать на вопросы вроде «сколько уникальных установок работает на версии X» или «на сколько пользователей повлиял краш Y — на одного или сотню». Хеш:

- **Анонимен** — не выводится из и не сопоставляется с email аккаунта, отпечатком устройства, IP-адресом или аппаратным идентификатором.
- **Стабилен между релизами** — одна и та же установка сохраняет тот же хеш при автообновлении приложения, поэтому метрики удержания переживают апдейты версий.
- **Необратим** — на нашей стороне нет способа сопоставить хеш обратно с UUID или вашим устройством.
- **Сбрасывается при выключении телеметрии** — переключение тумблера в Настройках в положение «выкл» немедленно очищает идентификатор у Sentry-клиента и останавливает дальнейшие передачи.

Мы используем этот идентификатор так же, как веб-аналитика использует анонимный visitor id: он позволяет считать *уникальные* инсталляции, а не *общее число событий*. Эта разница и есть причина, по которой телеметрия вообще полезна — без неё одна шумная установка выглядела бы так же, как сотня тихих.

## События

### Жизненный цикл приложения

| Событие | Тип | Агрегируется | Теги | Назначение |
| --- | --- | --- | --- | --- |
| `app.session_started` | event | нет | `version`, `platform`, `theme`, `lang`, `accounts_count`, `install_id_hash` | Один раз при запуске приложения. Несёт `install_id_hash` для DAU/MAU. |
| `app.session_ended` | histogram | нет | `reason`, `install_id_hash` | Один раз при штатном завершении. value_ms = длительность сессии. |
| `app.updated` | event | нет | `from_version`, `to_version` | Один раз после установки автообновлением новой версии. |
| `app.startup_ms` | histogram | нет | `accounts_count` | Время от `app.whenReady` до первого видимого `BrowserWindow`. |

### Сводка использования

| Событие | Тип | Агрегируется | Теги | Назначение |
| --- | --- | --- | --- | --- |
| `usage.session_summary` | event | нет | `search_used`, `compose_used`, `snooze_used`, `read_later_used`, `ai_used`, `rules_used`, `templates_used`, `followup_used`, `install_id_hash` | Битовая карта «какие фичи хотя бы раз использовали в сессии», на её конец. |

### Онбординг

| Событие | Тип | Агрегируется | Теги | Назначение |
| --- | --- | --- | --- | --- |
| `onboarding.wizard_opened` | event | нет | `first_run` | Пользователь открыл мастер добавления аккаунта. |
| `onboarding.method_selected` | event | нет | `method` | Пользователь выбрал OAuth или ручную IMAP/SMTP-настройку. |
| `onboarding.autoconfig_result` | event | нет | `success`, `provider` | Завершилась автоконфигурация — нашли ли мы IMAP/SMTP-настройки? |
| `onboarding.connection_test_result` | event | нет | `kind`, `success`, `failure_kind` | Завершился тест связи IMAP или SMTP. |
| `onboarding.google_oauth_result` | event | нет | `success`, `failure_kind` | Завершился Google OAuth2-поток. |
| `onboarding.account_saved` | event | нет | `provider`, `auth_type` | Учётные данные аккаунта записаны в keytar/electron-store. |
| `onboarding.first_headers_sync_completed` | histogram | нет | `provider`, `folder_count_bucket` | Время от `account_saved` до завершения первой синхронизации заголовков (value_ms). |
| `onboarding.first_message_opened` | event | нет | `time_since_sync_bucket` | Пользователь открыл своё первое письмо после входа в аккаунт. |

### Написание

| Событие | Тип | Агрегируется | Теги | Назначение |
| --- | --- | --- | --- | --- |
| `compose.opened` | event | нет | `source`, `has_draft` | Окно написания открыто; отслеживается точка входа. |

### Очередь отправки

| Событие | Тип | Агрегируется | Теги | Назначение |
| --- | --- | --- | --- | --- |
| `send_queue.enqueued` | event | нет | `scheduled`, `send_and_archive`, `has_attachments`, `body_size_bucket` | Исходящее письмо добавлено в `send_queue` (немедленно или по расписанию). |
| `send_queue.sent` | histogram | нет | `scheduled` | Время от постановки в очередь до успешной доставки — SMTP для большинства аккаунтов, Microsoft Graph для Outlook (value_ms). |
| `send_queue.failed` | event | нет | `failure_kind` | Попытка отправки окончательно провалилась (очередь сдалась). Покрывает оба пути: SMTP и Microsoft Graph. |
| `send_queue.retried` | event | нет | `attempt_number` | Временная ошибка отправки — письмо переставлено в очередь. Покрывает оба пути: SMTP и Microsoft Graph. |

### Предупреждения о неверном получателе

| Событие | Тип | Агрегируется | Теги | Назначение |
| --- | --- | --- | --- | --- |
| `misdirection.prompted` | event | нет | `kind` | В Compose показан диалог-предупреждение о возможной отправке не туда. |
| `misdirection.outcome` | event | нет | `outcome`, `kind` | Пользователь отреагировал на это предупреждение. |

### Шаблоны

| Событие | Тип | Агрегируется | Теги | Назначение |
| --- | --- | --- | --- | --- |
| `template.applied` | event | нет | `var_count` | Пользователь вставил шаблон в окно написания. |

### Напоминания follow-up

| Событие | Тип | Агрегируется | Теги | Назначение |
| --- | --- | --- | --- | --- |
| `followup.created` | event | нет | `duration_days_bucket` | К исходящему письму прикреплено follow-up-напоминание. |

### Поиск

| Событие | Тип | Агрегируется | Теги | Назначение |
| --- | --- | --- | --- | --- |
| `search.duration_ms` | histogram | нет | `scope`, `folder_role`, `account_count`, `sort`, `pagination`, `len_bucket`, `token_count`, `result_bucket`, `duration_bucket`, `zero_results` | Сквозная задержка FTS-поиска (на стороне main, до слияния с серверными результатами). Будет заменено на `search.completed` в PR 2. |
| `search.error` | event | нет | `scope`, `kind` | Обработчик поиска бросил исключение — пользователь отменил или реальный сбой. |

### Индексатор тел

| Событие | Тип | Агрегируется | Теги | Назначение |
| --- | --- | --- | --- | --- |
| `body_indexer.tick.duration_ms` | histogram | нет | `indexed`, `folders_scanned` | Один полный тик индексатора по всем папкам. |
| `body_indexer.coverage_pct` | gauge | нет | `total_messages`, `indexed_messages` | Доля кэшированных писем, у которых проиндексирован `body_text`. |
| `body_indexer.backlog` | gauge | нет | — | Абсолютное число кэшированных писем, у которых ещё нет `body_text`. |
| `body_indexer.folder_error` | event | нет | `folder_role`, `error_streak`, `backoff_ms` | Индексатор столкнулся с серией ошибок по папке и ушёл на backoff. |

### Обслуживание полнотекстового индекса

| Событие | Тип | Агрегируется | Теги | Назначение |
| --- | --- | --- | --- | --- |
| `fts.optimize.duration_ms` | histogram | нет | `segments_before`, `segments_after`, `reduction` | Проход FTS5 optimize: время и количество сегментов до/после. |
| `fts.optimize.failed` | event | нет | `reason` | FTS5 optimize упал с ошибкой. |

### Синхронизация заголовков

| Событие | Тип | Агрегируется | Теги | Назначение |
| --- | --- | --- | --- | --- |
| `sync.headers.wall_ms` | histogram | нет | `folder_role`, `upsert_ms`, `other_ms`, `batches`, `rows`, `max_batch_ms` | Полный прогон `syncFolderHeaders` — разделение upsert и прочего для профилирования. |
| `sync.headers.coalesced` | event | нет | `folder_role` | Параллельная попытка `syncFolderHeaders` подцепилась к уже идущему прогону. |

### Инструментирование открытия писем

| Событие | Тип | Агрегируется | Теги | Назначение |
| --- | --- | --- | --- | --- |
| `mail.open` | histogram | нет | `cache_hit_level`, `body_size_bucket`, `attachments_count` | Сквозная задержка открытия письма, наблюдаемая со стороны renderer (от клика до отрисовки тела). Тег `cache_hit_level` кодирует, из какого уровня кэша получено тело: `memory`, `db`, `eml`, `imap` или `imap_timeout`. |
| `net.message_details.wall_ms` | histogram | нет | `cache_hit_level` | Walltime IPC-обработчика `net:messageDetails` на стороне основного процесса. Изолирует серверную латентность от шума round-trip renderer→main. Одна выборка на терминальный путь (`memory`, `db`, `eml`, `imap`, `imap_timeout`). |
| `imap.pool_queue_wait_ms` | event | нет | `requester`, `wait_ms_bucket` | Время ожидания получения соединения из per-account пула IMAP. Испускается только при ожидании свыше 500 мс, поэтому дашборды видят длинный хвост без шума от быстрых захватов. |

### Обновление OAuth-токенов IMAP

| Событие | Тип | Агрегируется | Теги | Назначение |
| --- | --- | --- | --- | --- |
| `imap.auth_refresh_attempt` | event | нет | `provider` | Запущено обновление OAuth-токена в ответ на ошибку аутентификации IMAP (XOAUTH2 / AUTHENTICATE). |
| `imap.auth_refresh_success` | event | нет | `provider` | Обновление успешно — повтор IMAP-запроса пойдёт уже со свежим токеном. |
| `imap.auth_refresh_failure` | event | нет | `provider`, `reason` | Обновление не удалось — исходная ошибка аутентификации поднимается выше. |
| `imap.auth_refresh_suppressed` | event | нет | `reason` | Per-account cooldown подавил попытку обновления, чтобы не штормить запросами `/token`, когда refresh-токен отозван. |
| `imap.idle_auth_refreshed` | event | нет | `provider` | Цикл IDLE восстановился после mid-cycle ошибки аутентификации через in-loop обновление токена — push-доставка вернулась без 60-минутного auth-backoff. |
| `imap.auth_refresh_exhausted` | event | нет | `provider`, `consecutive` | Цикл IDLE сработал на storm-brake — N подряд успешных обновлений на стороне провайдера, но IMAP всё равно отверг свежие токены, поэтому переходим к обычному auth-backoff. |

### Удержание кэша

| Событие | Вид | Агрегирован | Теги | Назначение |
| --- | --- | --- | --- | --- |
| `cache.eml_pruned` | event | нет | `count_bucket`, `freed_bytes_bucket` | Плановая очистка удалила файлы `.eml` старше настроенного срока хранения. Количества и объёмы передаются только в виде диапазонов — точные пути и числа не передаются. |
| `cache.folder_index_disabled` | event | нет | `count`, `role` | Папка была исключена из полнотекстового поиска — автоматически для Junk/Spam/Trash при первой регистрации или вручную через контекстное меню папки. `role`: `spam`, `trash` или `manual`. |

### Сигналы безопасности кэша и потери данных

| Событие | Тип | Агрегируется | Теги | Назначение |
| --- | --- | --- | --- | --- |
| `db.mass_delete_messages` | event | нет | `folder_role`, `reason`, `deleted_count_bucket`, `watermark_preserved` | Выполнен папочный `DELETE FROM messages`. Каждый call site сообщает причину, чтобы регрессию-«потеря кэша» можно было отличить от штатного UIDVALIDITY-bump. |
| `imap.stale_wipe_guard_tripped` | event | нет | `folder_role`, `provider` | Защита от mass-delete отказала в очистке локального кэша папки, потому что `mailbox.exists` вернулся не-числом. Всплеск означает проблему провайдера/связи, а не реальную потерю данных. |
| `db.shutdown_wal_checkpoint_ms` | histogram | нет | `busy`, `reclaimed_kb_bucket`, `ok` | Длительность `PRAGMA wal_checkpoint(TRUNCATE)` перед закрытием — гарантирует, что закоммиченные, но не чекпойнтнутые записи переживут перезапуск. |

### Шлюз stdio MCP (защита renderer-to-RCE)

| Событие | Тип | Агрегируется | Теги | Назначение |
| --- | --- | --- | --- | --- |
| `mcp.stdio.connect_attempted` | event | нет | `approved_source` | Транспорт stdio MCP вот-вот будет запущен — фиксируется один раз на успешный connect после прохождения approval и allowlist гейтов. |
| `mcp.stdio.connect_blocked` | event | нет | `reason` | Подключение или сохранение stdio отклонено гейтом (`not_approved`, `unapproved_command`, `forbidden_field`, `forbidden_env_key`, `env_disabled`). |
| `mcp.stdio.approval_granted` | event | нет | `source`, `scope` | Пользователь дал согласие на stdio MCP (глобальное включение или per-connection); `source` различает env vs native-confirm, `scope` — global vs per-connection. |
| `mcp.stdio.env_sanitized_on_load` | event | нет | `count_bucket` | Миграция настроек удалила запрещённые loader-hook env-ключи из сохранённых MCP-подключений при загрузке. Срабатывает не более одного раза на запуск. |

### Аудит AI-действий (барьер preview → apply)

| Событие | Тип | Агрегируется | Теги | Назначение |
| --- | --- | --- | --- | --- |
| `ai.action.preview_created` | event | нет | `kind` | `*_preview` MCP-инструмент зарегистрировал ожидающее мутирующее действие, ждущее клика «Apply». |
| `ai.action.applied` | event | нет | `kind` | `*_apply` MCP-инструмент успешно выполнил ранее подтверждённое мутирующее действие. |
| `ai.action.rejected` | event | нет | `kind`, `reason` | Вызов `*_apply` отклонён на гейте валидации (preview отсутствует/истёк, токен не совпал, kind mismatch, нет callback или превышен rate-limit). |
| `ai.action.expired` | event | нет | `kind` | Ожидающее мутирующее действие истекло, не дождавшись клика Apply (TTL). |
| `ai.action.apply_duration_ms` | histogram | нет | `kind` | Длительность успешного apply — сколько занимает базовая мутация (DB / IMAP / SMTP). |

### Шлюз исходящего egress AI

| Событие | Тип | Агрегируется | Теги | Назначение |
| --- | --- | --- | --- | --- |
| `ai.egress.blocked` | event | нет | `tool_name`, `account_id` | Внешний egress-вызов (например, `WebSearch`, `WebFetch`, общий внешний MCP-тул) был отклонён, пока пользовательские email-данные находились в области видимости — либо отфильтрован из toolset SDK, либо остановлен runtime-гейтом. |
| `ai.egress.allowed_once` | event | нет | `tool_name`, `account_id` | Пользователь дал одноразовое согласие на egress, и AI этим воспользовался. Помогает отделить «пользователи регулярно переопределяют» от «гейт держит, попытки в основном инъекционные». |

### Производительность IPC

| Событие | Тип | Агрегируется | Теги | Назначение |
| --- | --- | --- | --- | --- |
| `ipc.slow_ms` | histogram | да (окно 10 с) | `channel`, `duration_bucket` | IPC-обработчик длился дольше порога «медленно». |

### Отзывчивость UI

| Событие | Тип | Агрегируется | Теги | Назначение |
| --- | --- | --- | --- | --- |
| `ui.freeze.renderer_ms` | histogram | да (окно 10 с) | `duration_bucket`, `inflight_count`, `top_inflight` | Цикл событий renderer'а был заблокирован дольше порога заморозки. |
| `ui.freeze.main_ms` | histogram | да (окно 10 с) | `duration_bucket`, `inflight_count`, `top_inflight` | Цикл событий main-процесса был заблокирован (через `perf_hooks` delay). |

## Контакты

Вопросы или сомнения по поводу того, что мы собираем? Откройте issue на [github.com/mailcopilot/mailcopilot](https://github.com/mailcopilot/mailcopilot) или свяжитесь с командой напрямую через форму обратной связи в Настройки → О программе.
