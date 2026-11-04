import test from 'node:test';
import assert from 'node:assert/strict';
import { call, collect, sandbox, say, scriptedModel, testAgent, where } from './helpers.mjs';
import { runAgent } from '../src/harness.ts';
import { noteTools, readNotes, runNoteTool } from '../src/tools/notes.ts';

sandbox();

const notesAgent = model =>
  testAgent(model, { tools: noteTools, runTool: async (name, input, run) => runNoteTool(name, input, run.chatId) });

test('02 цикл: tool call → результат → фінальна відповідь', async () => {
  const { model, calls } = scriptedModel([
    [call('saveNote', { text: 'реліз у пʼятницю о 15:00' }, 'call_1')],
    say('Запамʼятав: реліз у пʼятницю о 15:00.'),
  ]);
  const trace = collect();
  const result = await runAgent(notesAgent(model), 'Запамʼятай: реліз у пʼятницю о 15:00', where('olia'));
  trace.stop();

  assert.equal(result.reason, 'final');
  assert.equal(result.text, 'Запамʼятав: реліз у пʼятницю о 15:00.');
  assert.equal(calls.length, 2, 'два запити: з tool call і фінальний');
  assert.equal(trace.of('tool_result')[0].output.text, 'реліз у пʼятницю о 15:00');

  // Другий запит містить історію циклу: задачу, виклик тула і його результат.
  const second = JSON.stringify(calls[1].prompt);
  assert.match(second, /call_1/);
  assert.match(second, /реліз у пʼятницю/);
});

test('02 нотатку записав наш код у файл, а chatId взяв з каналу', async () => {
  const notes = readNotes();
  assert.equal(notes.length, 1);
  assert.equal(notes[0].chatId, 'olia');
  // У схемі тула немає chatId: модель не може записати нотатку в чужий чат.
  assert.equal('chatId' in noteTools.saveNote.inputSchema.shape, false);
});

test('02 немає tool call = кінець циклу з першої ж відповіді', async () => {
  const { model, calls } = scriptedModel([say('Привіт!')]);
  const result = await runAgent(notesAgent(model), 'Привіт', where());
  assert.equal(result.reason, 'final');
  assert.equal(calls.length, 1);
});
