import { runAgent, type Agent } from '../harness.ts';
import { bus, type TraceEvent } from '../trace.ts';

// Термінальний канал: коротко друкуємо кожну подію циклу, повний trace лежить у .data/trace-cli.jsonl.
function line(event: TraceEvent) {
  switch (event.type) {
    case 'history':
      return `  історія чату: ${event.loaded} повідомлень${event.trimmed ? `, старих відкинуто ${event.trimmed}` : ''}`;
    case 'request':
      return `→ крок ${event.turn}: запит до моделі, ≈${event.approxTokens} токенів`;
    case 'response': {
      const calls = (event.toolCalls as { name: string }[]).map(call => call.name);
      const usage = event.usage as { input: number | null; output: number | null; cacheRead: number | null };
      const cache = usage.cacheRead === null ? '' : `, кеш ${usage.cacheRead}`;
      return `← модель: ${calls.length ? `просить ${calls.join(', ')}` : 'відповідь'} (in ${usage.input}, out ${usage.output}${cache})`;
    }
    case 'tool_result':
      return `  ✓ ${event.name}${event.truncated ? ' (обрізано)' : ''}`;
    case 'tool_error':
      return `  ✗ ${event.name}: ${event.error}`;
    case 'pre_tool_use':
      return `  PreToolUse ${event.name}: ${event.allow ? 'дозволено' : `заборонено, правило ${event.rule} (${event.reason})`}`;
    case 'retry':
      return `  повтор через ${event.waitMs} мс: ${event.message}`;
    case 'limit':
      return `  ліміт ${event.kind}`;
    case 'stop':
      return `■ зупинка: ${event.reason}`;
    default:
      return null;
  }
}

export async function runCli(agent: Agent, task: string) {
  if (!task) {
    console.error('Передай задачу: npm run cli -- "Запамʼятай: реліз у пʼятницю о 15:00"');
    process.exitCode = 1;
    return;
  }
  bus.on('event', event => {
    const text = line(event);
    if (text) console.log(text);
  });
  const result = await runAgent(agent, task, { channel: 'cli', chatId: 'cli' });
  console.log(`\n${result.text}`);
  // Код виходу 2 = задача не завершена (ліміт, збій). Скрипти й CI бачать це без читання тексту.
  if (!['final', 'echo'].includes(result.reason)) {
    process.exitCode = 2;
  }
}
