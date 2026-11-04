import { createAgent } from './agent.ts';
import { runCli } from './channels/cli.ts';
import { startWeb } from './channels/web.ts';

const agent = createAgent();
const mode = process.argv[2];

if (mode === 'cli') {
  await runCli(agent, process.argv.slice(3).join(' ').trim());
} else {
  const server = startWeb(agent);
  console.log(`Модель: ${agent.model.id}. Зупинити: Ctrl+C.`);

  const shutdown = () => {
    server.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
