// planner.js — pure planning logic (no I/O). Everything here is testable without a database.

const DAY = 864e5;
export const ms = (d) => Date.parse(d + "T00:00:00Z");
export const tehranToday = (now = Date.now()) => new Date(now + 210 * 6e4).toISOString().slice(0, 10);
export const addDays = (d, n) => new Date(ms(d) + n * DAY).toISOString().slice(0, 10);
export const diffDays = (a, b) => Math.round((ms(a) - ms(b)) / DAY);
export const dayIdx = (d) => (new Date(ms(d)).getUTCDay() + 1) % 7; // Saturday = 0 ... Friday = 6
export const isFriday = (d) => dayIdx(d) === 6;
export const maxDate = (a, b) => (a > b ? a : b);

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

export function nextSession(days, from) {
  if (!days.length) return null;
  for (let i = 1; i <= 7; i++) {
    const d = addDays(from, i);
    if (days.includes(dayIdx(d))) return d;
  }
  return null;
}

export function deadlineBefore(delivery) {
  let d = addDays(delivery, -1);
  if (isFriday(d)) d = addDays(d, -1);
  return d;
}

export const score = (cfg, kind, priority, d) =>
  cfg["kind_" + kind] * (cfg.subject_base - priority) * (cfg.urgency_base + cfg.urgency_scale / (d + 1) ** 2);

// ───────────────────────── page-based review / preview ─────────────────────────
//
// Idea: review and preview rows in `plan` carry page_from/page_to. The set of pages already
// covered is simply "plan rows with status='done' (plus live todo rows)", so there is no extra
// table to keep in sync. Teaching progress comes from progress_log.

const PAGE_KINDS = new Set(["review", "preview"]);
export const isPagedWork = (r) => PAGE_KINDS.has(r.kind) && r.page_from != null && r.page_to != null;

// Page numbers where a new lesson / chapter / problem-set starts (used to find lesson ends).
export function tocBoundaries(rows) {
  const s = new Set();
  for (const t of rows) {
    if (!(t.start_page > 0)) continue;
    if (t.kind === "chapter" || t.kind === "problems" || t.lesson != null) s.add(t.start_page);
  }
  return [...s].sort((a, b) => a - b);
}

// Last page the teacher has covered. Newest report wins (report_date, then id).
// A report gives either up_to_page, or toc_id (= the whole lesson up to the next boundary).
export function taughtInfo(progressRows, tocRows) {
  const bounds = tocBoundaries(tocRows);
  const byId = new Map(tocRows.map((t) => [t.id, t]));
  const rows = [...progressRows].sort((a, b) =>
    a.report_date < b.report_date ? 1 : a.report_date > b.report_date ? -1 : b.id - a.id
  );
  for (let i = 0; i < rows.length; i++) {
    const p = rows[i];
    let page = null;
    if (p.up_to_page != null) page = p.up_to_page;
    else if (p.toc_id != null && byId.has(p.toc_id)) {
      const next = bounds.find((b) => b > byId.get(p.toc_id).start_page);
      if (next != null) page = next - 1;
    }
    if (page != null) return { page, rowId: p.id, stale: i > 0 };
  }
  return null;
}

// contiguous page ranges inside [lo, hi] whose coverage count is below `target`
export function gapRanges(lo, hi, counts, target) {
  const out = [];
  let start = null;
  for (let p = lo; p <= hi; p++) {
    const need = (counts.get(p) || 0) < target;
    if (need && start == null) start = p;
    if ((!need || p === hi) && start != null) {
      out.push([start, need ? p : p - 1]);
      start = null;
    }
  }
  return out;
}

// split [a, z] into evenly sized chunks of at most `max` pages
export function chunkRange(a, z, max) {
  const len = z - a + 1;
  const n = Math.max(1, Math.ceil(len / max));
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push([a + Math.floor((i * len) / n), a + Math.floor(((i + 1) * len) / n) - 1]);
  }
  return out;
}

const pagesText = (a, z) => (a === z ? `صفحهٔ ${a}` : `صفحهٔ ${a} تا ${z}`);

export function planPageWork({ books, plan, toc, progress, sessions, cfg, today, deadIds }) {
  const rows = [];
  const warnings = [];
  const taught = {};
  const chunkPages = Math.max(1, Math.floor(cfg.chunk_pages ?? 12));
  const previewSpan = Math.max(1, Math.floor(cfg.preview_max_pages ?? 8));
  const reviewTarget = Math.max(0, Math.floor(cfg.review_target ?? 1));

  for (const b of books) {
    const myProgress = progress.filter((p) => p.book_id === b.id);
    if (!myProgress.length) continue;
    const myToc = toc.filter((t) => t.book_id === b.id);
    const info = taughtInfo(myProgress, myToc);
    if (!info) {
      warnings.push(`${b.subject}: هیچ‌کدام از گزارش‌های تدریس شمارهٔ صفحه (up_to_page) یا toc_id قابل‌استفاده ندارند؛ برای این درس مرور/پیش‌مطالعهٔ خودکار ساخته نشد`);
      continue;
    }
    if (info.stale) warnings.push(`${b.subject}: آخرین گزارش تدریس شمارهٔ صفحه ندارد؛ از گزارش قبلی‌تر (تا ص ${info.page}) استفاده شد`);
    taught[b.subject] = info.page;

    const bounds = tocBoundaries(myToc);
    const delivery = nextSession(sessions.get(b.id) || [], today) || addDays(today, 7);
    const due = maxDate(deadlineBefore(delivery), today);

    // how many times each page is already covered: done rows + still-live todo rows
    const countsFor = (kind) => {
      const m = new Map();
      for (const r of plan) {
        if (r.book_id !== b.id || r.kind !== kind || !isPagedWork(r)) continue;
        const counts = r.status === "done" || (r.status === "todo" && !deadIds.has(r.id) && r.due_date >= today);
        if (!counts) continue;
        for (let p = r.page_from; p <= r.page_to; p++) m.set(p, (m.get(p) || 0) + 1);
      }
      return m;
    };

    const emit = (kind, a, z) => {
      const parts = chunkRange(a, z, chunkPages);
      const key = `auto-${kind}-${b.id}-${a}-${z}`;
      parts.forEach(([pf, pt], i) => {
        const suffix = parts.length > 1 ? ` (بخش ${i + 1} از ${parts.length})` : "";
        rows.push({
          book_id: b.id,
          kind,
          description: `${kind === "review" ? "مرور" : "پیش‌مطالعهٔ"} ${b.subject}: ${pagesText(pf, pt)}${suffix}`,
          page_from: pf,
          page_to: pt,
          due_date: due,
          plan_date: due,
          part_no: parts.length > 1 ? i + 1 : null,
          parts_total: parts.length > 1 ? parts.length : null,
          group_key: key,
          source_type: "progress",
          source_id: info.rowId
        });
      });
    };

    // reviews: taught pages that have not been reviewed `target` times yet
    const target = b.max_reviews == null ? reviewTarget : Math.min(reviewTarget, b.max_reviews);
    if (target > 0) {
      // first page worth reviewing = start of the first real lesson (skips chapter title pages)
      const lessonStarts = myToc.filter((t) => t.lesson != null && t.start_page > 0).map((t) => t.start_page);
      const lo = lessonStarts.length ? Math.min(...lessonStarts) : bounds[0] ?? 1;
      for (const [a, z] of gapRanges(lo, info.page, countsFor("review"), target)) emit("review", a, z);
    }

    // previews: the next stretch of the book (until the lesson ends, at most previewSpan pages)
    if (b.preview_needed) {
      const lo = info.page + 1;
      const nb = bounds.find((x) => x > lo);
      const hi = Math.min(nb != null ? nb - 1 : lo + previewSpan - 1, lo + previewSpan - 1);
      for (const [a, z] of gapRanges(lo, hi, countsFor("preview"), 1)) emit("preview", a, z);
    }
  }
  return { rows, warnings, taught };
}

// ───────────────────────── phase 1: burn / lapse / generate ─────────────────────────

export function computePhase1(state, today) {
  const { plan, homework, exams, books, sessions } = state;
  const progress = state.progress || [];
  const toc = state.toc || [];
  const cfg = state.cfg || {};
  const hwById = new Map(homework.map((h) => [h.id, h]));
  const bookById = new Map(books.map((b) => [b.id, b]));
  const lapses = [];
  const hwExtensions = new Map();

  // A) previews die as soon as the teacher has covered their first page ("taught"); no extension.
  const taughtByBook = new Map();
  for (const b of books) {
    const mine = progress.filter((p) => p.book_id === b.id);
    if (mine.length) taughtByBook.set(b.id, taughtInfo(mine, toc.filter((t) => t.book_id === b.id)));
  }
  const burned = new Set();
  for (const r of plan) {
    if (r.status !== "todo" || r.kind !== "preview" || !isPagedWork(r)) continue;
    const t = taughtByBook.get(r.book_id);
    if (t && r.page_from <= t.page) {
      lapses.push({ id: r.id, reason: "taught", clone: null });
      burned.add(r.id);
    }
  }

  // B) overdue work: homework/legacy rows are extended; page-based review/preview are simply
  //    closed as missed and get regenerated below from the pages that are still uncovered.
  for (const r of plan) {
    if (r.status !== "todo" || r.due_date >= today || burned.has(r.id)) continue;
    const l = { id: r.id, reason: "missed", clone: null };
    if (r.kind !== "exam" && !isPagedWork(r)) {
      const hw = r.source_type === "homework" ? hwById.get(r.source_id) : null;
      if (hw && hw.status !== "todo") {
        l.reason = "source_closed";
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

  // C) new rows: homework, exams (unchanged logic) …
  const have = new Set(plan.filter((p) => p.source_type).map((p) => p.source_type + ":" + p.source_id));
  const generated = [];
  for (const h of homework) {
    if (h.status !== "todo" || have.has("homework:" + h.id)) continue;
    const delivery = h.due_date || nextSession(sessions.get(h.book_id) || [], today) || addDays(today, 7);
    if (delivery <= today) continue;
    const due = maxDate(deadlineBefore(delivery), today);
    generated.push({
      book_id: h.book_id,
      kind: "homework",
      description: `تکلیف ${bookById.get(h.book_id).subject}: ${h.description}`,
      page_from: null,
      page_to: null,
      due_date: due,
      plan_date: due,
      part_no: null,
      parts_total: null,
      group_key: "hw-" + h.id,
      source_type: "homework",
      source_id: h.id
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
        if (i === n) {
          pf = e.page_from;
          pt = e.page_to;
        }
      }
      generated.push({
        book_id: e.book_id,
        kind: "exam",
        description:
          i === n && n > 1
            ? `${subj}: مرور نهایی و خودآزمایی ${e.covers} (بخش ${i} از ${n})`
            : `${subj}: مرور ${e.covers} برای امتحان` + (n > 1 ? ` (بخش ${i} از ${n})` : ""),
        page_from: pf,
        page_to: pt,
        due_date: due,
        plan_date: due,
        part_no: n > 1 ? i : null,
        parts_total: n > 1 ? n : null,
        group_key: "exam-" + e.id,
        source_type: "exam",
        source_id: e.id
      });
    }
  }

  // … and page-based review / preview from teaching progress
  const pw = planPageWork({
    books, plan, toc, progress, sessions, cfg, today,
    deadIds: new Set(lapses.map((l) => l.id))
  });
  generated.push(...pw.rows);

  return { lapses, hwExtensions: [...hwExtensions.values()], generated, warnings: pw.warnings, taught: pw.taught };
}

// ───────────────────────── phase 2: spread live work over the next 7 days ─────────────────────────

export function computeAssign(rows, today, cfg, priorityOf) {
  const horizon = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(today, i);
    if (!isFriday(d)) horizon.push(d);
  }
  if (!horizon.length) horizon.push(today);
  const defaults = { 4: 1.25, 5: 1.5 };
  const weight = (d) => cfg["day_weight_" + dayIdx(d)] ?? defaults[dayIdx(d)] ?? 1;
  const scored = rows.map((r, seq) => ({
    ...r,
    seq,
    score: score(cfg, r.kind, priorityOf(r.book_id), diffDays(r.due_date, today))
  }));
  scored.sort((a, b) => b.score - a.score || (a.part_no || 0) - (b.part_no || 0) || a.seq - b.seq);
  const load = new Map(horizon.map((d) => [d, 0]));
  const lastByGroup = new Map();
  const assignments = new Map();
  for (const r of scored) {
    const grouped = r.group_key && (r.parts_total || 0) > 1;
    const minDate = grouped && lastByGroup.has(r.group_key) ? addDays(lastByGroup.get(r.group_key), 1) : today;
    const elig = horizon.filter((d) => d <= r.due_date);
    const reserve = grouped && r.part_no ? Math.max(0, r.parts_total - r.part_no) : 0;
    const limit = Math.max(0, elig.length - 1 - reserve);
    let cands = elig.filter((d, i) => d >= minDate && i <= limit);
    if (!cands.length) cands = elig.filter((d) => d >= minDate);
    if (!cands.length) cands = elig;
    if (!cands.length) cands = [today];
    let best = cands[0], bv = Infinity;
    for (const d of cands) {
      const v = ((load.get(d) || 0) + 1) / weight(d);
      if (v < bv - 1e-9) {
        bv = v;
        best = d;
      }
    }
    load.set(best, (load.get(best) || 0) + 1);
    assignments.set(r.id, best);
    if (grouped) lastByGroup.set(r.group_key, best);
  }
  return { assignments, scores: new Map(scored.map((r) => [r.id, Math.round(r.score * 10) / 10])), load };
}
