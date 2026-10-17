/* Postgres storage driver (fork): replaces the fs DATA_DIR for everything except media.
 *
 * Chosen server-side with STORAGE=postgres and DATABASE_URL. Everything server.js keeps in
 * files upstream lands in three tables — accounts and small JSON (documents), one whole
 * document per profile (states), the activity log (audit) — so the api needs no persistent
 * disk and runs anywhere that speaks to Postgres, including serverless hosts. The default
 * 'fs' behaviour of server.js is untouched, and this file is only ever imported when that
 * env var says so, so stock deploys do not even parse it.
 *
 * Deliberate limits, inherited from how server.js actually works:
 * - db.json's whole-object save() calls are fire-and-forget everywhere; here they are
 *   write-behind: the newest value replaces older ones, flushed on a short debounce, on a
 *   slow-burn interval, and before the process leaves on SIGTERM/SIGINT. A hard kill can
 *   therefore roll the accounts document back at most one debounce window; nothing else can
 *   lose more: per-profile documents are awaited BEFORE their 200 goes out.
 * - Per-profile documents live in this process's memory and are the truth the in-process
 *   compare-and-write of PUT /api/data guards; that contract holds for exactly one api
 *   instance. Never scale this storage mode to more than one replica.
 * - Media bytes stay on the filesystem under DATA_DIR/uploads (space on an ephemeral disk is
 *   fine: devices notice a lost blob through /api/media/missing and upload it again).
 */
import pg from 'pg';

const TABLES = `
  CREATE TABLE IF NOT EXISTS opengym_documents (
    key        text        PRIMARY KEY,
    data       jsonb       NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS opengym_states (
    uid        text        PRIMARY KEY,
    data       jsonb       NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS opengym_audit (
    id bigint      NOT NULL PRIMARY KEY,   -- app-owned; admin paging is by this, newest first
    rec jsonb       NOT NULL,
    at timestamptz  NOT NULL DEFAULT now()
  );
`;

export async function openPgStore(log = console) {
  const url = String(process.env.DATABASE_URL || '').trim();
  if (!url) throw new Error('STORAGE=postgres requires DATABASE_URL');
  const wantsSsl = /sslmode=(require|verify)/i.test(url) || /[.:]neon\.tech/.test(url);
  const pool = new pg.Pool({
    connectionString: url,
    max: 3,
    idleTimeoutMillis: 10000,          // drop connections quickly: an idle Neon compute may doze
    connectionTimeoutMillis: 15000,    // a waking Neon needs a moment before the first answer
    ...(wantsSsl ? { ssl: { rejectUnauthorized: false } } : {})
  });
  await pool.query(TABLES);

  /* ---- documents (secret, VAPID keys, the accounts document, Coach config) ---- */

  const dirty = new Map();             // key -> value awaiting its UPDATE (latest wins)
  const auditInFlight = new Set();     // the audit INSERTs not yet answered by the database
  let flushTimer = null;
  let chain = Promise.resolve();

  async function writeDocs(values) {
    for (const [key, value] of values) {
      await pool.query(
        `INSERT INTO opengym_documents (key, data, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET data = $2, updated_at = now()`,
        [key, JSON.stringify(value)]
      );
    }
  }

  // Serialized through `chain` so two flushes never interleave; a failed write stays dirty and
  // retries on the next beat.
  function flush() {
    if (!dirty.size) return;
    const snapshot = [...dirty];
    snapshot.forEach(([key]) => dirty.delete(key));
    chain = chain.then(() => writeDocs(snapshot)).catch(e => {
      // Back into the queue, but only where a newer value has not already replaced the failed
      // one while this flush was in flight — the newest write must never be rolled back.
      snapshot.forEach(([key, value]) => { if (!dirty.has(key)) dirty.set(key, value); });
      console.error('postgres: document save failed, will retry —', e.message);
    });
  }
  function scheduleFlush() {
    if (!flushTimer) {
      flushTimer = setTimeout(() => { flushTimer = null; flush(); }, 1500);
      flushTimer.unref?.();
    }
  }
  setInterval(flush, 30000).unref?.();  // slow-burn belt under the debounce

  // SIGTERM (deploys) and SIGINT (Ctrl-C) flush before leaving — and then leave: installing a
  // handler removes node's default terminate, so the flush can't be the only thing that happens.
  // A kill -9 skips all of it; the accounts document can be at most one debounce window behind.
  let leaving = false;
  const onLeave = () => {
    if (leaving) return;
    leaving = true;
    clearTimeout(flushTimer); flushTimer = null; flush();
    chain.then(() => process.exit(0)).catch(() => process.exit(0));
  };
  process.on('SIGTERM', onLeave);
  process.on('SIGINT', onLeave);

  return {
    mode: 'postgres',

    /* ---- documents ---- */
    async kvGet(key) {
      const r = await pool.query('SELECT data FROM opengym_documents WHERE key = $1', [key]);
      return r.rows.length ? r.rows[0].data : null;
    },
    async kvPut(key, value) {
      await pool.query(
        `INSERT INTO opengym_documents (key, data, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET data = $2, updated_at = now()`,
        [key, JSON.stringify(value)]
      );
    },
    // The accounts document: one row, whole object, like DB.json on disk.
    saveDbDoc(value) { dirty.set('db.json', value); scheduleFlush(); return true; },
    flushNow() { clearTimeout(flushTimer); flushTimer = null; flush(); },

    /* ---- per-profile documents ---- */
    // uid -> raw document text, exactly what readState() would have read from disk.
    async preloadStates() {
      const r = await pool.query('SELECT uid, data FROM opengym_states');
      return new Map(r.rows.map(x => [x.uid, JSON.stringify(x.data)]));
    },
    // Awaited by PUT /api/data before its 200: the durability the fs write had (temp, fsync,
    // rename) this UPDATE now has (WAL commit). `text` is what the route already validated and
    // stringified; parsing it is a shape check that also makes the JSONB round-trip exact.
    async putStateRaw(uid, text) {
      const value = JSON.parse(text);      // throws only if the caller had lied; then 500s
      await pool.query(
        `INSERT INTO opengym_states (uid, data, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (uid) DO UPDATE SET data = $2, updated_at = now()`,
        [uid, JSON.stringify(value)]
      );
    },
    async deleteState(uid) {
      await pool.query('DELETE FROM opengym_states WHERE uid = $1', [uid]);
    },

  /* ---- audit (opengym_audit) ---- */
  // audit() is synchronous upstream; the INSERT rides along best-effort, exactly like the
  // appendFileSync it sits in for ("never throws: a log that can't be written must not break
  // signing in"). auditFlush() is the read-your-writes point for the admin views of the log.
  insertAudit(rec) {
    const done = pool.query('INSERT INTO opengym_audit (id, rec) VALUES ($1, $2)', [rec.id, JSON.stringify(rec)])
      .catch(e => console.error('audit insert failed', e.message))
      .finally(() => auditInFlight.delete(done));
    auditInFlight.add(done);
  },
  async auditFlush() {
    while (auditInFlight.size) await Promise.allSettled([...auditInFlight]);
  },
    async auditSeed() {
      const r = await pool.query('SELECT COALESCE(max(id), 0) AS max, count(*) AS n FROM opengym_audit');
      return { maxId: Number(r.rows[0].max), count: Number(r.rows[0].n) };
    },
    // Newest first by id. All rows come back (retention caps the table, see auditPrune) so the
    // caller can apply its exact file-mode filters and pagination without inventing SQL for it.
    async auditRows({ keepFn = null, cat = '', failOnly = false } = {}) {
      const r = await pool.query('SELECT rec FROM opengym_audit ORDER BY id DESC');
      let rows = r.rows.map(x => x.rec);
      if (keepFn) rows = keepFn(rows);
      if (failOnly) rows = rows.filter(x => !x.ok);
      else if (cat) rows = rows.filter(x => String(x.ev).startsWith(cat + '.'));
      return rows;
    },
    async auditCount() {
      const r = await pool.query('SELECT count(*) AS n FROM opengym_audit');
      return Number(r.rows[0].n);
    },
    // Retention the way auditKeep() does it for the file: age first, then the newest N of what
    // is left. Both bounds are optional, 0 or absent meaning "this one is off".
    async auditPrune({ max = 0, days = 0 } = {}) {
      // Apply age first, then cap the survivors: one combined OR would calculate the cap
      // against expired rows too and could leave more than max recent entries behind.
      if (days > 0) {
        await pool.query('DELETE FROM opengym_audit WHERE at < now() - make_interval(days => $1::int)', [days]);
      }
      if (max > 0) {
        await pool.query(
          'DELETE FROM opengym_audit WHERE id <= (SELECT id FROM opengym_audit ORDER BY id DESC OFFSET $1 LIMIT 1)',
          [max]
        );
      }
    },
    async auditClear() {
      await pool.query('TRUNCATE opengym_audit');
    },

    async close() {
      clearTimeout(flushTimer); flushTimer = null; flush();
      await chain.catch(() => {});
      await pool.end();
    }
  };
}
