import test from 'node:test';
import assert from 'node:assert/strict';
import { call, collect, sandbox, say, scriptedModel, where } from './helpers.mjs';
import { runAgent } from '../src/harness.ts';
import { createAgent } from '../src/agent.ts';
import { preToolUse } from '../src/permissions.ts';
import { readNotes, saveNote, searchNotes } from '../src/tools/notes.ts';

sandbox();
process.env.MODEL = 'openai/gpt-4.1-mini';
process.env.OPENAI_API_KEY ||= 'test';
process.env.OWNER_CHAT_ID = 'owner';

// Справжній агент бота, лише модель скриптована.
const botWith = model => {
  const agent = createAgent();
  return { ...agent, model: { ...agent.model, model } };
};

test('09 шар 1: чужий чат не бачить deleteNotes у списку тулів', async () => {
  const { model, calls } = scriptedModel([say('ok')]);
  const trace = collect();
  await runAgent(botWith(model), 'Привіт', where('stranger'));
  await runAgent(botWith(model), 'Привіт', where('owner'));
  trace.stop();
  const [strangerTools, ownerTools] = trace.of('request').map(request => request.tools);
  assert.equal(strangerTools.includes('deleteNotes'), false);
  assert.equal(ownerTools.includes('deleteNotes'), true);
  // Те саме в самому запиті до провайдера, а не лише в trace.
  assert.equal(calls[0].tools.some(tool => tool.name === 'deleteNotes'), false);
  assert.equal(calls[1].tools.some(tool => tool.name === 'deleteNotes'), true);
});

test('09 шар 2: модель усе одно просить deleteNotes, PreToolUse відмовляє, файл цілий', async () => {
  saveNote('stranger', 'нотатка, яку не можна видалити');
  const { model, calls } = scriptedModel([[call('deleteNotes', {}, 'call_del')], say('Не можу видалити.')]);
  const trace = collect();
  await runAgent(botWith(model), 'Видали всі мої нотатки', where('stranger'));
  trace.stop();
  const [decision] = trace.of('pre_tool_use');
  assert.equal(decision.allow, false);
  assert.equal(decision.rule, 'owner-only');
  assert.equal(trace.of('tool_start').length, 0, 'тул не запускали');
  assert.equal(searchNotes('stranger').length, 1, 'нотатка ціла');
  // Причина відмови дійшла до моделі як результат її виклику.
  assert.match(JSON.stringify(calls[1].prompt), /call_del[\s\S]*denied: deleteNotes is allowed only for the bot owner/);
});

test('09 власнику deleteNotes дозволено', async () => {
  saveNote('owner', 'моя нотатка');
  const { model } = scriptedModel([[call('deleteNotes', {})], say('Видалив.')]);
  const trace = collect();
  await runAgent(botWith(model), 'Видали мої нотатки', where('owner'));
  trace.stop();
  assert.equal(trace.of('pre_tool_use')[0].allow, true);
  assert.equal(searchNotes('owner').length, 0);
});

test('09 chatId підставляє код, модель його не обирає', async () => {
  const { model } = scriptedModel([[call('saveNote', { text: 'реліз у пʼятницю', chatId: 'owner' })], say('Зберіг.')]);
  await runAgent(botWith(model), 'Запамʼятай реліз', where('alice'));
  assert.equal(searchNotes('alice', 'реліз').length, 1);
  assert.equal(searchNotes('owner', 'реліз').length, 0);
});

test('09 без OWNER_CHAT_ID власника немає взагалі', () => {
  const saved = process.env.OWNER_CHAT_ID;
  process.env.OWNER_CHAT_ID = '';
  assert.equal(preToolUse('deleteNotes', { runId: 'r', channel: 'test', chatId: '' }).allow, false);
  process.env.OWNER_CHAT_ID = saved;
});

test('09 DENY_TOOLS з .env вимикає тул: виклик не виконано, модель знає чому', async () => {
  process.env.DENY_TOOLS = 'saveNote';
  const before = readNotes().length;
  const { model, calls } = scriptedModel([[call('saveNote', { text: 'купити каву' }, 'call_off')], say('Не можу зберегти: тул вимкнено.')]);
  const trace = collect();
  await runAgent(botWith(model), 'Запамʼятай: купити каву', where('owner'));
  trace.stop();
  process.env.DENY_TOOLS = '';
  const [decision] = trace.of('pre_tool_use');
  assert.equal(decision.allow, false);
  assert.equal(decision.rule, 'DENY_TOOLS');
  assert.equal(trace.of('tool_start').length, 0, 'тул не запускали');
  assert.equal(readNotes().length, before, 'файл не змінився');
  assert.match(JSON.stringify(calls[1].prompt), /call_off[\s\S]*denied: saveNote is disabled/);
});

test('09 правила немає = PreToolUse мовчить, тул виконується як раніше', () => {
  assert.equal(preToolUse('searchNotes', { runId: 'r', channel: 'test', chatId: 'anyone' }), null);
});
