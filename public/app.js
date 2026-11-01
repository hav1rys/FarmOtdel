import {
  FINE_CATALOG, MEMBER_ROLES, DEFAULT_SETTINGS, dayNum, isoOf, todayNum, weekStart,
  costFor, daysFor, memberState, buildRoster, weekReport,
} from '/calc.js';

const RANK = { member: 0, viewer: 1, editor: 2, admin: 3, owner: 4 };
const ACCESS_ROLES = { viewer: 'Просмотр', editor: 'Редактор', admin: 'Администратор', owner: 'Владелец' };
const TABS = [
  { id: 'roster', label: 'Состав' },
  { id: 'payments', label: 'Оплаты' },
  { id: 'fines', label: 'Штрафы' },
  { id: 'vacations', label: 'Отпуска' },
  { id: 'week', label: 'По неделям' },
  { id: 'prices', label: 'Цены и правила' },
  { id: 'access', label: 'Доступ', min: 'admin' },
  { id: 'audit', label: 'Журнал', min: 'admin' },
];

const S = {
  me: null, data: null, access: null, audit: null,
  calcAmount: '', tab: 'roster', rosterFilter: 'active', search: '', fineFilter: 'open', payQuery: '', weekOffset: 0,
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
const settings = () => ({ ...DEFAULT_SETTINGS, ...(S.data?.settings || {}) });
const can = (min) => S.me && RANK[S.me.role] >= RANK[min];
const memberById = (id) => S.data.members.find((m) => m.id === id);
const fineInfo = (code) => FINE_CATALOG.find((f) => f.code === code) || FINE_CATALOG[FINE_CATALOG.length - 1];
const days = (n) => `${n} дн.`;

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
      ${failed ? '<p class="form-error">Не получилось войти через Discord. Попробуйте ещё раз.</p>' : ''}
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
  const active = roster.filter((r) => !r.member.left && r.status.key !== 'staff');
  const paid = active.filter((r) => r.status.key === 'ok').length;
  const due = active.filter((r) => ['due', 'unpaid', 'today'].includes(r.status.key));
  const openFines = S.data.fines.filter((f) => !f.paid);
  const overdueFines = openFines.filter((f) => t > dayNum(f.date) + st.fineDays);
  const week = weekReport(S.data, weekStart(t));

  const tabs = TABS.filter((tb) => !tb.min || can(tb.min));
  const badge = { fines: overdueFines.length, roster: due.length };

  const views = { roster: rosterTab, payments: paymentsTab, fines: finesTab, vacations: vacationsTab, week: weekTab, prices: pricesTab, access: accessTab, audit: auditTab };

  return `
    ${header()}
    <main class="wrap">
      <section class="tiles" aria-label="Сводка">
        <div class="tile"><span class="label">В отделе</span><span class="value">${active.length}</span><span class="sub">участников без руководства</span></div>
        <div class="tile good"><span class="label">Оплачено</span><span class="value">${paid}</span><span class="sub">из ${active.length}</span></div>
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
  return `<span class="pill ${s.key}">${s.label}${extra}</span>${r.vacationNow ? ` <span class="pill vac">Отпуск по ${fdShort(dayNum(r.vacationNow.start) + r.vacationNow.days - 1)}</span>` : ''}`;
}

function discordLine(m) {
  if (!m.discord) return '';
  if (m.discordMissing) return `<span class="bad-text">ID не найден в Discord</span>`;
  return `<span>${m.discordTag ? `<span class="tag-at">@${esc(m.discordTag)}</span> · ` : ''}${esc(m.discord)}</span>`;
}

function memberCell(m) {
  return `<div class="who"><b>${esc(m.name)}</b>${discordLine(m)}</div>`;
}

function memberAvatar(m, size = 44) {
  return avatarHtml(m.discord, m.discordAvatar, m.discordName || m.name, size);
}

// ----- Состав -----
function rosterTab(roster) {
  const q = S.search.trim().toLowerCase();
  const rows = roster.filter((r) => {
    if (S.rosterFilter === 'active' && r.member.left) return false;
    if (S.rosterFilter === 'left' && !r.member.left) return false;
    return !q || r.member.name.toLowerCase().includes(q) || r.member.discord.includes(q) || r.member.discordTag.toLowerCase().includes(q.replace(/^@/, ''));
  });
  const edit = can('editor');
  return `
    <div class="toolbar">
      <div class="seg" role="group" aria-label="Фильтр">
        ${[['active', 'В отделе'], ['left', 'Ушедшие'], ['all', 'Все']].map(([k, l]) => `<button aria-pressed="${S.rosterFilter === k}" data-act="roster-filter" data-v="${k}">${l}</button>`).join('')}
      </div>
      <input class="input" id="roster-search" type="search" placeholder="Поиск: имя, @тег или Discord ID" value="${esc(S.search)}">
      <span class="grow"></span>
      <button class="btn" data-act="remind" title="Текст с упоминаниями тех, кому нужно заплатить">Напоминание должникам</button>
      ${edit ? '<button class="btn" data-act="new-member">+ Участник</button><button class="btn primary" data-act="new-payment">+ Оплата</button>' : ''}
    </div>
    <div class="card table-wrap">
      ${rows.length ? `<table>
        <thead><tr><th>Участник</th><th>Статус</th><th>Оплачено до</th><th class="hide-sm">Посл. оплата</th><th class="r">Штрафы</th><th class="r hide-sm">В отделе</th>${edit ? '<th></th>' : ''}</tr></thead>
        <tbody>${rows.map((r) => `
          <tr class="click ${r.member.left ? 'is-left' : ''}" data-act="open-member" data-id="${r.member.id}">
            <td>${memberCell(r.member)}</td>
            <td>${statusPill(r)}</td>
            <td class="num">${r.status.key === 'staff' ? '—' : fd(r.paidUntil)}</td>
            <td class="num hide-sm">${r.lastPay ? `${fd(r.lastPay.date)} <span class="muted">· ${money(r.lastPay.amount)}</span>` : '—'}</td>
            <td class="num r">${r.unpaidFinesSum ? `<span class="pill ${r.overdueFines.length ? 'bad' : 'warn'}">${money(r.unpaidFinesSum)}</span>` : '<span class="muted">—</span>'}</td>
            <td class="num r hide-sm">${r.daysInDept == null ? '—' : days(r.daysInDept)}</td>
            ${edit ? `<td class="r">${!r.member.left && r.status.key !== 'staff' ? `<button class="btn sm" data-act="new-payment" data-member="${r.member.id}">Оплата</button>` : ''}</td>` : ''}
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
function finesTab() {
  const t = T();
  const st = settings();
  const rows = [...S.data.fines]
    .filter((f) => S.fineFilter === 'all' || !f.paid)
    .sort((a, b) => (a.paid - b.paid) || b.date.localeCompare(a.date));
  const edit = can('editor');
  return `
    <div class="toolbar">
      <div class="seg" role="group">
        ${[['open', 'К оплате'], ['all', 'Все']].map(([k, l]) => `<button aria-pressed="${S.fineFilter === k}" data-act="fine-filter" data-v="${k}">${l}</button>`).join('')}
      </div>
      <span class="small muted">На оплату штрафа даётся ${st.fineDays} сут., дальше — ЧС.</span>
      <span class="grow"></span>
      ${edit ? '<button class="btn primary" data-act="new-fine">+ Штраф</button>' : ''}
    </div>
    <div class="card table-wrap">
      ${rows.length ? `<table>
        <thead><tr><th>Выдан</th><th>Участник</th><th>Пункт</th><th class="r">Сумма</th><th>Статус</th>${edit ? '<th></th>' : ''}</tr></thead>
        <tbody>${rows.map((f) => {
          const m = memberById(f.memberId);
          const deadline = dayNum(f.date) + st.fineDays;
          const status = f.paid
            ? `<span class="pill ok">Оплачен ${fdShort(f.paidDate)}</span>`
            : t > deadline ? `<span class="pill bad">Просрочен · ЧС</span>` : `<span class="pill warn">Оплатить до ${fdShort(deadline)}</span>`;
          return `<tr>
            <td class="num">${fd(f.date)}</td>
            <td>${m ? `<a href="#" data-act="open-member" data-id="${m.id}">${esc(m.name)}</a>` : '—'}</td>
            <td><span class="tag">${esc(f.code === 'other' ? '—' : f.code)}</span> ${esc(fineInfo(f.code).title)}${f.note ? `<div class="small muted">${esc(f.note)}</div>` : ''}</td>
            <td class="num r">${money(f.amount)}</td>
            <td>${status}</td>
            ${edit ? `<td><div class="actions">${!f.paid ? `<button class="btn sm" data-act="fine-paid" data-id="${f.id}">Оплачен</button>` : ''}<button class="btn sm ghost" data-act="edit-fine" data-id="${f.id}">Изменить</button></div></td>` : ''}
          </tr>`;
        }).join('')}</tbody></table>` : emptyState(S.fineFilter === 'open' ? 'Неоплаченных штрафов нет' : 'Штрафов пока нет', 'Штраф выписывается по пункту из системы штрафов, сумма подставится сама.', edit && S.data.members.length ? '<button class="btn primary" data-act="new-fine">+ Выписать штраф</button>' : '')}
    </div>`;
}

// ----- Отпуска -----
function vacationsTab() {
  const t = T();
  const rows = [...S.data.vacations].sort((a, b) => b.start.localeCompare(a.start));
  const edit = can('editor');
  return `
    <div class="toolbar">
      <span class="small muted">Дни отпуска сдвигают дату следующей оплаты.</span>
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
function pricesTab() {
  const st = settings();
  const p = st.prices;
  return `
    <div class="cols">
      <div class="panel">
        <h3>Цена дней</h3>
        <div class="table-wrap"><table>
          <thead><tr><th>Дней</th><th class="r">За 1 день</th><th class="r">Мин. оплата</th><th class="r">За неделю</th></tr></thead>
          <tbody>${p.map((price, i) => `<tr><td class="num">${i === 6 ? '7+' : i + 1}</td><td class="num r">${money(price)}</td><td class="num r">${money(costFor(i + 1 === 7 ? 7 : i + 1, p))}</td><td class="num r">${money(price * 7)}</td></tr>`).join('')}</tbody>
        </table></div>
        <p class="small muted" style="margin:0">Вступительный взнос: <b class="num">${money(st.entryFee)}</b>. Остаток суммы, которого не хватает на целый день, не переносится.</p>
        ${can('admin') ? '<div><button class="btn" data-act="edit-prices">Изменить цены</button></div>' : ''}
      </div>
      <div class="panel">
        <h3>Калькулятор</h3>
        <label class="field">Сумма оплаты, $<input id="calc-amount" class="num" inputmode="numeric" placeholder="52 500" value="${esc(S.calcAmount)}"></label>
        <div class="calc" id="calc-out">${calcText(parseMoney(S.calcAmount))}</div>
      </div>
      <div class="panel" style="grid-column: 1 / -1">
        <h3>Система штрафов</h3>
        <div class="table-wrap"><table>
          <thead><tr><th>Пункт</th><th>Нарушение</th><th>Санкция</th></tr></thead>
          <tbody>${FINE_CATALOG.filter((f) => f.code !== 'other').map((f) => `<tr><td><span class="tag">${f.code}</span></td><td>${esc(f.title)}</td><td class="num">${esc(f.sanction)}</td></tr>`).join('')}</tbody>
        </table></div>
        <p class="small muted" style="margin:0">На оплату штрафов даётся ${st.fineDays} суток, иначе — ЧС. Все штрафы оплачиваются на счёт фракции с отчётом в канале.</p>
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
          <div><span class="pill idle">Участник отдела</span> — автоматически: видит только свою карточку (срок оплаты, штрафы).</div>
          <div><span class="pill staff">Просмотр</span> — видит все данные, ничего не меняет.</div>
          <div><span class="pill ok">Редактор</span> — вносит оплаты, отпуска, штрафы и состав.</div>
          <div><span class="pill warn">Администратор</span> — плюс цены, выдача доступа и журнал действий.</div>
          <div><span class="pill bad">Владелец</span> — задаётся на сервере; назначает администраторов.</div>
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

function auditTab() {
  if (!S.audit) return '<div class="boot">Загрузка…</div>';
  return `<div class="card table-wrap">${S.audit.length ? `<table>
    <thead><tr><th>Когда</th><th>Кто</th><th>Действие</th><th>Подробности</th></tr></thead>
    <tbody>${S.audit.map((a) => {
      const d = new Date(a.at);
      return `<tr><td class="num small">${d.toLocaleDateString('ru-RU')} ${d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</td>
        <td>${esc(a.global_name || a.username || a.actor_id)}</td><td>${esc(a.action)}</td><td class="small">${esc(a.summary)}</td></tr>`;
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
  // Подсказка: просрочка без штрафа 1.1 после окончания оплаты
  const needs11 = r.status.key === 'due' && !r.fines.some((f) => f.code === '1.1' && dayNum(f.date) >= r.paidUntil);
  const history = [
    ...r.pays.map((p) => ({ d: p.date, html: `<span><span class="k">Оплата</span>${money(p.amount)} за ${days(p.days)}${p.entry ? ` <span class="muted small">(вкл. вступ. ${money(p.entry)})</span>` : ''}${p.note ? `<div class="small muted">${esc(p.note)}</div>` : ''}</span>`, act: edit ? `<button class="btn sm ghost" data-act="edit-payment" data-id="${p.id}">Изм.</button>` : '' })),
    ...r.vacs.map((v) => ({ d: v.start, html: `<span><span class="k">Отпуск</span>${days(v.days)}, до ${fd(dayNum(v.start) + v.days - 1)}</span>`, act: edit ? `<button class="btn sm ghost" data-act="edit-vacation" data-id="${v.id}">Изм.</button>` : '' })),
    ...r.fines.map((f) => ({ d: f.date, html: `<span><span class="k">Штраф ${esc(f.code === 'other' ? '' : f.code)}</span>${money(f.amount)} — ${f.paid ? `<span style="color:var(--ok)">оплачен</span>` : t > dayNum(f.date) + st.fineDays ? '<span style="color:var(--bad)">просрочен</span>' : 'не оплачен'}${f.note ? `<div class="small muted">${esc(f.note)}</div>` : ''}</span>`, act: edit ? `<button class="btn sm ghost" data-act="edit-fine" data-id="${f.id}">Изм.</button>` : '' })),
  ].sort((a, b) => b.d.localeCompare(a.d));

  return `
    <div class="drawer-bg" data-act="close-drawer"></div>
    <aside class="drawer" aria-label="Карточка участника">
      <div class="drawer-head">
        ${m.discord ? memberAvatar(m) : ''}
        <div style="flex:1;display:grid;gap:6px;min-width:0">
          <h2>${esc(m.name)}</h2>
          ${m.discordTag ? `<span class="small"><span class="tag-at">@${esc(m.discordTag)}</span>${m.discordName && m.discordName !== m.discordTag ? ` <span class="muted">· ${esc(m.discordName)}</span>` : ''}</span>` : ''}
          <div>${statusPill(r)} ${m.role !== 'member' ? `<span class="pill staff">${MEMBER_ROLES[m.role]}</span>` : ''}</div>
        </div>
        <button class="btn ghost" data-act="close-drawer" aria-label="Закрыть">✕</button>
      </div>
      ${m.discord ? `<div class="copy-line"><code>&lt;@${esc(m.discord)}&gt;</code><button class="btn sm" data-act="copy" data-text="<@${esc(m.discord)}>" title="Упоминание для Discord">Копировать</button>${edit && S.me.botEnabled ? `<button class="btn sm ghost" data-act="discord-refresh" data-id="${m.id}" title="Заново узнать тег и аватар">Обновить тег</button>` : ''}</div>` : ''}
      ${m.discordMissing ? '<div class="hint bad"><span>Discord не нашёл пользователя с этим ID. Проверьте ID в карточке участника.</span></div>' : ''}
      <dl class="facts" style="margin:0">
        <div><dt>Оплачено до</dt><dd>${fd(r.paidUntil)}</dd></div>
        <div><dt>Посл. оплата</dt><dd>${r.lastPay ? fd(r.lastPay.date) : '—'}</dd></div>
        <div><dt>Внесено всего</dt><dd>${money(r.totalPaid)}</dd></div>
        <div><dt>Штрафы к оплате</dt><dd>${money(r.unpaidFinesSum)}</dd></div>
        <div><dt>Вступил</dt><dd>${fd(m.joined)}</dd></div>
        <div><dt>${m.left ? 'Уволился' : 'В отделе'}</dt><dd>${m.left ? fd(m.left) : r.daysInDept == null ? '—' : days(r.daysInDept)}</dd></div>
      </dl>
      ${m.note ? `<p class="small muted" style="margin:0">${esc(m.note)}</p>` : ''}
      ${edit && needs11 ? `<div class="hint bad"><span>Просрочка оплаты ${days(r.status.overdue)} По пункту 1.1 положен штраф 30 000$.</span><button class="btn sm" data-act="quick-fine" data-member="${m.id}">Выписать 1.1</button></div>` : ''}
      ${edit ? `<div class="btn-row">
        ${!m.left ? `<button class="btn primary" data-act="new-payment" data-member="${m.id}">+ Оплата</button>
        <button class="btn" data-act="new-vacation" data-member="${m.id}">+ Отпуск</button>` : ''}
        <button class="btn" data-act="new-fine" data-member="${m.id}">+ Штраф</button>
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
  let big = r.status.label;
  let line = '';
  if (r.status.key === 'ok') { big = `Оплачено до ${fd(r.paidUntil)}`; line = `Осталось ${days(r.status.daysLeft)}.`; }
  if (r.status.key === 'today') line = 'Сегодня последний день — внесите оплату.';
  if (r.status.key === 'due') line = `Просрочка ${days(r.status.overdue)}. Внесите оплату, чтобы избежать штрафа 1.1.`;
  if (r.status.key === 'unpaid') line = 'Оплат пока не было.';
  return `
    ${header()}
    <main class="wrap">
      <section class="self-hero">
        <span class="small muted">${esc(m.name)}</span>
        <span class="big">${esc(big)}</span>
        <span>${statusPill(r)}</span>
        ${line ? `<span class="muted">${esc(line)}</span>` : ''}
      </section>
      ${r.unpaidFines.length ? `<div class="hint ${r.overdueFines.length ? 'bad' : ''}" style="margin-bottom:16px"><span>Неоплаченные штрафы: <b class="num">${money(r.unpaidFinesSum)}</b>. Срок оплаты — ${st.fineDays} сут. с момента выдачи, иначе ЧС.</span></div>` : ''}
      <div class="cols">
        <div class="panel">
          <h3>Мои записи</h3>
          ${[...r.pays.map((p) => ({ d: p.date, t: `Оплата ${money(p.amount)} за ${days(p.days)}` })),
             ...r.vacs.map((v) => ({ d: v.start, t: `Отпуск ${days(v.days)}` })),
             ...r.fines.map((f) => ({ d: f.date, t: `Штраф ${f.code === 'other' ? '' : f.code} ${money(f.amount)} — ${f.paid ? 'оплачен' : 'не оплачен'}` }))]
            .sort((a, b) => b.d.localeCompare(a.d))
            .map((h) => `<div class="tl" style="grid-template-columns:86px 1fr"><span class="d">${fd(h.d)}</span><span>${esc(h.t)}</span></div>`).join('') || '<p class="muted small">Записей пока нет.</p>'}
        </div>
        <div class="panel">
          <h3>Сколько заплатить</h3>
          <label class="field">Сумма, $<input id="calc-amount" class="num" inputmode="numeric" placeholder="52 500" value="${esc(S.calcAmount)}"></label>
          <div class="calc" id="calc-out">${calcText(parseMoney(S.calcAmount))}</div>
          <table><tbody>${st.prices.map((p, i) => `<tr><td class="num">${i === 6 ? '7+' : i + 1} дн.</td><td class="num r">${money(p)} / день</td></tr>`).join('')}</tbody></table>
        </div>
      </div>
    </main>`;
}

// ---------- формы ----------
function openModal(html, onMount) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-bg" data-act="modal-bg"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
  const first = root.querySelector('input:not([type=hidden]), select, textarea');
  onMount?.(root);
  first?.focus();
}
const closeModal = () => { $('#modal-root').innerHTML = ''; };

function memberOptions(selectedId, includeLeft = false) {
  const list = [...S.data.members]
    .filter((m) => includeLeft || !m.left || m.id === selectedId)
    .sort((a, b) => a.name.localeCompare(b.name));
  return `<option value="" disabled ${selectedId ? '' : 'selected'}>Выберите участника</option>` +
    list.map((m) => `<option value="${m.id}" ${m.id === selectedId ? 'selected' : ''}>${esc(m.name)}${m.left ? ' (ушёл)' : ''}</option>`).join('');
}

function formShell(title, body, { onDelete } = {}) {
  return `<form id="f" novalidate>
    <h2>${esc(title)}</h2>
    <div style="display:grid;gap:12px;margin-top:14px">${body}</div>
    <div class="form-error" id="f-error"></div>
    <div class="modal-actions">
      ${onDelete ? '<button type="button" class="btn danger left" data-confirm="delete">Удалить</button>' : ''}
      <button type="button" class="btn ghost" data-act="close-modal">Отмена</button>
      <button class="btn primary">Сохранить</button>
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
    if (btn.dataset.armed) { clearTimeout(timer); action(); return; }
    btn.dataset.armed = '1'; btn.textContent = label;
    timer = setTimeout(() => { delete btn.dataset.armed; btn.textContent = original; }, 3500);
  });
}

async function afterSave(msg) {
  await loadData();
  render();
  toast(msg);
}

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
    <label class="field">Заметка<textarea id="f-note">${esc(m?.note)}</textarea></label>
    <span class="small muted">Discord ID нужен, чтобы участник видел свою карточку при входе. В Discord: правый клик по человеку → «Копировать ID».</span>
  `, { onDelete: !!m }), (root) => { bindDiscordCheck(); bindForm(root, async () => {
    const body = { name: $('#f-name').value, discord: $('#f-discord').value, role: $('#f-role').value, joined: $('#f-joined').value, left: $('#f-left').value, note: $('#f-note').value };
    const saved = m ? await api('PUT', `/api/members/${m.id}`, body) : await api('POST', '/api/members', body);
    if (!m) S.drawer = saved.id;
    await afterSave(m ? 'Участник обновлён' : 'Участник добавлен');
  }, m && (async () => {
    await api('DELETE', `/api/members/${m.id}`);
    S.drawer = null;
    await afterSave('Участник удалён вместе с его записями');
  })); });
}

// Пока вводят Discord ID, бот проверяет, кто это
function bindDiscordCheck() {
  const input = $('#f-discord');
  const out = $('#f-discord-check');
  let timer, seq = 0;
  const check = () => {
    const id = input.value.replace(/[<@!>\s]/g, '');
    clearTimeout(timer);
    if (!id) { out.textContent = ''; return; }
    if (!/^\d{17,20}$/.test(id)) { out.innerHTML = '<span class="bad-text">ID — это 17–20 цифр</span>'; return; }
    if (!S.me.botEnabled) { out.textContent = ''; return; }
    out.innerHTML = '<span class="muted">Ищу в Discord…</span>';
    const mine = ++seq;
    timer = setTimeout(async () => {
      try {
        const u = await api('GET', `/api/discord/lookup/${id}`);
        if (mine !== seq) return;
        out.innerHTML = `<span class="ok-text">✓ @${esc(u.tag)}${u.name && u.name !== u.tag ? ` · ${esc(u.name)}` : ''}</span>`;
        if (!$('#f-name').value.trim() && u.name) $('#f-name').placeholder = u.name;
      } catch (ex) {
        if (mine === seq) out.innerHTML = `<span class="bad-text">${esc(ex.message)}</span>`;
      }
    }, 400);
  };
  input.addEventListener('input', check);
  check();
}

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

function fineForm(f = null, memberId = null, presetCode = null) {
  const code = f?.code || presetCode || '1.1';
  openModal(formShell(f ? 'Изменить штраф' : 'Выписать штраф', `
    <label class="field">Участник<select id="f-member" required>${memberOptions(f?.memberId || memberId || '', true)}</select></label>
    <label class="field">Пункт<select id="f-code">${FINE_CATALOG.map((x) => `<option value="${x.code}" ${x.code === code ? 'selected' : ''}>${x.code === 'other' ? 'Другое' : `${x.code} — ${esc(x.title)}`}</option>`).join('')}</select></label>
    <div class="grid2">
      <label class="field">Дата выдачи<input id="f-date" type="date" required value="${esc(f?.date || todayIso())}"></label>
      <label class="field">Сумма, $<input id="f-amount" class="num" inputmode="numeric" required value="${f ? f.amount : fineInfo(code).amount}"></label>
    </div>
    <div class="calc" id="f-calc"></div>
    <label class="check"><input type="checkbox" id="f-paid" ${f?.paid ? 'checked' : ''}> Штраф оплачен</label>
    <label class="field" id="f-paid-wrap" ${f?.paid ? '' : 'hidden'}>Дата оплаты<input id="f-paid-date" type="date" value="${esc(f?.paidDate || todayIso())}"></label>
    <label class="field">Комментарий<input id="f-note" value="${esc(f?.note)}"></label>
  `, { onDelete: !!f }), (root) => {
    const update = () => {
      const info = fineInfo($('#f-code').value);
      const d = dayNum($('#f-date').value);
      $('#f-calc').innerHTML = `<span>${info.sanction ? `Санкция: ${esc(info.sanction)}. ` : ''}${d != null ? `Оплатить до <b>${fd(d + settings().fineDays)}</b>.` : ''}</span>`;
    };
    $('#f-code').addEventListener('change', () => { const info = fineInfo($('#f-code').value); if (info.amount) $('#f-amount').value = info.amount; update(); });
    $('#f-date').addEventListener('input', update);
    $('#f-paid').addEventListener('change', () => { $('#f-paid-wrap').hidden = !$('#f-paid').checked; });
    update();
    bindForm(root, async () => {
      const body = {
        memberId: $('#f-member').value, code: $('#f-code').value, date: $('#f-date').value, amount: parseMoney($('#f-amount').value),
        paid: $('#f-paid').checked, paidDate: $('#f-paid-date').value, note: $('#f-note').value,
      };
      if (!body.memberId) throw new Error('Выберите участника');
      if (f) await api('PUT', `/api/fines/${f.id}`, body); else await api('POST', '/api/fines', body);
      await afterSave(f ? 'Штраф изменён' : 'Штраф выписан');
    }, f && (async () => { await api('DELETE', `/api/fines/${f.id}`); await afterSave('Штраф удалён'); }));
  });
}

function pricesForm() {
  const st = settings();
  openModal(formShell('Цены', `
    <div class="grid2">${st.prices.map((p, i) => `<label class="field">${i === 6 ? '7+ дней' : `${i + 1} ${i ? 'дня' : 'день'}`}, $ за день<input id="f-p${i}" class="num" inputmode="numeric" value="${p}"></label>`).join('')}</div>
    <div class="grid2">
      <label class="field">Вступительный взнос, $<input id="f-entry" class="num" inputmode="numeric" value="${st.entryFee}"></label>
      <label class="field">Срок оплаты штрафа, сут.<input id="f-fine-days" class="num" type="number" min="0" value="${st.fineDays}"></label>
    </div>
    <span class="small muted">Новые цены применяются к новым оплатам. Уже внесённые оплаты не пересчитываются.</span>
  `), (root) => bindForm(root, async () => {
    await api('PUT', '/api/settings', {
      prices: st.prices.map((_, i) => parseMoney($(`#f-p${i}`).value)),
      entryFee: parseMoney($('#f-entry').value), fineDays: parseInt($('#f-fine-days').value, 10) || 0,
    });
    await afterSave('Цены сохранены');
  }));
}

// ---------- напоминание должникам ----------
function remindText() {
  const roster = buildRoster(S.data, settings(), T());
  const lines = roster
    .filter((r) => !r.member.left && ['due', 'unpaid', 'today'].includes(r.status.key))
    .map((r) => {
      const who = r.member.discord ? `<@${r.member.discord}>` : r.member.name;
      if (r.status.key === 'today') return `${who} — сегодня последний день оплаты`;
      if (r.status.key === 'unpaid') return `${who} — оплаты ещё не было`;
      return `${who} — просрочка ${days(r.status.overdue)}`;
    });
  if (!lines.length) return null;
  return `**Напоминание об оплате взноса отдела Farm**\n${lines.join('\n')}\n\nЗа неуплату — штраф 30 000$ + штрафной ранг (п. 1.1).`;
}

// ---------- события ----------
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  const id = el.dataset.id;
  const find = (list) => S.data[list].find((x) => x.id === id);
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
    case 'week': S.weekOffset = el.dataset.d === '0' ? 0 : S.weekOffset + Number(el.dataset.d); render(); break;
    case 'open-member': if (e.target.closest('button') && e.target.closest('button') !== el) return; S.drawer = id; render(); break;
    case 'close-drawer': S.drawer = null; render(); break;
    case 'new-member': memberForm(); break;
    case 'edit-member': memberForm(find('members')); break;
    case 'new-payment': e.stopPropagation(); paymentForm(null, el.dataset.member); break;
    case 'edit-payment': paymentForm(find('payments')); break;
    case 'new-vacation': vacationForm(null, el.dataset.member); break;
    case 'edit-vacation': vacationForm(find('vacations')); break;
    case 'new-fine': fineForm(null, el.dataset.member); break;
    case 'quick-fine': fineForm(null, el.dataset.member, '1.1'); break;
    case 'edit-fine': fineForm(find('fines')); break;
    case 'fine-paid': {
      const f = find('fines');
      try { await api('PUT', `/api/fines/${f.id}`, { ...f, paid: true, paidDate: todayIso() }); await afterSave('Штраф отмечен оплаченным'); } catch (ex) { toast(ex.message, true); }
      break;
    }
    case 'edit-prices': pricesForm(); break;
    case 'discord-refresh':
      el.disabled = true;
      try { const m = await api('POST', `/api/members/${id}/discord-refresh`); await afterSave(m.discordTag ? `Тег обновлён: @${m.discordTag}` : 'Discord не нашёл этот ID'); } catch (ex) { toast(ex.message, true); el.disabled = false; }
      break;
    case 'close-modal': closeModal(); break;
    case 'modal-bg': if (e.target === el) closeModal(); break;
    case 'copy': copy(el.dataset.text); break;
    case 'remind': {
      const text = remindText();
      if (text) copy(text, 'Напоминание скопировано — вставьте его в Discord'); else toast('Должников нет');
      break;
    }
    case 'logout': await api('POST', '/auth/logout').catch(() => {}); location.href = '/'; break;
    case 'grant':
      try { await api('PUT', `/api/access/${id}`, { role: el.dataset.role }); await afterSave('Доступ выдан'); } catch (ex) { toast(ex.message, true); }
      break;
    case 'revoke':
      if (!el.dataset.armed) {
        el.dataset.armed = '1'; el.textContent = 'Точно снять?';
        setTimeout(() => { if (el.isConnected) { delete el.dataset.armed; el.textContent = 'Снять'; } }, 3500);
        break;
      }
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
  if (el.id === 'calc-amount') { S.calcAmount = el.value; $('#calc-out').innerHTML = calcText(parseMoney(el.value)); }
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
