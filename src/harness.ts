import { randomUUID } from 'node:crypto';
import {
  generateText,
  type JSONValue,
  type LanguageModelUsage,
  type ModelMessage,
  type ToolSet,
  type TypedToolCall,
} from 'ai';
import { costOf, type ModelInfo } from './model.ts';
import { approxTokens, tracer, type RunInfo } from './trace.ts';

// Запобіжник від нескінченного циклу і стеля відповіді (Groq Free не приймає max_tokens > 1000).
// Ліміти з .env і бюджет задачі зробимо на етапі 04.
const limits = { maxTurns: 10, maxOutputTokens: 1_000 };

export type Agent = {
  model: ModelInfo;
  system: string;
  tools: ToolSet;
  // Виконання тулів живе в нашому коді. Модель лише просить, а run каже, хто питає.
  runTool: (name: string, input: unknown, run: RunInfo) => Promise<JSONValue>;
};

export type StopReason = 'final' | 'max_turns';

export type RunResult = {
  runId: string;
  reason: StopReason;
  text: string;
  turns: number;
  costUsd: number | null;
  messages: ModelMessage[];
};

type Trace = ReturnType<typeof tracer>;

type ToolCall = TypedToolCall<ToolSet>;

export async function runAgent(
  agent: Agent,
  task: string,
  where: { channel: string; chatId: string },
): Promise<RunResult> {
  const run: RunInfo = { runId: randomUUID().slice(0, 8), ...where };
  const trace = tracer(run);
  const system = agent.system;
  const tools = agent.tools;
  // Уся «памʼять» моделі = цей масив. Що в нього не поклали, того вона не бачить.
  const messages: ModelMessage[] = [{ role: 'user', content: task }];
  let cost: number | null = agent.model.price ? 0 : null;
  let turn = 0;

  const stop = (reason: StopReason, text: string): RunResult => {
    trace('stop', { reason, text, turns: turn, costUsd: cost });
    return { runId: run.runId, reason, text, turns: turn, costUsd: cost, messages };
  };

  trace('start', { task, model: agent.model.id });

  while (turn < limits.maxTurns) {
    turn++;
    trace('request', {
      turn,
      system,
      messages,
      tools: Object.keys(tools),
      approxTokens: approxTokens(system + JSON.stringify(messages)),
    });

    const reply = await generateText({
      model: agent.model.model,
      system,
      messages,
      tools,
      maxOutputTokens: limits.maxOutputTokens,
      abortSignal: AbortSignal.timeout(60_000),
      // Зберегти сирий HTTP-запит, щоб показати його у веб-trace.
      include: { requestBody: true },
    });
    const turnCost = costOf(agent.model, reply.usage);
    if (cost !== null && turnCost !== null) {
      cost += turnCost;
    }

    trace('response', {
      turn,
      text: reply.text,
      toolCalls: reply.toolCalls.map(call => ({ id: call.toolCallId, name: call.toolName, input: call.input })),
      finishReason: reply.finishReason,
      usage: usageOf(reply.usage),
      costUsd: turnCost,
      totalCostUsd: cost,
      body: reply.request.body ?? null,
    });

    messages.push(...reply.responseMessages.filter(message => message.role === 'assistant'));

    // Немає запитів на тули: модель дала фінальну відповідь, виходимо з циклу.
    if (reply.toolCalls.length === 0) {
      return stop('final', reply.text.trim() || '(модель не повернула тексту)');
    }

    // На кожен tool call рівно один tool result з тим самим id.
    for (const call of reply.toolCalls) {
      const result = await executeTool(agent, call, run, trace, turn);
      messages.push(toolResult(call, result));
    }
  }

  return stop('max_turns', `Зупинився після ${limits.maxTurns} кроків. Задача може бути незавершена.`);
}

async function executeTool(
  agent: Agent,
  call: ToolCall,
  run: RunInfo,
  trace: Trace,
  turn: number,
): Promise<JSONValue> {
  const base = { turn, id: call.toolCallId, name: call.toolName };
  trace('tool_start', { ...base, input: call.input });
  const output = await agent.runTool(call.toolName, call.input, run);
  trace('tool_result', { ...base, output, chars: JSON.stringify(output)?.length ?? 0 });
  return output;
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

function toolResult(call: ToolCall, result: JSONValue): ModelMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: { type: 'json', value: result },
      },
    ],
  };
}
