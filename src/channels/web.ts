import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { runAgent, type Agent } from '../harness.ts';
import { bus, followOtherProcesses, recentEvents, type TraceEvent } from '../trace.ts';

const webRoot = new URL('../../web/', import.meta.url);
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
};

export function startWeb(agent: Agent, port = Number(process.env.PORT) || 3000) {
  const server = createServer((request, response) => {
    handle(agent, request, response).catch(error => {
      console.error('Веб:', error);
      if (!response.headersSent) {
        json(response, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    });
  });
  // Спершу історія з файлів, потім стежимо за CLI з інших процесів.
  recentEvents();
  const follower = followOtherProcesses(['web', 'telegram']);
  server.on('close', () => clearInterval(follower));
  // Слухаємо лише localhost: харнес має доступ до ключів і нотаток.
  server.listen(port, '127.0.0.1', () => {
    console.log(`Веб-харнес: http://localhost:${port}`);
  });
  return server;
}

async function handle(agent: Agent, request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? '/', 'http://localhost');

  if (request.method === 'GET' && url.pathname === '/api/events') {
    return streamEvents(request, response);
  }
  if (request.method === 'GET' && url.pathname === '/api/info') {
    return json(response, 200, {
      model: agent.model.id,
      price: agent.model.price,
      telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim()),
      owner: process.env.OWNER_CHAT_ID?.trim() || null,
    });
  }
  if (request.method === 'POST' && url.pathname === '/api/chat') {
    const body = JSON.parse(await readBody(request));
    const text = String(body.text ?? '').trim();
    if (!text) {
      return json(response, 400, { error: 'Порожнє повідомлення' });
    }
    // У веб-чаті chatId задаєш ти сам: так видно, що бачить власник, а що чужий чат.
    const chatId = String(body.chatId ?? 'web').trim() || 'web';
    const result = await runAgent(agent, text, { channel: 'web', chatId });
    return json(response, 200, { text: result.text, reason: result.reason });
  }
  if (request.method === 'GET') {
    return serveStatic(url.pathname, response);
  }
  response.writeHead(404).end();
}

// Server-Sent Events: спершу останні події з файлів, далі живі з шини.
function streamEvents(request: IncomingMessage, response: ServerResponse) {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const send = (event: TraceEvent) => response.write(`data: ${JSON.stringify(event)}\n\n`);
  for (const event of recentEvents()) {
    send(event);
  }
  response.write('event: ready\ndata: {}\n\n');
  bus.on('event', send);
  const ping = setInterval(() => response.write(': ping\n\n'), 15_000);
  request.on('close', () => {
    clearInterval(ping);
    bus.off('event', send);
  });
}

async function serveStatic(pathname: string, response: ServerResponse) {
  const name = pathname === '/' ? 'index.html' : pathname.slice(1);
  // Лише файли з web/, без «..» у шляху.
  if (name.includes('..') || !types[extname(name)]) {
    return response.writeHead(404).end();
  }
  try {
    const file = await readFile(new URL(name, webRoot));
    response.writeHead(200, { 'content-type': types[extname(name)] }).end(file);
  } catch {
    response.writeHead(404).end();
  }
}

function readBody(request: IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    let data = '';
    request.on('data', chunk => {
      data += chunk;
      if (data.length > 100_000) {
        reject(new Error('Завелике повідомлення'));
        request.destroy();
      }
    });
    request.on('end', () => resolve(data || '{}'));
    request.on('error', reject);
  });
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
}
