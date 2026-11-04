# Події trace

Кожна подія: `{ type, runId, channel, chatId, at, ...поля }`. Один запуск агента (`runId`) = одна задача.
`channel`: `web` | `telegram` | `cli`. Пишуться в `.data/trace-<channel>.jsonl`, у браузер ідуть через SSE `GET /api/events`
(спершу до 2000 останніх подій, потім `event: ready`, потім живі).

| type | коли | поля |
|---|---|---|
| `start` | початок задачі | `task`, `model`, `limits {maxTurns, maxCostUsd, maxToolChars, maxOutputTokens, maxRetries, maxRetryWaitMs}` |
| `history` | один раз на старті (з етапу 07) | `loaded` (скільки повідомлень чату лежало у файлі), `kept` (скільки пішло в запит), `trimmed` (скільки найстаріших відкинуто, ріжемо лише перед user-повідомленням) |
| `context` | один раз на старті (з етапу 10) | `system {tokens}`, `tools [{name, tokens}]` (лише тули цього чату), `sections [{tag, source, tokens}]`, `history {messages, tokens}` (tokens ≈, оцінка) |
| `request` | перед кожним запитом до моделі | `turn`, `system`, `messages` (ModelMessage[] AI SDK, з етапу 07 разом з історією чату), `tools` (імена; з етапу 09 лише ті, що бачить цей чат), `approxTokens` |
| `response` | відповідь моделі | `turn`, `text`, `toolCalls [{id, name, input}]`, `finishReason`, `usage {input, output, cacheRead, cacheWrite}` (null = провайдер не повідомив), `costUsd` (null = ціни немає), `totalCostUsd`, `body` (сирий HTTP-запит до провайдера) |
| `retry` | повтор після 429/5xx | `turn`, `attempt`, `waitMs`, `status`, `message` |
| `pre_tool_use` | рішення PreToolUse для тула з правилами (з етапу 09) | `turn`, `id`, `name`, `allow`, `rule` (`DENY_TOOLS` або `owner-only`), `reason`, `result` (при відмові: що отримала модель) |
| `tool_start` | перед виконанням тула | `turn`, `id`, `name`, `input` |
| `tool_result` | тул відпрацював | `turn`, `id`, `name`, `output`, `chars`, `truncated` |
| `tool_error` | тул упав / аргументи не пройшли схему | `turn`, `id`, `name`, `error` |
| `limit` | спрацював ліміт | `kind: max_turns | max_cost`, `value`, `actual?` |
| `error` | модель не відповіла (після повторів) | `turn`, `message` |
| `stop` | кінець задачі | `reason: final | max_turns | max_cost | truncated | error | echo`, `text`, `turns`, `costUsd` |

HTTP: `GET /api/info` → `{ model, price, telegram, owner }` (ліміти беремо з `start.limits`, тули з `request.tools`); `POST /api/chat {text, chatId}` → `{ text, reason }` (відповідає, коли задача закінчилась; події йдуть паралельно в SSE).
На етапі 00 є лише `start` і `stop` (reason `echo`); на 01 зʼявляються `request`/`response`; tool-події з 02; `limit` з 04; `tool_error` з 03 (аргументи не за схемою), з 05 і для впалого тула; `retry` з 05; `history` з 07; `pre_tool_use` з 09; `context` з 10.
