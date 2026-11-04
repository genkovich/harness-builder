// npm run doctor: перевіряє все, що треба до заняття. Зелене = можна приходити.
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { generateText } from 'ai';
import { loadModel } from '../src/model.ts';

let failed = 0;
const ok = (text: string) => console.log(`\x1b[32m✓\x1b[0m ${text}`);
const bad = (text: string, fix: string) => {
  failed++;
  console.log(`\x1b[31m✗\x1b[0m ${text}\n  → ${fix}`);
};
const warn = (text: string, fix: string) => console.log(`\x1b[33m!\x1b[0m ${text}\n  → ${fix}`);

// 1. Node
const [major, minor] = process.versions.node.split('.').map(Number);
if (major > 24 || (major === 24 && minor >= 11) || (major === 22 && minor >= 19)) {
  ok(`Node ${process.versions.node}`);
} else {
  bad(`Node ${process.versions.node} застарий`, 'постав Node 22.19+ або 24.11+ (nodejs.org або nvm install 24)');
}

// 2. .env
if (existsSync('.env')) {
  ok('.env є');
} else {
  bad('.env немає', 'скопіюй: cp .env.example .env');
}

// 3. Модель: один короткий запит
try {
  const info = loadModel();
  if (!process.env[info.keyEnv]?.trim()) {
    bad(`${info.keyEnv} порожній для MODEL=${info.id}`, `встав ключ у .env (${info.keyEnv}=...)`);
  } else {
    const started = Date.now();
    const reply = await generateText({
      model: info.model,
      prompt: 'Reply with one word: ok',
      maxOutputTokens: 200,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(30_000),
    });
    ok(`модель ${info.id} відповіла за ${Date.now() - started} мс (in ${reply.usage.inputTokens}, out ${reply.usage.outputTokens})`);
  }
} catch (error) {
  bad(`модель не відповіла: ${error instanceof Error ? error.message : error}`, 'перевір MODEL і ключ у .env; на Groq Free почекай хвилину, якщо 429');
}

// 4. Telegram: getMe
const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
if (!token) {
  warn('TELEGRAM_BOT_TOKEN порожній', 'отримай токен у @BotFather (/newbot) і встав у .env, він потрібен з етапу 06');
} else {
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(10_000) });
    const body = (await response.json()) as { ok: boolean; result?: { username: string }; description?: string };
    if (!body.ok) throw new Error(body.description ?? `HTTP ${response.status}`);
    ok(`Telegram-бот @${body.result?.username}`);
  } catch (error) {
    bad(`Telegram не прийняв токен: ${error instanceof Error ? error.message : error}`, 'візьми новий токен у @BotFather (/token)');
  }
}

// 5. Порт веб-харнесу
const port = Number(process.env.PORT) || 3000;
const free = await new Promise<boolean>(resolve => {
  const probe = createServer()
    .once('error', () => resolve(false))
    .once('listening', () => probe.close(() => resolve(true)))
    .listen(port, '127.0.0.1');
});
if (free) {
  ok(`порт ${port} вільний`);
} else {
  bad(`порт ${port} зайнятий`, `зупини інший процес або постав PORT=3001 у .env`);
}

const ready = token ? 'Усе готово до заняття.' : 'Етапи 00-05 готові. Додай токен бота, він потрібен з етапу 06.';
console.log(failed ? `\n${failed} проблем(и). Виправ і запусти ще раз.` : `\n${ready}`);
process.exitCode = failed ? 1 : 0;
