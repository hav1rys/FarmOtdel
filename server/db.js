import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_SETTINGS, DEFAULT_RULES, DEFAULT_REMINDER, DEFAULT_ROSTER, DEFAULT_LINEUP } from '../public/calc.js';

// SQLite: встроенный в Node 22.13+ модуль, а на более старом Node (например, 20 у хостинга) — пакет better-sqlite3.
// API у них совпадает в том, что мы используем: exec, prepare().run/get/all.
let Driver;
export let sqliteDriver;
if (process.env.FARM_SQLITE !== 'better-sqlite3') {
  try { ({ DatabaseSync: Driver } = await import('node:sqlite')); sqliteDriver = 'node:sqlite'; } catch {}
}
if (!Driver) {
  try { Driver = (await import('better-sqlite3')).default; sqliteDriver = 'better-sqlite3'; } catch {
    throw new Error(`Нет SQLite: нужен Node.js 22.13+ или установленный пакет better-sqlite3 (npm install). Сейчас Node ${process.version}.`);
  }
}

export function openDb(file) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new Driver(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS members (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      discord TEXT,
      role TEXT NOT NULL DEFAULT 'member',
      joined TEXT,
      left_at TEXT,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      amount INTEGER NOT NULL,
      entry INTEGER NOT NULL DEFAULT 0,
      days INTEGER NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '',
      created_by TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS vacations (
      id TEXT PRIMARY KEY,
      member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      start TEXT NOT NULL,
      days INTEGER NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_by TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS fines (
      id TEXT PRIMARY KEY,
      member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      code TEXT NOT NULL,
      amount INTEGER NOT NULL,
      paid INTEGER NOT NULL DEFAULT 0,
      paid_date TEXT,
      note TEXT NOT NULL DEFAULT '',
      created_by TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    -- Кому выдан доступ к сайту (по Discord ID)
    CREATE TABLE IF NOT EXISTS access (
      discord_id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      added_by TEXT,
      added_at TEXT NOT NULL
    );
    -- Все, кто хоть раз входил через Discord
    CREATE TABLE IF NOT EXISTS users (
      discord_id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      global_name TEXT,
      avatar TEXT,
      first_login TEXT NOT NULL,
      last_login TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      discord_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    -- Чёрный список отдела: по Discord ID, может быть и не участником
    CREATE TABLE IF NOT EXISTS blacklist (
      id TEXT PRIMARY KEY,
      discord TEXT,
      name TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      date TEXT NOT NULL,
      until TEXT,
      member_id TEXT,
      fine_id TEXT,
      discord_tag TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL
    );
    -- Заготовки: тексты с форматированием Discord, чтобы копировать и вставлять
    CREATE TABLE IF NOT EXISTS templates (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      actor_id TEXT,
      action TEXT NOT NULL,
      summary TEXT NOT NULL
    );
  `);

  // Новые поля в уже созданных базах
  const addCols = (table, list) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    for (const [col, type] of list) if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  };
  // Данные из Discord, которые подтягивает бот; exempt — не платит взнос (бессрочно)
  addCols('members', [['discord_tag', 'TEXT'], ['discord_name', 'TEXT'], ['discord_avatar', 'TEXT'], ['discord_checked_at', 'TEXT'],
    ['discord_missing', 'INTEGER NOT NULL DEFAULT 0'], ['exempt', 'INTEGER NOT NULL DEFAULT 0']]);
  // Название пункта и выбранные плашки санкции сохраняются в штрафе: правила потом могут поменяться
  addCols('fines', [['title', "TEXT NOT NULL DEFAULT ''"], ['sanctions', "TEXT NOT NULL DEFAULT '[]'"], ['auto', 'INTEGER NOT NULL DEFAULT 0']]);
  return db;
}

const now = () => new Date().toISOString();

export const rowTo = {
  member: (r) => ({
    id: r.id, name: r.name, discord: r.discord || '', role: r.role, joined: r.joined, left: r.left_at, note: r.note,
    discordTag: r.discord_tag || '', discordName: r.discord_name || '', discordAvatar: r.discord_avatar || '', discordMissing: !!r.discord_missing,
    exempt: !!r.exempt,
  }),
  payment: (r) => ({ id: r.id, memberId: r.member_id, date: r.date, amount: r.amount, entry: r.entry, days: r.days, note: r.note }),
  vacation: (r) => ({ id: r.id, memberId: r.member_id, start: r.start, days: r.days, note: r.note }),
  fine: (r) => ({
    id: r.id, memberId: r.member_id, date: r.date, code: r.code, title: r.title || '', sanctions: JSON.parse(r.sanctions || '[]'),
    amount: r.amount, paid: !!r.paid, paidDate: r.paid_date, note: r.note, auto: !!r.auto,
  }),
  template: (r) => ({ id: r.id, title: r.title, body: r.body, updatedAt: r.updated_at }),
  blacklist: (r) => ({
    id: r.id, discord: r.discord || '', name: r.name, reason: r.reason, date: r.date, until: r.until,
    memberId: r.member_id, fineId: r.fine_id, discordTag: r.discord_tag || '',
  }),
};

export function repo(db) {
  const q = (sql) => db.prepare(sql);
  return {
    allRecords() {
      return {
        members: q('SELECT * FROM members ORDER BY joined, name').all().map(rowTo.member),
        payments: q('SELECT * FROM payments ORDER BY date').all().map(rowTo.payment),
        vacations: q('SELECT * FROM vacations ORDER BY start').all().map(rowTo.vacation),
        fines: q('SELECT * FROM fines ORDER BY date').all().map(rowTo.fine),
        blacklist: q('SELECT * FROM blacklist ORDER BY date DESC').all().map(rowTo.blacklist),
        templates: q('SELECT * FROM templates ORDER BY created_at').all().map(rowTo.template),
      };
    },
    getSettings() {
      const row = q("SELECT value FROM settings WHERE key = 'main'").get();
      const key = (k, def) => { const r = q('SELECT value FROM settings WHERE key = ?').get(k); return r ? JSON.parse(r.value) : def; };
      const roster = key('roster', DEFAULT_ROSTER);
      return {
        ...DEFAULT_SETTINGS, ...(row ? JSON.parse(row.value) : {}),
        rules: key('rules', DEFAULT_RULES),
        reminder: { ...DEFAULT_REMINDER, ...key('reminder', {}) },
        lineup: { ...DEFAULT_LINEUP, ...key('lineup', {}) },
        roster: { roles: roster.roles, columns: { ...DEFAULT_ROSTER.columns, ...roster.columns } },
      };
    },
    setKey(k, value) {
      q('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, JSON.stringify(value));
    },
    setRules(rules) {
      q("INSERT INTO settings (key, value) VALUES ('rules', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(rules));
    },
    setSettings({ rules, reminder, roster, lineup, ...s }) {
      q("INSERT INTO settings (key, value) VALUES ('main', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(s));
    },

    upsertMember(m, actor) {
      q(`INSERT INTO members (id, name, discord, role, joined, left_at, note, exempt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, discord = excluded.discord, role = excluded.role,
           joined = excluded.joined, left_at = excluded.left_at, note = excluded.note, exempt = excluded.exempt,
           -- сменился Discord ID — старый тег больше не верен
           discord_tag = CASE WHEN members.discord IS excluded.discord THEN members.discord_tag END,
           discord_name = CASE WHEN members.discord IS excluded.discord THEN members.discord_name END,
           discord_avatar = CASE WHEN members.discord IS excluded.discord THEN members.discord_avatar END,
           discord_checked_at = CASE WHEN members.discord IS excluded.discord THEN members.discord_checked_at END,
           discord_missing = CASE WHEN members.discord IS excluded.discord THEN members.discord_missing ELSE 0 END`)
        .run(m.id, m.name, m.discord || null, m.role, m.joined || null, m.left || null, m.note || '', m.exempt ? 1 : 0, now());
    },
    setMemberDiscordInfo(id, info) {
      q(`UPDATE members SET discord_tag = ?, discord_name = ?, discord_avatar = ?, discord_missing = ?, discord_checked_at = ? WHERE id = ?`)
        .run(info?.tag || null, info?.name || null, info?.avatar || null, info ? 0 : 1, now(), id);
    },
    // У кого есть Discord ID, но тег не проверялся давно (или ни разу)
    membersForDiscordRefresh(olderThanIso) {
      return q(`SELECT * FROM members WHERE discord IS NOT NULL AND discord != ''
                AND (discord_checked_at IS NULL OR discord_checked_at < ?) ORDER BY discord_checked_at IS NOT NULL, discord_checked_at`)
        .all(olderThanIso).map(rowTo.member);
    },
    upsertPayment(p, actor) {
      q(`INSERT INTO payments (id, member_id, date, amount, entry, days, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET member_id = excluded.member_id, date = excluded.date, amount = excluded.amount,
           entry = excluded.entry, days = excluded.days, note = excluded.note`)
        .run(p.id, p.memberId, p.date, p.amount, p.entry, p.days, p.note || '', actor, now());
    },
    upsertVacation(v, actor) {
      q(`INSERT INTO vacations (id, member_id, start, days, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET member_id = excluded.member_id, start = excluded.start, days = excluded.days, note = excluded.note`)
        .run(v.id, v.memberId, v.start, v.days, v.note || '', actor, now());
    },
    upsertFine(f, actor) {
      q(`INSERT INTO fines (id, member_id, date, code, title, sanctions, amount, paid, paid_date, note, auto, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET member_id = excluded.member_id, date = excluded.date, code = excluded.code,
           title = excluded.title, sanctions = excluded.sanctions, amount = excluded.amount, paid = excluded.paid,
           paid_date = excluded.paid_date, note = excluded.note`)
        .run(f.id, f.memberId, f.date, f.code, f.title || '', JSON.stringify(f.sanctions || []), f.amount, f.paid ? 1 : 0,
          f.paidDate || null, f.note || '', f.auto ? 1 : 0, actor, now());
    },
    upsertBlacklist(b, actor) {
      q(`INSERT INTO blacklist (id, discord, name, reason, date, until, member_id, fine_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET discord = excluded.discord, name = excluded.name, reason = excluded.reason,
           date = excluded.date, until = excluded.until, member_id = excluded.member_id,
           discord_tag = CASE WHEN blacklist.discord IS excluded.discord THEN blacklist.discord_tag END`)
        .run(b.id, b.discord || null, b.name, b.reason || '', b.date, b.until || null, b.memberId || null, b.fineId || null, actor, now());
    },
    upsertTemplate(t, actor) {
      const at = now();
      q(`INSERT INTO templates (id, title, body, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, body = excluded.body, updated_at = excluded.updated_at`)
        .run(t.id, t.title, t.body, actor, at, at);
    },
    setBlacklistTag(id, tag) {
      q('UPDATE blacklist SET discord_tag = ? WHERE id = ?').run(tag || null, id);
    },
    // Есть ли уже штраф по этому пункту, выданный в этот же долг (не раньше даты, с которой не оплачено)
    hasFineSince(memberId, code, sinceIso) {
      return !!q('SELECT 1 FROM fines WHERE member_id = ? AND code = ? AND date >= ? LIMIT 1').get(memberId, code, sinceIso);
    },
    remove(table, id) {
      const allowed = { members: 1, payments: 1, vacations: 1, fines: 1, blacklist: 1, templates: 1 };
      if (!allowed[table]) throw new Error('bad table');
      return q(`DELETE FROM ${table} WHERE id = ?`).run(id).changes > 0;
    },
    get(table, id) {
      const map = { members: rowTo.member, payments: rowTo.payment, vacations: rowTo.vacation, fines: rowTo.fine, blacklist: rowTo.blacklist, templates: rowTo.template };
      const r = q(`SELECT * FROM ${table} WHERE id = ?`).get(id);
      return r ? map[table](r) : null;
    },

    // ----- доступ и вход -----
    getAccess(discordId) {
      return q('SELECT * FROM access WHERE discord_id = ?').get(discordId) || null;
    },
    listAccess() {
      return q(`SELECT a.discord_id, a.role, a.note, a.added_by, a.added_at, u.username, u.global_name, u.avatar, u.last_login
                FROM access a LEFT JOIN users u ON u.discord_id = a.discord_id ORDER BY a.added_at`).all();
    },
    setAccess(discordId, role, note, actor) {
      q(`INSERT INTO access (discord_id, role, note, added_by, added_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(discord_id) DO UPDATE SET role = excluded.role, note = excluded.note`)
        .run(discordId, role, note || '', actor, now());
    },
    removeAccess(discordId) {
      q('DELETE FROM access WHERE discord_id = ?').run(discordId);
      q('DELETE FROM sessions WHERE discord_id = ?').run(discordId);
    },
    // Те, кто входил, но доступа не имеет — «запросы»
    listUsersWithoutAccess() {
      return q(`SELECT u.* FROM users u LEFT JOIN access a ON a.discord_id = u.discord_id
                WHERE a.discord_id IS NULL ORDER BY u.last_login DESC LIMIT 50`).all();
    },
    upsertUser(u) {
      const t = now();
      q(`INSERT INTO users (discord_id, username, global_name, avatar, first_login, last_login) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(discord_id) DO UPDATE SET username = excluded.username, global_name = excluded.global_name,
           avatar = excluded.avatar, last_login = excluded.last_login`)
        .run(u.id, u.username, u.global_name || null, u.avatar || null, t, t);
    },
    getUser(discordId) {
      return q('SELECT * FROM users WHERE discord_id = ?').get(discordId) || null;
    },
    createSession(token, discordId, ttlMs) {
      q('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
      q('INSERT INTO sessions (token, discord_id, expires_at) VALUES (?, ?, ?)').run(token, discordId, Date.now() + ttlMs);
    },
    getSession(token) {
      const s = q('SELECT * FROM sessions WHERE token = ?').get(token);
      return s && s.expires_at > Date.now() ? s : null;
    },
    deleteSession(token) {
      q('DELETE FROM sessions WHERE token = ?').run(token);
    },

    log(actor, action, summary) {
      q('INSERT INTO audit (at, actor_id, action, summary) VALUES (?, ?, ?, ?)').run(now(), actor, action, summary);
    },
    listAudit(limit = 300) {
      return {
        total: q('SELECT COUNT(*) AS n FROM audit').get().n,
        rows: q(`SELECT a.*, u.username, u.global_name FROM audit a LEFT JOIN users u ON u.discord_id = a.actor_id
                 ORDER BY a.id DESC LIMIT ?`).all(limit),
      };
    },
    deleteAudit(id) {
      return q('DELETE FROM audit WHERE id = ?').run(id).changes;
    },
    // Удалить записи журнала старше даты (или все, если даты нет)
    clearAudit(beforeIso) {
      return beforeIso ? q('DELETE FROM audit WHERE at < ?').run(beforeIso).changes : q('DELETE FROM audit').run().changes;
    },
    memberByDiscord(discordId) {
      const r = q('SELECT * FROM members WHERE discord = ? ORDER BY left_at IS NOT NULL, joined DESC LIMIT 1').get(discordId);
      return r ? rowTo.member(r) : null;
    },
    transaction(fn) {
      db.exec('BEGIN');
      try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
}
