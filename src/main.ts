import { createAgent } from './agent.ts';
import { runCli } from './channels/cli.ts';
import { startTelegram } from './channels/telegram.ts';
import { startWeb } from './channels/web.ts';

const agent = createAgent();
const mode = process.argv[2];

if (mode === 'cli') {
  await runCli(agent, process.argv.slice(3).join(' ').trim());
} else {
  // Один процес: веб-харнес і Telegram пишуть в одну шину trace.
  const server = startWeb(agent);
  const bot = startTelegram(agent);
  console.log(`Модель: ${agent.model.id}. Зупинити: Ctrl+C.`);

  // Ctrl+C: спершу чемно зупиняємо бота, інакше Telegram надішле останнє повідомлення ще раз.
  const shutdown = async () => {
    await bot?.stop();
    server.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
