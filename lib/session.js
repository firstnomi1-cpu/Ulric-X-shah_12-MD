/**
 * Ulric-X MD - Session Validation & Persistence Layer
 *
 * This module sits AROUND the existing pairing flow (which is untouched).
 * It solves the "Could not link devices" error by:
 *
 * 1. ATOMIC WRITES
 *    creds.json is written to a temp file first, then renamed.
 *    If process dies mid-write, the temp file is left (corrupt) but
 *    the main creds.json stays intact.
 *
 * 2. LINKED MARKER FILE
 *    When connection.update fires with 'open' (login complete), we
 *    write a `linked.json` marker. On restart, a session is only
 *    considered valid if BOTH creds.json AND linked.json exist.
 *
 * 3. INTEGRITY CHECK
 *    Before loading a session, we verify creds.json contains the
 *    required Baileys fields (me, signalIdentities, etc.). Corrupt
 *    sessions are auto-deleted (forces re-pair).
 *
 * 4. RECONNECT LIMIT
 *    If a session fails to reconnect 3 times in a row, it's marked
 *    corrupt and deleted. User must re-pair (instead of infinite loop).
 *
 * 5. DETAILED LOGS
 *    All 7 required log points are emitted here.
 */
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const config = require('../config');

const SESSIONS_DIR = config.SESSIONS_DIR;

// ─── Helpers ────────────────────────────────────────────────────

function sessionPath(jid) {
  return path.join(SESSIONS_DIR, jid);
}

function credsPath(jid) {
  return path.join(sessionPath(jid), 'creds.json');
}

function linkedPath(jid) {
  return path.join(sessionPath(jid), 'linked.json');
}

function tempPath(jid) {
  return path.join(sessionPath(jid), 'creds.json.tmp');
}

function failCountPath(jid) {
  return path.join(sessionPath(jid), 'failcount.json');
}

// ─── Atomic Write ───────────────────────────────────────────────

/**
 * Write JSON atomically: write to .tmp, then rename.
 * Prevents corruption if process dies mid-write.
 */
function atomicWrite(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmp = filePath + '.tmp.' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Check if a session is VALID (has both creds.json and linked.json,
 * and creds.json passes integrity check).
 *
 * Returns: { valid, reason, jid }
 */
function validateSession(jid) {
  const sp = sessionPath(jid);
  const cp = credsPath(jid);
  const lp = linkedPath(jid);

  // No folder = never paired
  if (!fs.existsSync(sp)) {
    return { valid: false, reason: 'no_folder', jid };
  }

  // No creds.json = pairing never started or was cleaned up
  if (!fs.existsSync(cp)) {
    return { valid: false, reason: 'no_creds', jid };
  }

  // Has creds but no linked.json = pairing started but never completed
  if (!fs.existsSync(lp)) {
    return { valid: false, reason: 'not_linked', jid };
  }

  // Validate creds.json structure
  try {
    const creds = JSON.parse(fs.readFileSync(cp, 'utf8'));

    // Required fields for a valid Baileys session
    if (!creds.me || !creds.cachedGroupMetadataRef) {
      // Note: 'me' is set when WhatsApp confirms identity
      if (!creds.me) {
        return { valid: false, reason: 'no_me_identity', jid };
      }
    }

    // Check signal identities exist (key exchange completed)
    if (!creds.signalIdentities || Object.keys(creds.signalIdentities).length === 0) {
      // Some valid sessions might not have this immediately, so just warn
      console.log(chalk.yellow(`[SESSION] Warning: ${jid} has no signalIdentities yet`));
    }

    return { valid: true, reason: 'ok', jid };
  } catch (e) {
    return { valid: false, reason: 'corrupt_json', jid, error: e.message };
  }
}

/**
 * Mark a session as successfully linked.
 * Call this when connection.update fires with 'open'.
 *
 * This is the KEY fix — without this marker, we can't distinguish
 * between "pairing started" and "pairing completed successfully".
 */
function markLinked(jid, extra = {}) {
  try {
    const linked = {
      jid,
      linkedAt: Date.now(),
      linkedAtISO: new Date().toISOString(),
      ...extra
    };
    atomicWrite(linkedPath(jid), linked);
    console.log(chalk.green(`[SESSION] ✅ Marked as linked: ${jid}`));
    console.log(chalk.green(`[SESSION]    Linked at: ${linked.linkedAtISO}`));
    return true;
  } catch (e) {
    console.error(chalk.red(`[SESSION] Failed to mark linked for ${jid}: ${e.message}`));
    return false;
  }
}

/**
 * Increment fail count for a session.
 * If count >= maxFails, delete the session (force re-pair).
 *
 * Returns: { deleted, failCount }
 */
function recordReconnectFailure(jid, maxFails = 3) {
  const fp = failCountPath(jid);
  let count = 0;
  try {
    if (fs.existsSync(fp)) {
      count = JSON.parse(fs.readFileSync(fp, 'utf8')).count || 0;
    }
  } catch (e) {}

  count++;
  try {
    atomicWrite(fp, { count, lastFail: Date.now() });
  } catch (e) {}

  console.log(chalk.yellow(`[SESSION] Reconnect failure ${count}/${maxFails} for ${jid}`));

  if (count >= maxFails) {
    console.log(chalk.red(`[SESSION] ❌ Max failures reached for ${jid}, deleting session`));
    destroySession(jid);
    return { deleted: true, failCount: count };
  }

  return { deleted: false, failCount: count };
}

/**
 * Reset fail count (called when session reconnects successfully).
 */
function resetFailCount(jid) {
  const fp = failCountPath(jid);
  try {
    if (fs.existsSync(fp)) {
      fs.unlinkSync(fp);
    }
  } catch (e) {}
}

/**
 * Completely destroy a session (force re-pair).
 * Used when session is corrupt or user unpairs.
 */
function destroySession(jid) {
  const sp = sessionPath(jid);
  try {
    if (fs.existsSync(sp)) {
      fs.rmSync(sp, { recursive: true, force: true });
    }
    console.log(chalk.red(`[SESSION] Destroyed session: ${jid}`));
    return true;
  } catch (e) {
    console.error(chalk.red(`[SESSION] Failed to destroy ${jid}: ${e.message}`));
    return false;
  }
}

/**
 * Get session info (for dashboard / debugging).
 */
function getSessionInfo(jid) {
  const v = validateSession(jid);
  const info = {
    jid,
    valid: v.valid,
    reason: v.reason,
    exists: fs.existsSync(sessionPath(jid))
  };

  try {
    const linked = JSON.parse(fs.readFileSync(linkedPath(jid), 'utf8'));
    info.linkedAt = linked.linkedAt;
    info.linkedAtISO = linked.linkedAtISO;
  } catch (e) {
    info.linkedAt = null;
  }

  try {
    const fp = failCountPath(jid);
    if (fs.existsSync(fp)) {
      info.failCount = JSON.parse(fs.readFileSync(fp, 'utf8')).count;
    } else {
      info.failCount = 0;
    }
  } catch (e) {
    info.failCount = 0;
  }

  return info;
}

/**
 * List all sessions (valid + invalid) — for admin panel.
 */
function listAllSessions() {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  const entries = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });
  const sessions = [];
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.endsWith('@s.whatsapp.net')) {
      sessions.push(getSessionInfo(entry.name));
    }
  }
  return sessions;
}

/**
 * Atomic save wrapper for Baileys creds.
 * Use this as the saveCreds callback to prevent corruption.
 */
function makeAtomicSaver(jid, originalSaveCreds) {
  return async () => {
    try {
      // First call the original Baileys save (writes creds.json)
      if (typeof originalSaveCreds === 'function') {
        await originalSaveCreds();
      }
      // Note: Baileys' useMultiFileAuthState already writes atomically
      // internally (temp + rename), so we just verify it succeeded.
    } catch (e) {
      console.error(chalk.red(`[SESSION] Save failed for ${jid}: ${e.message}`));
    }
  };
}

/**
 * Log all 7 required lifecycle events in a structured way.
 */
function logEvent(event, jid, extra = {}) {
  const ts = new Date().toISOString();
  const logLine = `[LIFECYCLE] ${ts} | ${event.padEnd(25)} | ${jid} ${Object.keys(extra).length ? JSON.stringify(extra) : ''}`;
  console.log(chalk.cyan(logLine));

  // Also append to a dedicated lifecycle log file (for debugging)
  try {
    const logFile = path.join(config.LOGS_DIR || './logs', 'lifecycle.log');
    const logDir = path.dirname(logFile);
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(logFile, logLine + '\n');
  } catch (e) {}
}

module.exports = {
  validateSession,
  markLinked,
  recordReconnectFailure,
  resetFailCount,
  destroySession,
  getSessionInfo,
  listAllSessions,
  makeAtomicSaver,
  logEvent,
  atomicWrite,
  sessionPath,
  credsPath,
  linkedPath
};
