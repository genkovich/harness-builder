# 08. Skill: стендап

[Усі етапи](README.md) · [Попередній](07-history.md) · [Наступний](09-permissions.md)

**Гілка:** `step-08`. Перейти: `npm run step 08`, далі перезапусти `npm run web`.

## Що додаємо і навіщо

Хочемо, щоб бот складав стендап з нотаток у сталому форматі: що зроблено, що далі, що блокує. Інструкцію для цього можна дописати в `system`, але тоді вона йтиме в кожен запит, навіть у «привіт», і їстиме контекст і гроші щоразу.

Skill вирішує це в два кроки. У `system` іде лише каталог: назва і один рядок опису кожного skill. Повний текст модель читає тулом `readSkill`, коли бачить, що опис підходить до задачі. Перший skill `skills/standup/SKILL.md` описує, як скласти стендап.

`readSkill` бере назву від моделі, але шукає її лише серед skills, які харнес знайшов на старті. Шлях від моделі на диск не йде, тож `../AGENTS` чи `../../.env` вона не прочитає.

Стендапу потрібне «сьогодні», а модель не знає, який зараз день. Тому в `system` зʼявляється поточний час. Тут він ламає одну річ, яку ми полагодимо на етапі 10. Поки просто запамʼятай, де він стоїть.

## Код

### Сам skill: `skills/standup/SKILL.md`

```md
---
name: standup
description: Скласти короткий стендап зі збережених нотаток (зроблено, далі, блокери). Використовуй, коли користувач просить стендап.
---
1. Виклич searchNotes з порожнім query: отримаєш усі нотатки користувача.
2. Розклади їх у три рядки: Зроблено; Далі; Блокери.
3. Не вигадуй фактів. Якщо для рядка нотаток немає, так і напиши.
```

Між `---` лежать назва й опис. Опис модель бачить завжди і лише за ним вирішує, чи потрібен skill. Першим кроком стоїть виклик тула. Без нього модель складе стендап з памʼяті розмови, і легко щось вигадає.

### Каталог: `src/tools/skills.ts`

```ts
export function skillCatalog(): Section {
  const header = 'Before working on a task that matches one of these skills, call readSkill with its name.';
  const lines = skills.map(skill => `${skill.name}: ${skill.description}`);
  return { tag: 'skills', source: 'skills/', text: [header, ...lines].join('\n') };
}
```

`description` береться з frontmatter `SKILL.md`. Без нього харнес не стартує: `Немає description у skills/<назва>/SKILL.md`.

### Читання тіла

```ts
export function readSkill(name: string) {
  // Обираємо зі знайдених skills, а не відкриваємо шлях від моделі.
  const skill = skills.find(item => item.name === name);
  if (!skill) {
    throw new Error(`Невідомий skill: ${name}. Є: ${skills.map(item => item.name).join(', ')}`);
  }
  return { name, text: skill.text };
}
```

Невідома назва кидає помилку. З етапу 05 вона йде моделі як результат, разом зі списком наявних skills.

### System = інструкції + каталог + час: `src/harness.ts`

```ts
export function renderSection(section: Section) {
  return `<${section.tag} source="${section.source}">\n${section.text.trim()}\n</${section.tag}>`;
}

// System = інструкції агента + файли проєкту + поточний час (стендапу треба знати, що таке «сьогодні»).
function systemOf(agent: Agent) {
  const sections = (agent.context ?? []).map(renderSection);
  return [agent.system, ...sections, `Current time: ${new Date().toISOString()}`].join('\n\n');
}
```

Каталог лягає в `system` у тегу `<skills source="skills/">`. Час стоїть у самому кінці `system`, і через це `system` тепер різний у кожному запиті. На етапі 10 побачимо, чому це погано для кешу, і перенесемо час.

### Агент: `src/agent.ts`

```ts
'Skills: check <skills> first. If a description matches the task, call readSkill before any other tool.',
// ...
const tools = { ...noteTools, ...skillTools };
// ...
context: [skillCatalog()],
```

## Спробуй

- Збережи дві-три нотатки, наприклад «Запамʼятай: вчора закрив тікет з логіном» і «Запамʼятай: чекаю доступ до проду від Петра». Потім «Зроби стендап». Першим кроком у trace має бути `readSkill` з `name: "standup"`, далі `searchNotes` з порожнім `query`. Відповідь розкладена на «Зроблено», «Далі», «Блокери».
- Розгорни «Запит до моделі» першого кроку і подивись на `system`: там каталог у `<skills source="skills/">` і рядок `Current time: ...`. Повного тексту skill там немає. Він зʼявляється лише в результаті `readSkill`.
- Спитай щось без стендапу, наприклад «Що в мене з релізом?». `readSkill` не має викликатись.

## Перевірка

```bash
npm test -- --step 08
```

- `08 у каталозі лише опис skill, тіло не потрапляє в контекст`.
- `08 каталог іде моделі в кожному запиті, тіло skill вона читає тулом`: `<skills source="skills/">` є в `system`, `readSkill` на першому кроці, у першому запиті тіла skill немає.
- `08 модель знає поточну дату: стендапу треба «сьогодні»`: сьогоднішня дата є в запиті.
- `08 readSkill не відкриває довільні шляхи`: `../AGENTS` дає `Невідомий skill`.

## Якщо не так

- Модель пропускає `readSkill` і одразу шукає: деякі моделі ігнорують каталог. Допиши в задачу «скористайся skill standup» або візьми сильнішу модель.
- Стендап з вигаданими пунктами: модель склала його з памʼяті розмови, без `searchNotes`. Перевір у trace, чи був виклик. Якщо історія чату заважає, почни новий чат.
- Новий skill не видно в каталозі: потрібна тека `skills/<назва>/SKILL.md` з рядком `description:` у frontmatter, і перезапуск `npm run web`.
- Панель «Контекст» досі пише «Зʼявиться на етапі 10»: так і є, подія `context` прийде на етапі 10. Каталог поки дивись у `system` запиту.
