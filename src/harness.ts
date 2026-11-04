import { randomUUID } from 'node:crypto';
import type { ModelInfo } from './model.ts';
import { tracer, type RunInfo } from './trace.ts';

export type Agent = {
  model: ModelInfo;
  system: string;
};

export type RunResult = {
  runId: string;
  reason: 'echo';
  text: string;
};

// Етап 00: харнес ще нічого не вміє, лише повертає задачу назад.
// Веб-чат, trace і doctor уже працюють. Модель підключимо на етапі 01.
export async function runAgent(
  agent: Agent,
  task: string,
  where: { channel: string; chatId: string },
): Promise<RunResult> {
  const run: RunInfo = { runId: randomUUID().slice(0, 8), ...where };
  const trace = tracer(run);
  trace('start', { task, model: agent.model.id });

  const text = `Ехо: ${task}`;
  trace('stop', { reason: 'echo', text, turns: 0, costUsd: null });
  return { runId: run.runId, reason: 'echo', text };
}
