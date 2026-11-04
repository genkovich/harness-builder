import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { APICallError } from 'ai';
import { call, collect, sandbox, say, scriptedModel, testAgent, where } from './helpers.mjs';
import { runAgent } from '../src/harness.ts';
import { noteTools, runNoteTool } from '../src/tools/notes.ts';

sandbox();

const notesAgent = (model, extra) =>
  testAgent(model, { tools: noteTools, runTool: async (name, input, run) => runNoteTool(name, input, run.chatId), ...extra });

test('05 помилка тула повертається моделі як дані, цикл живе далі', async () => {
  // Файл нотаток зіпсовано: readNotes кидає SyntaxError.
  writeFileSync(process.env.NOTES_FILE, '{ зламаний json');
  const { model, calls } = scriptedModel([[call('searchNotes', { query: '' }, 'call_x')], say('Не можу прочитати нотатки.')]);
  const trace = collect();
  const result = await runAgent(notesAgent(model), 'Покажи нотатки', where());
  trace.stop();
  writeFileSync(process.env.NOTES_FILE, '[]');
  assert.equal(result.reason, 'final');
  assert.equal(trace.of('tool_error')[0].id, 'call_x');
  assert.match(JSON.stringify(calls[1].prompt), /call_x[\s\S]*error/);
});

test('05 429 з Retry-After: чекаємо й повторюємо, повтор видно в trace', async () => {
  const limited = new APICallError({
    message: 'Rate limit reached',
    url: 'https://api.example/v1',
    requestBodyValues: {},
    statusCode: 429,
    responseHeaders: { 'retry-after': '0' },
    isRetryable: true,
  });
  const { model, calls } = scriptedModel([limited, say('Вийшло з другої спроби.')]);
  const trace = collect();
  const result = await runAgent(testAgent(model), 'Привіт', where());
  trace.stop();
  assert.equal(result.text, 'Вийшло з другої спроби.');
  assert.equal(calls.length, 2);
  assert.equal(trace.of('retry')[0].status, 429);
  assert.equal(trace.of('retry')[0].waitMs, 0);
});

test('05 «Request too large» не повторюємо: той самий запит не пройде', async () => {
  const tooLarge = new APICallError({
    message: 'Request too large on output tokens per minute',
    url: 'https://api.example/v1',
    requestBodyValues: {},
    statusCode: 429,
    isRetryable: true,
  });
  const { model, calls } = scriptedModel([tooLarge, say('не дійде')]);
  const result = await runAgent(testAgent(model), 'Привіт', where());
  assert.equal(result.reason, 'error');
  assert.equal(calls.length, 1);
});

test('05 обрізана відповідь моделі: тули з неї не виконуємо', async () => {
  let ran = 0;
  const { model } = scriptedModel([[call('saveNote', { text: 'напів' })]], { finishReasons: ['length'] });
  const result = await runAgent(notesAgent(model, { runTool: async () => (ran++, null) }), 'Запамʼятай', where());
  assert.equal(result.reason, 'truncated');
  assert.equal(ran, 0);
});
