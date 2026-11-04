// Спільне для тестів етапів: скриптована модель, тимчасові файли, свій чат на кожен тест. Мережі немає.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV4 } from 'ai/test';
import { bus } from '../src/trace.ts';

// Кожен тест пише trace, нотатки й історію чатів у тимчасову теку.
export function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'harness-test-'));
  process.env.TRACE_DIR = dir;
  process.env.NOTES_FILE = join(dir, 'notes.json');
  process.env.HISTORY_DIR = join(dir, 'history');
  return dir;
}

// Свій чат на кожен запуск: з етапу 07 історія одного тесту не підмішується в інший.
let chats = 0;
export const where = (chatId = `t${++chats}`) => ({ channel: 'test', chatId });

export const call = (name, input, id = `call_${name}`) => ({
  type: 'tool-call',
  toolCallId: id,
  toolName: name,
  input: JSON.stringify(input),
});
export const say = text => [{ type: 'text', text }];

// Модель відповідає по черзі заготовленими відповідями. Кожен запит зберігається в calls.
export function scriptedModel(replies, { usage = {}, finishReasons = [] } = {}) {
  const calls = [];
  let index = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async request => {
      calls.push(request);
      const reply = replies[Math.min(index, replies.length - 1)];
      if (reply instanceof Error) {
        index++;
        throw reply;
      }
      const finish = finishReasons[index] ?? (reply.some(part => part.type === 'tool-call') ? 'tool-calls' : 'stop');
      index++;
      return {
        content: reply,
        finishReason: { unified: finish, raw: finish },
        usage: {
          inputTokens: { total: usage.input ?? 100, noCache: (usage.input ?? 100) - (usage.cacheRead ?? 0), cacheRead: usage.cacheRead ?? 0, cacheWrite: 0 },
          outputTokens: { total: usage.output ?? 20, text: usage.output ?? 20, reasoning: 0 },
        },
        warnings: [],
        request: { body: { fake: true, turn: index } },
      };
    },
  });
  return { model, calls };
}

// Агент для тестів: лише те, що потрібно етапу, решта порожнє.
export function testAgent(model, extra = {}) {
  return { model: modelInfo(model), system: 'test system', context: [], tools: {}, runTool: async () => null, ...extra };
}

export function modelInfo(model, price = { input: 1, cachedInput: 0.5, output: 2 }) {
  return { id: 'test/mock', provider: 'test', name: 'mock', model, price, keyEnv: 'NONE' };
}

// Збираємо події шини під час тесту.
export function collect() {
  const events = [];
  const listener = event => events.push(event);
  bus.on('event', listener);
  return { events, stop: () => bus.off('event', listener), of: type => events.filter(event => event.type === type) };
}
