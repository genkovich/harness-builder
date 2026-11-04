import { Bot, GrammyError, type BotConfig, type Context } from 'grammy';
import { runAgent, type Agent } from '../harness.ts';

const telegramLimit = 4_000; // Telegram приймає до 4096 символів в одному повідомленні.

export function createBot(token: string, agent: Agent, config?: BotConfig<Context>) {
  const bot = new Bot(token, config);

  // /start показує chat id. Він знадобиться, щоб призначити власника бота (OWNER_CHAT_ID).
  bot.command('start', async ctx => {
    console.log('Telegram chat id:', ctx.chat.id);
    await ctx.reply(`Привіт! Твій chat id: ${ctx.chat.id}`);
  });

  bot.on('message:text', async ctx => {
    await ctx.replyWithChatAction('typing').catch(() => {});
    // chatId бере код з даних Telegram. Модель його не бачить і не вибирає.
    const result = await runAgent(agent, ctx.message.text, { channel: 'telegram', chatId: String(ctx.chat.id) });
    for (let offset = 0; offset < result.text.length; offset += telegramLimit) {
      await ctx.reply(result.text.slice(offset, offset + telegramLimit));
    }
  });

  // Помилки самого Telegram (обрив мережі, заблокований чат) не валять процес.
  bot.catch(error => {
    console.error('Помилка Telegram:', error.error instanceof Error ? error.error.message : error.error);
  });

  return bot;
}

export function startTelegram(agent: Agent) {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) {
    console.log('Telegram вимкнено: TELEGRAM_BOT_TOKEN порожній.');
    return null;
  }
  const bot = createBot(token, agent);

  bot
    .start({
      // onStart спрацьовує, коли Telegram уже прийняв токен.
      onStart: me => console.log(`Telegram: бот @${me.username} слухає повідомлення.`),
    })
    .catch(error => {
      if (error instanceof GrammyError && error.error_code === 409) {
        // Telegram віддає одне з'єднання на токен: другий процес обриває перший, і той зупиняється назавжди.
        console.error('Telegram 409 Conflict: з цим токеном запущено ще один процес, він перехопив повідомлення. Залиш один процес і перезапусти його.');
      } else if (error instanceof GrammyError && error.error_code === 401) {
        console.error('Telegram 401: токен неправильний. Візьми новий у @BotFather.');
      } else {
        console.error('Telegram не запустився:', error instanceof Error ? error.message : error);
      }
    });

  return bot;
}
