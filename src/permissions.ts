import type { ToolSet } from 'ai';
import type { Decision } from './harness.ts';
import type { RunInfo } from './trace.ts';

// Дозволи на тули. Як у Claude Code: правила окремо від моделі, перевіряє код перед кожним викликом.

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

// OWNER_CHAT_ID читає код. У повідомлення моделі він не потрапляє.
export function isOwner(chatId: string) {
  const owner = process.env.OWNER_CHAT_ID?.trim();
  return Boolean(owner) && chatId === owner;
}

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

// Додатково для owner-only: чужий чат не бачить тул у списку взагалі. Модель не попросить те, про що не знає.
// PreToolUse лишається другим шаром, якщо модель усе одно вигадає виклик.
export function toolsFor(tools: ToolSet, chatId: string): ToolSet {
  if (isOwner(chatId)) {
    return tools;
  }
  return Object.fromEntries(Object.entries(tools).filter(([name]) => !ownerOnly.has(name)));
}
