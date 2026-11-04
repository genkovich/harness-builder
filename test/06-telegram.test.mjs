import test from 'node:test';
import assert from 'node:assert/strict';
import { collect, sandbox, say, scriptedModel, testAgent } from './helpers.mjs';
import { createBot } from '../src/channels/telegram.ts';

sandbox();

const botInfo = {
  id: 1, is_bot: true, first_name: 'Test', username: 'test_bot',
  can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
  can_connect_to_business: false, has_main_web_app: false,
};

// Бот без мережі: перехоплюємо всі виклики Telegram API.
function offlineBot(agent) {
  const bot = createBot('123:test', agent, { botInfo });
  const sent = [];
  bot.api.config.use(async (prev, method, payload) => {
    sent.push({ method, payload });
    return { ok: true, result: method === 'sendMessage' ? { message_id: sent.length, date: 0, chat: { id: payload.chat_id, type: 'private' }, text: payload.text } : true };
  });
  return { bot, sent, messages: () => sent.filter(item => item.method === 'sendMessage').map(item => item.payload) };
}

const update = (text, chatId = 42) => ({
  update_id: Date.now(),
  message: {
    message_id: 1, date: 0, text,
    chat: { id: chatId, type: 'private', first_name: 'Olia' },
    from: { id: chatId, is_bot: false, first_name: 'Olia' },
    ...(text.startsWith('/') ? { entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] } : {}),
  },
});

test('06 /start відповідає chat id', async () => {
  const { model, calls } = scriptedModel([say('не має викликатись')]);
  const { bot, messages } = offlineBot(testAgent(model));
  await bot.handleUpdate(update('/start', 777));
  assert.match(messages()[0].text, /777/);
  assert.equal(calls.length, 0, '/start не йде в модель');
});

test('06 повідомлення з Telegram іде в той самий цикл і trace', async () => {
  const { model } = scriptedModel([say('Привіт з харнесу!')]);
  const { bot, messages } = offlineBot(testAgent(model));
  const trace = collect();
  await bot.handleUpdate(update('Привіт', 42));
  trace.stop();
  assert.equal(messages()[0].text, 'Привіт з харнесу!');
  const [start] = trace.of('start');
  assert.equal(start.channel, 'telegram');
  assert.equal(start.chatId, '42');
});

test('06 довга відповідь ріжеться на шматки до 4000 символів', async () => {
  const { model } = scriptedModel([say('а'.repeat(9_000))]);
  const { bot, messages } = offlineBot(testAgent(model));
  await bot.handleUpdate(update('Напиши багато'));
  assert.deepEqual(messages().map(message => message.text.length), [4_000, 4_000, 1_000]);
});
