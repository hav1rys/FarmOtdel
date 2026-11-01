// Расчёты отдела Farm. Этот модуль общий: его импортирует и сервер, и страница.

export const DEFAULT_SETTINGS = {
  // Цена за 1 день при оплате 1, 2, 3, 4, 5, 6 и 7+ дней
  prices: [15000, 14000, 13000, 12000, 11000, 10000, 7500],
  entryFee: 5000, // вступительный взнос
  fineDays: 3, // сколько суток даётся на оплату штрафа
};

// Плашки санкций. Вариант санкции — набор плашек, которые действуют вместе
// («30 000$ + штрафной ранг»). У пункта может быть несколько вариантов на выбор
// («50 000$ / исключение из отдела / ЧС») — при выдаче штрафа выбирается один.
export const CHIP_TYPES = {
  money: 'Сумма',
  rank: 'Штрафной ранг',
  kick: 'Исключение из отдела',
  bl: 'ЧС',
  text: 'Свой текст',
};

const money = (n) => `${Math.round(n || 0).toLocaleString('ru-RU')}$`;
export function chipLabel(c) {
  if (c.t === 'money') return money(c.amount);
  if (c.t === 'text') return c.label || '';
  return CHIP_TYPES[c.t] || '';
}
export const optionLabel = (opt) => opt.map(chipLabel).join(' + ');
export const sanctionsLabel = (options) => options.map(optionLabel).join(' / ');
export const optionAmount = (opt) => opt.filter((c) => c.t === 'money').reduce((s, c) => s + (c.amount || 0), 0);

const M = (amount) => ({ t: 'money', amount });
const RANK = { t: 'rank' };
export const DEFAULT_RULES = {
  categories: [
    { id: 'c1', title: 'Ежедневный взнос', items: [
      { code: '1.1', title: 'Невнесение ежедневного взноса', options: [[M(30000), RANK]], autoDays: 2 },
    ] },
    { id: 'c2', title: 'Старший состав', items: [
      { code: '2.1', title: 'Игнорирование старшего состава отдела Farm', options: [[M(10000), RANK]], autoDays: 0 },
      { code: '2.2', title: 'Пререкание со старшим составом отдела Farm', options: [[M(10000), RANK]], autoDays: 0 },
    ] },
    { id: 'c3', title: 'Выходной', items: [
      { code: '3.1', title: 'Активность в игре во время оставленной заявки в отпуск', options: [[M(15000), RANK]], autoDays: 0 },
    ] },
    { id: 'c4', title: 'Посещаемость', items: [
      { code: '4.1', title: 'Неявка на обязательное МП', options: [[M(20000), RANK]], autoDays: 0 },
    ] },
    { id: 'c5', title: 'Состав', items: [
      { code: '5.1', title: 'Разжигание конфликта внутри отдела Farm', options: [[M(50000)], [{ t: 'kick' }], [{ t: 'bl' }]], autoDays: 0 },
      { code: '5.2', title: 'Увольнение из отдела, не пробыв в нём 3 дней', options: [[M(15000)], [{ t: 'bl' }]], autoDays: 0 },
    ] },
  ],
  notes: 'На оплату штрафов у вас есть 3 суток, иначе — ЧС.\nВсе штрафы оплачиваются исключительно на счёт фракции с отчётом в канале.',
};

export const allRuleItems = (rules) => rules.categories.flatMap((c) => c.items.map((i) => ({ ...i, category: c.title })));
export const ruleByCode = (rules, code) => allRuleItems(rules).find((i) => i.code === code) || null;
// Пункт, который выдаётся сам за неоплату взноса
export const autoRules = (rules) => allRuleItems(rules).filter((i) => i.autoDays > 0);

// Порядок здесь — порядок групп в тексте состава: старший состав сверху
export const MEMBER_ROLES = {
  cur: 'Cur. Farm',
  head: 'Head Farm',
  dhead: 'D.Head Farm',
  member: 'Участник',
  trainee: 'Стажёр',
};

// Настройки вкладки «Состав»: должности и колонки таблицы (они же — на скриншоте)
export const ROSTER_COLUMNS = {
  status: 'Статус',
  owe: 'К оплате (под статусом)',
  paidUntil: 'Оплачено до',
  lastPay: 'Посл. оплата',
  fines: 'Штрафы',
  inDept: 'В отделе',
  discordId: 'Discord ID под именем',
};
export const DEFAULT_ROSTER = {
  roles: Object.entries(MEMBER_ROLES).map(([id, label]) => ({ id, label })),
  columns: Object.fromEntries(Object.keys(ROSTER_COLUMNS).map((k) => [k, true])),
};

// Текст напоминания должникам. В фигурных скобках — подстановки
export const DEFAULT_REMINDER = {
  header: '**Напоминание об оплате взноса**',
  line: '{mention} — не оплачено с {since}, к оплате {amount}',
  lineToday: '{mention} — оплата сегодня, к оплате {amount}',
  footer: 'За неуплату — {sanction} (п. {rule}), штраф выдаётся через {auto_days} дн. неоплаты.',
};
export const REMINDER_VARS = {
  header: { date: 'сегодняшняя дата', count: 'сколько должников' },
  line: {
    mention: 'упоминание <@id> (или имя, если ID нет)', name: 'имя', tag: '@тег', since: 'с какого числа не оплачено',
    days: 'сколько дней не оплачено', amount: 'сколько внести', pay_days: 'на сколько дней эта сумма',
  },
  footer: { sanction: 'санкция пункта за неуплату', rule: 'номер пункта', auto_days: 'через сколько дней автоштраф', date: 'сегодняшняя дата' },
};

// Текст состава для Discord: группы по должностям в порядке из настроек
export const DEFAULT_LINEUP = {
  header: '**Состав отдела Farm** — {count} чел.',
  group: '**{role}** ({count})',
  line: '{mention}',
  footer: '-# Обновлено {date}',
  showEmpty: false,
};
export const LINEUP_VARS = {
  header: { count: 'сколько всего в отделе', date: 'сегодняшняя дата' },
  group: { role: 'название должности', count: 'сколько человек на должности' },
  line: {
    mention: 'упоминание <@id> (или имя, если ID нет)', name: 'имя', tag: '@тег', role: 'должность',
    joined: 'дата вступления', days_in: 'сколько дней в отделе', paid_until: 'оплачено до',
  },
  footer: { count: 'сколько всего в отделе', date: 'сегодняшняя дата' },
};

// Подставляет {имя} из vars; неизвестные подстановки оставляет как есть
export const fillTemplate = (text, vars) => String(text || '').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

// ---------- даты: храним как 'YYYY-MM-DD', считаем в днях от эпохи ----------

const DAY = 86400000;
const pad = (n) => String(n).padStart(2, '0');

export function dayNum(iso) {
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY);
}

export function isoOf(n) {
  const d = new Date(n * DAY);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function todayNum(now = new Date()) {
  return Math.round(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / DAY);
}

export function isIsoDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && isoOf(dayNum(s)) === s;
}

// Понедельник недели, в которую попадает день n
export function weekStart(n) {
  const dow = new Date(n * DAY).getUTCDay(); // 0 = воскресенье
  return n - ((dow + 6) % 7);
}

// ---------- цены ----------

export function costFor(days, prices) {
  if (days <= 0) return 0;
  return days * (days >= 7 ? prices[6] : prices[days - 1]);
}

// Сколько дней покрывает сумма. 7+ дней дешевле, поэтому 52 500$ дают 7 дней, а не 5.
export function daysFor(amount, prices) {
  let best = 0;
  for (let d = 1; d <= 6; d++) if (costFor(d, prices) <= amount) best = d;
  const long = Math.floor(amount / prices[6]);
  if (long >= 7) best = Math.max(best, long);
  return best;
}

// Самая дешёвая оплата, которая закрывает не меньше n дней (5 дней = 55 000$, а 7 дней = 52 500$)
export function minPayFor(n, prices) {
  if (n <= 0) return { days: 0, cost: 0 };
  let best = { days: n, cost: costFor(n, prices) };
  if (n < 7 && costFor(7, prices) < best.cost) best = { days: 7, cost: costFor(7, prices) };
  return best;
}

// ---------- состояние участника ----------

export function memberState(member, records, settings, today) {
  const pays = records.payments.filter((p) => p.memberId === member.id).sort((a, b) => a.date.localeCompare(b.date));
  const vacs = records.vacations.filter((v) => v.memberId === member.id).sort((a, b) => a.start.localeCompare(b.start));
  const fines = records.fines.filter((f) => f.memberId === member.id).sort((a, b) => a.date.localeCompare(b.date));

  // Оплаченный период: ранняя оплата продлевает от конца текущего периода,
  // поздняя начинается с даты оплаты. Отпуск сдвигает дату следующей оплаты.
  const events = [
    ...pays.map((p) => ({ t: dayNum(p.date), k: 0, p })),
    ...vacs.map((v) => ({ t: dayNum(v.start), k: 1, v })),
  ].sort((a, b) => a.t - b.t || a.k - b.k);

  let paidUntil = null;
  for (const e of events) {
    if (e.k === 0) {
      if (e.p.days > 0) {
        const base = paidUntil != null && paidUntil > e.t ? paidUntil : e.t;
        paidUntil = base + e.p.days;
      }
    } else if (paidUntil != null) {
      paidUntil += e.v.days;
    }
  }

  const lastPay = pays.length ? pays[pays.length - 1] : null;
  const totalPaid = pays.reduce((s, p) => s + (p.amount || 0), 0);
  const vacationNow = vacs.find((v) => today >= dayNum(v.start) && today < dayNum(v.start) + v.days) || null;

  // Штраф без денежной части (например, только исключение) оплачивать не нужно
  const unpaidFines = fines.filter((f) => !f.paid && f.amount > 0);
  const unpaidFinesSum = unpaidFines.reduce((s, f) => s + (f.amount || 0), 0);
  const overdueFines = unpaidFines.filter((f) => today > dayNum(f.date) + settings.fineDays);

  const joined = dayNum(member.joined);
  const left = dayNum(member.left);
  const daysInDept = joined == null ? null : (left ?? today) - joined;

  // С какого дня не оплачено: день окончания оплаты, а если оплат не было — день вступления
  const dueSince = paidUntil ?? joined;
  let status;
  if (member.left) status = { key: 'left', label: 'Не в отделе' };
  else if (member.exempt) status = { key: 'exempt', label: 'Оплачено ∞' };
  else if (paidUntil == null) status = { key: 'unpaid', label: 'Не оплачено' };
  else if (paidUntil > today) status = { key: 'ok', label: 'Оплачено', daysLeft: paidUntil - today };
  else if (paidUntil === today) status = { key: 'today', label: 'Сегодня оплата' };
  else status = { key: 'due', label: 'Требуется оплата', overdue: today - paidUntil };

  // Сколько внести, чтобы закрыть долг по сегодняшний день включительно
  let owe = null;
  if (['due', 'today', 'unpaid'].includes(status.key) && dueSince != null) {
    const n = Math.max(1, today - dueSince + 1);
    const pay = minPayFor(n, settings.prices);
    owe = { since: dueSince, days: n, payDays: pay.days, amount: pay.cost + (pays.length ? 0 : settings.entryFee), withEntry: !pays.length };
  }

  return {
    member, pays, vacs, fines, paidUntil, lastPay, totalPaid, vacationNow,
    unpaidFines, unpaidFinesSum, overdueFines, daysInDept, status, dueSince, owe,
  };
}

const STATUS_ORDER = { due: 0, unpaid: 1, today: 2, ok: 3, exempt: 4, left: 5 };

export function buildRoster(records, settings, today) {
  return records.members
    .map((m) => memberState(m, records, settings, today))
    .sort((a, b) =>
      STATUS_ORDER[a.status.key] - STATUS_ORDER[b.status.key] ||
      (a.paidUntil ?? -1e9) - (b.paidUntil ?? -1e9) ||
      a.member.name.localeCompare(b.member.name));
}

// Чёрный список: действует, пока не наступила дата окончания (пустая — навсегда)
export const blacklistActive = (b, today) => !b.until || dayNum(b.until) >= today;

// ---------- отчёт за неделю (пн–вс) ----------

export function weekReport(records, ws) {
  const we = ws + 6;
  const inWeek = (iso) => { const n = dayNum(iso); return n != null && n >= ws && n <= we; };
  const payments = records.payments.filter((p) => inWeek(p.date)).sort((a, b) => a.date.localeCompare(b.date));
  const finesPaid = records.fines.filter((f) => f.paid && inWeek(f.paidDate));
  const finesIssued = records.fines.filter((f) => inWeek(f.date));
  const byMember = new Map();
  for (const p of payments) {
    const row = byMember.get(p.memberId) || { memberId: p.memberId, amount: 0, days: 0, count: 0 };
    row.amount += p.amount; row.days += p.days; row.count += 1;
    byMember.set(p.memberId, row);
  }
  return {
    ws, we, payments, finesPaid, finesIssued,
    byMember: [...byMember.values()].sort((a, b) => b.amount - a.amount),
    total: payments.reduce((s, p) => s + p.amount, 0),
    entryTotal: payments.reduce((s, p) => s + (p.entry || 0), 0),
    finesPaidTotal: finesPaid.reduce((s, f) => s + f.amount, 0),
  };
}
