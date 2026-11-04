import { EventEmitter } from 'node:events';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Одна подія = один рядок у .data/trace-<канал>.jsonl і одне повідомлення на шині.
// Веб-харнес слухає шину свого процесу: веб і Telegram видно наживо.
// Запуски з `npm run cli` ідуть окремим процесом: їх веб дочитує з файлів (followOtherProcesses).
export type TraceEvent = {
  type: string;
  runId: string;
  channel: string;
  chatId: string;
  at: string;
  [field: string]: unknown;
};

export type RunInfo = { runId: string; channel: string; chatId: string };

export const bus = new EventEmitter();
bus.setMaxListeners(100);

const keep = 2_000;
const recent: TraceEvent[] = [];
let loaded = false;

function traceDir() {
  return process.env.TRACE_DIR || '.data';
}

export function emit(run: RunInfo, type: string, data: Record<string, unknown> = {}) {
  const event: TraceEvent = { ...data, type, ...run, at: new Date().toISOString() };
  remember(event);
  try {
    mkdirSync(traceDir(), { recursive: true });
    appendFileSync(join(traceDir(), `trace-${run.channel}.jsonl`), JSON.stringify(event) + '\n');
  } catch (error) {
    console.error('Не вдалося записати trace:', error instanceof Error ? error.message : error);
  }
  bus.emit('event', event);
  return event;
}

// Зручна обгортка: усі події одного запуску з тими самими runId, channel, chatId.
export function tracer(run: RunInfo) {
  return (type: string, data: Record<string, unknown> = {}) => emit(run, type, data);
}

function remember(event: TraceEvent) {
  recent.push(event);
  if (recent.length > keep) {
    recent.splice(0, recent.length - keep);
  }
}

// Останні події з файлів: оновив сторінку або перезапустив процес, а trace лишився.
export function recentEvents(): TraceEvent[] {
  if (!loaded) {
    loaded = true;
    const fromFiles: TraceEvent[] = [];
    const dir = traceDir();
    if (existsSync(dir)) {
      for (const name of readdirSync(dir).filter(file => /^trace-.+\.jsonl$/.test(file))) {
        const lines = readFileSync(join(dir, name), 'utf8').trim().split('\n').slice(-500);
        for (const line of lines) {
          try {
            fromFiles.push(JSON.parse(line));
          } catch {
            // Обірваний рядок після аварійної зупинки пропускаємо.
          }
        }
      }
    }
    fromFiles.sort((a, b) => a.at.localeCompare(b.at));
    // Усе, що вже є в памʼяті, теж лежить у файлах, тож файли = повна картина.
    recent.splice(0, recent.length, ...fromFiles.slice(-keep));
  }
  return recent.slice(-keep);
}

// Інші процеси (наприклад, CLI) пишуть у свої trace-файли. Дочитуємо нові рядки й кидаємо їх на шину,
// тож веб бачить і ці запуски наживо. own = канали цього процесу, їх і так видно з шини.
export function followOtherProcesses(own: string[]) {
  const offsets = new Map<string, number>();
  let initial = true;
  const scan = () => {
    const dir = traceDir();
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const channel = /^trace-(.+)\.jsonl$/.exec(name)?.[1];
      if (!channel || own.includes(channel)) continue;
      const file = join(dir, name);
      const size = statSync(file).size;
      // Файли, що були до старту, вже прочитав recentEvents. Новий файл читаємо з початку.
      const from = offsets.get(file) ?? (initial ? size : 0);
      offsets.set(file, from);
      if (size <= from) continue;
      const buffer = Buffer.alloc(size - from);
      const fd = openSync(file, 'r');
      readSync(fd, buffer, 0, buffer.length, from);
      closeSync(fd);
      // Беремо лише повні рядки: інший процес міг дописати половину.
      const end = buffer.lastIndexOf(10);
      if (end < 0) continue;
      offsets.set(file, from + end + 1);
      for (const line of buffer.subarray(0, end).toString('utf8').split('\n')) {
        try {
          const event = JSON.parse(line) as TraceEvent;
          remember(event);
          bus.emit('event', event);
        } catch {
          // Битий рядок пропускаємо.
        }
      }
    }
  };
  scan();
  initial = false;
  // unref: таймер не тримає процес живим, коли все інше зупинилось.
  return setInterval(scan, 500).unref();
}

// Груба оцінка: ~4 символи на токен для англійської, для української токенів більше.
// Точне число за весь запит дає провайдер у usage, а це лише щоб порівнювати секції між собою.
export function approxTokens(text: string) {
  return Math.ceil(text.length / 4);
}
