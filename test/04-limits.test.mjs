import test from 'node:test';
import assert from 'node:assert/strict';
import { call, collect, sandbox, say, scriptedModel, testAgent, where } from './helpers.mjs';
import { runAgent } from '../src/harness.ts';
import { noteTools, runNoteTool, saveNote } from '../src/tools/notes.ts';

sandbox();

const notesAgent = (model, limits) =>
  testAgent(model, { tools: noteTools, runTool: async (name, input, run) => runNoteTool(name, input, run.chatId), limits });

test('04 max_turns: модель, що ніколи не зупиняється, зупиняє код', async () => {
  const { model, calls } = scriptedModel([[call('searchNotes', { query: '' })]]);
  const trace = collect();
  const result = await runAgent(notesAgent(model, { maxTurns: 3 }), 'Шукай', where());
  trace.stop();
  assert.equal(result.reason, 'max_turns');
  assert.equal(calls.length, 3);
  assert.equal(trace.of('limit')[0].kind, 'max_turns');
});

test('04 max_cost: бюджет задачі в доларах', async () => {
  const { model, calls } = scriptedModel([[call('searchNotes', { query: '' })]], { usage: { input: 10_000, output: 1_000 } });
  // Ціна тестової моделі: 10k × $1/M + 1k × $2/M = $0.012 за крок.
  const result = await runAgent(notesAgent(model, { maxCostUsd: 0.001 }), 'Шукай', where());
  assert.equal(result.reason, 'max_cost');
  assert.equal(calls.length, 1);
  assert.ok(result.costUsd > 0.001);
});

test('04 searchNotes по всіх нотатках обрізається, пара виклик-результат лишається', async () => {
  for (let i = 0; i < 30; i++) saveNote('busy', `Нотатка ${i}: ${'деталі '.repeat(10)}`);
  const { model, calls } = scriptedModel([[call('searchNotes', { query: '' }, 'call_all')], say('Ок.')]);
  const trace = collect();
  await runAgent(notesAgent(model, { maxToolChars: 500 }), 'Покажи всі нотатки', where('busy'));
  trace.stop();
  const [result] = trace.of('tool_result');
  assert.equal(result.truncated, true);
  assert.ok(result.chars > 500);
  assert.equal(result.output.preview.length, 500);
  assert.match(JSON.stringify(calls[1].prompt), /call_all[\s\S]*Результат обрізано/);
});
