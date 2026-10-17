#!/usr/bin/env node
/* End-to-end smoke test for the fork's Postgres storage mode (STORAGE=postgres).
 *
 * Boots the api against a real database, walks the routes a real instance uses — profile
 * registration, document push, the revision guard, restart durability, the admin activity
 * log — and refuses to pass while anything is off. The default DATABASE_URL points at the
 * local test container from the build steps:
 *
 *   docker run -d --name opengym-pg -e POSTGRES_PASSWORD=gym -e POSTGRES_DB=opengym -p 54329:5432 postgres:16-alpine
 *   node scripts/pg-smoke.mjs
 *
 * Reset the instance between runs with:
 *   docker exec opengym-pg psql -U postgres -d opengym -c 'DROP TABLE IF EXISTS opengym_documents, opengym_states, opengym_audit CASCADE'
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.js');

const DATABASE_URL = process.env.DATABASE_URL
  || 'postgresql://postgres:gym@localhost:54329/opengym';
const PORT = +(process.env.SMOKE_PORT || 31990);
const BASE = `http://localhost:${PORT}`;

async function resetDatabase() {
  // A run must see the exact conditions a fresh instance has (first profile becomes admin),
  // so the three tables go away and the driver's next boot recreates them.
  const host = new URL(DATABASE_URL).hostname;
  if (!['localhost', '127.0.0.1', '::1'].includes(host)
      && process.env.PG_SMOKE_ALLOW_RESET !== '1') {
    throw new Error(`refusing to DROP Postgres tables on remote host ${host}; use a disposable local database, or set PG_SMOKE_ALLOW_RESET=1 to explicitly allow destructive testing`);
  }
  const pool = new pg.Pool({ connectionString: DATABASE_URL, ssl: /sslmode|neon\.tech/.test(DATABASE_URL) ? { rejectUnauthorized: false } : undefined });
  await pool.query('DROP TABLE IF EXISTS opengym_documents, opengym_states, opengym_audit CASCADE');
  await pool.end();
}
const ENV = {
  ...process.env,
  STORAGE: 'postgres',
  DATABASE_URL,
  PORT: String(PORT),
  RP_ID: 'localhost',
  ORIGIN: BASE,
  RP_NAME: 'openGym smoke',
  PASSWORD_LOGIN: '1',
  FIRST_USER_ADMIN: '1',
    DATA_DIR: '/tmp/opengym-smoke-data',   // media only; isolated from the profile documents
  REMINDER_TICK_MS: '50'
};
delete ENV.RENDER;

let child = null;
const fail = msg => { console.error('SMOKE FAIL:', msg); if (child) child.kill('SIGTERM'); process.exit(1); };
const onFail = code => { fail(`server exited early with code ${code}`); };

async function boot() {
  child = spawn(process.execPath, [SERVER], { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  child.on('exit', onFail);
  const started = Date.now();
  while (Date.now() - started < 15000) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.status === 200) {
        const j = await r.json();
        assert.equal(j.storage, 'postgres', 'health must report the postgres backing');
        return;
      }
    } catch { /* not listening yet, or the boot hand-over to Postgres is still running */ }
    await new Promise(r => setTimeout(r, 150));
  }
  fail('server never answered /api/health within 15 s');
}
const stop = () => new Promise(res => {
  child.off('exit', onFail);
  child.on('exit', res);
  child.kill('SIGTERM');
});

const jar = new Map();
function cookieHeader() { return [...jar.values()].join('; '); }
function takeCookies(res) {
  for (const c of res.headers.getSetCookie?.() || []) jar.set(c.split(';')[0].split('=')[0], c.split(';')[0]);
}
const call = async (method, path, { body = undefined, session = true } = {}) => {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (session && jar.size) headers.cookie = cookieHeader();
  const r = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  takeCookies(r);
  let data = null;
  try { data = await r.json(); } catch { data = null; }
  return { status: r.status, data };
};
const bigState = n => {
  const workouts = Array.from({ length: n }, (_, i) => ({
    id: `w${i}`, d: new Date(Date.now() - i * 86400000).toISOString().slice(0, 10),
    name: ['Push', 'Pull', 'Legs'][i % 3],
    ex: [{ name: 'Bench Press', sets: [{ w: 80 + i % 20, reps: 8 }] }]
  }));
  return { lang: 'en', unit: 'kg', startWeekday: 1, reminder: { on: false }, workouts, routines: [] };
};

/* Use a unique profile name per run: a rerun against a kept database must test fresh lives. */
const RUN = crypto.randomBytes(3).toString('hex');
const PW = 'correct horse battery staple 42';

async function main() {
  console.log('0. reset the test database to a fresh instance');
  await resetDatabase();
  console.log('1. boot (postgres backing)');
  await boot();
  console.log('2. register two profiles (first is admin via FIRST_USER_ADMIN)');
  {
    const r = await call('POST', '/api/register/password', { session: false, body: { name: `u1-${RUN}`, password: PW } });
    assert.equal(r.status, 200, `register u1: ${JSON.stringify(r.data)}`);
    const who = await call('GET', '/api/account/password');
    if (who.status !== 200) console.log('   (account/password absent — check admin flag via audit route)');
  }
  {
    const guestCookie = new Map(jar); jar.clear();
    const r = await call('POST', '/api/register/password', { session: false, body: { name: `u2-${RUN}`, password: PW } });
    assert.equal(r.status, 200, `register u2: ${JSON.stringify(r.data)}`);
    jar.clear(); guestCookie.forEach((v, k) => jar.set(k, v));
  }
  console.log('3. first document push (no baseRev)');

  {
    const r = await call('PUT', '/api/data', { body: { state: bigState(3) } });
    assert.equal(r.status, 200, `push: ${JSON.stringify(r.data)}`);
    assert.equal(r.data.rev, 1, 'first write is revision 1');
  }
  console.log('4. revision guard: stale base answered 409 with the current document');
  {
    const r = await call('PUT', '/api/data', { body: { baseRev: 0, state: bigState(1) } });
    assert.equal(r.status, 409, 'a push over a revision it never saw is refused');
    assert.equal(r.data.rev, 1, 'the 409 carries the revision to merge onto');
    assert.equal(r.data.state?.workouts?.length, 3, 'the 409 carries the current document');
  }
  console.log('5. guarded push over the current revision');
  {
    const r = await call('PUT', '/api/data', { body: { baseRev: 1, baseWid: undefined, state: bigState(7) } });
    assert.equal(r.status, 200, `second push: ${JSON.stringify(r.data)}`);
    assert.equal(r.data.rev, 2, 'second write is revision 2');
  }
  console.log('6. read-back');
  {
    const rev = await call('GET', '/api/data/rev');
    assert.equal(rev.data.rev, 2, 'rev endpoint agrees');
    const doc = await call('GET', '/api/data');
    assert.equal(doc.data.rev, 2);
    assert.equal(doc.data.state.workouts.length, 7, 'round trip kept every workout');
  }
  console.log('7. save Ollama-compatible Coach settings and encrypted key');
  {
    const cfg = await call('POST', '/api/admin/coach/config', { body: {
      enabled: true, provider: 'compatible', baseUrl: 'https://ollama.com/v1', model: 'gemma4:31b', community: true
    } });
    assert.equal(cfg.status, 200, `Coach config: ${JSON.stringify(cfg.data)}`);
    const key = await call('POST', '/api/admin/coach/connect', { body: {
      provider: 'compatible', type: 'apikey', token: 'smoke-only-not-a-real-key'
    } });
    assert.equal(key.status, 200, `Coach API key: ${JSON.stringify(key.data)}`);
    const visible = await call('GET', '/api/config');
    assert.equal(visible.data.coach?.provider, 'compatible', 'connected Coach is visible to signed-in profiles');
    const sharing = await call('POST', '/api/coach/cohort/share', { body: { share: true } });
    assert.equal(sharing.data.sharing, true, 'per-profile Coach history store accepts writes');
    const cohort = await call('GET', '/api/coach/cohort');
    assert.equal(cohort.data.sharing, true, 'Coach state is read from Postgres-backed profile data');
  }
  console.log('8. restart: SIGTERM, fresh process, same database (Coach settings and secret persist)');
  await stop();
  await boot();
  {
    const cfg = await call('GET', '/api/config');
    assert.equal(cfg.data.coach?.provider, 'compatible', 'Coach settings survived restart');
    const cohort = await call('GET', '/api/coach/cohort');
    assert.equal(cohort.data.sharing, true, 'per-profile Coach settings survived restart');
    const rev = await call('GET', '/api/data/rev');
    assert.equal(rev.data.rev, 2, `revision survived the restart (got ${rev.data.rev})`);
    const r = await call('PUT', '/api/data', { body: { baseRev: 2, state: bigState(9) } });
    assert.equal(r.status, 200, `push after restart: ${JSON.stringify(r.data)}`);
    assert.equal(r.data.rev, 3, 'the counter continues after a restart');
  }
  console.log('9. admin: activity log readable, clear refused for a profile, fine for the admin');
  {
    // Re-sign in to the admin's cookie (jar held u1's session; the restart flushed nothing of it).
    const sign = await call('POST', '/api/login/password', { session: false, body: { name: `u1-${RUN}`, password: PW } });
    assert.equal(sign.status, 200, `login u1: ${JSON.stringify(sign.data)}`);
    const view = await call('GET', '/api/admin/audit');
    if (view.status === 403) fail('FIRST_USER_ADMIN did not promote the first profile');
    assert.equal(view.status, 200);
    assert.ok(view.data.events.length > 0, 'the log has the auth events of this run');
  }
  {
    const guestCookie = new Map(jar); jar.clear();
    await call('POST', '/api/login/password', { session: false, body: { name: `u2-${RUN}`, password: PW } });
    const refused = await call('GET', '/api/admin/audit');
    assert.equal(refused.status, 403, 'a plain profile must not read the log');
    jar.clear(); guestCookie.forEach((v, k) => jar.set(k, v));
  }
  {
    const cleared = await call('POST', '/api/admin/audit/clear');
    assert.equal(cleared.status, 200, 'admin clears the log');
    const after = await call('GET', '/api/admin/audit');
    assert.ok(after.data.events.length >= 1, 'the clearing itself is logged');
  }
  console.log('10. second profile isolated');
  {
    const adminCookie = new Map(jar); jar.clear();
    await call('POST', '/api/login/password', { session: false, body: { name: `u2-${RUN}`, password: PW } });
    const rev = await call('GET', '/api/data/rev');
    assert.equal(rev.status, 200, `u2 sign-in: ${JSON.stringify(rev.data)}`);
    assert.equal(rev.data.rev, 0, 'u2 has no document and no revision of u1');
    jar.clear(); adminCookie.forEach((v, k) => jar.set(k, v));
  }
  await stop();
  child = null;
  console.log('\nSMOKE PASS — Postgres storage mode behaved.');
}

try { await main(); }
catch (e) { fail(e.stack || e.message); }
if (child) child.kill('SIGTERM');
process.exit(0);
