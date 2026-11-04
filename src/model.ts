import { defaultSettingsMiddleware, wrapLanguageModel, type LanguageModel, type LanguageModelUsage } from 'ai';
import { createGroq } from '@ai-sdk/groq';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

export const DEFAULT_MODEL = 'groq/qwen/qwen3.8-27b';

// Ціна за 1 млн токенів у USD. null = ціни не знаємо, вартість показуємо як «н/д».
export type Price = { input: number; cachedInput: number; output: number } | null;

export type ModelInfo = {
  id: string; // як у MODEL: провайдер/модель
  provider: string;
  name: string;
  model: LanguageModel;
  price: Price;
  keyEnv: string; // яку змінну з .env читає провайдер
};

// Ціни з публічних прайсів провайдерів. Groq Free не бере грошей, лише ставить ліміти.
const prices: Record<string, Price> = {
  'openai/gpt-4.1-mini': { input: 0.4, cachedInput: 0.1, output: 1.6 },
  'openai/gpt-4.1': { input: 2, cachedInput: 0.5, output: 8 },
};

const keys: Record<string, string> = {
  groq: 'GROQ_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

function priceFor(id: string, provider: string): Price {
  // PRICE=input,cached,output у .env перебиває таблицю, якщо твоєї моделі в ній немає.
  const custom = process.env.PRICE?.split(',').map(Number);
  if (custom?.length === 3 && custom.every(Number.isFinite)) {
    return { input: custom[0], cachedInput: custom[1], output: custom[2] };
  }
  if (provider === 'groq') {
    return { input: 0, cachedInput: 0, output: 0 };
  }
  return prices[id] ?? null;
}

export function loadModel(spec = process.env.MODEL || DEFAULT_MODEL): ModelInfo {
  // Ділимо лише по першому «/»: у groq/qwen/qwen3.8-27b назва моделі сама містить слеш.
  const slash = spec.indexOf('/');
  if (slash < 1) {
    throw new Error(`MODEL має бути у форматі провайдер/модель, а не «${spec}».`);
  }
  const provider = spec.slice(0, slash);
  const name = spec.slice(slash + 1);
  const keyEnv = keys[provider];
  if (!keyEnv) {
    throw new Error(`Невідомий провайдер «${provider}». Є: ${Object.keys(keys).join(', ')}.`);
  }
  const apiKey = process.env[keyEnv];

  let model: LanguageModel;
  switch (provider) {
    case 'groq':
      // Qwen на Groq міркує перед відповіддю, і міркування їдять ті самі 1000 вихідних токенів.
      // Низьке зусилля лишає місце для відповіді й tool call. GROQ_REASONING=none|default|low|medium|high.
      model = wrapLanguageModel({
        model: createGroq({ apiKey })(name),
        middleware: defaultSettingsMiddleware({
          settings: {
            providerOptions: {
              groq: { reasoningEffort: (process.env.GROQ_REASONING || 'low') as 'low', reasoningFormat: 'parsed' },
            },
          },
        }),
      });
      break;
    case 'openai':
      model = createOpenAI({ apiKey })(name);
      break;
    case 'anthropic':
      model = createAnthropic({ apiKey })(name);
      break;
    default:
      // OpenRouter говорить протоколом OpenAI, тож беремо сумісний провайдер.
      model = createOpenAICompatible({
        name: 'openrouter',
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey,
        includeUsage: true,
      })(name);
  }

  return { id: spec, provider, name, model, price: priceFor(spec, provider), keyEnv };
}

// Скільки коштував один запит. null, якщо ціни немає.
export function costOf(info: ModelInfo, usage: LanguageModelUsage): number | null {
  if (!info.price) {
    return null;
  }
  const input = usage.inputTokens ?? 0;
  const cached = usage.inputTokenDetails?.cacheReadTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const { price } = info;
  return ((input - cached) * price.input + cached * price.cachedInput + output * price.output) / 1_000_000;
}
