// منطق خالص برنامه‌ریزی (بدون وابستگی به D1) — دقیقاً طبق جدول rules و config
const DAY = 86400000;
const ms = (d) => Date.parse(d + "T00:00:00Z");

export const tehranToday = (now = Date.now()) => new Date(now + 210 * 60000).toISOString().slice(0, 10);
export const addDays = (d, n) => new Date(ms(d) + n * DAY).toISOString().slice(0, 10);
export const diffDays = (a, b) => Math.round((ms(a) - ms(b)) / DAY);
export const dayIdx = (d) => (new Date(ms(d)).getUTCDay() + 1) % 7; // شنبه=۰ ... جمعه=۶
export const isFriday = (d) => dayIdx(d) === 6;
const maxDate = (a, b) => (a > b ? a : b);

// روزهای کلاس هر کتاب (کتاب‌کار زبان از کتاب اصلی ارث می‌برد)
export function sessionDaysByBook(books, sched) {
  const own = new Map();
  for (const s of sched) {
    if (s.book_id == null || s.subject === "خالی") continue;
    if (!own.has(s.book_id)) own.set(s.book_id, new Set());
    own.get(s.book_id).add(s.day_index);
  }
  const out = new Map();
  for (const b of books) {
    let days = own.get(b.id);
    if (!days) {
      const parent = books.find((p) => p.id !== b.id && own.has(p.id) && b.subject.startsWith(p.subject));
      days = parent ? own.get(parent.id) : null;
    }
    out.set(b.id, days ? [...days] : []);
  }
  return out;
}

// جلسهٔ بعدی کلاس، اکیداً بعد از `from`
export function nextSession(days, from) {
  if (!days.length) return null;
  for (let i = 1; i <= 7; i++) {
    const d = addDays(from, i);
    if (days.includes(dayIdx(d))) return d;
  }
  return null;
}

// قانون مهلت: یک روز قبل از تحویل؛ اگر جمعه شد، پنجشنبه
export function deadlineBefore(delivery) {
  let d = addDays(delivery, -1);
  if (isFriday(d)) d = addDays(d, -1);
  return d;
}

// نمره = ضریب نوع × (subject_base − اولویت) × (urgency_base + urgency_scale / (d+1)²)
export const score = (cfg, kind, priority, d) =>
  cfg["kind_" + kind] * (cfg.subject_base - priority) * (cfg.urgency_base + cfg.urgency_scale / ((d + 1) ** 2));

// ───────── فاز ۱: تمدید کارهای سوخته + ساخت ردیف برای تکلیف/امتحان جدید ─────────
export function computePhase1({ plan, homework, exams, books, sessions }, today) {
  const hwById = new Map(homework.map((h) => [h.id, h]));
  const bookById = new Map(books.map((b) => [b.id, b]));
  const lapses = [];
  const hwExtensions = new Map();

  for (const r of plan) {
    if (r.status !== "todo" || r.due_date >= today) continue;
    const l = { id: r.id, reason: "missed", clone: null };
    if (r.kind !== "exam") {
      const hw = r.source_type === "homework" ? hwById.get(r.source_id) : null;
      if (hw && hw.status !== "todo") {
        l.reason = "source_closed"; // تکلیف مبدأ بسته شده؛ تمدید معنا ندارد
      } else {
        const delivery = nextSession(sessions.get(r.book_id) || [], today) || addDays(today, 7);
        const due = maxDate(deadlineBefore(delivery), today);
        const description = r.description.includes("تمدیدشده") ? r.description : r.description + " (تمدیدشده)";
        l.clone = { ...r, description, due_date: due, plan_date: due };
        if (hw && !hwExtensions.has(hw.id)) hwExtensions.set(hw.id, { old: hw.id, delivery });
      }
    }
    lapses.push(l);
  }

  const have = new Set(plan.filter((p) => p.source_type).map((p) => p.source_type + ":" + p.source_id));
  const generated = [];

  for (const h of homework) {
    if (h.status !== "todo" || have.has("homework:" + h.id)) continue;
    const delivery = h.due_date || nextSession(sessions.get(h.book_id) || [], today) || addDays(today, 7);
    if (delivery <= today) continue;
    const due = maxDate(deadlineBefore(delivery), today);
    generated.push({
      book_id: h.book_id, kind: "homework", description: `تکلیف ${bookById.get(h.book_id).subject}: ${h.description}`,
      page_from: null, page_to: null, due_date: due, plan_date: due, part_no: null, parts_total: null,
      group_key: "hw-" + h.id, source_type: "homework", source_id: h.id,
    });
  }

  for (const e of exams) {
    if (e.status !== "upcoming" || have.has("exam:" + e.id) || e.exam_date <= today) continue;
    const due = maxDate(deadlineBefore(e.exam_date), today);
    let avail = 0;
    for (let d = today; d <= due; d = addDays(d, 1)) if (!isFriday(d)) avail++;
    const n = Math.max(1, Math.min(4, avail));
    const subj = bookById.get(e.book_id).subject;
    for (let i = 1; i <= n; i++) {
      let pf = null, pt = null;
      if (e.page_from != null && e.page_to != null) {
        const span = e.page_to - e.page_from + 1;
        pf = e.page_from + Math.floor(((i - 1) * span) / n);
        pt = e.page_from + Math.floor((i * span) / n) - 1;
        if (i === n) { pf = e.page_from; pt = e.page_to; } // بخش آخر: مرور کل محدوده
      }
      generated.push({
        book_id: e.book_id, kind: "exam",
        description: i === n && n > 1 ? `${subj}: مرور نهایی و خودآزمایی ${e.covers} (بخش ${i} از ${n})`
          : `${subj}: مرور ${e.covers} برای امتحان` + (n > 1 ? ` (بخش ${i} از ${n})` : ""),
        page_from: pf, page_to: pt, due_date: due, plan_date: due, part_no: n > 1 ? i : null, parts_total: n > 1 ? n : null,
        group_key: "exam-" + e.id, source_type: "exam", source_id: e.id,
      });
    }
  }
  return { lapses, hwExtensions: [...hwExtensions.values()], generated };
}

// ───────── فاز ۲: نمره‌دهی و پخش بار بین روزها ─────────
export function computeAssign(rows, today, cfg, priorityOf) {
  const horizon = [];
  for (let i = 0; i < 7; i++) { const d = addDays(today, i); if (!isFriday(d)) horizon.push(d); }
  if (!horizon.length) horizon.push(today);
  const defaults = { 4: 1.25, 5: 1.5 }; // چهارشنبه و پنجشنبه سنگین‌تر
  const weight = (d) => cfg["day_weight_" + dayIdx(d)] ?? defaults[dayIdx(d)] ?? 1;

  const scored = rows.map((r, seq) => ({
    ...r, seq, score: score(cfg, r.kind, priorityOf(r.book_id), diffDays(r.due_date, today)),
  }));
  scored.sort((a, b) => b.score - a.score || (a.part_no || 0) - (b.part_no || 0) || a.seq - b.seq);

  const load = new Map(horizon.map((d) => [d, 0]));
  const lastByGroup = new Map();
  const assignments = new Map();

  for (const r of scored) {
    const grouped = r.group_key && (r.parts_total || 0) > 1;
    const minDate = grouped && lastByGroup.has(r.group_key) ? addDays(lastByGroup.get(r.group_key), 1) : today;
    const elig = horizon.filter((d) => d <= r.due_date);
    // بخش k از n باید جا برای n−k بخش بعدی (روزهای جدا و به ترتیب) باقی بگذارد
    const reserve = grouped && r.part_no ? Math.max(0, r.parts_total - r.part_no) : 0;
    const limit = Math.max(0, elig.length - 1 - reserve);
    let cands = elig.filter((d, i) => d >= minDate && i <= limit);
    if (!cands.length) cands = elig.filter((d) => d >= minDate);
    if (!cands.length) cands = elig;
    if (!cands.length) cands = [today];
    let best = cands[0], bv = Infinity;
    for (const d of cands) {
      const v = ((load.get(d) || 0) + 1) / weight(d);
      if (v < bv - 1e-9) { bv = v; best = d; }
    }
    load.set(best, (load.get(best) || 0) + 1);
    assignments.set(r.id, best);
    if (grouped) lastByGroup.set(r.group_key, best);
  }
  return { assignments, scores: new Map(scored.map((r) => [r.id, Math.round(r.score * 10) / 10])), load };
}
