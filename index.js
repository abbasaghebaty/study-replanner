import { addDays, computeAssign, computePhase1, sessionDaysByBook, tehranToday } from "./planner.js";

const all = async (db, sql) => (await db.prepare(sql).all()).results;

async function loadState(db) {
  const [cfgRows, books, sched, plan, homework, exams, progress, toc] = await Promise.all([
    all(db, "SELECT key, value FROM config"),
    all(db, "SELECT id, subject, priority, preview_needed, max_reviews FROM books"),
    all(db, "SELECT day_index, subject, book_id FROM weekly_schedule"),
    all(db, "SELECT * FROM plan ORDER BY id"),
    all(db, "SELECT * FROM homework ORDER BY id"),
    all(db, "SELECT * FROM exams ORDER BY id"),
    all(db, "SELECT id, book_id, report_date, up_to_page, lesson_label, toc_id FROM progress_log ORDER BY id"),
    all(db, "SELECT id, book_id, chapter, lesson, kind, start_page FROM toc ORDER BY book_id, start_page, id")
  ]);
  const cfg = Object.fromEntries(cfgRows.map((r) => [r.key, r.value]));
  const prio = new Map(books.map((b) => [b.id, b.priority]));
  return {
    raw: [cfgRows, books, sched, plan, homework, exams, progress, toc], // used for the change fingerprint
    cfg, books, plan, homework, exams, progress, toc,
    sessions: sessionDaysByBook(books, sched),
    priorityOf: (id) => prio.get(id)
  };
}

const PLAN_COLS =
  "plan_date,book_id,kind,description,page_from,page_to,due_date,part_no,parts_total,group_key,source_type,source_id";

function phase1Statements(db, p1, nowIso) {
  const st = [];
  for (const e of p1.hwExtensions) {
    st.push(db.prepare("UPDATE homework SET status='skipped', closed_reason='missed', closed_at=? WHERE id=? AND status='todo'").bind(nowIso, e.old));
    st.push(
      db.prepare(
        `INSERT INTO homework(book_id,description,due_date,status,assigned_date,extended_from)
         SELECT book_id,description,?,'todo',assigned_date,id FROM homework
         WHERE id=? AND NOT EXISTS (SELECT 1 FROM homework WHERE extended_from=?)`
      ).bind(e.delivery, e.old, e.old)
    );
  }
  for (const l of p1.lapses) {
    // reason: missed | source_closed | taught
    st.push(db.prepare("UPDATE plan SET status='skipped', closed_reason=?, closed_at=? WHERE id=? AND status='todo'").bind(l.reason, nowIso, l.id));
    if (l.clone) {
      const c = l.clone;
      const hwSrc = c.source_type === "homework";
      const srcExpr = hwSrc ? "(SELECT id FROM homework WHERE extended_from=? ORDER BY id DESC LIMIT 1)" : "source_id";
      const binds = [c.due_date, c.description, c.due_date, ...(hwSrc ? [c.source_id] : []), c.id, c.id];
      st.push(
        db.prepare(
          `INSERT INTO plan(${PLAN_COLS},status,extended_from)
           SELECT ?,book_id,kind,?,page_from,page_to,?,part_no,parts_total,group_key,source_type,${srcExpr},'todo',id
           FROM plan WHERE id=? AND NOT EXISTS (SELECT 1 FROM plan WHERE extended_from=?)`
        ).bind(...binds)
      );
    }
  }
  for (const g of p1.generated) {
    const vals = [g.plan_date, g.book_id, g.kind, g.description, g.page_from, g.page_to, g.due_date, g.part_no, g.parts_total, g.group_key, g.source_type, g.source_id];
    if (g.source_type === "progress") {
      // page-based review/preview: never insert the same open row twice (safe if two runs overlap)
      st.push(
        db.prepare(
          `INSERT INTO plan(${PLAN_COLS},status)
           SELECT ?,?,?,?,?,?,?,?,?,?,?,?,'todo'
           WHERE NOT EXISTS (SELECT 1 FROM plan WHERE book_id=? AND kind=? AND page_from=? AND page_to=? AND status='todo')`
        ).bind(...vals, g.book_id, g.kind, g.page_from, g.page_to)
      );
    } else {
      st.push(db.prepare(`INSERT INTO plan(${PLAN_COLS},status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'todo')`).bind(...vals));
    }
  }
  return st;
}

const runBatches = async (db, statements) => {
  for (let i = 0; i < statements.length; i += 50) await db.batch(statements.slice(i, i + 50));
};

export async function replan(env, { dry = false, now = Date.now() } = {}) {
  const db = env.DB;
  const today = tehranToday(now);
  const nowIso = new Date(now).toISOString();
  let s = await loadState(db);
  const p1 = computePhase1(s, today);
  let live;
  if (dry) {
    const closedIds = new Set(p1.lapses.map((l) => l.id));
    const virtual = [...p1.lapses.filter((l) => l.clone).map((l) => l.clone), ...p1.generated].map((r, i) => ({ ...r, id: "new:" + (i + 1) }));
    live = [...s.plan.filter((r) => r.status === "todo" && r.due_date >= today && !closedIds.has(r.id)), ...virtual];
  } else {
    await runBatches(db, phase1Statements(db, p1, nowIso));
    s = await loadState(db);
    live = s.plan.filter((r) => r.status === "todo" && r.due_date >= today);
  }
  const { assignments, scores, load } = computeAssign(live, today, s.cfg, s.priorityOf);
  const moves = live
    .filter((r) => assignments.get(r.id) !== r.plan_date)
    .map((r) => ({ id: r.id, from: r.plan_date, to: assignments.get(r.id), score: scores.get(r.id) }));
  if (!dry) {
    await runBatches(db, moves.map((m) => db.prepare("UPDATE plan SET plan_date=? WHERE id=? AND status='todo'").bind(m.to, m.id)));
  }
  return {
    ok: true,
    dry,
    today,
    taught_to: p1.taught, // last taught page per subject, as understood from progress_log
    warnings: p1.warnings, // data problems worth fixing (never blocks the run)
    lapsed: p1.lapses.map((l) => ({ id: l.id, reason: l.reason, extended_to: l.clone?.due_date ?? null })),
    homework_extended: p1.hwExtensions.length,
    generated: p1.generated.map((g) => ({
      kind: g.kind,
      description: g.description,
      pages: g.page_from != null ? [g.page_from, g.page_to] : null,
      due: g.due_date
    })),
    moved: moves.length,
    moves: dry ? moves : undefined,
    load_per_day: Object.fromEntries(load)
  };
}

// ───────────── change detection ─────────────
// D1 cannot call a worker when a row changes, so a cheap cron tick (every 5 min) fingerprints
// everything the planner reads (plus today's Tehran date) and only replans when it differs from
// the fingerprint stored after the previous run.

async function fingerprint(state, today) {
  const bytes = new TextEncoder().encode(JSON.stringify([today, state.raw]));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const ensureStateTable = (db) =>
  db.prepare("CREATE TABLE IF NOT EXISTS replan_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)").run();

export async function syncReplan(env, { force = false, now = Date.now() } = {}) {
  const db = env.DB;
  await ensureStateTable(db);
  const today = tehranToday(now);
  const before = await fingerprint(await loadState(db), today);
  const stored = (await db.prepare("SELECT value FROM replan_state WHERE key='fingerprint'").first())?.value;
  if (!force && stored === before) return { ok: true, skipped: true, reason: "no changes", today };
  const result = await replan(env, { now });
  // fingerprint of the state the run left behind, so our own writes don't trigger another run
  const after = await fingerprint(await loadState(db), today);
  await db
    .prepare(
      "INSERT INTO replan_state(key,value,updated_at) VALUES('fingerprint',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at"
    )
    .bind(after, new Date(now).toISOString())
    .run();
  return { ...result, trigger: force ? "forced" : "db_changed" };
}

// must be identical to the 12-hour entry in wrangler.jsonc
const FORCED_CRON = "35 20,8 * * *";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true, service: "study-replanner" });
    if (url.pathname === "/replan" && request.method === "POST") {
      const token = env.REPLAN_TOKEN;
      if (!token || request.headers.get("Authorization") !== `Bearer ${token}`) return json({ error: "unauthorized" }, 401);
      try {
        if (url.searchParams.get("dry") === "1") return json(await replan(env, { dry: true }));
        return json(await syncReplan(env, { force: true }));
      } catch (e) {
        console.error("replan failed", e);
        return json({ error: "replan failed", detail: String(e?.message || e) }, 500);
      }
    }
    return json({ error: "not found" }, 404);
  },
  async scheduled(event, env, ctx) {
    // the 12-hour cron always replans; the 5-minute cron replans only if the database changed
    const force = event.cron === FORCED_CRON;
    ctx.waitUntil(syncReplan(env, { force }).catch((e) => console.error("scheduled replan failed", e)));
  }
};
