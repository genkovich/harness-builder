#!/usr/bin/env node
// npm test              усі тести етапів
// npm test -- --step 04 лише тести етапу 04
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

const args = process.argv.slice(2);
const at = args.indexOf('--step');
const step = at >= 0 ? String(args[at + 1] ?? '').padStart(2, '0') : null;
const files = readdirSync('test')
  .filter(name => name.endsWith('.test.mjs') && (!step || name.startsWith(`${step}-`)))
  .sort()
  .map(name => `test/${name}`);

if (files.length === 0) {
  console.error(step ? `Немає тестів етапу ${step}.` : 'Немає тестів.');
  process.exit(1);
}
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-reporter=spec', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
