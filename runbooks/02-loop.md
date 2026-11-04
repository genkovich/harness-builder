# 02. Цикл і перший тул: saveNote

[Усі етапи](README.md) · [Попередній](01-model.md) · [Наступний](03-tools.md)

**Гілка:** `step-02`. Перейти: `npm run step 02`, далі перезапусти `npm run web`.

## Що додаємо і навіщо

Тут зʼявляється сам агент. Харнес питає модель у циклі: якщо вона просить тул, наш код його виконує, кладе результат в історію і питає знову. Немає запитів на тули, значить це фінальна відповідь, виходимо.

Перший тул `saveNote` зберігає нотатку. Модель тул лише просить. Виконує його `runTool` у нашому коді, і пише у файл теж наш код. Нотатки одразу лежать у `.data/notes.json`, тож їх можна відкрити й перевірити руками. «Я запамʼятав» від моделі нічого не доводить, рядок у файлі доводить.

У кожної нотатки є `chatId`, але в схемі тула його немає. Чат бере код з того, звідки прийшла задача: `run.chatId`. Модель не може записати нотатку в чужий чат, навіть якщо дуже захоче, бо такого аргументу просто не існує. На цьому правилі далі тримається і пошук, і видалення.

Тут же закриваємо перший баг каркаса з дня 1. Там ліміт кроків зупиняв цикл через `raise StopIteration` усередині `async def`, а Python у корутині перетворює це на `RuntimeError: coroutine raised StopIteration`. У нас кожен вихід з циклу = явний `return stop(...)` з причиною. Причина потім видна в trace.

Ліміт кроків поки константа `maxTurns: 10`, просто запобіжник від нескінченного циклу. Справжні ліміти зробимо на етапі 04.

## Код

### Цикл: `src/harness.ts`

```ts
while (turn < limits.maxTurns) {
  turn++;
  // trace('request', ...), generateText з tools, trace('response', ...)

  messages.push(...reply.responseMessages.filter(message => message.role === 'assistant'));

  // Немає запитів на тули: модель дала фінальну відповідь, виходимо з циклу.
  if (reply.toolCalls.length === 0) {
    return stop('final', reply.text.trim() || '(модель не повернула тексту)');
  }

  // На кожен tool call рівно один tool result з тим самим id.
  for (const call of reply.toolCalls) {
    const result = await executeTool(agent, call, run, trace, turn);
    messages.push(toolResult(call, result));
  }
}

return stop('max_turns', `Зупинився після ${limits.maxTurns} кроків. Задача може бути незавершена.`);
```

`stop` пише подію `stop` і повертає `RunResult` з причиною. Причин дві: `final` і `max_turns`.

### Результат тула з тим самим id

```ts
function toolResult(call: ToolCall, result: JSONValue): ModelMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: { type: 'json', value: result },
      },
    ],
  };
}
```

`toolCallId` звʼязує результат з викликом. Провайдер перевіряє цю пару: виклик без результату або результат без виклику він не прийме.

### Тул і сховище: `src/tools/notes.ts`

```ts
// Нотатки живуть у файлі, тож переживають перезапуск. Тести підставляють свій NOTES_FILE.
function notesFile() {
  return process.env.NOTES_FILE || '.data/notes.json';
}

export function saveNote(chatId: string, text: string) {
  const note = { id: randomUUID(), chatId, text: text.trim(), createdAt: new Date().toISOString() };
  writeNotes([...readNotes(), note]);
  return note;
}

const noteInput = z.object({ text: z.string() });

// У схемах немає chatId: модель не може його підмінити, його підставляє код.
export const noteTools = {
  saveNote: tool({
    description: 'Save one note for the user when they ask to remember something.',
    inputSchema: noteInput,
  }),
};
```

Схема поки слабка: `z.string()` пропустить і порожній рядок, і текст на мегабайт. Підтягнемо її на етапі 03.

### Агент знає про тул: `src/agent.ts`

```ts
const system = [
  'Role: a personal notes assistant in Telegram. The user saves notes and asks about them.',
  'Notes: call saveNote when the user asks to remember something. Never claim a note is saved without a tool result.',
  'The current chat is chosen by code, not by you.',
  'Answer in Ukrainian, plain text.',
].join('\n');

// ...
async runTool(name, input, run) {
  const output = runNoteTool(name, input, run.chatId);
  if (output === undefined) {
    throw new Error(`Невідомий тул: ${name}`);
  }
  return output as JSONValue;
},
```

Опис тула (`tools`) іде в модель, виконання (`runTool`) лишається в нас. `run` каже, хто питає: канал і `chatId`.

## Спробуй

Напиши у веб-чат «Запамʼятай: у пʼятницю реліз о 15:00». У trace буде два кроки:

1. «Модель просить тул»: `saveNote` з текстом нотатки, під ним «Результат» із записаною нотаткою.
2. Модель отримала результат і відповідає текстом.

Розгорни «Запит до моделі» другого кроку: у `messages` тепер задача, виклик тула і його результат з тим самим id.

Відкрий `.data/notes.json`. Там твоя нотатка з `"chatId": "web"`, бо таке значення стоїть у полі `chat id` веб-чату. Зміни поле на `olia`, збережи ще одну нотатку і подивись у файл ще раз.

Тепер спитай «Що в мене з релізом?». Знайти бот не зможе: тула для пошуку ще немає, а попередньої розмови модель не бачить. Пошук додамо на етапі 03.

## Перевірка

```bash
npm test -- --step 02
```

- `02 цикл: tool call → результат → фінальна відповідь`: два запити до моделі, у другому запиті є id виклику і текст нотатки.
- `02 нотатку записав наш код у файл, а chatId взяв з каналу`: у файлі одна нотатка з `chatId: 'olia'`, у схемі тула поля `chatId` немає.
- `02 немає tool call = кінець циклу з першої ж відповіді`: один запит, причина `final`.

Вручну: модель викликає `saveNote`, нотатка лежить у `.data/notes.json`.

## Якщо не так

- Модель каже «Запамʼятав», а в trace немає `saveNote` і файл порожній: деякі моделі погано працюють з тулами. Попроси прямо «збережи нотатку» або візьми іншу модель.
- `.data/notes.json` немає: файл зʼявляється з першою нотаткою.
- Запуск висить як «виконується», а в чаті «Сервер не прийняв задачу. HTTP 500: ...»: тул або модель кинули помилку, а ловити їх навчимося на етапі 05. Найчастіше це зіпсований руками `.data/notes.json`. Причина в терміналі.
