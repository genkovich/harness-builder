import test from 'node:test';
import assert from 'node:assert/strict';
import { call, collect, sandbox, say, scriptedModel, testAgent, where } from './helpers.mjs';
import { runAgent } from '../src/harness.ts';
import { readSkill, runSkillTool, skillCatalog, skillTools } from '../src/tools/skills.ts';

sandbox();

const skillAgent = model =>
  testAgent(model, { tools: skillTools, runTool: async (name, input) => runSkillTool(name, input), context: [skillCatalog()] });

test('08 у каталозі лише опис skill, тіло не потрапляє в контекст', () => {
  const catalog = skillCatalog();
  assert.match(catalog.text, /standup: /);
  assert.doesNotMatch(catalog.text, /Зроблено; Далі; Блокери/);
});

test('08 каталог іде моделі в кожному запиті, тіло skill вона читає тулом', async () => {
  const { model, calls } = scriptedModel([[call('readSkill', { name: 'standup' }, 'call_skill')], say('Прочитав skill.')]);
  const trace = collect();
  await runAgent(skillAgent(model), 'Зроби стендап', where());
  trace.stop();
  assert.match(trace.of('request')[0].system, /<skills source="skills\/">/);
  const [result] = trace.of('tool_result');
  assert.equal(result.turn, 1);
  assert.match(result.output.text, /Зроблено; Далі; Блокери/);
  assert.doesNotMatch(JSON.stringify(calls[0].prompt), /Зроблено; Далі; Блокери/, 'до readSkill тіла в запиті немає');
});

test('08 модель знає поточну дату: стендапу треба «сьогодні»', async () => {
  const { model, calls } = scriptedModel([say('ok')]);
  await runAgent(skillAgent(model), 'Що в мене сьогодні?', where());
  const today = new Date().toISOString().slice(0, 10);
  // Де саме стоїть дата, вирішимо на етапі 10. Тут важливо, що вона є в запиті.
  assert.ok(JSON.stringify(calls[0].prompt).includes(today));
});

test('08 readSkill не відкриває довільні шляхи', () => {
  assert.throws(() => readSkill('../AGENTS'), /Невідомий skill/);
});
