import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { call, collect, sandbox, say, scriptedModel, testAgent, where } from './helpers.mjs';
import { runAgent } from '../src/harness.ts';
import { loadHistory, trimHistory } from '../src/history.ts';
import { noteTools, runNoteTool } from '../src/tools/notes.ts';

const dir = sandbox();

const notesAgent = model =>
  testAgent(model, { tools: noteTools, runTool: async (name, input, run) => runNoteTool(name, input, run.chatId) });
const sent = request => JSON.stringify(request.prompt);

test('07 памʼять розмови: другий запуск у тому ж чаті бачить перший, сусідній чат ні', async () => {
  const { model, calls } = scriptedModel([say('Привіт, Олю!'), say('Тебе звати Оля.'), say('Не знаю.')]);
  const trace = collect();
  await runAgent(notesAgent(model), 'Мене звати Оля', where('olia'));
  await runAgent(notesAgent(model), 'Як мене звати?', where('olia'));
  await runAgent(notesAgent(model), 'Як мене звати?', where('petro'));
  trace.stop();

  assert.doesNotMatch(sent(calls[0]), /Привіт, Олю/);
  assert.match(sent(calls[1]), /Мене звати Оля[\s\S]*Привіт, Олю![\s\S]*Як мене звати\?/, 'минулий обмін іде перед новим питанням');
  assert.doesNotMatch(sent(calls[2]), /Оля/, 'чужий чат не бачить цієї розмови');
  assert.deepEqual(trace.of('history').map(event => event.loaded), [0, 2, 0]);
});

test('07 історія лежить у файлі й переживає перезапуск', () => {
  // «Перезапуск»: читаємо файл напряму, як прочитав би новий процес.
  const onDisk = JSON.parse(readFileSync(join(process.env.HISTORY_DIR, 'olia.json'), 'utf8'));
  assert.deepEqual(onDisk.map(message => message.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(loadHistory('olia').length, 4);
});

test('07 у історію йдуть і виклики тулів, і їхні результати, і фінальна відповідь', async () => {
  const { model } = scriptedModel([[call('saveNote', { text: 'реліз у пʼятницю' }, 'call_save')], say('Зберіг.')]);
  await runAgent(notesAgent(model), 'Запамʼятай реліз', where('tools-chat'));
  const history = loadHistory('tools-chat');
  assert.deepEqual(history.map(message => message.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.match(JSON.stringify(history[2]), /call_save/);
});

// Обмін: питання → виклик тула → результат → відповідь. Чотири повідомлення.
const exchange = n => [
  { role: 'user', content: `питання ${n}` },
  { role: 'assistant', content: [{ type: 'tool-call', toolCallId: `c${n}`, toolName: 'searchNotes', input: {} }] },
  { role: 'tool', content: [{ type: 'tool-result', toolCallId: `c${n}`, toolName: 'searchNotes', output: { type: 'json', value: [] } }] },
  { role: 'assistant', content: `відповідь ${n}` },
];

test('07 обрізання історії ріже лише перед повідомленням користувача', () => {
  const messages = [1, 2, 3, 4, 5].flatMap(exchange);
  for (let max = 1; max <= messages.length; max++) {
    const { messages: kept, trimmed } = trimHistory(messages, max);
    assert.equal(kept[0].role, 'user', `max=${max}: починаємо з user`);
    assert.equal(kept.length + trimmed, messages.length);
    // Жодного tool result без свого tool call.
    const calls = new Set(kept.flatMap(m => (Array.isArray(m.content) ? m.content : [])).filter(p => p.type === 'tool-call').map(p => p.toolCallId));
    const results = kept.filter(m => m.role === 'tool').flatMap(m => m.content.map(p => p.toolCallId));
    assert.ok(results.every(id => calls.has(id)), `max=${max}: пара виклик-результат ціла`);
  }
  assert.equal(trimHistory(messages, 6).messages.length, 4, 'з 6 останніх вміщається лише один цілий обмін');
  assert.equal(trimHistory(messages, 100).trimmed, 0);
});

test('07 chatId з вебу не виводить файл історії за межі теки', async () => {
  const { model } = scriptedModel([say('ok')]);
  await runAgent(notesAgent(model), 'привіт', where('../../evil'));
  assert.equal(existsSync(join(dir, '..', 'evil.json')), false);
  assert.ok(readdirSync(process.env.HISTORY_DIR).some(name => name.includes('evil')));
});

test('07 зіпсований файл історії не валить чат: відкладаємо вбік і починаємо заново', async () => {
  mkdirSync(process.env.HISTORY_DIR, { recursive: true });
  writeFileSync(join(process.env.HISTORY_DIR, 'broken.json'), '{ зламаний json');
  const { model } = scriptedModel([say('Привіт!')]);
  const result = await runAgent(notesAgent(model), 'привіт', where('broken'));
  assert.equal(result.reason, 'final');
  assert.equal(loadHistory('broken').length, 2, 'нова історія з цього обміну');
  assert.ok(readdirSync(process.env.HISTORY_DIR).some(name => name.startsWith('broken.json.broken-')));
});

test('07 модель знає, що минулі повідомлення чату теж її памʼять', async () => {
  process.env.MODEL ||= 'openai/gpt-4.1-mini';
  process.env.OPENAI_API_KEY ||= 'test';
  const { createAgent } = await import('../src/agent.ts');
  // Без цього рядка gpt-4.1-mini на «як мене звати?» шукала імʼя в нотатках, хоча воно було в історії.
  assert.match(createAgent().system, /earlier messages of this chat are your conversation history/);
});
