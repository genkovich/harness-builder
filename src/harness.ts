import { randomUUID } from 'node:crypto';
import {
  APICallError,
  generateText,
  type JSONValue,
  type LanguageModelUsage,
  type ModelMessage,
  type ToolSet,
  type TypedToolCall,
} from 'ai';
import { loadHistory, saveHistory, trimHistory } from './history.ts';
import { costOf, type ModelInfo } from './model.ts';
import { approxTokens, tracer, type RunInfo } from './trace.ts';

// Шматок контексту з файла проєкту: тег, звідки взяли, текст.
export type Section = { tag: string; source: string; text: string };

// Рішення PreToolUse. rule = яке правило спрацювало, щоб у trace було видно причину.
export type Decision = { allow: true; rule?: string } | { allow: false; rule?: string; reason: string };

export type Limits = {
  maxTurns: number; // скільки разів максимум питаємо модель за одну задачу
  maxCostUsd: number; // бюджет однієї задачі
  maxToolChars: number; // довший результат тула обрізаємо, щоб не забити контекст
  maxOutputTokens: number; // Groq Free не приймає запит, де max_tokens > 1000
  maxRetries: number;
  maxRetryWaitMs: number;
};

export const defaultLimits: Limits = {
  maxTurns: 8,
  maxCostUsd: 0.05,
  maxToolChars: 6_000,
  maxOutputTokens: 1_000,
  maxRetries: 2,
  maxRetryWaitMs: 30_000,
};

export type Agent = {
  model: ModelInfo;
  system: string;
  // Файли проєкту, які харнес додає до system: каталог skills, з етапу 10 ще й AGENTS.md.
  context?: Section[];
  tools: ToolSet;
  // Які тули бачить цей чат. Немає функції = усі тули для всіх.
  toolsFor?: (chatId: string) => ToolSet;
  // Виконання тулів живе в нашому коді. Модель лише просить, а run каже, хто питає.
  runTool: (name: string, input: unknown, run: RunInfo) => Promise<JSONValue>;
  // PreToolUse: перевірка перед кожним викликом тула, як хук у Claude Code. null = правил немає.
  preToolUse?: (name: string, run: RunInfo) => Decision | null;
  limits?: Partial<Limits>;
};

export type StopReason = 'final' | 'max_turns' | 'max_cost' | 'truncated' | 'error';

export type RunResult = {
  runId: string;
  reason: StopReason;
  text: string;
  turns: number;
  costUsd: number | null;
  messages: ModelMessage[];
};

type Trace = ReturnType<typeof tracer>;

// Порожні значення з .env не перебивають типові ліміти.
export function withDefaults(custom: Partial<Limits> = {}): Limits {
  const set = Object.entries(custom).filter(([, value]) => value !== undefined);
  return { ...defaultLimits, ...Object.fromEntries(set) };
}

type ToolCall = TypedToolCall<ToolSet>;

export function renderSection(section: Section) {
  return `<${section.tag} source="${section.source}">\n${section.text.trim()}\n</${section.tag}>`;
}

// System = інструкції агента + файли проєкту. Між задачами він однаковий байт у байт,
// тож разом зі списком тулів і історією чату це стабільний префікс, який провайдер бере з кешу.
function systemOf(agent: Agent) {
  return [agent.system, ...(agent.context ?? []).map(renderSection)].join('\n\n');
}

// Час міняється щозапиту, тому стоїть у самому кінці, після всього стабільного.
// У історію повідомлення йде саме таким, тож наступний запит почнеться з тих самих байтів.
function userMessage(task: string): ModelMessage {
  return { role: 'user', content: `${task}\n\n<now>${new Date().toISOString()}</now>` };
}

// Anthropic кешує лише до позначки cacheControl. Ставимо її на останнє повідомлення запиту
// і не зберігаємо в історію: інакше позначки накопичувались би (Anthropic приймає до чотирьох).
// OpenAI і Groq кешують префікс самі, без позначок.
function markCache(messages: ModelMessage[]): ModelMessage[] {
  const last = messages.at(-1);
  if (!last) {
    return messages;
  }
  return [...messages.slice(0, -1), { ...last, providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } }];
}

export async function runAgent(
  agent: Agent,
  task: string,
  where: { channel: string; chatId: string },
): Promise<RunResult> {
  const run: RunInfo = { runId: randomUUID().slice(0, 8), ...where };
  const trace = tracer(run);
  const limits = withDefaults(agent.limits);
  const system = systemOf(agent);
  // Список тулів залежить від того, хто питає. Вирішує код, до першого запиту.
  const tools = agent.toolsFor?.(where.chatId) ?? agent.tools;
  // Памʼять розмови: спершу минулі повідомлення цього чату, нове повідомлення в кінці.
  const history = loadHistory(where.chatId);
  const kept = trimHistory(history);
  // Уся «памʼять» моделі = цей масив. Що в нього не поклали, того вона не бачить.
  const messages: ModelMessage[] = [...kept.messages, userMessage(task)];
  let cost: number | null = agent.model.price ? 0 : null;
  let turn = 0;

  const stop = (reason: StopReason, text: string): RunResult => {
    // Користувач бачив цей текст, тож і в історії він має бути. Фінальна відповідь моделі вже в messages.
    if (reason !== 'final') {
      messages.push({ role: 'assistant', content: text });
    }
    saveHistory(where.chatId, messages);
    trace('stop', { reason, text, turns: turn, costUsd: cost });
    return { runId: run.runId, reason, text, turns: turn, costUsd: cost, messages };
  };

  trace('start', { task, model: agent.model.id, limits });
  trace('history', { loaded: history.length, kept: kept.messages.length, trimmed: kept.trimmed });
  trace('context', {
    system: { tokens: approxTokens(agent.system) },
    tools: Object.entries(tools).map(([name, tool]) => ({
      name,
      tokens: approxTokens(name + (tool.description ?? '')),
    })),
    sections: (agent.context ?? []).map(section => ({
      tag: section.tag,
      source: section.source,
      tokens: approxTokens(section.text),
    })),
    history: { messages: kept.messages.length, tokens: approxTokens(JSON.stringify(kept.messages)) },
  });

  try {
    while (turn < limits.maxTurns) {
      turn++;
      trace('request', {
        turn,
        system,
        messages,
        tools: Object.keys(tools),
        approxTokens: approxTokens(system + JSON.stringify(messages)),
      });

      const reply = await callModel(agent.model, system, messages, tools, limits, trace, turn);
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

      // Обрізана відповідь: аргументи тулів можуть бути неповні, тож нічого не виконуємо.
      if (reply.finishReason === 'length') {
        return stop('truncated', 'Відповідь моделі обрізано на maxOutputTokens. Тули з неї не виконую, спробуй коротшу задачу.');
      }

      messages.push(...reply.responseMessages.filter(message => message.role === 'assistant'));

      // Немає запитів на тули: модель дала фінальну відповідь, виходимо з циклу.
      if (reply.toolCalls.length === 0) {
        return stop('final', reply.text.trim() || '(модель не повернула тексту)');
      }

      // На кожен tool call рівно один tool result з тим самим id, навіть коли тул упав.
      for (const call of reply.toolCalls) {
        const result = await executeTool(agent, call, run, trace, limits, turn);
        messages.push(toolResult(call, result));
      }

      if (cost !== null && cost > limits.maxCostUsd) {
        trace('limit', { kind: 'max_cost', value: limits.maxCostUsd, actual: cost });
        return stop('max_cost', `Зупинився на бюджеті $${limits.maxCostUsd}. Задача може бути незавершена.`);
      }
    }

    trace('limit', { kind: 'max_turns', value: limits.maxTurns });
    return stop('max_turns', `Зупинився після ${limits.maxTurns} кроків. Задача може бути незавершена.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    trace('error', { turn, message });
    return stop('error', `Модель не відповіла: ${message}`);
  }
}

async function callModel(
  model: ModelInfo,
  system: string,
  messages: ModelMessage[],
  tools: ToolSet,
  limits: Limits,
  trace: Trace,
  turn: number,
) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await generateText({
        model: model.model,
        system,
        messages: markCache(messages),
        tools,
        maxOutputTokens: limits.maxOutputTokens,
        // Повтори робимо самі, щоб їх було видно в trace.
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(60_000),
        // Зберегти сирий HTTP-запит, щоб показати його у веб-trace.
        include: { requestBody: true },
      });
    } catch (error) {
      const wait = retryDelay(error, attempt, limits);
      if (wait === null) {
        throw error;
      }
      trace('retry', {
        turn,
        attempt: attempt + 1,
        waitMs: wait,
        status: APICallError.isInstance(error) ? error.statusCode : null,
        message: error instanceof Error ? error.message : String(error),
      });
      await new Promise(resolve => setTimeout(resolve, wait));
    }
  }
}

// Повторюємо лише те, що може пройти з другої спроби: 429 і 5xx.
function retryDelay(error: unknown, attempt: number, limits: Limits): number | null {
  if (attempt >= limits.maxRetries || !APICallError.isInstance(error)) {
    return null;
  }
  const status = error.statusCode ?? 0;
  // «Request too large» теж 429, але той самий запит не пройде і вдруге.
  if (/too large/i.test(error.message) || (status !== 429 && status < 500)) {
    return null;
  }
  const seconds = Number(error.responseHeaders?.['retry-after']);
  const wait = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : 1_000 * 2 ** attempt;
  return Math.min(wait, limits.maxRetryWaitMs);
}

async function executeTool(
  agent: Agent,
  call: ToolCall,
  run: RunInfo,
  trace: Trace,
  limits: Limits,
  turn: number,
): Promise<JSONValue> {
  const base = { turn, id: call.toolCallId, name: call.toolName };
  // PreToolUse стоїть першим, ще до схеми: виклик тула, якого немає в списку, теж сюди доходить.
  const decision = agent.preToolUse?.(call.toolName, run) ?? null;
  if (decision && !decision.allow) {
    // Модель отримає цю відмову як результат свого виклику і пояснить її користувачу.
    const denied = { error: `denied: ${decision.reason}` };
    trace('pre_tool_use', { ...base, allow: false, rule: decision.rule ?? null, reason: decision.reason, result: denied });
    return denied;
  }
  if (decision) {
    trace('pre_tool_use', { ...base, allow: true, rule: decision.rule ?? null, reason: null });
  }

  try {
    // Аргументи не пройшли схему: виконавцю такий виклик не передаємо.
    if (call.invalid) {
      throw call.error;
    }

    trace('tool_start', { ...base, input: call.input });
    // await потрібен, щоб catch перехопив і помилку асинхронної функції.
    const output = await agent.runTool(call.toolName, call.input, run);
    const clipped = clip(output, limits.maxToolChars);
    trace('tool_result', { ...base, output: clipped.value, chars: clipped.chars, truncated: clipped.truncated });
    return clipped.value;
  } catch (error) {
    // Помилка тула = дані для моделі. Вона прочитає й спробує інакше.
    const message = error instanceof Error ? error.message : String(error);
    trace('tool_error', { ...base, error: message });
    return { error: message };
  }
}

// Обрізаємо вміст результату, а не викидаємо повідомлення: пара виклик-результат лишається цілою.
function clip(output: JSONValue, maxChars: number) {
  const json = JSON.stringify(output) ?? 'null';
  if (json.length <= maxChars) {
    return { value: output, chars: json.length, truncated: false };
  }
  return {
    value: {
      truncated: true,
      preview: json.slice(0, maxChars),
      note: `Результат обрізано: ${maxChars} з ${json.length} символів. Звузь запит, щоб отримати решту.`,
    },
    chars: json.length,
    truncated: true,
  };
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
