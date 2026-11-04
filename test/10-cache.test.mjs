import test from 'node:test';
import assert from 'node:assert/strict';
import { collect, sandbox, say, scriptedModel, where } from './helpers.mjs';
import { runAgent } from '../src/harness.ts';
import { createAgent } from '../src/agent.ts';

sandbox();
process.env.MODEL = 'openai/gpt-4.1-mini';
process.env.OPENAI_API_KEY ||= 'test';

const botWith = (model, extra = {}) => {
  const agent = createAgent();
  return { ...agent, model: { ...agent.model, model, ...extra } };
};
const systemOf = request => request.prompt.find(message => message.role === 'system').content;

test('10 AGENTS.md іде в system, у trace видно, скільки займає кожна частина', async () => {
  const { model, calls } = scriptedModel([say('ok')]);
  const trace = collect();
  await runAgent(botWith(model), 'Привіт', where());
  trace.stop();
  assert.match(systemOf(calls[0]), /<project source="AGENTS.md">[\s\S]*простий текст/);
  const [context] = trace.of('context');
  assert.ok(context.sections.some(section => section.source === 'AGENTS.md' && section.tokens > 0));
  assert.ok(context.tools.some(tool => tool.name === 'saveNote'));
});

test('10 префікс запиту однаковий байт у байт: system, тули, історія', async () => {
  const { model, calls } = scriptedModel([say('Привіт, Олю!'), say('Тебе звати Оля.')]);
  await runAgent(botWith(model), 'Мене звати Оля', where('olia'));
  await new Promise(resolve => setTimeout(resolve, 5)); // час точно інший
  await runAgent(botWith(model), 'Як мене звати?', where('olia'));
  const [first, second] = calls;

  assert.equal(systemOf(first), systemOf(second), 'system однаковий');
  assert.doesNotMatch(systemOf(first), /\d{4}-\d{2}-\d{2}T/, 'у system немає часу');
  assert.deepEqual(first.tools, second.tools, 'тули однакові');
  // Перше повідомлення другого запуску = те саме повідомлення, що пішло в першому.
  const user = request => request.prompt.filter(message => message.role === 'user');
  assert.deepEqual(user(second)[0].content, user(first)[0].content);
  // Час стоїть у самому кінці нового повідомлення.
  assert.match(JSON.stringify(user(second).at(-1).content), /Як мене звати\?\\n\\n<now>\d{4}-\d{2}-\d{2}T[^<]+<\/now>/);
});

test('10 позначка кешу для Anthropic лише на останньому повідомленні запиту і не в історії', async () => {
  const { model, calls } = scriptedModel([say('ok'), say('ok')]);
  await runAgent(botWith(model), 'перше', where('cache'));
  await runAgent(botWith(model), 'друге', where('cache'));
  const marked = calls[1].prompt.filter(message => message.providerOptions?.anthropic?.cacheControl);
  assert.equal(marked.length, 1, 'одна позначка, а не по одній на кожен минулий запуск');
  assert.equal(marked[0], calls[1].prompt.at(-1));
});

test('10 cache read з usage видно в trace, і він здешевлює запит', async () => {
  const { model } = scriptedModel([say('ok')], { usage: { input: 2_000, cacheRead: 1_536, output: 10 } });
  const trace = collect();
  await runAgent(botWith(model), 'Задача', where());
  trace.stop();
  const [response] = trace.of('response');
  assert.equal(response.usage.cacheRead, 1_536);
  // gpt-4.1-mini: 464 × $0.40 + 1536 × $0.10 + 10 × $1.60 за мільйон.
  assert.equal(response.costUsd.toFixed(7), ((464 * 0.4 + 1536 * 0.1 + 10 * 1.6) / 1e6).toFixed(7));
});
