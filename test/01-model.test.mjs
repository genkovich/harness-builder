import test from 'node:test';
import assert from 'node:assert/strict';
import { collect, sandbox, scriptedModel, say, testAgent, where } from './helpers.mjs';
import { runAgent } from '../src/harness.ts';
import { loadModel } from '../src/model.ts';

sandbox();

test('01 один запит: текст моделі, сирий запит, токени й ціна в trace', async () => {
  const { model, calls } = scriptedModel([say('Це відповідь моделі.')], { usage: { input: 100, output: 20 } });
  const trace = collect();
  const result = await runAgent(testAgent(model), 'Що таке харнес?', where());
  trace.stop();

  assert.equal(result.text, 'Це відповідь моделі.');
  assert.equal(calls.length, 1, 'рівно один запит до моделі');
  const [request] = trace.of('request');
  // З етапу 08 до system харнес дописує ще дещо, тож перевіряємо початок.
  assert.match(request.system, /^test system/);
  assert.match(JSON.stringify(request.messages), /Що таке харнес\?/);
  const [response] = trace.of('response');
  assert.deepEqual([response.usage.input, response.usage.output], [100, 20]);
  // 100 × $1 + 20 × $2 за мільйон токенів.
  assert.equal(response.costUsd, 0.00014);
  assert.ok(response.body, 'сирий HTTP-запит до провайдера');
});

test('01 MODEL ділиться лише по першому слешу', () => {
  process.env.GROQ_API_KEY ||= 'test';
  const info = loadModel('groq/qwen/qwen3.8-27b');
  assert.equal(info.provider, 'groq');
  assert.equal(info.name, 'qwen/qwen3.8-27b');
  assert.equal(info.keyEnv, 'GROQ_API_KEY');
  assert.throws(() => loadModel('gpt-4.1-mini'), /провайдер\/модель/);
  assert.throws(() => loadModel('nope/model'), /Невідомий провайдер/);
});

test('01 Groq: низьке зусилля міркувань, щоб відповідь влізла в 1000 токенів', async () => {
  const { generateText } = await import('ai');
  const original = globalThis.fetch;
  let body;
  globalThis.fetch = async (url, options) => {
    body = JSON.parse(options.body);
    return Response.json({
      id: 'x', object: 'chat.completion', created: 1, model: body.model,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
    });
  };
  try {
    process.env.GROQ_API_KEY ||= 'test';
    const reply = await generateText({ model: loadModel('groq/qwen/qwen3.8-27b').model, prompt: 'hi', maxOutputTokens: 1_000 });
    assert.equal(reply.text, 'ok');
    assert.equal(body.reasoning_effort, 'low');
    assert.equal(body.max_tokens, 1_000);
  } finally {
    globalThis.fetch = original;
  }
});

test('01 невідома ціна = null, нуль не підставляємо', () => {
  process.env.OPENAI_API_KEY ||= 'test';
  assert.equal(loadModel('openai/some-new-model').price, null);
  assert.ok(loadModel('openai/gpt-4.1-mini').price.input > 0);
});
