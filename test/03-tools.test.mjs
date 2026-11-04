import test from 'node:test';
import assert from 'node:assert/strict';
import { call, collect, sandbox, say, scriptedModel, testAgent, where } from './helpers.mjs';
import { runAgent } from '../src/harness.ts';
import { noteTools, runNoteTool, saveNote, searchNotes } from '../src/tools/notes.ts';

sandbox();

const notesAgent = model =>
  testAgent(model, { tools: noteTools, runTool: async (name, input, run) => runNoteTool(name, input, run.chatId) });

test('03 searchNotes шукає лише в нотатках свого чату', () => {
  saveNote('olia', 'Реліз у пʼятницю');
  saveNote('olia', 'Купити каву');
  saveNote('petro', 'Реліз у четвер');
  assert.deepEqual(searchNotes('olia', 'реліз').map(note => note.text), ['Реліз у пʼятницю']);
  assert.equal(searchNotes('olia').length, 2, 'порожній запит = усі нотатки чату');
});

test('03 у трейсі виклик і результат мають той самий id', async () => {
  const { model } = scriptedModel([[call('searchNotes', { query: 'реліз' }, 'call_find')], say('Знайшов.')]);
  const trace = collect();
  await runAgent(notesAgent(model), 'Що там з релізом?', where('olia'));
  trace.stop();
  assert.equal(trace.of('response')[0].toolCalls[0].id, 'call_find');
  assert.equal(trace.of('tool_result')[0].id, 'call_find');
  assert.equal(trace.of('tool_result')[0].output.length, 1);
});

test('03 аргументи не за схемою не доходять до виконавця', async () => {
  const before = searchNotes('olia').length;
  const { model, calls } = scriptedModel([
    [call('saveNote', { text: '' }, 'call_bad')],
    say('Порожню нотатку не зберіг.'),
  ]);
  const trace = collect();
  await runAgent(notesAgent(model), 'Збережи порожню нотатку', where('olia'));
  trace.stop();
  assert.equal(trace.of('tool_start').length, 0, 'виконавця не викликали');
  assert.equal(searchNotes('olia').length, before, 'файл не змінився');
  assert.equal(trace.of('tool_error')[0].id, 'call_bad');
  // Модель отримала помилку як результат свого виклику.
  assert.match(JSON.stringify(calls[1].prompt), /call_bad[\s\S]*error/);
});
