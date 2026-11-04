import { randomUUID } from 'node:crypto';
import { generateText, type LanguageModelUsage, type ModelMessage } from 'ai';
import { costOf, type ModelInfo } from './model.ts';
import { approxTokens, tracer, type RunInfo } from './trace.ts';

export type Agent = {
  model: ModelInfo;
  system: string;
};

export type RunResult = {
  runId: string;
  reason: 'final';
  text: string;
  costUsd: number | null;
};

// Groq Free не приймає запит, де max_tokens > 1000.
const maxOutputTokens = 1_000;

export async function runAgent(
  agent: Agent,
  task: string,
  where: { channel: string; chatId: string },
): Promise<RunResult> {
  const run: RunInfo = { runId: randomUUID().slice(0, 8), ...where };
  const trace = tracer(run);
  trace('start', { task, model: agent.model.id });

  // Уся «памʼять» моделі = цей масив. Що в нього не поклали, того вона не бачить.
  const messages: ModelMessage[] = [{ role: 'user', content: task }];

  trace('request', {
    turn: 1,
    system: agent.system,
    messages,
    tools: [],
    approxTokens: approxTokens(agent.system + JSON.stringify(messages)),
  });

  const reply = await generateText({
    model: agent.model.model,
    system: agent.system,
    messages,
    maxOutputTokens,
    abortSignal: AbortSignal.timeout(60_000),
    // Зберегти сирий HTTP-запит, щоб показати його у веб-trace.
    include: { requestBody: true },
  });

  const costUsd = costOf(agent.model, reply.usage);
  trace('response', {
    turn: 1,
    text: reply.text,
    toolCalls: [],
    finishReason: reply.finishReason,
    usage: usageOf(reply.usage),
    costUsd,
    totalCostUsd: costUsd,
    body: reply.request.body ?? null,
  });

  const text = reply.text.trim() || '(модель не повернула тексту)';
  trace('stop', { reason: 'final', text, turns: 1, costUsd });
  return { runId: run.runId, reason: 'final', text, costUsd };
}

// null = провайдер цього числа не повідомив. Це не те саме, що нуль.
function usageOf(usage: LanguageModelUsage) {
  return {
    input: usage.inputTokens ?? null,
    output: usage.outputTokens ?? null,
    cacheRead: usage.inputTokenDetails?.cacheReadTokens ?? null,
    cacheWrite: usage.inputTokenDetails?.cacheWriteTokens ?? null,
  };
}
