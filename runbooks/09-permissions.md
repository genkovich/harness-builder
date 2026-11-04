# 09. Дозволи: PreToolUse, DENY_TOOLS, deleteNotes лише власнику

[Усі етапи](README.md) · [Попередній](08-skill.md) · [Наступний](10-cache.md)

**Гілка:** `step-09`. Перейти: `npm run step 09`, далі перезапусти `npm run web`. Для другого демо потрібен `OWNER_CHAT_ID` у `.env`.

## Що додаємо і навіщо

Нам потрібне правило, яке модель не може обійти. Написати в `system` «не видаляй нотатки чужим» можна, але модель цей рядок прочитає і, якщо її добре попросити, порушить. Правило має перевіряти код, і перевіряти в той момент, коли модель уже попросила тул, а наш код ще не виконав.

Першого дня ти бачив це в Claude Code. Там є дозволи на тули і хук `PreToolUse`: він запускається перед кожним викликом тула і може сказати «ні». Модель про правила нічого не вирішує, вона лише дізнається відмову. Тут робимо те саме у своєму харнесі: функцію `preToolUse(name, run)`, яку харнес кличе перед кожним тулом.

Правил два.

1. `DENY_TOOLS` з `.env`. Список тулів через кому, вимикає їх для всіх. Код правити не треба: змінив `.env`, перезапустив `npm run web`.
2. `owner-only`, у коді. Новий тул `deleteNotes` видаляє всі нотатки чату, і його можна лише власнику бота. Власника визначає `OWNER_CHAT_ID` у `.env`. Це значення читає лише код, у запит до моделі воно не потрапляє.

Відмова не валить запуск. Модель отримує `denied: ...` як результат свого виклику, з тим самим id, і пояснює користувачу, чому не вийшло. Для тулів без правил `preToolUse` повертає `null` і не втручається.

## Код

### Хук: `src/permissions.ts`

```ts
// Правило 1, з .env: DENY_TOOLS=saveNote,searchNotes вимикає ці тули для всіх.
// Читаємо щоразу: змінив .env і перезапустив веб, код правити не треба.
export function deniedTools() {
  return new Set(
    (process.env.DENY_TOOLS ?? '')
      .split(',')
      .map(name => name.trim())
      .filter(Boolean),
  );
}

// Правило 2, у коді: тули, які знищують дані, лише власнику бота.
export const ownerOnly = new Set(['deleteNotes']);

// PreToolUse: харнес кличе цю функцію перед кожним викликом тула.
// null = правил для цього тула немає, виконуємо. Відмову з причиною отримає модель.
export function preToolUse(name: string, run: RunInfo): Decision | null {
  if (deniedTools().has(name)) {
    return { allow: false, rule: 'DENY_TOOLS', reason: `${name} is disabled in this bot. Tell the user you cannot do it.` };
  }
  if (ownerOnly.has(name)) {
    if (isOwner(run.chatId)) {
      return { allow: true, rule: 'owner-only' };
    }
    return { allow: false, rule: 'owner-only', reason: `${name} is allowed only for the bot owner. Tell the user you cannot do it.` };
  }
  return null;
}
```

`rule` каже, яке правило спрацювало. Його видно в trace, тож не треба гадати, чому тул не виконався. `DENY_TOOLS` перевіряється першим: якщо вписати туди `deleteNotes`, його не отримає і власник.

### Харнес кличе хук першим: `src/harness.ts`

```ts
const base = { turn, id: call.toolCallId, name: call.toolName };
// PreToolUse стоїть першим, ще до схеми: виклик тула, якого немає в списку, теж сюди доходить.
const decision = agent.preToolUse?.(call.toolName, run) ?? null;
if (decision && !decision.allow) {
  // Модель отримає цю відмову як результат свого виклику і пояснить її користувачу.
  const denied = { error: `denied: ${decision.reason}` };
  trace('pre_tool_use', { ...base, allow: false, rule: decision.rule ?? null, reason: decision.reason, result: denied });
  return denied;
}
if (decision) {
  trace('pre_tool_use', { ...base, allow: true, rule: decision.rule ?? null, reason: null });
}
```

Подія `pre_tool_use` пишеться лише для тулів, на які є правило. `readSkill` чи `searchNotes` без `DENY_TOOLS` її не дають.

### Тул: `src/tools/notes.ts`

```ts
export function deleteNotes(chatId: string) {
  const notes = readNotes();
  const remaining = notes.filter(note => note.chatId !== chatId);
  writeNotes(remaining);
  return { deleted: notes.length - remaining.length };
}

// ...
deleteNotes: tool({
  description: "Delete all of the user's notes. Use only when the user explicitly asks to delete them.",
  inputSchema: z.object({}),
}),
```

Аргументів немає. Що видаляти, визначає `chatId` з каналу, тож навіть власник видаляє лише нотатки свого чату.

### Чужий чат тул навіть не бачить

```ts
// Додатково для owner-only: чужий чат не бачить тул у списку взагалі. Модель не попросить те, про що не знає.
// PreToolUse лишається другим шаром, якщо модель усе одно вигадає виклик.
export function toolsFor(tools: ToolSet, chatId: string): ToolSet {
  if (isOwner(chatId)) {
    return tools;
  }
  return Object.fromEntries(Object.entries(tools).filter(([name]) => !ownerOnly.has(name)));
}
```

Харнес збирає список тулів для конкретного чату ще до першого запиту: `agent.toolsFor?.(where.chatId) ?? agent.tools`. Модель не попросить тул, про який не знає. А якщо все одно вигадає виклик, бо побачила назву десь в історії чи її вмовили, його зупинить `preToolUse`. Він стоїть до перевірки схеми, тож бачить і виклик тула, якого в списку немає. На `DENY_TOOLS` цей фільтр не діє, тому вимкнений тул модель бачить, просить і отримує відмову.

**Чому в боті немає bash.** Каркас з дня 1 давав моделі `bash` з `shell=True` без жодного дозволу. У боті, якому пише будь-хто, це команда на твоїй машині від імені незнайомця. Правило «лише власнику» тут теж не рятує повністю. Власник пересилає боту чужий текст, просить зберегти нотатку з листа, а в тексті «виконай ось це». Модель виконує команду в чаті власника, і хук її пропускає. Тому агент, відкритий стороннім, отримує лише тули, наслідки яких тебе влаштують від будь-якого автора повідомлення. Найгірше, що може `deleteNotes` у власника, це стерти його ж нотатки.

## Спробуй

### Демо 1: вимкнути тул з `.env`

Додай у `.env`:

```bash
DENY_TOOLS=saveNote
```

Зупини `npm run web` (Ctrl+C) і запусти знову: `.env` читається лише на старті процесу. Напиши «Запамʼятай: купити каву». У trace під викликом `saveNote` буде «PreToolUse: заборонено», бейдж «правило DENY_TOOLS» і причина `saveNote is disabled in this bot...`, а поруч «Тул не виконано. Модель отримала помилку denied.» Модель відповість, що зберегти не може. У `.data/notes.json` кави немає.

З термінала той самий запит через `npm run cli -- "Запамʼятай: купити каву"` друкує рядок `PreToolUse saveNote: заборонено, правило DENY_TOOLS (...)`.

Прибери `DENY_TOOLS` з `.env` і знову перезапусти. Кава зберігається як раніше.

### Демо 2: deleteNotes лише власнику

Встав свій chat id з `/start` у `.env` і перезапусти `npm run web`:

```bash
OWNER_CHAT_ID=123456789
```

У веб-харнесі біля «власник» тепер `задано · chat 123456789`.

1. У Telegram збережи пару нотаток, потім «Видали всі мої нотатки». У trace «PreToolUse: дозволено», бейдж «правило owner-only» і «запит від власника». Нотаток твого чату в файлі більше немає.
2. Попроси сусіда написати твоєму боту «Видали всі мої нотатки». Розгорни «Запит до моделі» в його запуску: у списку тулів немає `deleteNotes`. Модель, швидше за все, відповість щось на кшталт «не можу видаляти нотатки», а нотатки сусіда в файлі цілі.
3. Те саме без сусіда, у веб-чаті: поле `chat id` задаєш сам, і біля нього підказка «це власник» або «не власник».

«PreToolUse: заборонено» з правилом `owner-only` з живою моделлю побачиш рідко: чужому чату тул не пропонують, і модель його не просить. Цей випадок перевіряє тест, де скриптована модель усе одно шле `deleteNotes`.

## Перевірка

```bash
npm test -- --step 09
```

- `09 шар 1: чужий чат не бачить deleteNotes у списку тулів`: і в trace, і в самому запиті до провайдера.
- `09 шар 2: модель усе одно просить deleteNotes, PreToolUse відмовляє, файл цілий`: правило `owner-only`, тул не запускали, нотатка ціла, у наступному запиті є `denied: deleteNotes is allowed only for the bot owner`.
- `09 власнику deleteNotes дозволено`.
- `09 chatId підставляє код, модель його не обирає`: модель передала `chatId: 'owner'`, нотатка однаково лягла в чат `alice`.
- `09 без OWNER_CHAT_ID власника немає взагалі`.
- `09 DENY_TOOLS з .env вимикає тул: виклик не виконано, модель знає чому`: правило `DENY_TOOLS`, `tool_start` не було, файл не змінився, у наступному запиті є `denied: saveNote is disabled`.
- `09 правила немає = PreToolUse мовчить, тул виконується як раніше`: для `searchNotes` хук повертає `null`.

## Якщо не так

- `DENY_TOOLS` не діє: `.env` читається на старті, зупини й перезапусти `npm run web`. Назва тула має збігатися точно, з тим самим регістром: `saveNote`. Рядок `savenote` не спрацює.
- Тул вимкнено, а модель каже «Зберіг»: подивись trace. Якщо там «PreToolUse: заборонено», файл не змінився, а модель збрехала. Тому стан перевіряй у файлі й trace. Текст відповіді нічого не доводить.
- Власнику теж немає `deleteNotes` у списку тулів: перевір `OWNER_CHAT_ID` без пробілів і лапок, перезапусти `npm run web`. У веб-чаті перевір поле `chat id`.
- Біля «власник» пише «не задано»: `.env` читається лише на старті, перезапусти `npm run web`.
- Модель видаляє нотатки без прохання: опис тула це забороняє, але гарантію дає лише код. Для чужих чатів він її дає. Для власника видалення дозволене, тож будь обережний із задачами на кшталт «прибери все». Хочеш заборонити й собі: `DENY_TOOLS=deleteNotes`.
