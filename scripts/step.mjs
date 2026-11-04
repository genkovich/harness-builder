#!/usr/bin/env node
// npm run step 03   перейти на етап 03: код етапу, diff від попереднього, тести етапу.
// npm run step      показати, де ти зараз, і список етапів.
import { spawnSync } from 'node:child_process';

const git = (...args) => spawnSync('git', args, { encoding: 'utf8' });
const out = (...args) => git(...args).stdout.trim();
const show = (...args) => spawnSync('git', args, { stdio: 'inherit' });

const arg = process.argv[2];
const branches = out('branch', '-a', '--format=%(refname:short)')
  .split('\n')
  .map(name => name.replace(/^origin\//, ''))
  .filter(name => /^step-\d\d$/.test(name));
const steps = [...new Set(branches)].sort();

if (!arg) {
  console.log(`Ти на: ${out('rev-parse', '--abbrev-ref', 'HEAD')}`);
  console.log(`Етапи: ${steps.map(name => name.slice(5)).join(' ')}`);
  console.log('Перейти: npm run step 03');
  process.exit(0);
}

const number = String(arg).padStart(2, '0');
const target = `step-${number}`;
const previous = `step-${String(Number(number) - 1).padStart(2, '0')}`;
// Спершу беремо гілку з origin: якщо етап виправили під час заняття, отримаєш свіжу версію.
const hasOrigin = Boolean(out('remote'));
if (hasOrigin) git('fetch', 'origin', '--quiet');
const exists = name => git('rev-parse', '--verify', '--quiet', name).status === 0;
const ref = name => (hasOrigin && exists(`origin/${name}`) ? `origin/${name}` : name);

if (!exists(ref(target))) {
  console.error(`Етапу ${number} немає. Є: ${steps.map(name => name.slice(5)).join(' ')}`);
  process.exit(1);
}

// Свої правки не губимо: ховаємо їх у stash з підписом. .env, .data і node_modules git не чіпає.
if (out('status', '--porcelain')) {
  const message = `мої правки перед ${target}`;
  git('stash', 'push', '--include-untracked', '-m', message);
  console.log(`\x1b[33mТвої незакомічені правки збережено: git stash list → «${message}».\x1b[0m`);
}

const switched = git('switch', '--force-create', target, ref(target));
if (switched.status !== 0) {
  console.error(switched.stderr);
  process.exit(1);
}
console.log(`\x1b[36m${out('log', '-1', '--format=%s')}\x1b[0m\n`);

// Що змінилось порівняно з попереднім етапом (тести показуємо лише списком).
if (exists(ref(previous))) {
  show('--no-pager', 'diff', '--stat', ref(previous), 'HEAD');
  // -w: зміну відступів не показуємо, лише суть.
  show('--no-pager', 'diff', '-w', '--color=always', ref(previous), 'HEAD', '--', '.', ':(exclude)test', ':(exclude)package-lock.json');
}

console.log(`\n\x1b[36mТести етапу ${number}:\x1b[0m`);
const tests = spawnSync(process.execPath, ['scripts/test.mjs', '--step', number], { stdio: 'inherit' });
process.exit(tests.status ?? 1);
