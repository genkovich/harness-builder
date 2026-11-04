import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { sandbox, scriptedModel, say, testAgent } from './helpers.mjs';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { startWeb } from '../src/channels/web.ts';
import { bus } from '../src/trace.ts';

sandbox();

test('00 веб бачить наживо запуски з інших процесів, наприклад CLI', async () => {
  const { model } = scriptedModel([say('ok')]);
  const server = startWeb(testAgent(model), 0);
  await once(server, 'listening');
  try {
    const seen = new Promise(resolve => bus.on('event', event => event.runId === 'other-1' && resolve(event)));
    const line = { type: 'start', runId: 'other-1', channel: 'cli', chatId: 'cli', at: new Date().toISOString(), task: 'з терміналу' };
    // Файлу ще немає: інший процес створює його вже після старту вебу.
    appendFileSync(join(process.env.TRACE_DIR, 'trace-cli.jsonl'), JSON.stringify(line) + '\n');
    const event = await seen;
    assert.equal(event.task, 'з терміналу');
  } finally {
    server.close();
  }
});

test('00 веб-харнес: сторінка, info, чат і SSE з подіями', async () => {
  const { model } = scriptedModel([say('Привіт!')]);
  const server = startWeb(testAgent(model), 0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(base + '/');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<html/i);

    const info = await (await fetch(base + '/api/info')).json();
    assert.equal(info.model, 'test/mock');

    const chat = await fetch(base + '/api/chat', { method: 'POST', body: JSON.stringify({ text: 'Привіт' }) });
    const reply = await chat.json();
    assert.ok(reply.text.length > 0, 'чат повертає текст');

    // SSE віддає вже записані події: оновив сторінку, а trace лишився.
    const controller = new AbortController();
    const stream = await fetch(base + '/api/events', { signal: controller.signal });
    const reader = stream.body.getReader();
    let text = '';
    while (!text.includes('event: ready')) {
      text += new TextDecoder().decode((await reader.read()).value);
    }
    controller.abort();
    assert.match(text, /"type":"start"/);
    assert.match(text, /"type":"stop"/);
  } finally {
    server.close();
  }
});

test('00 статика не віддає файли поза web/', async () => {
  const { model } = scriptedModel([say('ok')]);
  const server = startWeb(testAgent(model), 0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(base + '/..%2F.env')).status, 404);
    assert.equal((await fetch(base + '/missing.js')).status, 404);
  } finally {
    server.close();
  }
});
