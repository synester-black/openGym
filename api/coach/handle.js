/* The stable per-profile pseudonym a payload carries instead of the uid: never the uid, never
 * reversible, the same across jobs. Keyed on the instance secret so two instances never mint
 * the same handle for the same uid. Node-only — the phone mints its own random handle. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DATA = process.env.DATA_DIR || '/data';
let secretOverride = null;

// Installed by server.js when Postgres is the backing store; this stable pseudonym must keep
// using the same instance secret even when no secret file exists on the ephemeral filesystem.
export function setSecret(secret) { secretOverride = String(secret || ''); }

export const HANDLE_LENGTH = 16;

export function handleFor(uid) {
  const secret = secretOverride || fs.readFileSync(path.join(DATA, 'secret'), 'utf8').trim();
  return crypto.createHmac('sha256', secret).update('coach-handle:' + uid).digest('base64url').slice(0, HANDLE_LENGTH);
}
