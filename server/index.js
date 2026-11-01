import express from 'express';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb, repo } from './db.js';
import { createDiscordBot } from './discord-bot.js';
import { DEFAULT_SETTINGS, FINE_CATALOG, MEMBER_ROLES, isIsoDate, daysFor } from '../public/calc.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(join(root, '.env'))) process.loadEnvFile(join(root, '.env'));

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || undefined; // на сервере 127.0.0.1: снаружи доступ только через Caddy
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
const OWNER_IDS = (process.env.OWNER_DISCORD_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
const IS_LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE_URL);
// Вход без Discord — только для проверки на своём компьютере
const DEV_LOGIN = process.env.DEV_LOGIN === '1' && IS_LOCAL;
const SECURE_COOKIE = BASE_URL.startsWith('https://');
const SESSION_TTL = 30 * 24 * 3600 * 1000;

const db = openDb(process.env.DB_FILE || join(root, 'data', 'farm.db'));
const R = repo(db);
const bot = createDiscordBot(process.env.DISCORD_BOT_TOKEN || '');

// ---------- уровни доступа ----------
// member — участник отдела без выданного доступа: видит только свою карточку
const RANK = { member: 0, viewer: 1, editor: 2, admin: 3, owner: 4 };
export const ACCESS_ROLES = { viewer: 'Просмотр', editor: 'Редактор', admin: 'Администратор', owner: 'Владелец' };

function resolveRole(discordId) {
  if (OWNER_IDS.includes(discordId)) return 'owner';
  const a = R.getAccess(discordId);
  if (a) return a.role;
  const m = R.memberByDiscord(discordId);
  if (m && !m.left) return 'member';
  return null;
}

// ---------- приложение ----------
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '200kb' }));

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function setCookie(res, name, value, maxAgeMs) {
  const bits = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
  if (SECURE_COOKIE) bits.push('Secure');
  res.append('Set-Cookie', bits.join('; '));
}

// Кто зашёл
app.use((req, res, next) => {
  const token = parseCookies(req).sid;
  const s = token && R.getSession(token);
  if (s) {
    req.sid = token;
    req.userId = s.discord_id;
    req.role = resolveRole(s.discord_id);
  }
  next();
});

// Защита от подделки запросов: изменять данные можно только из нашей же страницы
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.get('X-Farm') !== '1') return res.status(403).json({ error: 'Запрос отклонён' });
  next();
});

const need = (min) => (req, res, next) => {
  if (!req.userId) return res.status(401).json({ error: 'Нужно войти через Discord' });
  if (req.role == null || RANK[req.role] < RANK[min]) return res.status(403).json({ error: 'Недостаточно прав' });
  next();
};

// ---------- вход через Discord ----------
app.get('/auth/discord', (req, res) => {
  if (!CLIENT_ID || !CLIENT_SECRET) return res.status(500).send('Вход через Discord не настроен: заполните DISCORD_CLIENT_ID и DISCORD_CLIENT_SECRET в .env');
  const state = randomBytes(16).toString('hex');
  setCookie(res, 'oauth_state', state, 10 * 60 * 1000);
  const url = new URL('https://discord.com/oauth2/authorize');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'identify');
  url.searchParams.set('redirect_uri', `${BASE_URL}/auth/discord/callback`);
  url.searchParams.set('state', state);
  url.searchParams.set('prompt', 'none');
  res.redirect(url.toString());
});

app.get('/auth/discord/callback', async (req, res) => {
  const { code, state } = req.query;
  const expected = parseCookies(req).oauth_state;
  setCookie(res, 'oauth_state', '', 0);
  if (!code || !state || state !== expected) return res.redirect('/?login=failed');
  try {
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'authorization_code',
        code: String(code), redirect_uri: `${BASE_URL}/auth/discord/callback`,
      }),
    });
    if (!tokenRes.ok) throw new Error(`token ${tokenRes.status}`);
    const { access_token } = await tokenRes.json();
    const meRes = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${access_token}` } });
    if (!meRes.ok) throw new Error(`me ${meRes.status}`);
    const me = await meRes.json();
    login(res, me);
    res.redirect('/');
  } catch (e) {
    console.error('Discord login failed:', e.message);
    res.redirect('/?login=failed');
  }
});

function login(res, discordUser) {
  R.upsertUser(discordUser);
  const token = randomBytes(32).toString('hex');
  R.createSession(token, discordUser.id, SESSION_TTL);
  setCookie(res, 'sid', token, SESSION_TTL);
}

if (DEV_LOGIN) {
  console.warn('ВНИМАНИЕ: включён тестовый вход без Discord (DEV_LOGIN=1). Не используйте на публичном адресе.');
  app.get('/auth/dev', (req, res) => {
    const id = String(req.query.id || '');
    if (!/^\d{5,25}$/.test(id)) return res.status(400).send('Укажите ?id=<Discord ID>');
    login(res, { id, username: `test_${id.slice(-4)}`, global_name: String(req.query.name || `Тест ${id.slice(-4)}`) });
    res.redirect('/');
  });
}

app.post('/auth/logout', (req, res) => {
  if (req.sid) R.deleteSession(req.sid);
  setCookie(res, 'sid', '', 0);
  res.json({ ok: true });
});

// ---------- живые обновления ----------
const streams = new Set();
let version = Date.now();
function changed() {
  version = Date.now();
  for (const s of streams) s.write(`event: change\ndata: ${version}\n\n`);
}
app.get('/api/events', need('member'), (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write(`retry: 5000\ndata: ${version}\n\n`);
  streams.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); streams.delete(res); });
});

// ---------- чтение ----------
app.get('/api/me', (req, res) => {
  if (!req.userId) return res.json({ user: null, devLogin: DEV_LOGIN, discordConfigured: !!(CLIENT_ID && CLIENT_SECRET) });
  const u = R.getUser(req.userId);
  res.json({
    user: { id: req.userId, username: u?.username, name: u?.global_name || u?.username, avatar: u?.avatar },
    role: req.role,
    roleLabel: req.role === 'member' ? 'Участник отдела' : ACCESS_ROLES[req.role] || null,
    memberId: R.memberByDiscord(req.userId)?.id || null,
    botEnabled: bot.enabled,
  });
});

app.get('/api/data', need('member'), (req, res) => {
  const all = R.allRecords();
  const settings = R.getSettings();
  if (req.role === 'member') {
    const me = R.memberByDiscord(req.userId);
    const mine = (r) => r.memberId === me.id;
    return res.json({
      members: [me], payments: all.payments.filter(mine), vacations: all.vacations.filter(mine), fines: all.fines.filter(mine),
      settings, version,
    });
  }
  res.json({ ...all, settings, version });
});

// ---------- проверка входных данных ----------
class Bad extends Error {}
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const int = (v, name, min = 0, max = 1e9) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Bad(`Неверное значение: ${name}`);
  return n;
};
const date = (v, name, optional = false) => {
  if (optional && (v == null || v === '')) return null;
  if (!isIsoDate(v)) throw new Bad(`Неверная дата: ${name}`);
  return v;
};
const memberRef = (id) => {
  if (!R.get('members', id)) throw new Bad('Участник не найден');
  return id;
};
const discordId = (v, optional = true) => {
  const s = str(v, 40).replace(/[<@!>\s]/g, '');
  if (!s && optional) return '';
  if (!/^\d{5,25}$/.test(s)) throw new Bad('Discord ID — это число из 17–20 цифр');
  return s;
};

const validators = {
  members: (b, id) => {
    const role = MEMBER_ROLES[b.role] ? b.role : 'member';
    const name = str(b.name, 80);
    if (!name) throw new Bad('Укажите имя');
    return { id, name, discord: discordId(b.discord), role, joined: date(b.joined, 'вступил', true), left: date(b.left, 'уволился', true), note: str(b.note, 500) };
  },
  payments: (b, id) => {
    const amount = int(b.amount, 'сумма', 0);
    const entry = int(b.entry ?? 0, 'вступительный', 0, amount);
    const days = int(b.days ?? daysFor(amount - entry, R.getSettings().prices), 'дней', 0, 3650);
    return { id, memberId: memberRef(b.memberId), date: date(b.date, 'дата'), amount, entry, days, note: str(b.note, 500) };
  },
  vacations: (b, id) => ({ id, memberId: memberRef(b.memberId), start: date(b.start, 'начало'), days: int(b.days, 'дней', 1, 365), note: str(b.note, 500) }),
  fines: (b, id) => {
    const code = FINE_CATALOG.some((f) => f.code === b.code) ? b.code : 'other';
    const paid = !!b.paid;
    return { id, memberId: memberRef(b.memberId), date: date(b.date, 'дата'), code, amount: int(b.amount, 'сумма'), paid, paidDate: paid ? date(b.paidDate, 'дата оплаты') : null, note: str(b.note, 500) };
  },
};
const upserts = { members: 'upsertMember', payments: 'upsertPayment', vacations: 'upsertVacation', fines: 'upsertFine' };
const labels = { members: 'участник', payments: 'оплата', vacations: 'отпуск', fines: 'штраф' };

function describe(table, rec) {
  const m = rec.memberId ? R.get('members', rec.memberId) : rec;
  const who = m?.name || '?';
  if (table === 'payments') return `${who}: ${rec.amount.toLocaleString('ru-RU')}$ за ${rec.days} дн. (${rec.date})`;
  if (table === 'vacations') return `${who}: отпуск ${rec.days} дн. с ${rec.start}`;
  if (table === 'fines') return `${who}: штраф ${rec.code}, ${rec.amount.toLocaleString('ru-RU')}$${rec.paid ? ' (оплачен)' : ''}`;
  return who;
}

for (const table of Object.keys(validators)) {
  const save = (isNew) => (req, res) => {
    try {
      const id = isNew ? randomUUID() : req.params.id;
      const prev = isNew ? null : R.get(table, id);
      if (!isNew && !prev) return res.status(404).json({ error: 'Запись не найдена' });
      const rec = validators[table](req.body || {}, id);
      R[upserts[table]](rec, req.userId);
      R.log(req.userId, `${isNew ? 'Добавлено' : 'Изменено'}: ${labels[table]}`, describe(table, rec));
      changed();
      res.json(rec);
      // Новый или сменённый Discord ID — бот подтягивает тег в фоне, страницы обновятся сами
      if (table === 'members' && rec.discord && (!prev || prev.discord !== rec.discord || !prev.discordTag)) refreshDiscord(rec.id);
    } catch (e) {
      if (e instanceof Bad) return res.status(400).json({ error: e.message });
      throw e;
    }
  };
  app.post(`/api/${table}`, need('editor'), save(true));
  app.put(`/api/${table}/:id`, need('editor'), save(false));
  app.delete(`/api/${table}/:id`, need('editor'), (req, res) => {
    const rec = R.get(table, req.params.id);
    if (!rec) return res.status(404).json({ error: 'Запись не найдена' });
    const summary = describe(table, rec);
    R.remove(table, req.params.id);
    R.log(req.userId, `Удалено: ${labels[table]}`, summary);
    changed();
    res.json({ ok: true });
  });
}

// ---------- бот: теги Discord ----------
async function refreshDiscord(memberId) {
  if (!bot.enabled) return;
  const m = R.get('members', memberId);
  if (!m?.discord) return;
  try {
    const info = await bot.lookup(m.discord);
    // Пока ждали ответ, ID могли поменять — тогда ответ уже не про этого человека
    if (R.get('members', memberId)?.discord !== m.discord) return;
    R.setMemberDiscordInfo(memberId, info);
    changed();
  } catch (e) {
    console.error(`Бот: не удалось получить тег ${m.discord}:`, e.message);
  }
}

// Раз в сутки сверяем теги: люди меняют ники
let refreshing = false;
async function refreshStaleDiscord() {
  if (!bot.enabled || refreshing) return;
  refreshing = true;
  try {
    const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    for (const m of R.membersForDiscordRefresh(dayAgo)) {
      await refreshDiscord(m.id);
      await new Promise((r) => setTimeout(r, 1500));
    }
  } finally {
    refreshing = false;
  }
}
setTimeout(refreshStaleDiscord, 5000);
setInterval(refreshStaleDiscord, 6 * 3600 * 1000);

// Проверка ID в форме: «нашёлся @tag»
app.get('/api/discord/lookup/:discordId', need('editor'), async (req, res) => {
  if (!bot.enabled) return res.status(503).json({ error: 'Бот не настроен' });
  if (!/^\d{5,25}$/.test(req.params.discordId)) return res.status(400).json({ error: 'Discord ID — это число из 17–20 цифр' });
  try {
    const info = await bot.lookup(req.params.discordId);
    if (!info) return res.status(404).json({ error: 'Пользователь с таким ID не найден' });
    res.json(info);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/members/:id/discord-refresh', need('editor'), async (req, res) => {
  if (!bot.enabled) return res.status(503).json({ error: 'Бот не настроен: добавьте DISCORD_BOT_TOKEN' });
  if (!R.get('members', req.params.id)?.discord) return res.status(400).json({ error: 'У участника не указан Discord ID' });
  await refreshDiscord(req.params.id);
  res.json(R.get('members', req.params.id));
});

app.put('/api/settings', need('admin'), (req, res) => {
  try {
    const b = req.body || {};
    const prices = Array.isArray(b.prices) && b.prices.length === 7 ? b.prices.map((p, i) => int(p, `цена ${i + 1}`, 1)) : null;
    if (!prices) throw new Bad('Нужно 7 цен');
    const s = { prices, entryFee: int(b.entryFee ?? DEFAULT_SETTINGS.entryFee, 'вступительный', 0), fineDays: int(b.fineDays ?? DEFAULT_SETTINGS.fineDays, 'срок штрафа', 0, 60) };
    R.setSettings(s);
    R.log(req.userId, 'Изменены цены', `Цены: ${prices.join(' / ')}, вступительный ${s.entryFee}, срок штрафа ${s.fineDays} сут.`);
    changed();
    res.json(s);
  } catch (e) {
    if (e instanceof Bad) return res.status(400).json({ error: e.message });
    throw e;
  }
});

// ---------- управление доступом ----------
app.get('/api/access', need('admin'), (req, res) => {
  res.json({
    owners: OWNER_IDS.map((id) => ({ discord_id: id, role: 'owner', ...(R.getUser(id) || {}) })),
    access: R.listAccess(),
    requests: R.listUsersWithoutAccess().filter((u) => !OWNER_IDS.includes(u.discord_id)),
  });
});

app.put('/api/access/:discordId', need('admin'), (req, res) => {
  try {
    const id = discordId(req.params.discordId, false);
    const role = req.body?.role;
    if (!['viewer', 'editor', 'admin'].includes(role)) throw new Bad('Неизвестный уровень доступа');
    if (OWNER_IDS.includes(id)) throw new Bad('Права владельца задаются в настройках сервера');
    const current = R.getAccess(id);
    // Администратор управляет только редакторами и просмотром; назначать администраторов может владелец
    if (req.role !== 'owner' && (role === 'admin' || current?.role === 'admin')) return res.status(403).json({ error: 'Назначать администраторов может только владелец' });
    R.setAccess(id, role, str(req.body?.note, 200), req.userId);
    const u = R.getUser(id);
    R.log(req.userId, 'Выдан доступ', `${u?.global_name || u?.username || id}: ${ACCESS_ROLES[role]}`);
    changed();
    res.json({ ok: true });
  } catch (e) {
    if (e instanceof Bad) return res.status(400).json({ error: e.message });
    throw e;
  }
});

app.delete('/api/access/:discordId', need('admin'), (req, res) => {
  const id = req.params.discordId;
  const current = R.getAccess(id);
  if (!current) return res.status(404).json({ error: 'Доступ не найден' });
  if (req.role !== 'owner' && current.role === 'admin') return res.status(403).json({ error: 'Снять администратора может только владелец' });
  if (id === req.userId) return res.status(400).json({ error: 'Нельзя снять доступ с самого себя' });
  R.removeAccess(id);
  const u = R.getUser(id);
  R.log(req.userId, 'Снят доступ', `${u?.global_name || u?.username || id}`);
  changed();
  res.json({ ok: true });
});

app.get('/api/audit', need('admin'), (req, res) => res.json(R.listAudit()));

// ---------- страница ----------
app.use(express.static(join(root, 'public'), { extensions: ['html'] }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Ошибка сервера' });
});

app.listen(PORT, HOST, () => {
  console.log(`Farm Otdel: ${BASE_URL} (порт ${PORT})`);
  if (!CLIENT_ID || !CLIENT_SECRET) console.warn('Вход через Discord не настроен — см. README.md');
  if (!OWNER_IDS.length) console.warn('Не задан OWNER_DISCORD_IDS — некому будет выдавать доступы');
  if (!bot.enabled) console.warn('Не задан DISCORD_BOT_TOKEN — теги Discord подтягиваться не будут');
});
