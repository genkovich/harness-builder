// Візуальний харнес: читає події trace через SSE і малює кожен крок циклу агента.
// Без збірки й без бібліотек. Події описані в docs/trace-events.md.
'use strict';

const $ = id => document.getElementById(id);

const state = {
  info: null,
  runs: new Map(), // runId -> run
  seen: new Set(), // ключі подій, щоб не дублювати після перепідключення
  ready: false,
  selected: null,
  follow: true,
  open: new Set(), // розгорнуті JSON-блоки: runId|ключ
  shown: new Set(), // рядки, які вже зʼявлялись (анімуємо лише нові)
  local: [], // надіслані з веба, але ще без події start
};

// ---------- утиліти ----------

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style') el.setAttribute('style', v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const badge = (text, cls = '', title) => h('span', { class: `badge ${cls}`, title }, text);
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const fmtInt = n => Math.round(n).toLocaleString('uk-UA');
const time = at => {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
};

function fmtCost(n) {
  if (!isNum(n)) return null;
  if (n === 0) return '$0';
  if (n < 0.0001) return `$${n.toFixed(6)}`;
  if (n < 0.1) return `$${n.toFixed(4).replace(/0+$/, '')}`;
  return `$${n.toFixed(2)}`;
}

function excerpt(text, max = 90) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function oneLine(value, max = 160) {
  if (value === undefined) return '';
  let s;
  try { s = typeof value === 'string' ? value : JSON.stringify(value); } catch { s = String(value); }
  return excerpt(s, max);
}

// Колір-мітка для id виклику: та сама крапка біля tool call у відповіді моделі й біля його результату.
function idColor(id) {
  let x = 0;
  for (const c of String(id)) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${x % 360} 70% 62%)`;
}
const shortId = id => {
  const s = String(id ?? '');
  return s.length > 10 ? `…${s.slice(-6)}` : s;
};
const idChip = id => h('span', { class: 'idchip', title: `id: ${id}` }, h('i', { style: `background:${idColor(id)}` }), shortId(id));

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const MAX_JSON = 300_000;

// Підсвітка JSON: спершу екрануємо, потім фарбуємо токени. Дані з trace в HTML як є не потрапляють.
function jsonPre(value) {
  let text;
  try { text = JSON.stringify(value, null, 2); } catch { text = String(value); }
  if (text === undefined) text = 'undefined';
  let note = null;
  if (text.length > MAX_JSON) {
    note = `показано ${fmtInt(MAX_JSON)} з ${fmtInt(text.length)} символів`;
    text = text.slice(0, MAX_JSON);
  }
  const pre = h('pre');
  pre.innerHTML = escapeHtml(text).replace(
    /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g,
    (m, str, colon, lit) => {
      if (str) return colon ? `<span class="jk">${str}</span>${colon}` : `<span class="js">${str}</span>`;
      if (lit) return `<span class="jb">${lit}</span>`;
      return `<span class="jn">${m}</span>`;
    },
  );
  return note ? [pre, h('div', { class: 'dim' }, note)] : pre;
}

function textPre(text) {
  return h('pre', {}, String(text ?? ''));
}

function maybeParse(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

// ---------- модель даних ----------

function eventKey(ev) {
  return [ev.runId, ev.type, ev.at, ev.turn ?? '', ev.id ?? '', ev.attempt ?? ''].join('|');
}

function getRun(ev) {
  let run = state.runs.get(ev.runId);
  if (!run) {
    run = {
      runId: ev.runId, channel: ev.channel, chatId: ev.chatId, firstAt: ev.at, lastAt: ev.at,
      start: null, history: null, context: null, stop: null, limit: null, errors: [], extra: [], turns: new Map(),
    };
    state.runs.set(ev.runId, run);
  }
  if (ev.at < run.firstAt) run.firstAt = ev.at;
  if (ev.at > run.lastAt) run.lastAt = ev.at;
  return run;
}

function getTurn(run, n) {
  const key = isNum(n) ? n : 0;
  let turn = run.turns.get(key);
  if (!turn) {
    turn = { n: key, request: null, response: null, retries: [], error: null, tools: new Map() };
    run.turns.set(key, turn);
  }
  return turn;
}

function getTool(turn, id, name) {
  const key = id ?? `${name}-${turn.tools.size}`;
  let tool = turn.tools.get(key);
  if (!tool) {
    tool = { id: key, name, call: null, guard: null, start: null, result: null, error: null };
    turn.tools.set(key, tool);
  }
  if (!tool.name && name) tool.name = name;
  return tool;
}

function ingest(ev) {
  if (!ev || typeof ev !== 'object' || !ev.runId || !ev.type) return false;
  const key = eventKey(ev);
  if (state.seen.has(key)) return false;
  state.seen.add(key);

  const run = getRun(ev);
  switch (ev.type) {
    case 'start': run.start = ev; break;
    case 'history': run.history = ev; break;
    case 'context': run.context = ev; break;
    case 'stop': run.stop = ev; break;
    case 'limit': run.limit = ev; break;
    case 'request': getTurn(run, ev.turn).request = ev; break;
    case 'response': {
      const turn = getTurn(run, ev.turn);
      turn.response = ev;
      for (const call of Array.isArray(ev.toolCalls) ? ev.toolCalls : []) {
        getTool(turn, call.id, call.name).call = call;
      }
      break;
    }
    case 'retry': getTurn(run, ev.turn).retries.push(ev); break;
    case 'error':
      if (isNum(ev.turn) && ev.turn > 0) getTurn(run, ev.turn).error = ev;
      else run.errors.push(ev);
      break;
    case 'pre_tool_use': getTool(getTurn(run, ev.turn), ev.id, ev.name).guard = ev; break;
    case 'tool_start': getTool(getTurn(run, ev.turn), ev.id, ev.name).start = ev; break;
    case 'tool_result': getTool(getTurn(run, ev.turn), ev.id, ev.name).result = ev; break;
    case 'tool_error': getTool(getTurn(run, ev.turn), ev.id, ev.name).error = ev; break;
    default: run.extra.push(ev);
  }

  // Задача з веб-чату дійшла до харнесу: локальний «надсилаю» більше не потрібен.
  if (ev.type === 'start' && ev.channel === 'web') {
    const i = state.local.findIndex(l => !l.error && l.text === String(ev.task ?? '').trim() && l.chatId === ev.chatId);
    if (i >= 0) state.local.splice(i, 1);
  }
  return true;
}

const runsSorted = () => [...state.runs.values()].sort((a, b) => a.firstAt.localeCompare(b.firstAt));
const latestRun = () => runsSorted().at(-1) ?? null;
const maxTurnsOf = run => run?.start?.limits?.maxTurns ?? null;
const maxCostOf = run => run?.start?.limits?.maxCostUsd ?? null;
const turnsOf = run => [...run.turns.values()].filter(t => t.n > 0).sort((a, b) => a.n - b.n);
const responsesOf = run => turnsOf(run).map(t => t.response).filter(Boolean);

function usedTurns(run) {
  if (isNum(run.stop?.turns)) return run.stop.turns;
  const ts = turnsOf(run);
  return ts.length ? ts.at(-1).n : 0;
}

function runCost(run) {
  if (run.stop && 'costUsd' in run.stop) return run.stop.costUsd;
  const last = responsesOf(run).at(-1);
  return last ? last.totalCostUsd ?? null : null;
}

const STOP = {
  final: { label: 'фінальна відповідь', cls: 'ok', title: 'Фінальна відповідь' },
  echo: { label: 'ехо', cls: 'ctx', title: 'Ехо: модель ще не підключена' },
  error: { label: 'помилка', cls: 'err', title: 'Зупинка: модель не відповіла' },
  max_turns: { label: 'ліміт кроків', cls: 'err', title: 'Зупинка: ліміт кроків' },
  max_cost: { label: 'бюджет', cls: 'err', title: 'Зупинка: вичерпано бюджет' },
  truncated: { label: 'обрізано', cls: 'err', title: 'Зупинка: відповідь моделі обрізана' },
};
const stopInfo = reason => STOP[reason] ?? { label: String(reason ?? 'кінець'), cls: '', title: `Зупинка: ${reason}` };

function stopBadge(run) {
  if (!run.stop) return badge('виконується', 'model');
  const s = stopInfo(run.stop.reason);
  return badge(s.label, s.cls);
}

function channelLabel(run) {
  if (run.channel === 'telegram') return `Telegram · chat ${run.chatId}`;
  if (run.channel === 'web') return `веб · ${run.chatId}`;
  if (run.channel === 'cli') return 'CLI';
  return `${run.channel} · ${run.chatId}`;
}
const channelBadge = run => badge(channelLabel(run), run.channel === 'telegram' ? 'code' : run.channel === 'web' ? 'ctx' : '');
const isOwner = chatId => Boolean(state.info?.owner) && String(chatId) === String(state.info.owner);
const taskOf = run => (run.start ? String(run.start.task ?? '') : '(початок запуску поза буфером)');

// ---------- рендер ----------

let pending = null;
function schedule(animate) {
  if (!state.ready) return;
  if (pending) { pending.animate ||= animate; return; }
  pending = { animate };
  requestAnimationFrame(() => {
    const { animate: a } = pending;
    pending = null;
    render(a);
  });
}

function render(animate) {
  if (state.follow) state.selected = latestRun()?.runId ?? null;
  const run = state.selected ? state.runs.get(state.selected) : null;
  renderChat(animate);
  renderPicker(run);
  renderCounters(run);
  renderTimeline(run, animate);
  renderContext(run);
}

const nearBottom = el => el.scrollHeight - el.scrollTop - el.clientHeight < 80;

function markAnim(el, key, animate) {
  if (animate && !state.shown.has(key)) el.classList.add('enter');
  state.shown.add(key);
  return el;
}

// ---------- шапка ----------

function renderInfo() {
  const info = state.info;
  $('info-model').textContent = info?.model ?? 'н/д';
  $('info-model').title = info?.price ? `ціна за 1 млн токенів: вхід $${info.price.input}, кеш $${info.price.cachedInput}, вихід $${info.price.output}` : 'ціни немає, вартість буде «н/д»';
  const tg = $('info-telegram');
  tg.textContent = info ? (info.telegram ? 'увімкнено' : 'вимкнено') : 'н/д';
  tg.className = info?.telegram ? 'on' : 'off';
  const owner = $('info-owner');
  owner.textContent = info ? (info.owner ? `задано · chat ${info.owner}` : 'не задано') : 'н/д';
  owner.className = info?.owner ? 'on' : 'off';
  updateChatIdHint();
}

async function loadInfo() {
  try {
    const res = await fetch('/api/info');
    state.info = res.ok ? await res.json() : null;
  } catch {
    state.info = null;
  }
  renderInfo();
  schedule(false);
}

// ---------- чат ----------

function renderChat(animate) {
  const box = $('messages');
  const stick = nearBottom(box);
  const runs = runsSorted().filter(r => r.channel === 'web' || r.channel === 'telegram');
  const items = [];

  for (const run of runs) {
    const meta = h('div', { class: 'meta' },
      run.channel === 'telegram' ? badge(`Telegram · chat ${run.chatId}`, 'code') : badge(`chat ${run.chatId}`, 'ctx mono'),
      isOwner(run.chatId) ? badge('власник', 'ok') : null,
      h('span', {}, time(run.start?.at ?? run.firstAt)),
    );
    const user = h('div', { class: 'bubble user' }, h('div', { class: 'clip' }, taskOf(run)));
    let bot;
    if (run.stop) {
      const r = run.stop.reason;
      const cls = r === 'error' ? 'err' : r === 'final' || r === 'echo' ? '' : 'warn';
      bot = h('div', { class: `bubble bot ${cls}` },
        h('div', { class: 'clip' }, String(run.stop.text ?? '')),
        r !== 'final' ? h('div', { class: 'meta', style: 'margin-top:6px' }, stopBadge(run)) : null);
    } else {
      const n = usedTurns(run);
      bot = h('div', { class: 'bubble bot pending' }, n ? `Агент працює · крок ${n}` : 'Агент працює');
    }
    const ex = h('div', {
      class: `exchange${run.runId === state.selected ? ' selected' : ''}`,
      title: 'Показати trace цього запуску',
      onclick: () => selectRun(run.runId),
    }, meta, user, bot);
    items.push(markAnim(ex, `chat|${run.runId}|${run.stop ? 'done' : 'run'}`, animate));
  }

  for (const l of state.local) {
    items.push(h('div', { class: 'exchange' },
      h('div', { class: 'meta' }, badge(`chat ${l.chatId}`, 'ctx mono')),
      h('div', { class: 'bubble user' }, l.text),
      l.error ? h('div', { class: 'bubble bot err' }, l.error) : h('div', { class: 'bubble bot pending' }, 'Надсилаю')));
  }

  if (!items.length) {
    items.push(h('div', { class: 'empty' }, 'Повідомлень ще немає. Напиши задачу внизу, а задачі з Telegram теж зʼявляться тут.'));
  }
  box.replaceChildren(...items);
  if (stick || animate) box.scrollTop = box.scrollHeight;
}

// ---------- вибір запуску ----------

function selectRun(runId) {
  const latest = latestRun();
  state.selected = runId;
  state.follow = latest?.runId === runId;
  closeList();
  $('timeline').scrollTop = 0;
  updateFollow();
  render(false);
}

function updateFollow() {
  const btn = $('follow');
  btn.classList.toggle('on', state.follow);
  btn.textContent = state.follow ? 'стежу за останнім' : 'до останнього';
}

function runLine(run) {
  return [
    h('span', { class: 'time' }, time(run.start?.at ?? run.firstAt)),
    channelBadge(run),
    h('span', { class: 'task' }, excerpt(taskOf(run), 120)),
    stopBadge(run),
  ];
}

function renderPicker(run) {
  const label = $('run-btn-label');
  if (!run) {
    label.replaceChildren(h('span', { class: 'dim' }, 'Запусків ще немає'));
  } else {
    const n = runsSorted().findIndex(r => r.runId === run.runId) + 1;
    label.replaceChildren(
      h('span', { class: 'dim' }, `Запуск ${n} з ${state.runs.size}`),
      channelBadge(run),
      h('span', { class: 'task' }, excerpt(taskOf(run), 140)),
      stopBadge(run),
    );
  }
  const list = $('run-list');
  if (!list.hidden) fillList();
}

function fillList() {
  const list = $('run-list');
  const runs = runsSorted().reverse();
  list.replaceChildren(...runs.map(run => h('button', {
    class: `run-item${run.runId === state.selected ? ' active' : ''}`,
    type: 'button', role: 'option', 'aria-selected': String(run.runId === state.selected),
    onclick: () => selectRun(run.runId),
  }, runLine(run))));
  if (!runs.length) list.replaceChildren(h('div', { class: 'empty' }, 'Запусків ще немає'));
}

function openList() {
  fillList();
  $('run-list').hidden = false;
  $('run-btn').setAttribute('aria-expanded', 'true');
}
function closeList() {
  $('run-list').hidden = true;
  $('run-btn').setAttribute('aria-expanded', 'false');
}

// ---------- лічильники ----------

function counter(k, v, opts = {}) {
  const na = v === null || v === undefined;
  return h('div', { class: `counter ${opts.cls ?? ''}`, title: opts.title },
    h('span', { class: 'k' }, k),
    h('span', { class: `v${na ? ' na' : ''}` }, na ? opts.na ?? 'н/д' : v),
    opts.extra ?? null);
}

function sumUsage(responses, field) {
  const vals = responses.map(r => r.usage?.[field]).filter(isNum);
  return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
}

function renderCounters(run) {
  const box = $('counters');
  if (!run) { box.replaceChildren(); return; }
  const responses = responsesOf(run);
  const maxT = maxTurnsOf(run);
  const used = usedTurns(run);

  const input = sumUsage(responses, 'input');
  const output = sumUsage(responses, 'output');
  const cache = sumUsage(responses, 'cacheRead');
  const noResp = responses.length === 0;
  const tokTitle = noResp ? 'Відповідей моделі ще немає (request/response зʼявляються з етапу 01)' : 'Сума usage з усіх відповідей моделі';

  const cost = runCost(run);
  const maxC = maxCostOf(run);
  let budget = null;
  if (isNum(cost) && isNum(maxC) && maxC > 0) {
    const p = cost / maxC;
    budget = h('div', { class: `bar${p > 1 ? ' over' : p > 0.7 ? ' hot' : ''}` }, h('i', { style: `width:${Math.min(100, Math.max(p * 100, cost > 0 ? 2 : 0)).toFixed(1)}%` }));
  }
  const costText = isNum(cost) ? `${fmtCost(cost)}${isNum(maxC) ? ` з ${fmtCost(maxC)}` : ''}` : null;

  box.replaceChildren(
    counter('кроки', maxT ? `${used} / ${maxT}` : String(used), { title: maxT ? 'Скільки разів харнес питав модель / maxTurns' : 'Скільки разів харнес питав модель. maxTurns невідомий' }),
    counter('вхід, токени', isNum(input) ? fmtInt(input) : null, { title: tokTitle }),
    counter('вихід, токени', isNum(output) ? fmtInt(output) : null, { title: tokTitle }),
    counter('кеш прочитано', isNum(cache) ? fmtInt(cache) : null, {
      cls: 'cache', na: noResp ? 'н/д' : 'провайдер не повідомляє кеш',
      title: 'usage.cacheRead: скільки вхідних токенів провайдер узяв із кешу',
    }),
    counter('вартість / бюджет', costText, {
      cls: 'budget', extra: budget, na: 'н/д',
      title: isNum(cost) ? 'Сума costUsd усіх кроків проти maxCostUsd' : 'Ціни для цієї моделі немає',
    }),
    counter('зупинка', run.stop ? stopInfo(run.stop.reason).label : 'виконується', { cls: `stop ${run.stop ? stopInfo(run.stop.reason).cls : 'model'}` }),
  );
}

// ---------- timeline ----------

// Розгортання JSON: вміст будуємо лише при відкритті, бо messages і body бувають великі.
function expandable(run, key, summaryKids, buildRaw, extraKids = []) {
  const fullKey = `${run.runId}|${key}`;
  const d = h('details', {}, h('summary', { class: 'head' }, summaryKids, h('span', { class: 'tw' })), extraKids);
  const fill = () => {
    if (d.dataset.filled) return;
    d.dataset.filled = '1';
    d.append(h('div', { class: 'raw' }, buildRaw()));
  };
  if (state.open.has(fullKey)) { d.open = true; fill(); }
  d.addEventListener('toggle', () => {
    if (d.open) { state.open.add(fullKey); fill(); } else state.open.delete(fullKey);
  });
  return d;
}

function section(title, content, note) {
  return [h('h4', {}, title, note ? h('span', { class: 'note' }, note) : null), content];
}

function row(kind, key, cls, card, animate, run) {
  const el = h('div', { class: `row k-${kind} ${cls ?? ''}`, 'data-key': key }, h('div', { class: 'card' }, card));
  return markAnim(el, `${run.runId}|${key}`, animate);
}

function pick(ev, fields) {
  const out = {};
  for (const f of fields) if (ev && f in ev) out[f] = ev[f];
  return out;
}

function messageBlock(m, i) {
  const role = m?.role ?? '?';
  const cls = role === 'user' ? 'ctx' : role === 'assistant' ? 'model' : role === 'tool' ? 'code' : '';
  const content = m?.content;
  return h('div', { class: 'msg' },
    h('div', { class: 'role' }, badge(role, cls), h('span', { class: 'dim' }, `#${i + 1}`)),
    typeof content === 'string' ? textPre(content) : jsonPre(content));
}

function startRow(run, animate) {
  const s = run.start;
  if (!s) {
    return row('start', 'start', '', h('div', { class: 'head' }, h('span', { class: 'title x' }, 'Задача'), h('span', { class: 'sub' }, 'Подія start вийшла за межі буфера останніх подій')), animate, run);
  }
  return row('start', 'start', '', [
    expandable(run, 'start', [
      h('span', { class: 'title x' }, 'Задача'),
      channelBadge(run),
      isOwner(run.chatId) ? badge('власник', 'ok') : null,
      s.model ? badge(s.model, 'model mono') : null,
      h('span', { class: 'sub' }, time(s.at)),
    ], () => jsonPre(pick(s, ['task', 'model', 'limits', 'channel', 'chatId', 'runId']))),
    h('div', { class: 'text task' }, String(s.task ?? '')),
  ], animate, run);
}

// Етап 07: скільки минулих повідомлень чату харнес підклав перед новим.
function historyRow(run, animate) {
  const e = run.history;
  const loaded = isNum(e.loaded) ? e.loaded : 0;
  const trimmed = isNum(e.trimmed) ? e.trimmed : 0;
  const sub = loaded === 0
    ? 'Перше повідомлення в цьому чаті: минулого немає'
    : `${fmtInt(e.kept ?? loaded)} минулих повідомлень іде в запит${trimmed ? `, ${fmtInt(trimmed)} найстаріших відкинуто` : ''}`;
  return row('context', 'history', '', expandable(run, 'history', [
    h('span', { class: 'title x' }, 'Історія чату'),
    badge(`chat ${run.chatId}`, 'ctx mono'),
    h('span', { class: 'sub' }, sub),
  ], () => jsonPre(pick(e, ['loaded', 'kept', 'trimmed']))), animate, run);
}

function contextRow(run, animate) {
  const c = run.context;
  const tools = Array.isArray(c.tools) ? c.tools : [];
  const sections = Array.isArray(c.sections) ? c.sections : [];
  const total = (c.system?.tokens ?? 0) + tools.reduce((a, t) => a + (t.tokens ?? 0), 0) + sections.reduce((a, t) => a + (t.tokens ?? 0), 0) + (c.history?.tokens ?? 0);
  return row('context', 'context', '', expandable(run, 'context', [
    h('span', { class: 'title x' }, 'Контекст зібрано'),
    h('span', { class: 'sub' }, `≈ ${fmtInt(total)} токенів: system, ${tools.length} тулів, ${sections.length} секцій, історія. Розбивка праворуч`),
  ], () => jsonPre(pick(c, ['system', 'tools', 'sections', 'history']))), animate, run);
}

function turnHead(run, turn) {
  const maxT = maxTurnsOf(run);
  const hasTools = turn.tools.size > 0;
  return h('div', { class: 'turn-head' },
    h('span', { class: 'num' }, String(turn.n)),
    h('span', { class: 'label' }, `Крок ${turn.n}${maxT ? ` з ${maxT}` : ''}`),
    h('span', { class: 'flow' },
      h('b', { class: 'c' }, 'запит'), ' → ', h('b', { class: 'm' }, 'модель'),
      hasTools ? [' → ', h('b', { class: 'c' }, 'tool call'), ' → ', h('b', { class: 'x' }, 'результат')] : turn.response ? [' → ', h('b', { class: 'ok' }, 'відповідь')] : null));
}

function requestRow(run, turn, animate) {
  const r = turn.request;
  const msgs = Array.isArray(r.messages) ? r.messages : [];
  const tools = Array.isArray(r.tools) ? r.tools : [];
  return row('request', `t${turn.n}:req`, '', expandable(run, `t${turn.n}:req`, [
    h('span', { class: 'title c' }, 'Запит до моделі'),
    h('span', { class: 'sub' }, `${msgs.length} повідомл. · ${isNum(r.approxTokens) ? `≈ ${fmtInt(r.approxTokens)} токенів` : 'токени н/д'} · тулів: ${tools.length}`),
  ], () => [
    section('system', textPre(r.system ?? '')),
    section('messages', h('div', { style: 'display:flex;flex-direction:column;gap:8px' }, msgs.map(messageBlock)), `${msgs.length} шт.`),
    section('tools', jsonPre(tools)),
  ]), animate, run);
}

function retryRow(run, turn, ev, animate) {
  return row('retry', `t${turn.n}:retry:${ev.attempt}:${ev.at}`, '', expandable(run, `t${turn.n}:retry:${ev.attempt}:${ev.at}`, [
    h('span', { class: 'title m' }, `Повтор ${ev.attempt ?? ''}`),
    ev.status ? badge(String(ev.status), 'err mono') : null,
    isNum(ev.waitMs) ? badge(`чекаю ${(ev.waitMs / 1000).toFixed(ev.waitMs < 10_000 ? 1 : 0)} с`, '') : null,
    h('span', { class: 'sub' }, excerpt(ev.message, 140)),
  ], () => jsonPre(pick(ev, ['turn', 'attempt', 'waitMs', 'status', 'message']))), animate, run);
}

function responseRow(run, turn, animate) {
  const r = turn.response;
  const u = r.usage ?? {};
  const calls = Array.isArray(r.toolCalls) ? r.toolCalls : [];
  const cost = fmtCost(r.costUsd);
  const facts = [
    r.finishReason ? badge(r.finishReason, r.finishReason === 'length' ? 'err mono' : 'mono') : null,
    badge(`вхід ${isNum(u.input) ? fmtInt(u.input) : 'н/д'}`, 'mono'),
    badge(`вихід ${isNum(u.output) ? fmtInt(u.output) : 'н/д'}`, 'mono'),
    isNum(u.cacheRead) ? badge(`кеш ${fmtInt(u.cacheRead)}`, 'ok mono') : badge('кеш н/д', '', 'провайдер не повідомляє кеш'),
    badge(cost ?? 'ціна н/д', cost ? 'model mono' : ''),
  ];
  const extra = [];
  if (r.text && String(r.text).trim()) extra.push(h('div', { class: 'text clip' }, String(r.text)));
  if (calls.length) {
    extra.push(h('div', { class: 'calls' }, calls.map(c => h('div', {
      class: 'call', title: 'Показати виконання', style: 'cursor:pointer',
      onclick: () => flashTool(`t${turn.n}:tool:${c.id}`),
    }, h('span', { class: 'arrow' }, '→'), idChip(c.id), h('span', { class: 'nm' }, c.name), h('span', { class: 'args' }, oneLine(c.input))))));
  }
  return row('response', `t${turn.n}:res`, '', [
    expandable(run, `t${turn.n}:res`, [
      h('span', { class: 'title m' }, calls.length ? `Модель просить ${calls.length === 1 ? 'тул' : `${calls.length} тули`}` : 'Модель відповіла'),
      h('span', { class: 'facts' }, facts),
    ], () => [
      section('відповідь', jsonPre(pick(r, ['text', 'toolCalls', 'finishReason', 'usage', 'costUsd', 'totalCostUsd']))),
      section('body', r.body === null || r.body === undefined ? h('div', { class: 'dim' }, 'body немає') : jsonPre(maybeParse(r.body)), 'сирий HTTP-запит до провайдера'),
    ]),
    extra,
  ], animate, run);
}

function toolRow(run, turn, tool, animate) {
  const key = `t${turn.n}:tool:${tool.id}`;
  const input = tool.call?.input ?? tool.start?.input;
  const segs = [];

  segs.push(h('div', { class: 'seg' }, expandable(run, `${key}:call`, [
    h('span', { class: 'title c' }, 'Tool call'),
    h('span', { class: 'mono', style: 'color:var(--code);font-weight:700' }, tool.name ?? '?'),
    idChip(tool.id),
    h('span', { class: 'sub mono' }, oneLine(input, 120)),
  ], () => section('input', jsonPre(input ?? null)))));

  const g = tool.guard;
  if (g) {
    segs.push(markAnim(h('div', { class: `seg ${g.allow ? 'guard-ok' : 'guard-deny'}` }, h('div', { class: 'head' },
      h('span', { class: `title ${g.allow ? 'ok' : 'err'}` }, g.allow ? 'PreToolUse: дозволено' : 'PreToolUse: заборонено'),
      g.rule ? badge(`правило ${g.rule}`, 'mono') : null,
      g.allow ? h('span', { class: 'reason' }, isOwner(run.chatId) ? 'запит від власника' : 'правило пропустило') : h('span', { class: 'reason' }, String(g.reason ?? '')),
      !g.allow ? h('span', { class: 'sub dim' }, 'Тул не виконано. Модель отримала помилку denied.') : null)), `${run.runId}|${key}:guard`, animate));
  }

  if (tool.result) {
    const r = tool.result;
    segs.push(markAnim(h('div', { class: 'seg res-ok' }, expandable(run, `${key}:res`, [
      h('span', { class: 'title' }, 'Результат'),
      idChip(tool.id),
      isNum(r.chars) ? badge(`${fmtInt(r.chars)} символів`, 'mono') : null,
      r.truncated ? badge('обрізано', 'err') : null,
      h('span', { class: 'sub mono' }, oneLine(r.output, 110)),
    ], () => section('output', jsonPre(r.output ?? null)))), `${run.runId}|${key}:res`, animate));
  } else if (tool.error) {
    const e = tool.error;
    segs.push(markAnim(h('div', { class: 'seg res-err' }, expandable(run, `${key}:err`, [
      h('span', { class: 'title err' }, 'Помилка тула'),
      idChip(tool.id),
      h('span', { class: 'reason' }, excerpt(e.error, 200)),
      h('span', { class: 'sub dim' }, 'Помилка пішла моделі як результат.'),
    ], () => jsonPre(pick(e, ['turn', 'id', 'name', 'error'])))), `${run.runId}|${key}:err`, animate));
  } else if (!(g && !g.allow)) {
    let text;
    if (run.stop) text = run.stop.reason === 'truncated' ? 'Не виконано: відповідь обрізана' : 'Не виконано';
    else text = tool.start ? 'Виконується…' : 'Чекає на виконання';
    segs.push(h('div', { class: 'seg wait' }, h('div', { class: 'head' }, h('span', { class: 'title' }, text))));
  }

  const el = row('tool', key, '', h('div', { class: 'pair' }, segs), animate, run);
  el.id = `tool-${run.runId}-${turn.n}-${tool.id}`.replace(/[^\w-]/g, '_');
  return el;
}

function flashTool(key) {
  const el = $('timeline').querySelector(`[data-key="${CSS.escape(key)}"]`);
  if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1200);
}

function errorRow(run, key, ev, animate) {
  return row('error', key, '', expandable(run, key, [
    h('span', { class: 'title err' }, 'Модель не відповіла'),
    h('span', { class: 'reason' }, excerpt(ev.message, 220)),
  ], () => jsonPre(pick(ev, ['turn', 'message']))), animate, run);
}

function limitRow(run, animate) {
  const l = run.limit;
  const kind = l.kind === 'max_turns' ? 'maxTurns' : l.kind === 'max_cost' ? 'maxCostUsd' : l.kind;
  const val = l.kind === 'max_cost' ? fmtCost(l.value) ?? l.value : l.value;
  const actual = l.kind === 'max_cost' ? fmtCost(l.actual) : l.actual;
  return row('limit', 'limit', '', expandable(run, 'limit', [
    h('span', { class: 'title err' }, 'Спрацював ліміт'),
    badge(`${kind} = ${val}`, 'err mono'),
    actual !== undefined && actual !== null ? h('span', { class: 'sub' }, `фактично ${actual}`) : null,
    h('span', { class: 'sub dim' }, 'Цикл зупиняє код харнесу, не модель'),
  ], () => jsonPre(pick(l, ['kind', 'value', 'actual']))), animate, run);
}

function stopRow(run, animate) {
  const s = run.stop;
  const info = stopInfo(s.reason);
  const cls = s.reason === 'final' ? 'ok' : s.reason === 'echo' ? 'echo' : 'err';
  const cost = fmtCost(s.costUsd);
  return row('stop', 'stop', cls, [
    expandable(run, 'stop', [
      h('span', { class: `title ${cls === 'echo' ? 'x' : cls}` }, info.title),
      badge(`кроків: ${isNum(s.turns) ? s.turns : 0}`, 'mono'),
      badge(cost ?? 'вартість н/д', cost ? 'model mono' : ''),
      s.reason === 'echo' ? h('span', { class: 'sub dim' }, 'Етап 00: харнес повертає задачу назад. Модель зʼявиться на етапі 01') : null,
    ], () => jsonPre(pick(s, ['reason', 'text', 'turns', 'costUsd']))),
    h('div', { class: 'text' }, String(s.text ?? '')),
  ], animate, run);
}

function extraRow(run, ev, animate) {
  const key = `extra:${ev.type}:${ev.at}`;
  return row('extra', key, '', expandable(run, key, [
    h('span', { class: 'title' }, `Подія ${ev.type}`),
    h('span', { class: 'sub dim' }, time(ev.at)),
  ], () => jsonPre(ev)), animate, run);
}

function renderTimeline(run, animate) {
  const box = $('timeline');
  if (!run) {
    box.replaceChildren(h('div', { class: 'placeholder' },
      h('p', {}, h('b', {}, 'Тут буде кожен крок циклу агента.')),
      h('p', {}, 'Надішли задачу в чат ліворуч або напиши боту в Telegram. Запуск зʼявиться тут одразу, а кроки домальовуватимуться наживо.')));
    return;
  }
  const stick = nearBottom(box);
  const same = box.dataset.run === run.runId;
  const rows = [startRow(run, animate)];
  if (run.history) rows.push(historyRow(run, animate));
  if (run.context) rows.push(contextRow(run, animate));
  for (const ev of run.errors) rows.push(errorRow(run, `error:${ev.at}`, ev, animate));

  for (const turn of turnsOf(run)) {
    rows.push(turnHead(run, turn));
    if (turn.request) rows.push(requestRow(run, turn, animate));
    for (const ev of turn.retries) rows.push(retryRow(run, turn, ev, animate));
    if (turn.response) rows.push(responseRow(run, turn, animate));
    else if (!turn.error && !run.stop && turn.request) {
      rows.push(row('pending', `t${turn.n}:wait`, '', h('div', { class: 'head' }, h('span', { class: 'title m' }, 'Модель думає…')), animate, run));
    }
    for (const tool of turn.tools.values()) rows.push(toolRow(run, turn, tool, animate));
    if (turn.error) rows.push(errorRow(run, `t${turn.n}:error`, turn.error, animate));
  }

  for (const ev of run.extra) rows.push(extraRow(run, ev, animate));
  if (run.limit) rows.push(limitRow(run, animate));
  if (run.stop) rows.push(stopRow(run, animate));
  else if (!turnsOf(run).some(t => t.request && !t.response && !t.error)) {
    rows.push(row('pending', 'pending', '', h('div', { class: 'head' }, h('span', { class: 'title m' }, 'Агент працює…')), animate, run));
  }

  const top = box.scrollTop;
  box.replaceChildren(h('div', { class: 'steps' }, rows));
  box.dataset.run = run.runId;
  if (same && animate && stick) box.scrollTop = box.scrollHeight;
  else if (same) box.scrollTop = top;
}

// ---------- контекст ----------

function renderContext(run) {
  const box = $('context');
  if (!run) { box.replaceChildren(); return; }
  const c = run.context;
  if (!c) {
    box.replaceChildren(
      h('h2', {}, 'Контекст'),
      h('p', { class: 'placeholder' }, 'Зʼявиться на етапі 10. Тоді харнес почне надсилати подію context: скільки займають system, кожен тул, кожна секція проєкту й історія чату.'));
    return;
  }
  const tools = Array.isArray(c.tools) ? c.tools : [];
  const sections = Array.isArray(c.sections) ? c.sections : [];
  const history = c.history ?? null;
  const all = [c.system?.tokens ?? 0, ...tools.map(t => t.tokens ?? 0), ...sections.map(s => s.tokens ?? 0), history?.tokens ?? 0];
  const max = Math.max(1, ...all);
  const total = all.reduce((a, b) => a + b, 0);

  const bar = (cls, name, src, tokens) => h('div', { class: `ctx-row ${cls}` },
    h('div', { class: 'lbl' },
      h('span', { class: 'n', title: src ? `${name} ${src}` : name }, name, src ? [' ', h('span', { class: 'src' }, src)] : null),
      h('span', { class: 't' }, `≈ ${fmtInt(tokens ?? 0)}`)),
    h('div', { class: 'track' }, h('i', { style: `width:${(((tokens ?? 0) / max) * 100).toFixed(1)}%` })));

  const first = run.turns.get(1)?.response;
  let real;
  if (!first) real = h('span', { class: 'v na' }, run.stop ? 'відповіді моделі немає' : 'ще немає відповіді');
  else if (!isNum(first.usage?.input)) real = h('span', { class: 'v na' }, 'провайдер не повідомив');
  else real = h('span', { class: 'v real' }, fmtInt(first.usage.input));

  box.replaceChildren(...[
    h('h2', {}, 'Контекст', h('span', { class: 'est' }, '≈ оцінка')),
    h('p', { class: 'lead' }, 'Символи / 4, щоб порівняти частини між собою. Точне число рахує провайдер.'),
    h('div', { class: 'ctx-group' }, 'system'),
    bar('system', 'system', null, c.system?.tokens),
    tools.length ? [h('div', { class: 'ctx-group' }, `тули · ${tools.length}`), tools.map(t => bar('tool', t.name, null, t.tokens))] : null,
    sections.length ? [h('div', { class: 'ctx-group' }, `секції · ${sections.length}`), sections.map(s => bar('section', `<${s.tag}>`, s.source, s.tokens))] : null,
    history ? [h('div', { class: 'ctx-group' }, `історія чату · ${fmtInt(history.messages ?? 0)} повідомл.`), bar('section', 'history', null, history.tokens)] : null,
    h('div', { class: 'ctx-total' },
      h('div', {}, h('span', {}, 'сума оцінок'), h('span', { class: 'v' }, `≈ ${fmtInt(total)}`)),
      h('div', {}, h('span', {}, 'usage.input, крок 1'), real),
      h('div', { class: 'hint' }, 'У реальному числі ще задача й JSON-схеми тулів.')),
  ].flat(Infinity).filter(Boolean));
}

// ---------- композер ----------

function updateChatIdHint() {
  const input = $('chat-id');
  const label = input.closest('.chatid');
  label.querySelector('.owner-hint')?.remove();
  const id = input.value.trim() || 'web';
  if (state.info?.owner) {
    label.append(h('span', { class: 'owner-hint', style: isOwner(id) ? '' : 'color:var(--dim)' }, isOwner(id) ? 'це власник' : 'не власник'));
  }
}

async function send(event) {
  event?.preventDefault();
  const textEl = $('text');
  const text = textEl.value.trim();
  if (!text) return;
  const chatId = $('chat-id').value.trim() || 'web';
  try { localStorage.setItem('harness.chatId', chatId); } catch { /* приватне вікно */ }
  const local = { text, chatId, error: null };
  state.local.push(local);
  textEl.value = '';
  state.follow = true;
  updateFollow();
  schedule(true);
  try {
    const res = await fetch('/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, chatId }),
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const body = await res.json(); if (body?.error) msg += `: ${body.error}`; } catch { /* не JSON */ }
      local.error = `Сервер не прийняв задачу. ${msg}`;
    } else {
      const i = state.local.indexOf(local);
      if (i >= 0) state.local.splice(i, 1);
    }
  } catch (error) {
    local.error = `Немає звʼязку з сервером: ${error instanceof Error ? error.message : error}`;
  }
  schedule(false);
}

// ---------- SSE ----------

function setConn(text, cls) {
  const el = $('conn');
  el.textContent = text;
  el.className = `conn ${cls}`;
}

function connect() {
  const es = new EventSource('/api/events');
  es.onopen = () => setConn('наживо', 'on');
  es.onmessage = message => {
    let ev;
    try { ev = JSON.parse(message.data); } catch { return; }
    if (ingest(ev)) schedule(true);
  };
  es.addEventListener('ready', () => {
    const first = !state.ready;
    state.ready = true;
    setConn('наживо', 'on');
    // Після перезапуску сервера (новий етап) ліміти й модель могли змінитись.
    loadInfo();
    if (first) {
      render(false);
      $('timeline').scrollTop = $('timeline').scrollHeight;
    }
  });
  es.onerror = () => setConn('перепідключаюсь…', 'off');
}

// ---------- старт ----------

function init() {
  try {
    const saved = localStorage.getItem('harness.chatId');
    if (saved) $('chat-id').value = saved;
  } catch { /* приватне вікно */ }

  $('composer').addEventListener('submit', send);
  $('text').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) send(e);
  });
  $('chat-id').addEventListener('input', updateChatIdHint);
  $('run-btn').addEventListener('click', e => {
    e.stopPropagation();
    if ($('run-list').hidden) openList(); else closeList();
  });
  $('follow').addEventListener('click', () => {
    state.follow = true;
    updateFollow();
    $('timeline').scrollTop = $('timeline').scrollHeight;
    render(false);
    $('timeline').scrollTop = $('timeline').scrollHeight;
  });
  document.addEventListener('click', e => {
    if (!$('run-list').hidden && !e.target.closest('.picker')) closeList();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeList();
  });

  renderInfo();
  updateFollow();
  render(false);
  connect();
}

init();
