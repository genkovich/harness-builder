import type { ModelMessage } from 'ai';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Памʼять розмови: усі повідомлення чату лежать у файлі й переживають перезапуск.
// Модель сама нічого не памʼятає. Що код не поклав у запит, того вона не бачить.
export const maxHistoryMessages = 40;

function historyDir() {
  return process.env.HISTORY_DIR || '.data/history';
}

// chatId у вебі задає користувач. У назві файла лишаємо лише безпечні символи,
// інакше «../../щось» вийшло б за межі теки.
function historyFile(chatId: string) {
  return join(historyDir(), `${chatId.replace(/[^\w-]/g, '_')}.json`);
}

export function loadHistory(chatId: string): ModelMessage[] {
  const file = historyFile(chatId);
  if (!existsSync(file)) {
    return [];
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    // Зіпсований файл не має валити кожен запуск цього чату. Відкладаємо його вбік і починаємо з чистої історії.
    const broken = `${file}.broken-${Date.now()}`;
    renameSync(file, broken);
    console.error(`Історія чату ${chatId} не читається (${error instanceof Error ? error.message : error}), відклав у ${broken}.`);
    return [];
  }
}

export function saveHistory(chatId: string, messages: ModelMessage[]) {
  mkdirSync(historyDir(), { recursive: true });
  writeFileSync(historyFile(chatId), JSON.stringify(messages, null, 2), 'utf8');
}

// Старі повідомлення відкидаємо, але ріжемо лише перед повідомленням користувача.
// Так tool result ніколи не лишиться без свого tool call: пара живе в межах одного обміну.
export function trimHistory(messages: ModelMessage[], max = maxHistoryMessages) {
  if (messages.length <= max) {
    return { messages, trimmed: 0 };
  }
  let start = messages.findIndex((message, index) => index >= messages.length - max && message.role === 'user');
  if (start < 0) {
    // В останніх max повідомленнях немає жодного user: беремо останній обмін цілим, навіть якщо він довший.
    start = messages.map(message => message.role).lastIndexOf('user');
  }
  if (start < 0) {
    return { messages: [], trimmed: messages.length };
  }
  return { messages: messages.slice(start), trimmed: start };
}
