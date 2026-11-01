// Расчёты отдела Farm. Этот модуль общий: его импортирует и сервер, и страница.

export const DEFAULT_SETTINGS = {
  // Цена за 1 день при оплате 1, 2, 3, 4, 5, 6 и 7+ дней
  prices: [15000, 14000, 13000, 12000, 11000, 10000, 7500],
  entryFee: 5000, // вступительный взнос
  fineDays: 3, // сколько суток даётся на оплату штрафа
};

export const FINE_CATALOG = [
  { code: '1.1', title: 'Не внесение ежедневного взноса', amount: 30000, sanction: '30 000$ + штрафной ранг' },
  { code: '2.1', title: 'Игнорирование старшего состава отдела Farm', amount: 10000, sanction: '10 000$ + штрафной ранг' },
  { code: '2.2', title: 'Пререкание со старшим составом отдела Farm', amount: 10000, sanction: '10 000$ + штрафной ранг' },
  { code: '3.1', title: 'Активность в игре во время заявки в отпуск', amount: 15000, sanction: '15 000$ + штрафной ранг' },
  { code: '4.1', title: 'Неявка на обязательное МП', amount: 20000, sanction: '20 000$ + штрафной ранг' },
  { code: '5.1', title: 'Разжигание конфликта внутри отдела Farm', amount: 50000, sanction: '50 000$ / исключение из отдела / ЧС' },
  { code: '5.2', title: 'Увольнение из отдела, не пробыв в нём 3 дней', amount: 15000, sanction: '15 000$ / ЧС' },
  { code: 'other', title: 'Другое', amount: 0, sanction: '' },
];

export const MEMBER_ROLES = {
  member: 'Участник',
  head: 'Head Farm',
  dhead: 'D.Head Farm',
};

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

  const unpaidFines = fines.filter((f) => !f.paid);
  const unpaidFinesSum = unpaidFines.reduce((s, f) => s + (f.amount || 0), 0);
  const overdueFines = unpaidFines.filter((f) => today > dayNum(f.date) + settings.fineDays);

  const joined = dayNum(member.joined);
  const left = dayNum(member.left);
  const daysInDept = joined == null ? null : (left ?? today) - joined;

  let status;
  if (member.left) status = { key: 'left', label: 'Не в отделе' };
  else if (member.role === 'head' || member.role === 'dhead') status = { key: 'staff', label: MEMBER_ROLES[member.role] };
  else if (paidUntil == null) status = { key: 'unpaid', label: 'Не оплачено' };
  else if (paidUntil > today) status = { key: 'ok', label: 'Оплачено', daysLeft: paidUntil - today };
  else if (paidUntil === today) status = { key: 'today', label: 'Сегодня оплата' };
  else status = { key: 'due', label: 'Требуется оплата', overdue: today - paidUntil };

  return {
    member, pays, vacs, fines, paidUntil, lastPay, totalPaid, vacationNow,
    unpaidFines, unpaidFinesSum, overdueFines, daysInDept, status,
  };
}

const STATUS_ORDER = { due: 0, unpaid: 1, today: 2, ok: 3, staff: 4, left: 5 };

export function buildRoster(records, settings, today) {
  return records.members
    .map((m) => memberState(m, records, settings, today))
    .sort((a, b) =>
      STATUS_ORDER[a.status.key] - STATUS_ORDER[b.status.key] ||
      (a.paidUntil ?? -1e9) - (b.paidUntil ?? -1e9) ||
      a.member.name.localeCompare(b.member.name));
}

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
