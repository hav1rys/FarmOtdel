import {
  MEMBER_ROLES, DEFAULT_SETTINGS, DEFAULT_RULES, CHIP_TYPES, dayNum, isoOf, todayNum, weekStart,
  costFor, daysFor, minPayFor, memberState, buildRoster, weekReport, chipLabel, optionLabel, optionAmount,
  allRuleItems, ruleByCode, autoRules, blacklistActive,
} from '/calc.js';

const RANK = { member: 0, viewer: 1, editor: 2, admin: 3, owner: 4 };
const ACCESS_ROLES = { viewer: 'Просмотр', editor: 'Редактор', admin: 'Администратор', owner: 'Владелец' };
const TABS = [
  { id: 'roster', label: 'Состав' },
  { id: 'payments', label: 'Оплаты' },
  { id: 'fines', label: 'Штрафы' },
  { id: 'blacklist', label: 'Чёрный список' },
  { id: 'vacations', label: 'Отпуска' },
  { id: 'week', label: 'По неделям' },
  { id: 'rules', label: 'Цены и правила' },
  { id: 'access', label: 'Доступ', min: 'admin' },
  { id: 'audit', label: 'Журнал', min: 'admin' },
];

const S = {
  me: null, data: null, access: null, audit: null,
  tab: 'roster', rosterFilter: 'active', search: '', fineFilter: 'open', blFilter: 'active', payQuery: '', weekOffset: 0,
  drawer: null,
};

// ---------- утилиты ----------
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => `${Math.round(n || 0).toLocaleString('ru-RU')}$`;
const T = () => todayNum();
const todayIso = () => isoOf(T());
function fd(v) {
  if (v == null || v === '') return '—';
  const s = typeof v === 'number' ? isoOf(v) : v;
  const [y, m, d] = s.split('-');
  return `${d}.${m}.${y}`;
}
const fdShort = (v) => fd(v).slice(0, 5);
const parseMoney = (s) => parseInt(String(s).replace(/\D/g, ''), 10) || 0;
const settings = () => ({ ...DEFAULT_SETTINGS, rules: DEFAULT_RULES, ...(S.data?.settings || {}) });
const rules = () => settings().rules;
const can = (min) => S.me && RANK[S.me.role] >= RANK[min];
const memberById = (id) => S.data.members.find((m) => m.id === id);
const days = (n) => `${n} дн.`;
const clone = (o) => JSON.parse(JSON.stringify(o));
const blacklist = () => S.data.blacklist || [];
const blFor = (discord) => (discord ? blacklist().find((b) => b.discord === discord && blacklistActive(b, T())) : null);
// Пункт правил за неоплату взноса: тот, что выдаётся автоматически, иначе 1.1
const nonPayRule = () => autoRules(rules())[0] || ruleByCode(rules(), '1.1');

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'X-Farm': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/me') { boot(); throw new Error('Сессия закончилась, войдите снова'); }
  if (!res.ok) throw new Error(json.error || `Ошибка ${res.status}`);
  return json;
}

let toastTimer;
function toast(msg, isErr = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = isErr ? 'err' : '';
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, isErr ? 5000 : 2500);
}

async function copy(text, okMsg = 'Скопировано') {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMsg);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.append(ta); ta.select();
    try { document.execCommand('copy'); toast(okMsg); } catch { toast('Не удалось скопировать', true); }
    ta.remove();
  }
}

function avatarHtml(id, avatar, name, size = 32) {
  if (avatar) return `<img class="avatar" style="width:${size}px;height:${size}px" src="https://cdn.discordapp.com/avatars/${esc(id)}/${esc(avatar)}.png?size=64" alt="">`;
  return `<span class="avatar" style="width:${size}px;height:${size}px">${esc((name || '?').slice(0, 1).toUpperCase())}</span>`;
}

// Плашки санкции: внутри варианта — вместе, между вариантами — «или»
const chipsHtml = (chips) => `<span class="chips">${chips.map((c) => `<span class="chip chip-${c.t}">${esc(chipLabel(c))}</span>`).join('')}</span>`;
const optionsHtml = (options) => options.map(chipsHtml).join('<span class="or">или</span>');
const explain = (html) => `<div class="explain">${html}</div>`;

const LEAF = `<svg width="20" height="20" viewBox="0 0 32 32" aria-hidden="true"><path d="M16 5v22M16 12c-4 0-6-2-7-4 4 0 6 1 7 4zm0 0c4 0 6-2 7-4-4 0-6 1-7 4zm0 6c-4 0-6-2-7-4 4 0 6 1 7 4zm0 0c4 0 6-2 7-4-4 0-6 1-7 4z" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round"/></svg>`;

// ---------- загрузка ----------
async function boot() {
  try {
    S.me = await api('GET', '/api/me');
  } catch (e) {
    $('#app').innerHTML = `<div class="boot">Сервер недоступен: ${esc(e.message)}</div>`;
    return;
  }
  if (!S.me.user) return renderLogin();
  if (!S.me.role) return renderNoAccess();
  const fromHash = location.hash.slice(1);
  if (TABS.some((t) => t.id === fromHash && (!t.min || can(t.min)))) S.tab = fromHash;
  await loadData();
  connectEvents();
  render();
}

async function loadData() {
  S.data = await api('GET', '/api/data');
  if (S.tab === 'access' && can('admin')) S.access = await api('GET', '/api/access');
  if (S.tab === 'audit' && can('admin')) S.audit = await api('GET', '/api/audit');
}

let es, reloadTimer;
function connectEvents() {
  if (es) return;
  es = new EventSource('/api/events');
  es.addEventListener('change', () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(async () => { await loadData().catch(() => {}); render(); }, 250);
  });
}

// Перерисовка с сохранением фокуса в поле поиска
function render() {
  const active = document.activeElement;
  const focusId = active?.id && $('#app').contains(active) ? active.id : null;
  const caret = focusId && 'selectionStart' in active ? active.selectionStart : null;
  $('#app').innerHTML = S.me.role === 'member' ? selfView() : appView();
  if (focusId) {
    const el = document.getElementById(focusId);
    if (el) { el.focus(); if (caret != null) try { el.setSelectionRange(caret, caret); } catch {} }
  }
}

// ---------- экраны входа ----------
function renderLogin() {
  const failed = new URLSearchParams(location.search).get('login') === 'failed';
  $('#app').innerHTML = `
    <div class="gate"><div class="gate-card">
      <span class="brand-mark">${LEAF}</span>
      <div><h1>Отдел Farm</h1><p>Учёт оплат, отпусков и штрафов</p></div>
      ${failed ? `<p class="form-error">Не получилось войти через Discord. Попробуйте ещё раз.</p>
        <p class="small">Если ошибка повторяется: в Discord Developer Portal → OAuth2 → Redirects должен быть ровно этот адрес:</p>
        <div class="copy-line"><code>${esc(S.me.redirectUri)}</code><button class="btn sm" data-act="copy" data-text="${esc(S.me.redirectUri)}">Копировать</button></div>` : ''}
      ${S.me.discordConfigured
        ? '<a class="btn discord" href="/auth/discord">Войти через Discord</a>'
        : '<p class="form-error">Вход через Discord ещё не настроен на сервере (см. README.md).</p>'}
      <p class="small">Доступ выдаёт руководство отдела. Участники отдела видят свою карточку автоматически.</p>
      ${S.me.devLogin ? `
        <form class="dev" id="dev-form">
          <span class="small muted">Тестовый вход (только на этом компьютере)</span>
          <div class="grid2">
            <label class="field">Discord ID<input id="dev-id" required inputmode="numeric" placeholder="652927337016328212"></label>
            <label class="field">Имя<input id="dev-name" placeholder="Тест"></label>
          </div>
          <button class="btn">Войти как этот пользователь</button>
        </form>` : ''}
    </div></div>`;
  $('#dev-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    location.href = `/auth/dev?id=${encodeURIComponent($('#dev-id').value.trim())}&name=${encodeURIComponent($('#dev-name').value.trim())}`;
  });
}

function renderNoAccess() {
  const u = S.me.user;
  $('#app').innerHTML = `
    <div class="gate"><div class="gate-card">
      <div class="me">${avatarHtml(u.id, u.avatar, u.name, 44)}<div class="me-name" style="display:block"><b>${esc(u.name)}</b><span>@${esc(u.username)}</span></div></div>
      <div><h1>Нет доступа</h1><p>Руководство отдела ещё не выдало вам доступ. Ваш запрос уже виден им на вкладке «Доступ». Можно также отправить свой Discord ID:</p></div>
      <div class="copy-line"><code>${esc(u.id)}</code><button class="btn" data-act="copy" data-text="${esc(u.id)}">Копировать</button></div>
      <button class="btn ghost" data-act="logout">Выйти</button>
    </div></div>`;
}

// ---------- шапка ----------
function header() {
  const u = S.me.user;
  return `
    <header class="top"><div class="wrap">
      <a class="brand" href="#roster" data-act="tab" data-tab="roster"><span class="brand-mark">${LEAF}</span>
        <span><h1>Отдел Farm</h1><small>СЕГОДНЯ ${fd(T())}</small></span></a>
      <span class="top-spacer"></span>
      <div class="me">
        ${avatarHtml(u.id, u.avatar, u.name)}
        <div class="me-name"><b>${esc(u.name)}</b><span>${esc(S.me.roleLabel || '')}</span></div>
        <button class="btn ghost sm" data-act="logout">Выйти</button>
      </div>
    </div></header>`;
}

// ---------- основной вид ----------
function appView() {
  const t = T();
  const st = settings();
  const roster = buildRoster(S.data, st, t);
  const active = roster.filter((r) => !r.member.left);
  const payers = active.filter((r) => !r.member.exempt);
  const paid = payers.filter((r) => r.status.key === 'ok').length;
  const due = payers.filter((r) => ['due', 'unpaid', 'today'].includes(r.status.key));
  const openFines = S.data.fines.filter((f) => !f.paid && f.amount > 0);
  const overdueFines = openFines.filter((f) => t > dayNum(f.date) + st.fineDays);
  const week = weekReport(S.data, weekStart(t));

  const tabs = TABS.filter((tb) => !tb.min || can(tb.min));
  const badge = { fines: overdueFines.length, roster: due.length };
  const views = { roster: rosterTab, payments: paymentsTab, fines: finesTab, blacklist: blacklistTab, vacations: vacationsTab, week: weekTab, rules: rulesTab, access: accessTab, audit: auditTab };

  return `
    ${header()}
    <main class="wrap">
      <section class="tiles" aria-label="Сводка">
        <div class="tile"><span class="label">В отделе</span><span class="value">${active.length}</span><span class="sub">${active.length - payers.length ? `${active.length - payers.length} не платят взнос` : 'все платят взнос'}</span></div>
        <div class="tile good"><span class="label">Оплачено</span><span class="value">${paid}</span><span class="sub">из ${payers.length} плательщиков</span></div>
        <div class="tile ${due.length ? 'alert' : ''}"><span class="label">Требуется оплата</span><span class="value">${due.length}</span><span class="sub">${due.filter((r) => r.status.key === 'today').length} — сегодня</span></div>
        <div class="tile ${overdueFines.length ? 'alert' : ''}"><span class="label">Штрафы к оплате</span><span class="value">${money(openFines.reduce((s, f) => s + f.amount, 0))}</span><span class="sub">${openFines.length} шт., просрочено ${overdueFines.length}</span></div>
        <div class="tile"><span class="label">Внесено за неделю</span><span class="value">${money(week.total)}</span><span class="sub">${fdShort(week.ws)}–${fdShort(week.we)}</span></div>
      </section>
      <nav class="tabs" role="tablist">
        ${tabs.map((tb) => `<button class="tab" role="tab" aria-selected="${S.tab === tb.id}" data-act="tab" data-tab="${tb.id}">${tb.label}${badge[tb.id] ? `<span class="count">${badge[tb.id]}</span>` : ''}</button>`).join('')}
      </nav>
      ${views[S.tab](roster)}
    </main>
    <footer class="wrap footer">Данные обновляются сами, когда кто-то из руководства вносит изменения.</footer>
    ${S.drawer ? drawerView(roster) : ''}`;
}

function statusPill(r) {
  const s = r.status;
  let extra = '';
  if (s.key === 'ok') extra = ` · ещё ${days(s.daysLeft)}`;
  if (s.key === 'due') extra = ` · ${days(s.overdue)} просрочки`;
  const bl = blFor(r.member.discord);
  return `<span class="pill ${s.key}">${s.label}${extra}</span>`
    + (r.vacationNow ? ` <span class="pill vac">Отпуск по ${fdShort(dayNum(r.vacationNow.start) + r.vacationNow.days - 1)}</span>` : '')
    + (bl ? ' <span class="pill bad">ЧС</span>' : '');
}

const paidUntilText = (r) => (r.member.exempt ? '∞' : r.paidUntil == null ? 'нет оплат' : fd(r.paidUntil));

function discordLine(m) {
  if (!m.discord) return '';
  if (m.discordMissing) return `<span class="bad-text">ID не найден в Discord</span>`;
  return `<span>${m.discordTag ? `<span class="tag-at">@${esc(m.discordTag)}</span> · ` : ''}${esc(m.discord)}</span>`;
}

function memberCell(m) {
  return `<div class="who"><b>${esc(m.name)}${m.role !== 'member' ? ` <span class="role">${esc(MEMBER_ROLES[m.role] || m.role)}</span>` : ''}</b>${discordLine(m)}</div>`;
}

function memberAvatar(m, size = 44) {
  return avatarHtml(m.discord, m.discordAvatar, m.discordName || m.name, size);
}

// ----- Состав -----
// Фильтр общий для вкладки и скриншота: на картинке — ровно то, что видно в таблице
function filterRoster(roster) {
  const q = S.search.trim().toLowerCase();
  return roster.filter((r) => {
    if (S.rosterFilter === 'active' && r.member.left) return false;
    if (S.rosterFilter === 'left' && !r.member.left) return false;
    return !q || r.member.name.toLowerCase().includes(q) || r.member.discord.includes(q) || r.member.discordTag.toLowerCase().includes(q.replace(/^@/, ''));
  });
}

function rosterTab(roster) {
  const rows = filterRoster(roster);
  const edit = can('editor');
  return `
    <div class="toolbar">
      <div class="seg" role="group" aria-label="Фильтр">
        ${[['active', 'В отделе'], ['left', 'Ушедшие'], ['all', 'Все']].map(([k, l]) => `<button aria-pressed="${S.rosterFilter === k}" data-act="roster-filter" data-v="${k}">${l}</button>`).join('')}
      </div>
      <input class="input" id="roster-search" type="search" placeholder="Поиск: имя, @тег или Discord ID" value="${esc(S.search)}">
      <span class="grow"></span>
      <button class="btn" data-act="calc">Калькулятор</button>
      <button class="btn" data-act="remind">Напоминание должникам</button>
      ${rows.length ? '<button class="btn" data-act="shot" data-kind="roster">Скриншот</button>' : ''}
      ${edit ? '<button class="btn" data-act="new-member">+ Участник</button><button class="btn primary" data-act="new-payment">+ Оплата</button>' : ''}
    </div>
    <div class="card table-wrap">
      ${rows.length ? `<table>
        <thead><tr><th>Участник</th><th>Статус</th><th>Оплачено до</th><th class="hide-sm">Посл. оплата</th><th class="r">Штрафы</th><th class="r hide-sm">В отделе</th>${edit ? '<th></th>' : ''}</tr></thead>
        <tbody>${rows.map((r) => `
          <tr class="click ${r.member.left ? 'is-left' : ''}" data-act="open-member" data-id="${r.member.id}">
            <td>${memberCell(r.member)}</td>
            <td>${statusPill(r)}${r.owe ? `<div class="small muted owe">к оплате ${money(r.owe.amount)}</div>` : ''}</td>
            <td class="num">${paidUntilText(r)}</td>
            <td class="num hide-sm">${r.lastPay ? `${fd(r.lastPay.date)} <span class="muted">· ${money(r.lastPay.amount)}</span>` : '—'}</td>
            <td class="num r">${r.unpaidFinesSum ? `<span class="pill ${r.overdueFines.length ? 'bad' : 'warn'}">${money(r.unpaidFinesSum)}</span>` : '<span class="muted">—</span>'}</td>
            <td class="num r hide-sm">${r.daysInDept == null ? '—' : days(r.daysInDept)}</td>
            ${edit ? `<td class="r">${!r.member.left && !r.member.exempt ? `<button class="btn sm" data-act="new-payment" data-member="${r.member.id}">Оплата</button>` : ''}</td>` : ''}
          </tr>`).join('')}
        </tbody></table>` : emptyState(S.data.members.length ? 'Никого не найдено' : 'В составе пока никого нет', S.data.members.length ? 'Измените фильтр или поиск.' : 'Добавьте первого участника: имя, Discord ID и дату вступления.', edit && !S.data.members.length ? '<button class="btn primary" data-act="new-member">+ Добавить участника</button>' : '')}
    </div>`;
}

function emptyState(title, text, action = '') {
  return `<div class="empty"><b>${esc(title)}</b><span>${esc(text)}</span>${action}</div>`;
}

// ----- Оплаты -----
function paymentsTab() {
  const q = S.payQuery.trim().toLowerCase();
  const rows = [...S.data.payments]
    .sort((a, b) => b.date.localeCompare(a.date))
    .filter((p) => !q || (memberById(p.memberId)?.name || '').toLowerCase().includes(q));
  const edit = can('editor');
  return `
    <div class="toolbar">
      <input class="input" id="pay-search" type="search" placeholder="Поиск по участнику" value="${esc(S.payQuery)}">
      <span class="grow"></span>
      ${edit ? '<button class="btn primary" data-act="new-payment">+ Оплата</button>' : ''}
    </div>
    <div class="card table-wrap">
      ${rows.length ? `<table>
        <thead><tr><th>Дата</th><th>Участник</th><th class="r">Сумма</th><th class="r">Дней</th><th class="hide-sm">Комментарий</th>${edit ? '<th></th>' : ''}</tr></thead>
        <tbody>${rows.map((p) => {
          const m = memberById(p.memberId);
          return `<tr>
            <td class="num">${fd(p.date)}</td>
            <td>${m ? `<a href="#" data-act="open-member" data-id="${m.id}">${esc(m.name)}</a>` : '—'}</td>
            <td class="num r">${money(p.amount)}${p.entry ? `<div class="small muted">вкл. вступ. ${money(p.entry)}</div>` : ''}</td>
            <td class="num r">${p.days}</td>
            <td class="hide-sm muted">${esc(p.note)}</td>
            ${edit ? `<td><div class="actions"><button class="btn sm ghost" data-act="edit-payment" data-id="${p.id}">Изменить</button></div></td>` : ''}
          </tr>`;
        }).join('')}</tbody></table>` : emptyState('Оплат пока нет', 'Каждая оплата сама продлевает срок участника по таблице цен.', edit && S.data.members.length ? '<button class="btn primary" data-act="new-payment">+ Внести оплату</button>' : '')}
    </div>`;
}

// ----- Штрафы -----
function fineStatus(f, t, st) {
  if (f.amount <= 0) return '<span class="pill idle">Без оплаты</span>';
  if (f.paid) return `<span class="pill ok">Оплачен ${fdShort(f.paidDate)}</span>`;
  const deadline = dayNum(f.date) + st.fineDays;
  return t > deadline ? '<span class="pill bad">Просрочен</span>' : `<span class="pill warn">Оплатить до ${fdShort(deadline)}</span>`;
}

const filterFines = () => [...S.data.fines]
  .filter((f) => S.fineFilter === 'all' || (!f.paid && f.amount > 0))
  .sort((a, b) => (a.paid - b.paid) || b.date.localeCompare(a.date));

function finesTab() {
  const t = T();
  const st = settings();
  const rows = filterFines();
  const edit = can('editor');
  const auto = autoRules(rules());
  return `
    ${explain(`Штраф выдаётся по пункту правил: сумма и санкция подставляются сами. Если у пункта несколько вариантов («50 000$ или ЧС»), выберите один.
      На оплату даётся <b>${st.fineDays} сут.</b> с даты выдачи, потом штраф становится «Просрочен» — человека можно занести в ЧС кнопкой в строке.
      ${auto.length ? `Пункт${auto.length > 1 ? 'ы' : ''} ${auto.map((r) => `<b>${esc(r.code)}</b> (через ${days(r.autoDays)} неоплаты взноса)`).join(', ')} выдаются автоматически.` : ''}
      Когда человек скинул отчёт об оплате, нажмите «Оплачен».`)}
    <div class="toolbar">
      <div class="seg" role="group">
        ${[['open', 'К оплате'], ['all', 'Все']].map(([k, l]) => `<button aria-pressed="${S.fineFilter === k}" data-act="fine-filter" data-v="${k}">${l}</button>`).join('')}
      </div>
      <span class="grow"></span>
      ${rows.length ? '<button class="btn" data-act="shot" data-kind="fines">Скриншот</button>' : ''}
      ${edit ? '<button class="btn primary" data-act="new-fine">+ Штраф</button>' : ''}
    </div>
    <div class="card table-wrap">
      ${rows.length ? `<table>
        <thead><tr><th>Выдан</th><th>Участник</th><th>Нарушение</th><th>Санкция</th><th>Статус</th>${edit ? '<th></th>' : ''}</tr></thead>
        <tbody>${rows.map((f) => {
          const m = memberById(f.memberId);
          const overdue = !f.paid && f.amount > 0 && t > dayNum(f.date) + st.fineDays;
          const inBl = m && blFor(m.discord);
          return `<tr>
            <td class="num">${fd(f.date)}${f.auto ? '<div class="small muted">авто</div>' : ''}</td>
            <td>${m ? `<a href="#" data-act="open-member" data-id="${m.id}">${esc(m.name)}</a>` : '—'}</td>
            <td>${f.code !== 'other' ? `<span class="tag">${esc(f.code)}</span> ` : ''}${esc(f.title)}${f.note ? `<div class="small muted">${esc(f.note)}</div>` : ''}</td>
            <td>${f.sanctions.length ? chipsHtml(f.sanctions) : `<span class="num">${money(f.amount)}</span>`}</td>
            <td>${fineStatus(f, t, st)}${inBl ? ' <span class="pill bad">ЧС</span>' : ''}</td>
            ${edit ? `<td><div class="actions">
              ${!f.paid && f.amount > 0 ? `<button class="btn sm" data-act="fine-paid" data-id="${f.id}">Оплачен</button>` : ''}
              ${overdue && m && !inBl ? `<button class="btn sm danger" data-act="bl-from-fine" data-id="${f.id}">В ЧС</button>` : ''}
              <button class="btn sm ghost" data-act="edit-fine" data-id="${f.id}">Изменить</button></div></td>` : ''}
          </tr>`;
        }).join('')}</tbody></table>` : emptyState(S.fineFilter === 'open' ? 'Неоплаченных штрафов нет' : 'Штрафов пока нет', 'Штраф выписывается по пункту правил, сумма подставится сама.', edit && S.data.members.length ? '<button class="btn primary" data-act="new-fine">+ Выписать штраф</button>' : '')}
    </div>`;
}

// ----- Чёрный список -----
function blacklistTab() {
  const t = T();
  const edit = can('editor');
  const rows = blacklist().filter((b) => S.blFilter === 'all' || blacklistActive(b, t));
  return `
    ${explain('В чёрном списке — люди, которых нельзя принимать в отдел. Если добавить в состав человека с Discord ID из ЧС, сайт предупредит. ЧС без даты окончания — навсегда. Занести можно здесь, из карточки участника или из просроченного штрафа.')}
    <div class="toolbar">
      <div class="seg" role="group">
        ${[['active', 'Действует'], ['all', 'Все']].map(([k, l]) => `<button aria-pressed="${S.blFilter === k}" data-act="bl-filter" data-v="${k}">${l}</button>`).join('')}
      </div>
      <span class="grow"></span>
      ${edit ? '<button class="btn primary" data-act="new-bl">+ В ЧС</button>' : ''}
    </div>
    <div class="card table-wrap">
      ${rows.length ? `<table>
        <thead><tr><th>Кто</th><th>Причина</th><th>С</th><th>До</th><th>Статус</th>${edit ? '<th></th>' : ''}</tr></thead>
        <tbody>${rows.map((b) => `<tr>
          <td><div class="who"><b>${esc(b.name)}</b>${b.discord ? `<span>${b.discordTag ? `<span class="tag-at">@${esc(b.discordTag)}</span> · ` : ''}${esc(b.discord)}</span>` : ''}</div></td>
          <td>${esc(b.reason || '—')}</td>
          <td class="num">${fd(b.date)}</td>
          <td class="num">${b.until ? fd(b.until) : 'навсегда'}</td>
          <td>${blacklistActive(b, t) ? '<span class="pill bad">Действует</span>' : '<span class="pill left">Истёк</span>'}</td>
          ${edit ? `<td><div class="actions"><button class="btn sm ghost" data-act="edit-bl" data-id="${b.id}">Изменить</button></div></td>` : ''}
        </tr>`).join('')}</tbody></table>` : emptyState('Чёрный список пуст', 'Сюда попадают нарушители: вручную или при штрафе с санкцией «ЧС».', edit ? '<button class="btn primary" data-act="new-bl">+ Занести в ЧС</button>' : '')}
    </div>`;
}

// ----- Отпуска -----
function vacationsTab() {
  const t = T();
  const rows = [...S.data.vacations].sort((a, b) => b.start.localeCompare(a.start));
  const edit = can('editor');
  const r31 = ruleByCode(rules(), '3.1');
  return `
    ${explain(`Отпуск — дни, когда участник не играет и не платит взнос. Дата следующей оплаты сдвигается на длину отпуска: если было оплачено до 10.11, а отпуск 5 дней, станет до 15.11.
      Внесите отпуск, когда человек оставил заявку.${r31 ? ` Активность в игре во время отпуска — нарушение п. ${esc(r31.code)}.` : ''}`)}
    <div class="toolbar">
      <span class="grow"></span>
      ${edit ? '<button class="btn primary" data-act="new-vacation">+ Отпуск</button>' : ''}
    </div>
    <div class="card table-wrap">
      ${rows.length ? `<table>
        <thead><tr><th>Участник</th><th>С</th><th>По</th><th class="r">Дней</th><th>Статус</th>${edit ? '<th></th>' : ''}</tr></thead>
        <tbody>${rows.map((v) => {
          const m = memberById(v.memberId);
          const s = dayNum(v.start); const e = s + v.days - 1;
          const st = t < s ? '<span class="pill idle">Запланирован</span>' : t <= e ? '<span class="pill vac">Идёт</span>' : '<span class="pill left">Завершён</span>';
          return `<tr>
            <td>${m ? `<a href="#" data-act="open-member" data-id="${m.id}">${esc(m.name)}</a>` : '—'}${v.note ? `<div class="small muted">${esc(v.note)}</div>` : ''}</td>
            <td class="num">${fd(s)}</td><td class="num">${fd(e)}</td><td class="num r">${v.days}</td><td>${st}</td>
            ${edit ? `<td><div class="actions"><button class="btn sm ghost" data-act="edit-vacation" data-id="${v.id}">Изменить</button></div></td>` : ''}
          </tr>`;
        }).join('')}</tbody></table>` : emptyState('Отпусков нет', 'Когда участник уходит в отпуск, внесите его здесь — срок оплаты продлится сам.', edit && S.data.members.length ? '<button class="btn primary" data-act="new-vacation">+ Отпуск</button>' : '')}
    </div>`;
}

// ----- По неделям -----
function weekTab() {
  const ws = weekStart(T()) + S.weekOffset * 7;
  const w = weekReport(S.data, ws);
  const allTotal = S.data.payments.reduce((s, p) => s + p.amount, 0);
  const allFines = S.data.fines.filter((f) => f.paid).reduce((s, f) => s + f.amount, 0);
  return `
    ${explain('Это замена листов «Заработок фарма» из таблицы, только считается само. Неделя — с понедельника по воскресенье. Сюда попадают все оплаты, внесённые на вкладке «Оплаты», по дате оплаты, и штрафы, отмеченные оплаченными. Стрелками листайте прошлые недели.')}
    <div class="toolbar">
      <div class="week-nav">
        <button class="btn" data-act="week" data-d="-1" aria-label="Предыдущая неделя">‹</button>
        <span class="range">${fd(w.ws)} – ${fd(w.we)}</span>
        <button class="btn" data-act="week" data-d="1" aria-label="Следующая неделя">›</button>
        ${S.weekOffset ? '<button class="btn ghost sm" data-act="week" data-d="0">Текущая</button>' : ''}
      </div>
    </div>
    <div class="tiles" style="margin-top:0">
      <div class="tile"><span class="label">Внесено за неделю</span><span class="value">${money(w.total)}</span><span class="sub">${w.payments.length} оплат</span></div>
      <div class="tile"><span class="label">Из них вступительные</span><span class="value">${money(w.entryTotal)}</span></div>
      <div class="tile"><span class="label">Оплачено штрафов</span><span class="value">${money(w.finesPaidTotal)}</span><span class="sub">выписано за неделю: ${w.finesIssued.length}</span></div>
      <div class="tile"><span class="label">Всего за всё время</span><span class="value">${money(allTotal)}</span><span class="sub">+ штрафы ${money(allFines)}</span></div>
    </div>
    <div class="card table-wrap">
      ${w.byMember.length ? `<table>
        <thead><tr><th>Участник</th><th class="r">Оплат</th><th class="r">Дней</th><th class="r">Внесено на нед.</th></tr></thead>
        <tbody>${w.byMember.map((r) => `<tr>
          <td>${esc(memberById(r.memberId)?.name || '—')}</td><td class="num r">${r.count}</td><td class="num r">${r.days}</td><td class="num r">${money(r.amount)}</td>
        </tr>`).join('')}</tbody></table>` : emptyState('За эту неделю оплат нет', 'Переключите неделю стрелками.')}
    </div>`;
}

// ----- Цены и правила -----
function priceTable(p) {
  return `<div class="table-wrap"><table>
    <thead><tr><th>Дней</th><th class="r">За 1 день</th><th class="r">Мин. оплата</th><th class="r">За неделю</th></tr></thead>
    <tbody>${p.map((price, i) => `<tr><td class="num">${i === 6 ? '7+' : i + 1}</td><td class="num r">${money(price)}</td><td class="num r">${money(costFor(i + 1, p))}</td><td class="num r">${money(price * 7)}</td></tr>`).join('')}</tbody>
  </table></div>`;
}

function rulesHtml(admin) {
  const r = rules();
  const st = settings();
  return `
    ${r.categories.map((c, ci) => `
      <div class="rule-cat">
        <div class="rule-cat-head">
          <h3>${ci + 1}. ${esc(c.title)}</h3>
          ${admin ? `<span class="actions">
            <button class="btn sm ghost" data-act="rule-new" data-cat="${ci}">+ Пункт</button>
            <button class="btn sm ghost" data-act="cat-edit" data-cat="${ci}">Переименовать</button>
          </span>` : ''}
        </div>
        ${c.items.length ? c.items.map((i, ii) => `
          <div class="rule-item">
            <span class="tag">${esc(i.code)}</span>
            <div class="rule-body">
              <span>${esc(i.title)}</span>
              <div class="rule-sanctions">${optionsHtml(i.options)}${i.autoDays ? `<span class="pill warn">автоштраф через ${days(i.autoDays)} неоплаты</span>` : ''}</div>
            </div>
            ${admin ? `<button class="btn sm ghost" data-act="rule-edit" data-cat="${ci}" data-item="${ii}">Изменить</button>` : ''}
          </div>`).join('') : '<p class="muted small" style="margin:0 0 0 4px">Пунктов пока нет.</p>'}
      </div>`).join('')}
    <div class="rule-notes">
      ${r.notes ? r.notes.split('\n').map((l) => `<p>${esc(l)}</p>`).join('') : ''}
      <p class="muted small">Срок оплаты штрафа в расчётах: ${st.fineDays} сут.</p>
      ${admin ? '<div class="btn-row"><button class="btn sm" data-act="cat-new">+ Категория</button><button class="btn sm" data-act="notes-edit">Изменить примечания и срок</button></div>' : ''}
    </div>`;
}

function rulesTab() {
  const st = settings();
  const admin = can('admin');
  return `
    <div class="cols rules-cols">
      <div class="panel">
        <h3>Цена дней</h3>
        ${priceTable(st.prices)}
        <p class="small muted" style="margin:0">Вступительный взнос: <b class="num">${money(st.entryFee)}</b>. Остаток суммы, которого не хватает на целый день, не переносится.</p>
        ${admin ? '<div><button class="btn" data-act="edit-prices">Изменить цены</button></div>' : ''}
      </div>
      <div class="panel">
        <h3>Система штрафов</h3>
        ${rulesHtml(admin)}
      </div>
    </div>`;
}

function calcText(amount) {
  const st = settings();
  if (!amount) return '<span>Введите сумму — покажу, на сколько дней её хватит.</span>';
  const d = daysFor(amount, st.prices);
  if (!d) return `<span>Не хватает даже на 1 день (нужно ${money(st.prices[0])}).</span>`;
  const cost = costFor(d, st.prices);
  return `<span>Хватит на <b>${d} дн.</b> — стоимость ${money(cost)}${amount - cost ? `, остаток ${money(amount - cost)}` : ''}</span>
    <span class="small muted">С вступительным взносом (новичок): ${daysFor(Math.max(0, amount - st.entryFee), st.prices)} дн.</span>`;
}

function calcDaysText(n) {
  const st = settings();
  if (!n) return '<span>Введите число дней — покажу, сколько это стоит.</span>';
  const exact = costFor(n, st.prices);
  const best = minPayFor(n, st.prices);
  return `<span>${days(n)} — <b>${money(exact)}</b></span>${best.days !== n ? `<span class="small muted">Выгоднее оплатить ${days(best.days)} за ${money(best.cost)}</span>` : ''}`;
}

// ----- Доступ -----
function accessTab() {
  if (!S.access) return '<div class="boot">Загрузка…</div>';
  const { owners, access, requests } = S.access;
  const isOwner = S.me.role === 'owner';
  const roleOptions = (cur) => ['viewer', 'editor', ...(isOwner ? ['admin'] : [])].map((r) => `<option value="${r}" ${cur === r ? 'selected' : ''}>${ACCESS_ROLES[r]}</option>`).join('');
  const person = (u) => `<div class="me">${avatarHtml(u.discord_id, u.avatar, u.global_name || u.username || '?')}<div class="who"><b>${esc(u.global_name || u.username || 'Ещё не входил')}</b><span>${esc(u.discord_id)}</span></div></div>`;
  const linkedMember = (id) => { const m = S.data.members.find((x) => x.discord === id); return m ? `<span class="small muted">в составе: ${esc(m.name)}</span>` : ''; };
  return `
    <div class="cols">
      <div class="panel">
        <h3>Выдать доступ</h3>
        <form id="access-form" class="section" style="margin:0">
          <label class="field">Discord ID<input id="acc-id" required inputmode="numeric" placeholder="17–20 цифр" list="acc-members"></label>
          <datalist id="acc-members">${S.data.members.filter((m) => m.discord).map((m) => `<option value="${esc(m.discord)}">${esc(m.name)}</option>`).join('')}</datalist>
          <div class="grid2">
            <label class="field">Уровень<select id="acc-role">${roleOptions('editor')}</select></label>
            <label class="field">Заметка<input id="acc-note" placeholder="Например: зам по оплатам"></label>
          </div>
          <div><button class="btn primary">Выдать доступ</button></div>
        </form>
      </div>
      <div class="panel">
        <h3>Уровни доступа</h3>
        <div class="small" style="display:grid;gap:6px">
          <div><span class="pill idle">Участник отдела</span> — автоматически: видит только свою карточку (срок оплаты, штрафы, правила).</div>
          <div><span class="pill staff">Просмотр</span> — видит все данные, ничего не меняет.</div>
          <div><span class="pill ok">Редактор</span> — вносит оплаты, отпуска, штрафы, ЧС и состав.</div>
          <div><span class="pill warn">Администратор</span> — плюс цены, правила, выдача доступа и журнал.</div>
          <div><span class="pill bad">Владелец</span> — задаётся на сервере; назначает администраторов и чистит журнал.</div>
        </div>
      </div>
    </div>
    ${requests.length ? `
      <div class="section" style="margin-top:20px">
        <h2>Запросы доступа</h2>
        <p class="small muted" style="margin:0">Эти люди вошли через Discord, но доступа у них нет.</p>
        <div class="card table-wrap"><table><tbody>${requests.map((u) => `<tr>
          <td>${person(u)} ${linkedMember(u.discord_id)}</td>
          <td class="num small muted hide-sm">вход ${fd(u.last_login.slice(0, 10))}</td>
          <td><div class="actions">
            <button class="btn sm" data-act="grant" data-id="${u.discord_id}" data-role="viewer">Просмотр</button>
            <button class="btn sm primary" data-act="grant" data-id="${u.discord_id}" data-role="editor">Редактор</button>
          </div></td></tr>`).join('')}</tbody></table></div>
      </div>` : ''}
    <div class="section" style="margin-top:20px">
      <h2>У кого есть доступ</h2>
      <div class="card table-wrap"><table>
        <thead><tr><th>Человек</th><th>Уровень</th><th class="hide-sm">Заметка</th><th></th></tr></thead>
        <tbody>
          ${owners.map((u) => `<tr><td>${person(u)}</td><td><span class="pill bad">Владелец</span></td><td class="hide-sm muted small">из настроек сервера</td><td></td></tr>`).join('')}
          ${access.map((a) => {
            const locked = (!isOwner && a.role === 'admin') || a.discord_id === S.me.user.id;
            return `<tr>
              <td>${person(a)} ${linkedMember(a.discord_id)}</td>
              <td>${locked ? `<span class="pill ${a.role === 'admin' ? 'warn' : 'ok'}">${ACCESS_ROLES[a.role]}</span>` : `<select class="input" style="width:auto" data-act="set-role" data-id="${a.discord_id}" data-note="${esc(a.note)}">${roleOptions(a.role)}</select>`}</td>
              <td class="hide-sm muted small">${esc(a.note)}</td>
              <td><div class="actions">${locked ? '' : `<button class="btn sm danger" data-act="revoke" data-id="${a.discord_id}">Снять</button>`}</div></td>
            </tr>`;
          }).join('')}
        </tbody></table></div>
    </div>`;
}

// ----- Журнал -----
function auditTab() {
  if (!S.audit) return '<div class="boot">Загрузка…</div>';
  const owner = can('owner');
  const { rows, total } = S.audit;
  return `
    <div class="toolbar">
      <span class="small muted">Записей: ${total}${total > rows.length ? `, показаны последние ${rows.length}` : ''}</span>
      <span class="grow"></span>
      ${owner && total ? `<button class="btn sm" data-act="audit-clear" data-days="30">Удалить старше 30 дней</button>
        <button class="btn sm danger" data-act="audit-clear">Очистить журнал</button>` : ''}
    </div>
    <div class="card table-wrap">${rows.length ? `<table>
    <thead><tr><th>Когда</th><th>Кто</th><th>Действие</th><th>Подробности</th>${owner ? '<th></th>' : ''}</tr></thead>
    <tbody>${rows.map((a) => {
      const d = new Date(a.at);
      return `<tr><td class="num small">${d.toLocaleDateString('ru-RU')} ${d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</td>
        <td>${a.actor_id ? esc(a.global_name || a.username || a.actor_id) : '<span class="muted">Система</span>'}</td><td>${esc(a.action)}</td><td class="small">${esc(a.summary)}</td>
        ${owner ? `<td><button class="btn sm ghost" data-act="audit-del" data-id="${a.id}" aria-label="Удалить запись">✕</button></td>` : ''}</tr>`;
    }).join('')}</tbody></table>` : emptyState('Журнал пуст', 'Здесь появится каждое изменение: кто и что внёс.')}</div>`;
}

// ---------- карточка участника ----------
function drawerView(roster) {
  const r = roster.find((x) => x.member.id === S.drawer);
  if (!r) return '';
  const m = r.member;
  const edit = can('editor');
  const st = settings();
  const t = T();
  const bl = blFor(m.discord);
  // Подсказка про штраф за неоплату: автоштраф выдастся сам, иначе — кнопка
  const npr = nonPayRule();
  const debt = ['due', 'unpaid'].includes(r.status.key) && r.dueSince != null;
  const hasNpFine = npr && r.fines.some((f) => f.code === npr.code && dayNum(f.date) >= r.dueSince);
  let fineHint = '';
  if (edit && debt && npr && !hasNpFine) {
    fineHint = npr.autoDays
      ? `<div class="hint"><span>Не оплачено с ${fd(r.dueSince)}. Если не оплатит, штраф п. ${esc(npr.code)} (${esc(optionLabel(npr.options[0]))}) выдастся сам ${fd(r.dueSince + npr.autoDays)}.</span></div>`
      : `<div class="hint bad"><span>Не оплачено с ${fd(r.dueSince)}. По п. ${esc(npr.code)}: ${esc(optionLabel(npr.options[0]))}.</span><button class="btn sm" data-act="quick-fine" data-member="${m.id}" data-code="${esc(npr.code)}">Выписать ${esc(npr.code)}</button></div>`;
  }
  const history = [
    ...r.pays.map((p) => ({ d: p.date, html: `<span><span class="k">Оплата</span>${money(p.amount)} за ${days(p.days)}${p.entry ? ` <span class="muted small">(вкл. вступ. ${money(p.entry)})</span>` : ''}${p.note ? `<div class="small muted">${esc(p.note)}</div>` : ''}</span>`, act: edit ? `<button class="btn sm ghost" data-act="edit-payment" data-id="${p.id}">Изм.</button>` : '' })),
    ...r.vacs.map((v) => ({ d: v.start, html: `<span><span class="k">Отпуск</span>${days(v.days)}, по ${fd(dayNum(v.start) + v.days - 1)}</span>`, act: edit ? `<button class="btn sm ghost" data-act="edit-vacation" data-id="${v.id}">Изм.</button>` : '' })),
    ...r.fines.map((f) => ({ d: f.date, html: `<span><span class="k">Штраф ${esc(f.code === 'other' ? '' : f.code)}${f.auto ? ' · авто' : ''}</span>${esc(f.title)}<div>${f.sanctions.length ? chipsHtml(f.sanctions) : money(f.amount)} ${fineStatus(f, t, st)}</div></span>`, act: edit ? `<button class="btn sm ghost" data-act="edit-fine" data-id="${f.id}">Изм.</button>` : '' })),
  ].sort((a, b) => b.d.localeCompare(a.d));

  return `
    <div class="drawer-bg" data-act="close-drawer"></div>
    <aside class="drawer" aria-label="Карточка участника">
      <div class="drawer-head">
        ${m.discord ? memberAvatar(m) : ''}
        <div style="flex:1;display:grid;gap:6px;min-width:0">
          <h2>${esc(m.name)}</h2>
          ${m.discordTag ? `<span class="small"><span class="tag-at">@${esc(m.discordTag)}</span>${m.discordName && m.discordName !== m.discordTag ? ` <span class="muted">· ${esc(m.discordName)}</span>` : ''}</span>` : ''}
          <div>${statusPill(r)} ${m.role !== 'member' ? `<span class="pill staff">${esc(MEMBER_ROLES[m.role] || m.role)}</span>` : ''}</div>
        </div>
        <button class="btn ghost" data-act="close-drawer" aria-label="Закрыть">✕</button>
      </div>
      ${m.discord ? `<div class="copy-line"><code>&lt;@${esc(m.discord)}&gt;</code><button class="btn sm" data-act="copy" data-text="<@${esc(m.discord)}>" title="Упоминание для Discord">Копировать</button>${edit && S.me.botEnabled ? `<button class="btn sm ghost" data-act="discord-refresh" data-id="${m.id}" title="Заново узнать тег и аватар">Обновить тег</button>` : ''}</div>` : ''}
      ${m.discordMissing ? '<div class="hint bad"><span>Discord не нашёл пользователя с этим ID. Проверьте ID в карточке участника.</span></div>' : ''}
      ${bl ? `<div class="hint bad"><span>В чёрном списке с ${fd(bl.date)}${bl.until ? ` по ${fd(bl.until)}` : ' (навсегда)'}${bl.reason ? `: ${esc(bl.reason)}` : ''}.</span></div>` : ''}
      <dl class="facts" style="margin:0">
        <div><dt>Оплачено до</dt><dd>${paidUntilText(r)}</dd></div>
        <div><dt>${r.owe ? 'К оплате' : 'Посл. оплата'}</dt><dd>${r.owe ? money(r.owe.amount) : r.lastPay ? fd(r.lastPay.date) : '—'}</dd></div>
        <div><dt>Внесено всего</dt><dd>${money(r.totalPaid)}</dd></div>
        <div><dt>Штрафы к оплате</dt><dd>${money(r.unpaidFinesSum)}</dd></div>
        <div><dt>Вступил</dt><dd>${fd(m.joined)}</dd></div>
        <div><dt>${m.left ? 'Уволился' : 'В отделе'}</dt><dd>${m.left ? fd(m.left) : r.daysInDept == null ? '—' : days(r.daysInDept)}</dd></div>
      </dl>
      ${m.exempt ? '<p class="small muted" style="margin:0">Не платит взнос — оплачено бессрочно.</p>' : ''}
      ${m.note ? `<p class="small muted" style="margin:0">${esc(m.note)}</p>` : ''}
      ${fineHint}
      ${edit ? `<div class="btn-row">
        ${!m.left && !m.exempt ? `<button class="btn primary" data-act="new-payment" data-member="${m.id}">+ Оплата</button>` : ''}
        ${!m.left ? `<button class="btn" data-act="new-vacation" data-member="${m.id}">+ Отпуск</button>` : ''}
        <button class="btn" data-act="new-fine" data-member="${m.id}">+ Штраф</button>
        ${!bl ? `<button class="btn danger" data-act="new-bl" data-member="${m.id}">В ЧС</button>` : ''}
        <button class="btn ghost" data-act="edit-member" data-id="${m.id}">Изменить</button>
      </div>` : ''}
      <div>
        <h2 style="margin-bottom:6px">История</h2>
        ${history.length ? `<div class="timeline">${history.map((h) => `<div class="tl"><span class="d">${fd(h.d)}</span>${h.html}<span>${h.act}</span></div>`).join('')}</div>` : '<p class="muted small">Записей пока нет.</p>'}
      </div>
    </aside>`;
}

// ---------- личная карточка участника ----------
function selfView() {
  const m = S.data.members[0];
  const st = settings();
  const t = T();
  const r = memberState(m, S.data, st, t);
  const npr = nonPayRule();
  let big = r.status.label;
  let line = '';
  if (r.status.key === 'exempt') { big = 'Оплачено бессрочно'; line = 'Вам не нужно платить взнос.'; }
  if (r.status.key === 'ok') { big = `Оплачено до ${fd(r.paidUntil)}`; line = `Осталось ${days(r.status.daysLeft)}.`; }
  if (r.status.key === 'today') line = 'Сегодня последний день — внесите оплату.';
  if (r.status.key === 'due') line = `Просрочка ${days(r.status.overdue)}.${npr ? ` За неуплату — ${optionLabel(npr.options[0])} (п. ${npr.code}).` : ''}`;
  if (r.status.key === 'unpaid') line = 'Оплат пока не было.';
  return `
    ${header()}
    <main class="wrap">
      <section class="self-hero">
        <span class="small muted">${esc(m.name)}</span>
        <span class="big">${esc(big)}</span>
        <span>${statusPill(r)}</span>
        ${line ? `<span class="muted">${esc(line)}</span>` : ''}
        ${r.owe ? `<span>К оплате: <b class="num">${money(r.owe.amount)}</b> <span class="muted small">(${days(r.owe.payDays)}${r.owe.withEntry ? ' + вступительный взнос' : ''})</span></span>` : ''}
      </section>
      ${r.unpaidFines.length ? `<div class="hint ${r.overdueFines.length ? 'bad' : ''}" style="margin-bottom:16px"><span>Неоплаченные штрафы: <b class="num">${money(r.unpaidFinesSum)}</b>. Срок оплаты — ${st.fineDays} сут. с момента выдачи.</span></div>` : ''}
      <div class="cols">
        <div class="panel">
          <h3>Мои записи</h3>
          ${[...r.pays.map((p) => ({ d: p.date, t: `Оплата ${money(p.amount)} за ${days(p.days)}` })),
             ...r.vacs.map((v) => ({ d: v.start, t: `Отпуск ${days(v.days)}` })),
             ...r.fines.map((f) => ({ d: f.date, t: `Штраф ${f.code === 'other' ? '' : f.code} «${f.title}»: ${f.sanctions.length ? optionLabel(f.sanctions) : money(f.amount)}${f.amount > 0 ? (f.paid ? ' — оплачен' : ' — не оплачен') : ''}` }))]
            .sort((a, b) => b.d.localeCompare(a.d))
            .map((h) => `<div class="tl" style="grid-template-columns:86px 1fr"><span class="d">${fd(h.d)}</span><span>${esc(h.t)}</span></div>`).join('') || '<p class="muted small">Записей пока нет.</p>'}
        </div>
        <div class="panel">
          <h3>Цена дней</h3>
          ${priceTable(st.prices)}
        </div>
        <div class="panel" style="grid-column: 1 / -1">
          <h3>Система штрафов</h3>
          ${rulesHtml(false)}
        </div>
      </div>
    </main>`;
}

// ---------- формы ----------
function openModal(html, onMount, wide = false) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-bg" data-act="modal-bg"><div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${html}</div></div>`;
  const first = root.querySelector('input:not([type=hidden]):not([type=radio]):not([type=checkbox]), select, textarea');
  onMount?.(root);
  first?.focus();
}
const closeModal = () => { $('#modal-root').innerHTML = ''; };

function memberOptions(selectedId, includeLeft = false, placeholder = 'Выберите участника', allowEmpty = false) {
  const list = [...S.data.members]
    .filter((m) => includeLeft || !m.left || m.id === selectedId)
    .sort((a, b) => a.name.localeCompare(b.name));
  return `<option value="" ${allowEmpty ? '' : 'disabled'} ${selectedId ? '' : 'selected'}>${esc(placeholder)}</option>` +
    list.map((m) => `<option value="${m.id}" ${m.id === selectedId ? 'selected' : ''}>${esc(m.name)}${m.left ? ' (ушёл)' : ''}</option>`).join('');
}

function formShell(title, body, { onDelete, submit = 'Сохранить' } = {}) {
  return `<form id="f" novalidate>
    <h2>${esc(title)}</h2>
    <div style="display:grid;gap:12px;margin-top:14px">${body}</div>
    <div class="form-error" id="f-error"></div>
    <div class="modal-actions">
      ${onDelete ? '<button type="button" class="btn danger left" data-confirm="delete">Удалить</button>' : ''}
      <button type="button" class="btn ghost" data-act="close-modal">Отмена</button>
      ${submit ? `<button class="btn primary">${esc(submit)}</button>` : ''}
    </div>
  </form>`;
}

function bindForm(root, submit, onDelete) {
  const form = $('#f', root);
  const err = $('#f-error', root);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const btn = form.querySelector('button.primary');
    btn.disabled = true;
    try { await submit(); closeModal(); } catch (ex) { err.textContent = ex.message; } finally { btn.disabled = false; }
  });
  const del = form.querySelector('[data-confirm="delete"]');
  if (del && onDelete) armButton(del, async () => {
    try { await onDelete(); closeModal(); } catch (ex) { err.textContent = ex.message; }
  });
}

// Удаление в два нажатия: первое — «Точно удалить?», второе — удаляет
function armButton(btn, action, label = 'Точно удалить?') {
  const original = btn.textContent;
  let timer;
  btn.addEventListener('click', () => {
    if (btn.dataset.armed) { clearTimeout(timer); delete btn.dataset.armed; btn.textContent = original; action(); return; }
    btn.dataset.armed = '1'; btn.textContent = label;
    timer = setTimeout(() => { delete btn.dataset.armed; btn.textContent = original; }, 3500);
  });
}

// То же для кнопок в таблицах, которые перерисовываются: подтверждение через data-armed
function confirmClick(el, label) {
  if (el.dataset.armed) return true;
  const original = el.textContent;
  el.dataset.armed = '1'; el.textContent = label;
  setTimeout(() => { if (el.isConnected) { delete el.dataset.armed; el.textContent = original; } }, 3500);
  return false;
}

async function afterSave(msg) {
  await loadData();
  render();
  toast(msg);
}

// ----- участник -----
function memberForm(m = null) {
  openModal(formShell(m ? 'Изменить участника' : 'Новый участник', `
    <label class="field">Имя Фамилия<input id="f-name" required value="${esc(m?.name)}" placeholder="Pan Asteryan"></label>
    <div class="grid2">
      <label class="field">Discord ID<input id="f-discord" inputmode="numeric" value="${esc(m?.discord)}" placeholder="946385586904764457"><span id="f-discord-check" class="small"></span></label>
      <label class="field">Должность<select id="f-role">${Object.entries(MEMBER_ROLES).map(([k, l]) => `<option value="${k}" ${(m?.role || 'member') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    </div>
    <div class="grid2">
      <label class="field">Вступил в отдел<input id="f-joined" type="date" value="${esc(m?.joined || todayIso())}"></label>
      <label class="field">Уволился<input id="f-left" type="date" value="${esc(m?.left || '')}"></label>
    </div>
    <label class="check"><input type="checkbox" id="f-exempt" ${m?.exempt ? 'checked' : ''}> Не платит взнос — оплачено бессрочно (∞)</label>
    <label class="field">Заметка<textarea id="f-note">${esc(m?.note)}</textarea></label>
    <span class="small muted">Discord ID нужен, чтобы участник видел свою карточку при входе. В Discord: правый клик по человеку → «Копировать ID».</span>
  `, { onDelete: !!m }), (root) => { bindDiscordCheck(); bindForm(root, async () => {
    const body = { name: $('#f-name').value, discord: $('#f-discord').value, role: $('#f-role').value, joined: $('#f-joined').value, left: $('#f-left').value, exempt: $('#f-exempt').checked, note: $('#f-note').value };
    const saved = m ? await api('PUT', `/api/members/${m.id}`, body) : await api('POST', '/api/members', body);
    if (!m) S.drawer = saved.id;
    await afterSave(m ? 'Участник обновлён' : 'Участник добавлен');
  }, m && (async () => {
    await api('DELETE', `/api/members/${m.id}`);
    S.drawer = null;
    await afterSave('Участник удалён вместе с его записями');
  })); });
}

// Пока вводят Discord ID, бот проверяет, кто это; заодно — нет ли человека в ЧС
function bindDiscordCheck(inputId = '#f-discord', outId = '#f-discord-check', nameId = '#f-name') {
  const input = $(inputId);
  const out = $(outId);
  let timer, seq = 0;
  const check = () => {
    const id = input.value.replace(/[<@!>\s]/g, '');
    clearTimeout(timer);
    if (!id) { out.textContent = ''; return; }
    if (!/^\d{17,20}$/.test(id)) { out.innerHTML = '<span class="bad-text">ID — это 17–20 цифр</span>'; return; }
    const bl = blFor(id);
    const blHtml = bl ? `<span class="bad-text">⚠ В чёрном списке${bl.reason ? `: ${esc(bl.reason)}` : ''}</span><br>` : '';
    if (!S.me.botEnabled) { out.innerHTML = blHtml; return; }
    out.innerHTML = `${blHtml}<span class="muted">Ищу в Discord…</span>`;
    const mine = ++seq;
    timer = setTimeout(async () => {
      try {
        const u = await api('GET', `/api/discord/lookup/${id}`);
        if (mine !== seq) return;
        out.innerHTML = `${blHtml}<span class="ok-text">✓ @${esc(u.tag)}${u.name && u.name !== u.tag ? ` · ${esc(u.name)}` : ''}</span>`;
        const nameEl = $(nameId);
        if (nameEl && !nameEl.value.trim() && u.name) nameEl.placeholder = u.name;
      } catch (ex) {
        if (mine === seq) out.innerHTML = `${blHtml}<span class="bad-text">${esc(ex.message)}</span>`;
      }
    }, 400);
  };
  input.addEventListener('input', check);
  check();
}

// ----- оплата -----
function paymentForm(p = null, memberId = null) {
  const st = settings();
  const selected = p?.memberId || memberId || '';
  openModal(formShell(p ? 'Изменить оплату' : 'Внести оплату', `
    <label class="field">Участник<select id="f-member" required>${memberOptions(selected, !!p)}</select></label>
    <div class="grid2">
      <label class="field">Дата оплаты<input id="f-date" type="date" required value="${esc(p?.date || todayIso())}"></label>
      <label class="field">Сумма, $<input id="f-amount" class="num" inputmode="numeric" required value="${p ? p.amount : ''}" placeholder="52 500"></label>
    </div>
    <label class="check"><input type="checkbox" id="f-entry" ${p?.entry ? 'checked' : ''}> В сумму входит вступительный взнос (${money(st.entryFee)})</label>
    <div class="grid2">
      <label class="field">Дней оплачено<input id="f-days" class="num" type="number" min="0" value="${p ? p.days : ''}"></label>
      <label class="check" style="align-self:end;padding-bottom:8px"><input type="checkbox" id="f-auto" ${!p || p.days === daysFor(p.amount - p.entry, st.prices) ? 'checked' : ''}> Считать по цене</label>
    </div>
    <div class="calc" id="f-calc"></div>
    <label class="field">Комментарий<input id="f-note" value="${esc(p?.note)}"></label>
  `, { onDelete: !!p }), (root) => {
    let entryTouched = !!p;
    const update = () => {
      const amount = parseMoney($('#f-amount').value);
      const entry = $('#f-entry').checked ? st.entryFee : 0;
      const auto = $('#f-auto').checked;
      const daysIn = $('#f-days');
      daysIn.disabled = auto;
      if (auto) daysIn.value = amount ? daysFor(Math.max(0, amount - entry), st.prices) : '';
      const d = parseInt(daysIn.value, 10) || 0;
      const mid = $('#f-member').value;
      const out = $('#f-calc');
      if (!mid || !amount) { out.innerHTML = '<span>Укажите участника и сумму — дни и новая дата оплаты посчитаются сами.</span>'; return; }
      const m = memberById(mid);
      const draft = { id: p?.id || '_new', memberId: mid, date: $('#f-date').value || todayIso(), amount, entry, days: d };
      const records = { ...S.data, payments: [...S.data.payments.filter((x) => x.id !== draft.id), draft] };
      const after = memberState(m, records, st, T());
      const cost = costFor(d, st.prices);
      const rest = amount - entry - cost;
      out.innerHTML = `<span>${d ? `<b>${d} дн.</b> по цене ${money(cost)}` : 'На целый день не хватает'}${auto && rest > 0 ? `, остаток ${money(rest)} не переносится` : ''}</span>
        <span>Следующая оплата: <b>${fd(after.paidUntil)}</b></span>`;
    };
    // Новичку (без оплат) по умолчанию ставим вступительный взнос
    const syncEntry = () => {
      if (entryTouched) return;
      const mid = $('#f-member').value;
      $('#f-entry').checked = !!mid && !S.data.payments.some((x) => x.memberId === mid);
    };
    $('#f-entry').addEventListener('change', () => { entryTouched = true; update(); });
    $('#f-member').addEventListener('change', () => { syncEntry(); update(); });
    for (const id of ['#f-amount', '#f-date', '#f-days', '#f-auto']) $(id).addEventListener('input', update);
    $('#f-auto').addEventListener('change', update);
    syncEntry(); update();
    if (selected) setTimeout(() => $('#f-amount').focus());
    bindForm(root, async () => {
      const body = {
        memberId: $('#f-member').value, date: $('#f-date').value, amount: parseMoney($('#f-amount').value),
        entry: $('#f-entry').checked ? st.entryFee : 0, days: parseInt($('#f-days').value, 10) || 0, note: $('#f-note').value,
      };
      if (!body.memberId) throw new Error('Выберите участника');
      if (!body.amount) throw new Error('Укажите сумму');
      if (p) await api('PUT', `/api/payments/${p.id}`, body); else await api('POST', '/api/payments', body);
      await afterSave(p ? 'Оплата изменена' : `Оплата внесена: ${money(body.amount)}`);
    }, p && (async () => { await api('DELETE', `/api/payments/${p.id}`); await afterSave('Оплата удалена'); }));
  });
}

// ----- отпуск -----
function vacationForm(v = null, memberId = null) {
  openModal(formShell(v ? 'Изменить отпуск' : 'Отпуск', `
    <label class="field">Участник<select id="f-member" required>${memberOptions(v?.memberId || memberId || '', !!v)}</select></label>
    <div class="grid2">
      <label class="field">Первый день<input id="f-start" type="date" required value="${esc(v?.start || todayIso())}"></label>
      <label class="field">Дней<input id="f-days" class="num" type="number" min="1" max="365" required value="${v ? v.days : 7}"></label>
    </div>
    <div class="calc" id="f-calc"></div>
    <label class="field">Комментарий<input id="f-note" value="${esc(v?.note)}"></label>
  `, { onDelete: !!v }), (root) => {
    const update = () => {
      const s = dayNum($('#f-start').value); const d = parseInt($('#f-days').value, 10) || 0;
      $('#f-calc').innerHTML = s != null && d ? `<span>Отпуск по <b>${fd(s + d - 1)}</b>. Дата следующей оплаты сдвинется на ${days(d)}.</span>` : '<span>Укажите дату и число дней.</span>';
    };
    $('#f-start').addEventListener('input', update); $('#f-days').addEventListener('input', update); update();
    bindForm(root, async () => {
      const body = { memberId: $('#f-member').value, start: $('#f-start').value, days: parseInt($('#f-days').value, 10), note: $('#f-note').value };
      if (!body.memberId) throw new Error('Выберите участника');
      if (v) await api('PUT', `/api/vacations/${v.id}`, body); else await api('POST', '/api/vacations', body);
      await afterSave(v ? 'Отпуск изменён' : 'Отпуск добавлен');
    }, v && (async () => { await api('DELETE', `/api/vacations/${v.id}`); await afterSave('Отпуск удалён'); }));
  });
}

// ----- штраф: пункт правил → вариант санкции плашками -----
function fineForm(f = null, memberId = null, presetCode = null) {
  const items = allRuleItems(rules());
  const code = f?.code || presetCode || items[0]?.code || 'other';
  const sameChips = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  openModal(formShell(f ? 'Изменить штраф' : 'Выписать штраф', `
    <label class="field">Участник<select id="f-member" required>${memberOptions(f?.memberId || memberId || '', true)}</select></label>
    <label class="field">Пункт правил<select id="f-code">
      ${rules().categories.map((c, ci) => `<optgroup label="${ci + 1}. ${esc(c.title)}">${c.items.map((i) => `<option value="${esc(i.code)}" ${i.code === code ? 'selected' : ''}>${esc(i.code)} — ${esc(i.title)}</option>`).join('')}</optgroup>`).join('')}
      <option value="other" ${code === 'other' || (f && !ruleByCode(rules(), f.code)) ? 'selected' : ''}>Другое (вне правил)</option>
    </select></label>
    <label class="field" id="f-title-wrap" hidden>Нарушение<input id="f-title" value="${esc(f?.title || '')}" placeholder="Что нарушено"></label>
    <div class="field"><span>Санкция</span><div id="f-options" class="opt-list"></div></div>
    <div class="grid2">
      <label class="field">Дата выдачи<input id="f-date" type="date" required value="${esc(f?.date || todayIso())}"></label>
      <label class="field">Сумма к оплате, $<input id="f-amount" class="num" inputmode="numeric" value="${f ? f.amount : ''}"></label>
    </div>
    <div class="calc" id="f-calc"></div>
    ${f ? '' : `<label class="check" id="f-bl-wrap" hidden><input type="checkbox" id="f-bl" checked> Занести в чёрный список</label>
    <label class="check" id="f-kick-wrap" hidden><input type="checkbox" id="f-kick" checked> Исключить из отдела (дата увольнения = дата штрафа)</label>`}
    <label class="check"><input type="checkbox" id="f-paid" ${f?.paid ? 'checked' : ''}> Штраф оплачен</label>
    <label class="field" id="f-paid-wrap" ${f?.paid ? '' : 'hidden'}>Дата оплаты<input id="f-paid-date" type="date" value="${esc(f?.paidDate || todayIso())}"></label>
    <label class="field">Комментарий<input id="f-note" value="${esc(f?.note)}"></label>
  `, { onDelete: !!f }), (root) => {
    let opts = [];
    let chosen = 0;
    const current = () => opts[chosen] || [];
    const renderOptions = () => {
      const c = $('#f-code').value;
      const rule = ruleByCode(rules(), c);
      $('#f-title-wrap').hidden = !!rule;
      if (rule) {
        opts = clone(rule.options);
        // При правке — выделяем тот вариант, что был выдан; если правила поменялись, показываем его отдельно
        if (f && f.code === c) {
          const idx = opts.findIndex((o) => sameChips(o, f.sanctions));
          if (idx >= 0) chosen = idx; else { opts.unshift(clone(f.sanctions)); chosen = 0; }
        } else chosen = 0;
      } else {
        opts = [];
        chosen = 0;
      }
      $('#f-options').innerHTML = rule
        ? opts.map((o, i) => `<label class="opt ${i === chosen ? 'on' : ''}"><input type="radio" name="f-opt" value="${i}" ${i === chosen ? 'checked' : ''}>${o.length ? chipsHtml(o) : '<span class="muted">без санкций</span>'}</label>`).join('')
        : '<span class="small muted">Вне правил: укажите сумму ниже.</span>';
      if (!f || f.code !== c) $('#f-amount').value = rule ? optionAmount(current()) : '';
      update();
    };
    const update = () => {
      const opt = current();
      const d = dayNum($('#f-date').value);
      const amount = parseMoney($('#f-amount').value);
      $('#f-calc').innerHTML = amount > 0 && d != null
        ? `<span>Оплатить до <b>${fd(d + settings().fineDays)}</b>, потом — «Просрочен».</span>`
        : '<span>Денежной части нет — оплачивать нечего.</span>';
      if (!f) {
        $('#f-bl-wrap').hidden = !opt.some((x) => x.t === 'bl');
        $('#f-kick-wrap').hidden = !opt.some((x) => x.t === 'kick');
      }
    };
    $('#f-code').addEventListener('change', renderOptions);
    $('#f-options').addEventListener('change', (e) => {
      if (e.target.name !== 'f-opt') return;
      chosen = Number(e.target.value);
      root.querySelectorAll('.opt').forEach((el, i) => el.classList.toggle('on', i === chosen));
      $('#f-amount').value = optionAmount(current());
      update();
    });
    $('#f-date').addEventListener('input', update);
    $('#f-amount').addEventListener('input', update);
    $('#f-paid').addEventListener('change', () => { $('#f-paid-wrap').hidden = !$('#f-paid').checked; });
    renderOptions();
    bindForm(root, async () => {
      const c = $('#f-code').value;
      const rule = ruleByCode(rules(), c);
      const amount = parseMoney($('#f-amount').value);
      // Денежная плашка всегда равна сумме к оплате
      let sanctions = rule ? clone(current()).filter((x) => x.t !== 'money') : [];
      if (amount > 0) sanctions = [{ t: 'money', amount }, ...sanctions];
      const body = {
        memberId: $('#f-member').value, code: rule ? c : 'other', title: rule ? rule.title : $('#f-title').value.trim(),
        sanctions, date: $('#f-date').value, amount,
        paid: $('#f-paid').checked && amount > 0, paidDate: $('#f-paid-date').value, note: $('#f-note').value,
        addBlacklist: !f && !$('#f-bl-wrap').hidden && $('#f-bl').checked,
        kick: !f && !$('#f-kick-wrap').hidden && $('#f-kick').checked,
      };
      if (!body.memberId) throw new Error('Выберите участника');
      if (!rule && !body.title) throw new Error('Опишите нарушение');
      if (f) await api('PUT', `/api/fines/${f.id}`, body); else await api('POST', '/api/fines', body);
      await afterSave(f ? 'Штраф изменён' : 'Штраф выписан');
    }, f && (async () => { await api('DELETE', `/api/fines/${f.id}`); await afterSave('Штраф удалён'); }));
  }, true);
}

// ----- чёрный список -----
function blacklistForm(b = null, preset = {}) {
  const memberId = b?.memberId || preset.memberId || '';
  const m = memberId ? memberById(memberId) : null;
  openModal(formShell(b ? 'Изменить запись ЧС' : 'Занести в чёрный список', `
    <label class="field">Из состава<select id="f-member">${memberOptions(memberId, true, '— не из состава —', true)}</select></label>
    <div class="grid2">
      <label class="field">Discord ID<input id="f-discord" inputmode="numeric" value="${esc(b?.discord || m?.discord || '')}" placeholder="17–20 цифр"><span id="f-discord-check" class="small"></span></label>
      <label class="field">Имя<input id="f-name" value="${esc(b?.name || m?.name || '')}" placeholder="Имя Фамилия"></label>
    </div>
    <label class="field">Причина<input id="f-reason" value="${esc(b?.reason || preset.reason || '')}" placeholder="Например: неоплата штрафа 1.1"></label>
    <div class="grid2">
      <label class="field">С<input id="f-date" type="date" value="${esc(b?.date || todayIso())}"></label>
      <label class="field">До (пусто — навсегда)<input id="f-until" type="date" value="${esc(b?.until || '')}"></label>
    </div>
  `, { onDelete: !!b, submit: b ? 'Сохранить' : 'Занести в ЧС' }), (root) => {
    $('#f-member').addEventListener('change', () => {
      const x = memberById($('#f-member').value);
      if (x) { $('#f-discord').value = x.discord; $('#f-name').value = x.name; $('#f-discord').dispatchEvent(new Event('input')); }
    });
    bindDiscordCheck();
    bindForm(root, async () => {
      const body = {
        memberId: $('#f-member').value || null, discord: $('#f-discord').value, name: $('#f-name').value,
        reason: $('#f-reason').value, date: $('#f-date').value, until: $('#f-until').value, fineId: b?.fineId || preset.fineId || null,
      };
      if (b) await api('PUT', `/api/blacklist/${b.id}`, body); else await api('POST', '/api/blacklist', body);
      await afterSave(b ? 'Запись ЧС изменена' : 'Занесён в чёрный список');
    }, b && (async () => { await api('DELETE', `/api/blacklist/${b.id}`); await afterSave('Убран из чёрного списка'); }));
  });
}

// ----- цены -----
function pricesForm() {
  const st = settings();
  openModal(formShell('Цены', `
    <div class="grid2">${st.prices.map((p, i) => `<label class="field">${i === 6 ? '7+ дней' : `${i + 1} ${i ? 'дня' : 'день'}`}, $ за день<input id="f-p${i}" class="num" inputmode="numeric" value="${p}"></label>`).join('')}</div>
    <label class="field">Вступительный взнос, $<input id="f-entry" class="num" inputmode="numeric" value="${st.entryFee}"></label>
    <span class="small muted">Новые цены применяются к новым оплатам. Уже внесённые оплаты не пересчитываются.</span>
  `), (root) => bindForm(root, async () => {
    await api('PUT', '/api/settings', {
      prices: st.prices.map((_, i) => parseMoney($(`#f-p${i}`).value)),
      entryFee: parseMoney($('#f-entry').value),
    });
    await afterSave('Цены сохранены');
  }));
}

// ----- правила: категории, пункты, плашки -----
async function saveRules(newRules, msg, fineDays) {
  await api('PUT', '/api/rules', { rules: newRules, fineDays: fineDays ?? settings().fineDays });
  await afterSave(msg);
}

function categoryForm(ci = null) {
  const r = clone(rules());
  const c = ci != null ? r.categories[ci] : null;
  openModal(formShell(c ? 'Категория' : 'Новая категория', `
    <label class="field">Название<input id="f-title" value="${esc(c?.title || '')}" placeholder="Например: Ежедневный взнос"></label>
    ${c && c.items.length ? `<span class="small muted">Удалить можно только пустую категорию — сначала перенесите или удалите её пункты (${c.items.length}).</span>` : ''}
  `, { onDelete: c && !c.items.length }), (root) => bindForm(root, async () => {
    const title = $('#f-title').value.trim();
    if (!title) throw new Error('Укажите название');
    if (c) c.title = title; else r.categories.push({ id: `c${Date.now()}`, title, items: [] });
    await saveRules(r, c ? 'Категория переименована' : 'Категория добавлена');
  }, c && (async () => { r.categories.splice(ci, 1); await saveRules(r, 'Категория удалена'); })));
}

function notesForm() {
  const r = clone(rules());
  openModal(formShell('Примечания к правилам', `
    <label class="field">Текст под правилами (каждая строка — отдельный абзац)<textarea id="f-notes" rows="5">${esc(r.notes || '')}</textarea></label>
    <label class="field">Сколько суток даётся на оплату штрафа<input id="f-fine-days" class="num" type="number" min="0" max="60" value="${settings().fineDays}"></label>
  `), (root) => bindForm(root, async () => {
    r.notes = $('#f-notes').value;
    await saveRules(r, 'Примечания сохранены', parseInt($('#f-fine-days').value, 10) || 0);
  }));
}

function ruleForm(ci, ii = null) {
  const r = clone(rules());
  const item = ii != null ? r.categories[ci].items[ii] : null;
  const nextCode = () => {
    const nums = r.categories[ci].items.map((i) => parseInt(String(i.code).split('.')[1], 10)).filter(Number.isFinite);
    return `${ci + 1}.${(nums.length ? Math.max(...nums) : 0) + 1}`;
  };
  let opts = clone(item?.options || [[{ t: 'money', amount: 10000 }, { t: 'rank' }]]);
  openModal(formShell(item ? `Пункт ${item.code}` : 'Новый пункт', `
    <div class="grid2">
      <label class="field">Номер<input id="f-code" value="${esc(item?.code || nextCode())}" placeholder="1.1"></label>
      <label class="field">Категория<select id="f-cat">${r.categories.map((c, i) => `<option value="${i}" ${i === ci ? 'selected' : ''}>${i + 1}. ${esc(c.title)}</option>`).join('')}</select></label>
    </div>
    <label class="field">Нарушение<textarea id="f-title" rows="2">${esc(item?.title || '')}</textarea></label>
    <div class="field"><span>Санкция — плашки внутри варианта действуют вместе; если вариантов несколько, при выдаче выбирается один</span>
      <div id="f-opts" class="opt-edit-list"></div>
      <div><button type="button" class="btn sm" data-ed="add-opt">+ Ещё вариант («или»)</button></div>
    </div>
    <label class="field">Автоштраф за неоплату взноса через, дн. (0 — не выдавать сам)<input id="f-auto" class="num" type="number" min="0" max="60" value="${item?.autoDays || 0}"></label>
    <span class="small muted">Автоштраф подходит для пункта о невнесении взноса: если человек не оплатил столько дней, штраф выдаётся сам (первый вариант санкции), один раз на каждую просрочку.</span>
  `, { onDelete: !!item }), (root) => {
    const draw = () => {
      $('#f-opts', root).innerHTML = opts.map((o, oi) => `
        <div class="opt-edit">
          <div class="opt-edit-head"><span class="small muted">Вариант ${oi + 1}</span>${opts.length > 1 ? `<button type="button" class="btn sm ghost" data-ed="del-opt" data-o="${oi}">Удалить вариант</button>` : ''}</div>
          <div class="chips">${o.map((c, k) => `<span class="chip chip-${c.t}">${esc(chipLabel(c))}<button type="button" class="chip-x" data-ed="del-chip" data-o="${oi}" data-k="${k}" aria-label="Убрать">×</button></span>`).join('') || '<span class="small muted">пусто — добавьте плашку</span>'}</div>
          <div class="chip-add">
            <select data-ed-type="${oi}">${Object.entries(CHIP_TYPES).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>
            <input data-ed-val="${oi}" placeholder="сумма" inputmode="numeric">
            <button type="button" class="btn sm" data-ed="add-chip" data-o="${oi}">Добавить плашку</button>
          </div>
        </div>`).join('');
      root.querySelectorAll('[data-ed-type]').forEach((sel) => {
        const val = root.querySelector(`[data-ed-val="${sel.dataset.edType}"]`);
        const sync = () => { val.hidden = !['money', 'text'].includes(sel.value); val.placeholder = sel.value === 'money' ? 'сумма, $' : 'текст'; };
        sel.addEventListener('change', sync); sync();
      });
    };
    // Слушаем форму, а не общий контейнер окон: иначе обработчики копились бы от прошлых открытий
    $('#f', root).addEventListener('click', (e) => {
      const b = e.target.closest('[data-ed]');
      if (!b) return;
      const oi = Number(b.dataset.o);
      if (b.dataset.ed === 'add-opt') opts.push([]);
      if (b.dataset.ed === 'del-opt') opts.splice(oi, 1);
      if (b.dataset.ed === 'del-chip') opts[oi].splice(Number(b.dataset.k), 1);
      if (b.dataset.ed === 'add-chip') {
        const t = root.querySelector(`[data-ed-type="${oi}"]`).value;
        const raw = root.querySelector(`[data-ed-val="${oi}"]`).value.trim();
        if (t === 'money') { const amount = parseMoney(raw); if (!amount) return toast('Укажите сумму', true); opts[oi].push({ t, amount }); }
        else if (t === 'text') { if (!raw) return toast('Введите текст плашки', true); opts[oi].push({ t, label: raw }); }
        else opts[oi].push({ t });
      }
      draw();
    });
    draw();
    bindForm(root, async () => {
      const code = $('#f-code').value.trim();
      const title = $('#f-title').value.trim();
      const target = Number($('#f-cat').value);
      if (!code || !title) throw new Error('Укажите номер и нарушение');
      const cleaned = opts.filter((o) => o.length);
      if (!cleaned.length) throw new Error('Добавьте хотя бы одну плашку санкции');
      const newItem = { code, title, options: cleaned, autoDays: parseInt($('#f-auto').value, 10) || 0 };
      if (item) r.categories[ci].items.splice(ii, 1);
      const list = r.categories[target].items;
      if (item && target === ci) list.splice(ii, 0, newItem); else list.push(newItem);
      await saveRules(r, item ? `Пункт ${code} сохранён` : `Пункт ${code} добавлен`);
    }, item && (async () => { r.categories[ci].items.splice(ii, 1); await saveRules(r, `Пункт ${item.code} удалён`); }));
  }, true);
}

// ----- калькулятор -----
function calcModal() {
  openModal(`
    <h2>Калькулятор</h2>
    <div class="grid2">
      <label class="field">Сумма оплаты, $<input id="calc-amount" class="num" inputmode="numeric" placeholder="52 500"></label>
      <label class="field">Или число дней<input id="calc-days" class="num" type="number" min="1" placeholder="7"></label>
    </div>
    <div class="calc" id="calc-out">${calcText(0)}</div>
    <div class="calc" id="calc-days-out">${calcDaysText(0)}</div>
    <div class="modal-actions"><button type="button" class="btn" data-act="close-modal">Закрыть</button></div>`, (root) => {
    $('#calc-amount', root).addEventListener('input', (e) => { $('#calc-out').innerHTML = calcText(parseMoney(e.target.value)); });
    $('#calc-days', root).addEventListener('input', (e) => { $('#calc-days-out').innerHTML = calcDaysText(parseInt(e.target.value, 10) || 0); });
  });
}

// ----- напоминание должникам -----
function remindData() {
  const roster = buildRoster(S.data, settings(), T());
  const debtors = roster.filter((r) => !r.member.left && r.owe);
  const lines = debtors.map((r) => {
    const who = r.member.discord ? `<@${r.member.discord}>` : r.member.name;
    const amount = `к оплате ${money(r.owe.amount)}`;
    if (r.status.key === 'today') return `${who} — оплата сегодня, ${amount}`;
    return `${who} — не оплачено с ${fdShort(r.owe.since)}, ${amount}`;
  });
  const npr = nonPayRule();
  const footer = npr ? `За неуплату — ${optionLabel(npr.options[0])} (п. ${npr.code})${npr.autoDays ? `, штраф выдаётся через ${days(npr.autoDays)} неоплаты` : ''}.` : '';
  const text = lines.length ? `**Напоминание об оплате взноса**\n${lines.join('\n')}${footer ? `\n\n${footer}` : ''}` : '';
  return { debtors, text };
}

function remindModal() {
  const { debtors, text } = remindData();
  openModal(`
    <h2>Напоминание должникам</h2>
    ${debtors.length ? `
      <div class="card table-wrap"><table>
        <thead><tr><th>Кто</th><th>Не оплачено с</th><th class="r">К оплате</th></tr></thead>
        <tbody>${debtors.map((r) => `<tr><td>${memberCell(r.member)}</td><td class="num">${r.status.key === 'today' ? 'сегодня' : fd(r.owe.since)}</td><td class="num r">${money(r.owe.amount)}<div class="small muted">${days(r.owe.payDays)}${r.owe.withEntry ? ' + вступ.' : ''}</div></td></tr>`).join('')}</tbody>
      </table></div>
      <label class="field">Текст для Discord<textarea id="remind-text" rows="${Math.min(14, debtors.length + 5)}" readonly>${esc(text)}</textarea></label>
      <span class="small muted">«К оплате» — самая дешёвая оплата, которая закрывает долг по сегодня включительно.</span>`
      : '<p class="muted">Должников нет — все оплатили.</p>'}
    <div class="modal-actions">
      <button type="button" class="btn ghost" data-act="close-modal">Закрыть</button>
      ${debtors.length ? '<button type="button" class="btn primary" data-act="copy-remind">Копировать</button>' : ''}
    </div>`, null, true);
}

// ----- скриншот состава и штрафов -----
// Картинка собирается отдельно от страницы: только «Отдел Farm», дата и таблица — без шапки со входом, сводки и кнопок
const SHOT_FILTERS = {
  roster: { active: 'в отделе', left: 'ушедшие', all: 'весь состав' },
  fines: { open: 'к оплате', all: 'все штрафы' },
};

function shotHtml(kind) {
  const t = T();
  const st = settings();
  let title;
  let sub;
  let table;
  if (kind === 'roster') {
    const rows = filterRoster(buildRoster(S.data, st, t));
    title = 'Состав';
    sub = `${SHOT_FILTERS.roster[S.rosterFilter]} · ${rows.length} чел.`;
    table = `<table>
      <thead><tr><th>Участник</th><th>Статус</th><th>Оплачено до</th><th>Посл. оплата</th><th class="r">Штрафы</th><th class="r">В отделе</th></tr></thead>
      <tbody>${rows.map((r) => `<tr class="${r.member.left ? 'is-left' : ''}">
        <td><div class="who"><b>${esc(r.member.name)}${r.member.role !== 'member' ? ` <span class="role">${esc(MEMBER_ROLES[r.member.role] || r.member.role)}</span>` : ''}</b>${r.member.discordTag ? `<span class="tag-at">@${esc(r.member.discordTag)}</span>` : ''}</div></td>
        <td>${statusPill(r)}${r.owe ? `<div class="small muted owe">к оплате ${money(r.owe.amount)}</div>` : ''}</td>
        <td class="num">${paidUntilText(r)}</td>
        <td class="num">${r.lastPay ? `${fd(r.lastPay.date)} <span class="muted">· ${money(r.lastPay.amount)}</span>` : '—'}</td>
        <td class="num r">${r.unpaidFinesSum ? `<span class="pill ${r.overdueFines.length ? 'bad' : 'warn'}">${money(r.unpaidFinesSum)}</span>` : '<span class="muted">—</span>'}</td>
        <td class="num r">${r.daysInDept == null ? '—' : days(r.daysInDept)}</td>
      </tr>`).join('')}</tbody></table>`;
  } else {
    const rows = filterFines();
    const sum = rows.filter((f) => !f.paid).reduce((s, f) => s + f.amount, 0);
    title = 'Штрафы';
    sub = `${SHOT_FILTERS.fines[S.fineFilter]} · ${rows.length} шт.${sum ? ` · не оплачено ${money(sum)}` : ''}`;
    table = `<table>
      <thead><tr><th>Выдан</th><th>Участник</th><th>Нарушение</th><th>Санкция</th><th>Статус</th></tr></thead>
      <tbody>${rows.map((f) => {
        const m = memberById(f.memberId);
        return `<tr>
          <td class="num">${fd(f.date)}</td>
          <td><div class="who"><b>${esc(m?.name || '—')}</b>${m?.discordTag ? `<span class="tag-at">@${esc(m.discordTag)}</span>` : ''}</div></td>
          <td>${f.code !== 'other' ? `<span class="tag">${esc(f.code)}</span> ` : ''}${esc(f.title)}</td>
          <td>${f.sanctions.length ? chipsHtml(f.sanctions) : `<span class="num">${money(f.amount)}</span>`}</td>
          <td>${fineStatus(f, t, st)}${m && blFor(m.discord) ? ' <span class="pill bad">ЧС</span>' : ''}</td>
        </tr>`;
      }).join('')}</tbody></table>`;
  }
  return `
    <div class="shot-head">
      <span class="brand-mark">${LEAF}</span>
      <div><h1>Отдел Farm</h1><span class="shot-sub">${title} на ${fd(t)} · ${esc(sub)}</span></div>
    </div>
    <div class="card">${table}</div>`;
}

let h2cLoading;
function loadHtml2canvas() {
  if (window.html2canvas) return Promise.resolve(window.html2canvas);
  h2cLoading ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/html2canvas.min.js';
    s.onload = () => resolve(window.html2canvas);
    s.onerror = () => { h2cLoading = null; reject(new Error('Не удалось загрузить модуль скриншотов. Обновите страницу.')); };
    document.head.append(s);
  });
  return h2cLoading;
}

async function makeShot(kind) {
  const holder = document.createElement('div');
  holder.className = 'shot';
  holder.innerHTML = shotHtml(kind);
  document.body.append(holder);
  try {
    const [h2c] = await Promise.all([loadHtml2canvas(), document.fonts.ready]);
    const canvas = await h2c(holder, { scale: 2, backgroundColor: getComputedStyle(document.body).backgroundColor, logging: false });
    return await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Не удалось собрать картинку'))), 'image/png'));
  } finally {
    holder.remove();
  }
}

let shotUrl;
async function shotModal(kind) {
  openModal(`
    <h2>Скриншот: ${kind === 'roster' ? 'состав' : 'штрафы'}</h2>
    <div class="shot-preview" id="shot-preview"><span class="muted">Собираю картинку…</span></div>
    <div class="form-error" id="shot-error"></div>
    <div class="modal-actions">
      <button type="button" class="btn ghost" data-act="close-modal">Закрыть</button>
      <button type="button" class="btn" id="shot-download" disabled>Скачать</button>
      <button type="button" class="btn primary" id="shot-copy" disabled>Копировать картинку</button>
    </div>`, null, true);
  try {
    const blob = await makeShot(kind);
    if (!$('#shot-preview')) return; // окно закрыли, пока собиралась картинка
    if (shotUrl) URL.revokeObjectURL(shotUrl);
    shotUrl = URL.createObjectURL(blob);
    const name = `farm-${kind === 'roster' ? 'sostav' : 'shtrafy'}-${todayIso()}.png`;
    $('#shot-preview').innerHTML = `<img src="${shotUrl}" alt="Скриншот">`;
    const dl = $('#shot-download');
    dl.disabled = false;
    dl.onclick = () => { const a = document.createElement('a'); a.href = shotUrl; a.download = name; a.click(); };
    const cp = $('#shot-copy');
    if (navigator.clipboard?.write && window.ClipboardItem) {
      cp.disabled = false;
      cp.onclick = async () => {
        try {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          toast('Картинка скопирована — вставьте её в Discord (Ctrl+V)');
        } catch {
          toast('Браузер не дал скопировать картинку — нажмите «Скачать»', true);
        }
      };
    } else cp.hidden = true;
  } catch (ex) {
    const err = $('#shot-error');
    if (err) err.textContent = ex.message;
  }
}

// ---------- события ----------
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  const id = el.dataset.id;
  const find = (list) => (S.data[list] || []).find((x) => x.id === id);
  if (el.tagName === 'A') e.preventDefault();
  switch (act) {
    case 'tab':
      e.preventDefault();
      S.tab = el.dataset.tab; S.drawer = null;
      history.replaceState(null, '', `#${S.tab}`);
      if ((S.tab === 'access' || S.tab === 'audit') && can('admin')) { render(); await loadData().catch((ex) => toast(ex.message, true)); }
      render();
      break;
    case 'roster-filter': S.rosterFilter = el.dataset.v; render(); break;
    case 'fine-filter': S.fineFilter = el.dataset.v; render(); break;
    case 'bl-filter': S.blFilter = el.dataset.v; render(); break;
    case 'week': S.weekOffset = el.dataset.d === '0' ? 0 : S.weekOffset + Number(el.dataset.d); render(); break;
    case 'open-member': S.drawer = id; render(); break;
    case 'close-drawer': S.drawer = null; render(); break;
    case 'new-member': memberForm(); break;
    case 'edit-member': memberForm(find('members')); break;
    case 'new-payment': e.stopPropagation(); paymentForm(null, el.dataset.member); break;
    case 'edit-payment': paymentForm(find('payments')); break;
    case 'new-vacation': vacationForm(null, el.dataset.member); break;
    case 'edit-vacation': vacationForm(find('vacations')); break;
    case 'new-fine': fineForm(null, el.dataset.member); break;
    case 'quick-fine': fineForm(null, el.dataset.member, el.dataset.code); break;
    case 'edit-fine': fineForm(find('fines')); break;
    case 'fine-paid': {
      const f = find('fines');
      try { await api('PUT', `/api/fines/${f.id}`, { ...f, paid: true, paidDate: todayIso() }); await afterSave('Штраф отмечен оплаченным'); } catch (ex) { toast(ex.message, true); }
      break;
    }
    case 'new-bl': blacklistForm(null, { memberId: el.dataset.member }); break;
    case 'edit-bl': blacklistForm(find('blacklist')); break;
    case 'bl-from-fine': {
      const f = find('fines');
      blacklistForm(null, { memberId: f.memberId, fineId: f.id, reason: `Неоплата штрафа ${f.code === 'other' ? '' : f.code + ' '}«${f.title}»` });
      break;
    }
    case 'edit-prices': pricesForm(); break;
    case 'cat-new': categoryForm(); break;
    case 'cat-edit': categoryForm(Number(el.dataset.cat)); break;
    case 'rule-new': ruleForm(Number(el.dataset.cat)); break;
    case 'rule-edit': ruleForm(Number(el.dataset.cat), Number(el.dataset.item)); break;
    case 'notes-edit': notesForm(); break;
    case 'calc': calcModal(); break;
    case 'shot': shotModal(el.dataset.kind); break;
    case 'remind': remindModal(); break;
    case 'copy-remind': copy($('#remind-text').value, 'Напоминание скопировано — вставьте его в Discord'); break;
    case 'discord-refresh':
      el.disabled = true;
      try { const m = await api('POST', `/api/members/${id}/discord-refresh`); await afterSave(m.discordTag ? `Тег обновлён: @${m.discordTag}` : 'Discord не нашёл этот ID'); } catch (ex) { toast(ex.message, true); el.disabled = false; }
      break;
    case 'audit-del':
      try { await api('DELETE', `/api/audit/${id}`); await afterSave('Запись удалена'); } catch (ex) { toast(ex.message, true); }
      break;
    case 'audit-clear': {
      if (!confirmClick(el, el.dataset.days ? 'Точно удалить?' : 'Точно очистить всё?')) break;
      try {
        const r = await api('DELETE', `/api/audit${el.dataset.days ? `?olderThanDays=${el.dataset.days}` : ''}`);
        await afterSave(`Удалено записей: ${r.removed}`);
      } catch (ex) { toast(ex.message, true); }
      break;
    }
    case 'close-modal': closeModal(); break;
    case 'modal-bg': if (e.target === el) closeModal(); break;
    case 'copy': copy(el.dataset.text); break;
    case 'logout': await api('POST', '/auth/logout').catch(() => {}); location.href = '/'; break;
    case 'grant':
      try { await api('PUT', `/api/access/${id}`, { role: el.dataset.role }); await afterSave('Доступ выдан'); } catch (ex) { toast(ex.message, true); }
      break;
    case 'revoke':
      if (!confirmClick(el, 'Точно снять?')) break;
      try { await api('DELETE', `/api/access/${id}`); await afterSave('Доступ снят'); } catch (ex) { toast(ex.message, true); }
      break;
  }
});

document.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.dataset?.act === 'set-role') {
    try { await api('PUT', `/api/access/${el.dataset.id}`, { role: el.value, note: el.dataset.note }); await afterSave('Уровень доступа изменён'); } catch (ex) { toast(ex.message, true); render(); }
  }
});

document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.id === 'roster-search') { S.search = el.value; render(); }
  if (el.id === 'pay-search') { S.payQuery = el.value; render(); }
});

document.addEventListener('submit', async (e) => {
  if (e.target.id !== 'access-form') return;
  e.preventDefault();
  try {
    await api('PUT', `/api/access/${encodeURIComponent($('#acc-id').value.replace(/\D/g, ''))}`, { role: $('#acc-role').value, note: $('#acc-note').value });
    await afterSave('Доступ выдан');
  } catch (ex) { toast(ex.message, true); }
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if ($('#modal-root').innerHTML) closeModal();
  else if (S.drawer) { S.drawer = null; render(); }
});

boot();
