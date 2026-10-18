// planner.js — جایگزین تابع computeAssign (همان امضای قبلی؛ فقط همین تابع را عوض کن)
//
// منطق جدید:
//  1) کارها بر اساس نمره (score) از زیاد به کم مرتب می‌شوند.
//  2) ظرفیت روزها نزولی است: روز اول بیشترین، روز آخر (هفتم) کمترین (n, n-1, ..., 1).
//  3) کارهایی که فقط یک روز مجازند (مهلت امروز) اول ثابت می‌شوند تا در بار همان روز حساب شوند.
//  4) بقیه، از مهم‌ترین، در «اولین روزِ مجاز که هنوز ظرفیت دارد» می‌نشینند.
//  5) بخش‌های یک گروه (part 1..n) مثل قبل پشت‌سرهم و روزهای متوالی می‌مانند.
//  6) مهلت (due_date) همیشه مقدم است.

export function computeAssign(rows, today, cfg, priorityOf) {
  const horizon = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(today, i);
    if (!isFriday(d)) horizon.push(d);
  }
  if (!horizon.length) horizon.push(today);

  const n = horizon.length;
  const scored = rows.map((r, seq) => ({
    ...r,
    seq,
    score: score(cfg, r.kind, priorityOf(r.book_id), diffDays(r.due_date, today))
  }));
  scored.sort((a, b) => b.score - a.score || (a.part_no || 0) - (b.part_no || 0) || a.seq - b.seq);

  // ظرفیت نزولی روزها
  const wsum = (n * (n + 1)) / 2;
  const target = new Map(horizon.map((d, i) => [d, (scored.length * (n - i)) / wsum]));
  const load = new Map(horizon.map((d) => [d, 0]));
  const lastByGroup = new Map();
  const assignments = new Map();
  const eligible = (r) => {
    const e = horizon.filter((d) => d <= r.due_date);
    return e.length ? e : [horizon[0]];
  };

  // مرحله ۱: کارهای تک‌روزه
  const rest = [];
  for (const r of scored) {
    const e = eligible(r);
    const grouped = r.group_key && (r.parts_total || 0) > 1;
    if (e.length === 1 && !grouped) {
      assignments.set(r.id, e[0]);
      load.set(e[0], load.get(e[0]) + 1);
    } else rest.push(r);
  }

  // مرحله ۲: از مهم‌ترین، زودترین روزِ دارای ظرفیت
  for (const r of rest) {
    const grouped = r.group_key && (r.parts_total || 0) > 1;
    const e = eligible(r);
    const minDate = grouped && lastByGroup.has(r.group_key) ? addDays(lastByGroup.get(r.group_key), 1) : horizon[0];
    const reserve = grouped && r.part_no ? Math.max(0, r.parts_total - r.part_no) : 0;
    const limit = Math.max(0, e.length - 1 - reserve);
    let cands = e.filter((d, i) => d >= minDate && i <= limit);
    if (!cands.length) cands = e.filter((d) => d >= minDate);
    if (!cands.length) cands = [e[e.length - 1]];

    let best = cands.find((d) => load.get(d) < Math.ceil(target.get(d) - 1e-9));
    if (!best) {
      let bv = Infinity;
      for (const d of cands) {
        const v = load.get(d) / target.get(d);
        if (v < bv - 1e-9) {
          bv = v;
          best = d;
        }
      }
    }
    load.set(best, load.get(best) + 1);
    assignments.set(r.id, best);
    if (grouped) lastByGroup.set(r.group_key, best);
  }

  return {
    assignments,
    scores: new Map(scored.map((r) => [r.id, Math.round(r.score * 10) / 10])),
    load
  };
}
