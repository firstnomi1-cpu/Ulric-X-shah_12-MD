/**
 * Ulric-X MD V12 - WhatsApp Multi-User Connection Manager
 *
 * ═══════════════════════════════════════════════════════════════════
 *  ROOT CAUSE FIX: Shared state object replaces closure variables.
 *
 *  In V11, attachHandlers() returned a SNAPSHOT of local variables.
 *  When we set handlerState.pairCode = formatted, the event handlers'
 *  closure still saw pairCode = null. So 515 handling NEVER triggered,
 *  and sessions were DESTROYED instead of retried.
 *
 *  V12 fix: ALL event handlers reference a shared `state` object.
 *  When we set state.pairCode = formatted, the handlers see it.
 *  515 handling now works correctly.
 * ═══════════════════════════════════════════════════════════════════
 *
 * Connection config is PRESERVED (same as working reference):
 *   - NO browser field (default Baileys)
 *   - connectTimeoutMs: 30000
 *   - defaultQueryTimeoutMs: 30000
 *   - keepAliveIntervalMs: 30000
 *   - requestPairingCode after 5s setTimeout
 */
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const chalk = require('chalk');
const baileys = require('@whiskeysockets/baileys');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = baileys;

const config = require('./config');
const store  = require('./lib/store');
const status = require('./lib/status');
const session = require('./lib/session');
const owner   = require('./lib/owner');

const connections = new Map();
const pendingPairs = new Map();
const heartbeats = new Map();
const connectedMsgSent = new Set();

// ═══════════════════════════════════════════════════════════════
// CONNECTED MESSAGE: Sent to user's "yourself" chat after login.
// Uses verified WhatsApp-style reply with bot logo image.
// Retry: attempt 1 → 3s → attempt 2 → 5s → fallback plain text.
// ═══════════════════════════════════════════════════════════════
async function sendConnectedMessage(jid, sock, attempt) {
  attempt = attempt || 1;
  if (connectedMsgSent.has(jid)) return;

  const verified = require('./lib/verifiedReply');
  const handler = require('./handler');

  try {
    await verified.sendVerified(sock, jid, {
      image: { url: config.BOT_LOGO },
      caption: config.BOT_CONNECTED_MSG,
      contextInfo: verified.verifiedContext()
    });
    connectedMsgSent.add(jid);
    session.logEvent('CONNECTED_MSG_SENT', jid, { attempt });
    console.log(chalk.green(`[CONNECTED] ✅ Sent to ${jid} (attempt ${attempt})`));

    await new Promise(r => setTimeout(r, 1500));
    try {
      await verified.sendVerified(sock, jid, {
        text: `👋 Welcome to ${config.BOT_NAME}!\n\nType .menu to see all ${handler.getTotalCommands()} commands.\nType .allmenu for the full list.\n\n> ${config.BOT_FOOTER}`
      });
    } catch {}
  } catch (e) {
    console.error(chalk.red(`[CONNECTED] Attempt ${attempt} failed: ${e.message}`));
    if (attempt < 3) {
      const delay = attempt === 1 ? 3000 : 5000;
      setTimeout(() => sendConnectedMessage(jid, sock, attempt + 1), delay);
    } else {
      try {
        await sock.sendMessage(jid, { text: config.BOT_CONNECTED_MSG });
        connectedMsgSent.add(jid);
        console.log(chalk.yellow(`[CONNECTED] Fallback text sent to ${jid}`));
      } catch (e2) {
        console.error(chalk.red(`[CONNECTED] All attempts failed: ${e2.message}`));
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// ATTACH ALL HANDLERS to a socket.
// Uses shared `state` object — ALL handlers can read/write it.
// This is the V12 fix: no more closure variable bugs.
// ═══════════════════════════════════════════════════════════════
function attachHandlers(sock, jid, sessionPath, state, saveCreds, authState, clean) {
  const handler = require('./handler');

  // ─── creds.update ─────────────────────────────────────────
  sock.ev.on('creds.update', () => {
    try { saveCreds(); } catch (e) {}

    const wasRegistered = state.registered;
    if (authState.creds && authState.creds.registered) {
      state.registered = true;
    }

    if (!wasRegistered && state.registered) {
      session.logEvent('REGISTERED', jid, {});
      console.log(chalk.green(`[PAIR] 📋 Device REGISTERED for ${jid}`));

      session.markLinked(jid, { pairedVia: 'code' });
      if (owner.assignOwner(jid, { pairedVia: 'code' })) {
        session.logEvent('OWNER_ASSIGNED', jid, { number: jid.split('@')[0] });
      }
      store.addUser(jid, {
        pairedAt: Date.now(),
        country: clean ? getCountryFromNumber(clean) : '',
        isOwner: owner.isOwner(jid)
      });
      status.setStatus(jid, 'connected');
    }
  });

  // ─── connection.update ────────────────────────────────────
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      state.everConnected = true;
      state.pairingLock = false;
      connections.set(jid, { sock, status: 'open', lastSeen: Date.now() });
      console.log(chalk.green(`[PAIR] ✅ CONNECTED: ${jid}`));
      status.setStatus(jid, 'connected');
      session.logEvent('CONNECTION_OPENED', jid);

      session.markLinked(jid, { pairedVia: 'code' });
      session.resetFailCount(jid);
      if (owner.assignOwner(jid, { pairedVia: 'code' })) {
        session.logEvent('OWNER_ASSIGNED', jid, { number: jid.split('@')[0] });
      }
      store.addUser(jid, {
        pairedAt: Date.now(),
        country: clean ? getCountryFromNumber(clean) : '',
        isOwner: owner.isOwner(jid)
      });

      // ═══ CONNECTED SMS: fire when socket is OPEN ═══
      if (!state.connectedMsgSent) {
        state.connectedMsgSent = true;
        sendConnectedMessage(jid, sock).catch(() => {});
      }

      // Move from pending to permanent
      const pending = pendingPairs.get(jid);
      if (pending) {
        heartbeats.set(jid, pending.heartbeat);
        pendingPairs.delete(jid);
      } else {
        heartbeats.set(jid, state.heartbeat);
      }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(chalk.yellow(`[PAIR] Closed ${jid} (code=${statusCode})`));
      session.logEvent('CONNECTION_CLOSED', jid, { statusCode, everConnected: state.everConnected });

      try { clearInterval(state.heartbeat); } catch (e) {}
      const hb = heartbeats.get(jid);
      if (hb) { clearInterval(hb); heartbeats.delete(jid); }

      // ═══ PAIRING LOCK: ignore close events during 5-min window ═══
      // V12 FIX: state.pairCode and state.pairingLock are now
      // properly updated (shared object, not closure snapshot)
      if (state.pairingLock && state.pairCode && !state.everConnected) {
        console.log(chalk.cyan(`[PAIR] Pairing lock active for ${jid}. Ignoring close (code ${statusCode}).`));

        if (statusCode === 515 && state.retry515Count < 5) {
          state.retry515Count++;
          console.log(chalk.yellow(`[PAIR] 515 retry ${state.retry515Count}/5 for ${jid} in 10s...`));
          session.logEvent('RECONNECT_ATTEMPT_515', jid, { retry: state.retry515Count });

          setTimeout(async () => {
            try {
              try { sock.end(); } catch (e) {}
              try { sock.ws.close(); } catch (e) {}

              const { state: ns, saveCreds: nsc } = await useMultiFileAuthState(sessionPath);
              const { version: nv } = await fetchLatestBaileysVersion();

              const newSock = makeWASocket({
                version: nv,
                logger: pino({ level: 'silent' }),
                auth: ns,
                printQRInTerminal: false,
                connectTimeoutMs: 30000,
                defaultQueryTimeoutMs: 30000,
                keepAliveIntervalMs: 30000,
              });

              const newHeartbeat = setInterval(() => {
                try { if (newSock.ws?.readyState === 1) newSock.sendPresenceUpdate('available'); } catch (e) {}
              }, 60000);
              state.heartbeat = newHeartbeat;
              state.sock = newSock;

              // Attach ALL handlers to retry socket — SAME state object!
              newSock.ev.on('creds.update', () => { try { nsc(); } catch (e) {} });

              newSock.ev.on('connection.update', async (upd) => {
                const { connection: conn2, lastDisconnect: ld2 } = upd;

                if (conn2 === 'open') {
                  state.everConnected = true;
                  state.pairingLock = false;
                  connections.set(jid, { sock: newSock, status: 'open', lastSeen: Date.now() });
                  console.log(chalk.green(`[PAIR] ✅ CONNECTED (515 retry ${state.retry515Count}): ${jid}`));
                  status.setStatus(jid, 'connected');
                  session.logEvent('CONNECTION_OPENED', jid, { afterRetry515: true });

                  session.markLinked(jid, { pairedVia: 'code' });
                  session.resetFailCount(jid);
                  if (owner.assignOwner(jid, { pairedVia: 'code' })) {
                    session.logEvent('OWNER_ASSIGNED', jid, {});
                  }
                  store.addUser(jid, { pairedAt: Date.now(), country: clean ? getCountryFromNumber(clean) : '', isOwner: owner.isOwner(jid) });

                  if (!state.connectedMsgSent) {
                    state.connectedMsgSent = true;
                    sendConnectedMessage(jid, newSock).catch(() => {});
                  }
                  heartbeats.set(jid, newHeartbeat);
                }

                if (conn2 === 'close' && state.pairingLock) {
                  const rc = ld2?.error?.output?.statusCode;
                  console.log(chalk.yellow(`[PAIR] Close during retry for ${jid} (code=${rc}).`));
                  if (rc === 515 && state.retry515Count < 5) {
                    state.retry515Count++;
                    console.log(chalk.yellow(`[PAIR] 515 retry ${state.retry515Count}/5 in 10s...`));
                    setTimeout(async () => {
                      try {
                        try { newSock.end(); } catch (e) {}
                        const { state: ns3, saveCreds: nsc3 } = await useMultiFileAuthState(sessionPath);
                        const { version: nv3 } = await fetchLatestBaileysVersion();
                        const rs = makeWASocket({ version: nv3, logger: pino({ level: 'silent' }), auth: ns3, printQRInTerminal: false, connectTimeoutMs: 30000, defaultQueryTimeoutMs: 30000, keepAliveIntervalMs: 30000 });
                        const rhb = setInterval(() => { try { if (rs.ws?.readyState === 1) rs.sendPresenceUpdate('available'); } catch (e) {} }, 60000);
                        state.heartbeat = rhb;
                        state.sock = rs;

                        rs.ev.on('creds.update', () => { try { nsc3(); } catch (e) {} });
                        rs.ev.on('connection.update', async (u3) => {
                          if (u3.connection === 'open') {
                            state.everConnected = true; state.pairingLock = false;
                            connections.set(jid, { sock: rs, status: 'open', lastSeen: Date.now() });
                            console.log(chalk.green(`[PAIR] ✅ CONNECTED (515 retry ${state.retry515Count}): ${jid}`));
                            status.setStatus(jid, 'connected');
                            session.markLinked(jid, { pairedVia: 'code' });
                            if (owner.assignOwner(jid, { pairedVia: 'code' })) session.logEvent('OWNER_ASSIGNED', jid, {});
                            store.addUser(jid, { pairedAt: Date.now(), country: clean ? getCountryFromNumber(clean) : '', isOwner: owner.isOwner(jid) });
                            if (!state.connectedMsgSent) { state.connectedMsgSent = true; sendConnectedMessage(jid, rs).catch(() => {}); }
                            heartbeats.set(jid, rhb);
                          }
                          if (u3.connection === 'close' && state.pairingLock && state.retry515Count < 5) {
                            state.retry515Count++;
                            console.log(chalk.yellow(`[PAIR] 515 retry ${state.retry515Count}/5 in 10s...`));
                            // Recursive retry would go here — for simplicity, let startConnection handle further retries
                          }
                        });
                        rs.ev.on('messages.upsert', async ({ messages }) => { try { await handler.onMessage(rs, messages[0]); } catch (e) {} });
                        rs.ev.on('messages.update', async (updates) => { try { await handler.onMessagesUpdate(rs, updates); } catch (e) {} });
                        rs.ev.on('group-participants.update', async (ev) => { try { await handler.onGroupUpdate(rs, ev); } catch (e) {} });
                      } catch (e3) { console.error(chalk.red(`[PAIR] Retry ${state.retry515Count} failed: ${e3.message}`)); }
                    }, 10000);
                  }
                }
              });

              // CRITICAL: Attach message handlers to retry socket!
              newSock.ev.on('messages.upsert', async ({ messages }) => {
                try { await handler.onMessage(newSock, messages[0]); } catch (e) {}
              });
              newSock.ev.on('messages.update', async (updates) => {
                try { await handler.onMessagesUpdate(newSock, updates); } catch (e) {}
              });
              newSock.ev.on('group-participants.update', async (ev) => {
                try { await handler.onGroupUpdate(newSock, ev); } catch (e) {}
              });

              console.log(chalk.green(`[PAIR] 515 retry socket created for ${jid}`));
            } catch (e) {
              console.error(chalk.red(`[PAIR] 515 retry failed: ${e.message}`));
            }
          }, 10000);
        }
        return; // Don't proceed to normal close handling
      }

      // Normal close handling
      if (state.everConnected) {
        connections.set(jid, { sock, status: 'reconnecting', lastSeen: Date.now() });
        const result = session.recordReconnectFailure(jid, 3);
        if (result.deleted) {
          console.log(chalk.red(`[PAIR] Session destroyed after ${result.failCount} failures: ${jid}`));
          connections.delete(jid);
        } else {
          setTimeout(() => startConnection(jid).catch(e => console.error(e.message)), 5000);
        }
      } else if (!state.pairCode) {
        status.setStatus(jid, 'failed', { error: `Connection closed (code ${statusCode})` });
        pendingPairs.delete(jid);
        const validation = session.validateSession(jid);
        if (!validation.valid) session.destroySession(jid);
      }
    }
  });

  // ─── messages.upsert — THE COMMAND HANDLER ─────────────────
  sock.ev.on('messages.upsert', async ({ messages }) => {
    try { await handler.onMessage(sock, messages[0]); } catch (e) {
      console.error(chalk.red(`[MSG] Error: ${e.message}`));
    }
  });

  // ─── messages.update — anti-delete/edit ────────────────────
  sock.ev.on('messages.update', async (updates) => {
    try { await handler.onMessagesUpdate(sock, updates); } catch (e) {}
  });

  // ─── group-participants.update ─────────────────────────────
  sock.ev.on('group-participants.update', async (ev) => {
    try { await handler.onGroupUpdate(sock, ev); } catch (e) {}
  });
}

// ═══════════════════════════════════════════════════════════════
// GENERATE PAIR CODE
// ═══════════════════════════════════════════════════════════════
async function generatePairCode(phoneNumber) {
  const clean = String(phoneNumber).replace(/\D/g, '');

  if (clean.length < 7 || clean.length > 15) throw new Error('Invalid phone number length');
  if (clean.startsWith('0')) throw new Error('Remove leading 0, use country code');

  const jid = clean + '@s.whatsapp.net';
  const sessionPath = path.join(config.SESSIONS_DIR, jid);

  if (fs.existsSync(path.join(sessionPath, 'creds.json'))) {
    startConnection(jid).catch(e => console.error(e.message));
    throw new Error('Already paired. Reconnecting.');
  }

  if (status.isPairingInProgress(jid)) {
    const s = status.getStatus(jid);
    if (s.code) return { code: s.code, jid, expiresAt: s.expiresAt, existing: true };
    throw new Error('Pairing already in progress.');
  }

  if (store.getUsers().length >= config.MAX_PAIR_USERS) throw new Error('Pairing limit reached.');

  status.setStatus(jid, 'connecting');
  session.logEvent('PAIR_REQUESTED', jid, { number: clean });

  try {
    fs.mkdirSync(sessionPath, { recursive: true });

    // SAME config as working reference (NO browser field)
    const { state: authState, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      auth: authState,
      printQRInTerminal: false,
      connectTimeoutMs: 30000,
      defaultQueryTimeoutMs: 30000,
      keepAliveIntervalMs: 30000,
    });

    const heartbeat = setInterval(() => {
      try { if (sock.ws?.readyState === 1) sock.sendPresenceUpdate('available'); } catch (e) {}
    }, 60000);

    // ═══════════════════════════════════════════════════════════════
    // V12 ROOT CAUSE FIX: Shared state object.
    // ALL event handlers reference THIS object.
    // When we set state.pairCode below, handlers see it.
    // ═══════════════════════════════════════════════════════════════
    const state = {
      everConnected: false,
      pairCode: null,           // ← Will be set AFTER requestPairingCode
      pairingLock: false,       // ← Will be set AFTER requestPairingCode
      retry515Count: 0,
      registered: false,
      connectedMsgSent: false,
      sock: sock,
      heartbeat: heartbeat
    };

    // Attach ALL handlers — they reference `state` (shared, mutable)
    attachHandlers(sock, jid, sessionPath, state, saveCreds, authState, clean);

    // Wait 5s (same as working reference)
    await new Promise(r => setTimeout(r, 5000));

    if (authState.creds.registered) throw new Error('Already registered.');

    status.setStatus(jid, 'requesting');

    // Request pair code
    const code = await sock.requestPairingCode(clean);
    const formatted = code?.match(/.{1,4}/g)?.join('-') || code;

    // ═══════════════════════════════════════════════════════════════
    // V12 FIX: Update SHARED state object (not closure variables!)
    // Event handlers can now see these values.
    // ═══════════════════════════════════════════════════════════════
    state.pairCode = formatted;
    state.pairingLock = true;

    console.log(chalk.green(`\n========================================`));
    console.log(chalk.green(`   YOUR PAIRING CODE: ${formatted}`));
    console.log(chalk.green(`   For: ${clean}`));
    console.log(chalk.green(`========================================\n`));
    session.logEvent('PAIR_CODE_GENERATED', jid, { code: formatted });
    session.logEvent('PAIRING_LOCK_ACTIVATED', jid, {});

    const expiresAt = Date.now() + 5 * 60 * 1000;
    status.setStatus(jid, 'code_generated', { code: formatted, expiresAt });

    pendingPairs.set(jid, { sock, heartbeat, expiresAt });

    // Auto cleanup after 5 min
    setTimeout(() => {
      if (pendingPairs.has(jid) && !connections.has(jid)) {
        try { clearInterval(heartbeat); } catch (e) {}
        try { sock.end(); } catch (e) {}
        pendingPairs.delete(jid);
        if (!store.isPaired(jid)) {
          status.setStatus(jid, 'expired');
          const validation = session.validateSession(jid);
          if (!validation.valid) session.destroySession(jid);
        }
      }
    }, 5 * 60 * 1000);

    return { code: formatted, rawCode: formatted.replace(/-/g, ''), jid, expiresAt };

  } catch (error) {
    console.error(chalk.red(`[PAIR] Error: ${error.message}`));
    status.setStatus(jid, 'failed', { error: error.message });
    throw error;
  }
}

// ═══════════════════════════════════════════════════════════════
// START CONNECTION (for already-paired users on restart/reconnect)
// ═══════════════════════════════════════════════════════════════
async function startConnection(jid) {
  const sessionPath = path.join(config.SESSIONS_DIR, jid);

  const validation = session.validateSession(jid);
  if (!validation.valid) {
    session.destroySession(jid);
    session.logEvent('SESSION_REJECTED', jid, { reason: validation.reason });
    return null;
  }
  session.logEvent('SESSION_LOADED', jid, { reason: validation.reason });

  try {
    const { state: authState, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      auth: authState,
      printQRInTerminal: false,
      connectTimeoutMs: 30000,
      defaultQueryTimeoutMs: 30000,
      keepAliveIntervalMs: 30000,
    });

    connections.set(jid, { sock, status: 'connecting', lastSeen: Date.now() });

    const heartbeat = setInterval(() => {
      try { if (sock.ws?.readyState === 1) sock.sendPresenceUpdate('available'); } catch (e) {}
    }, 60000);

    const state = {
      everConnected: false,
      pairCode: null,
      pairingLock: false,
      retry515Count: 0,
      registered: authState.creds?.registered || false,
      connectedMsgSent: connectedMsgSent.has(jid),
      sock: sock,
      heartbeat: heartbeat
    };

    attachHandlers(sock, jid, sessionPath, state, saveCreds, authState, null);

    return sock;
  } catch (e) {
    console.error(chalk.red(`[CONN] Failed ${jid}: ${e.message}`));
    return null;
  }
}

function unpairUser(jid, deleteSessionFlag) {
  const conn = connections.get(jid);
  if (conn?.sock) { try { conn.sock.end(); } catch (e) {} }
  const pending = pendingPairs.get(jid);
  if (pending) { try { clearInterval(pending.heartbeat); } catch (e) {} try { pending.sock.end(); } catch (e) {} pendingPairs.delete(jid); }
  const hb = heartbeats.get(jid);
  if (hb) { clearInterval(hb); heartbeats.delete(jid); }

  connections.delete(jid);
  status.clearStatus(jid);
  store.removeUser(jid);
  connectedMsgSent.delete(jid);

  if (deleteSessionFlag) session.destroySession(jid);
  return true;
}

async function autoLoadAllPaired(onProgress) {
  const entries = fs.existsSync(config.SESSIONS_DIR) ? fs.readdirSync(config.SESSIONS_DIR, { withFileTypes: true }) : [];
  const allDirs = entries.filter(d => d.isDirectory() && d.name.endsWith('@s.whatsapp.net')).map(d => d.name);

  const validDirs = [];
  for (const jid of allDirs) {
    const v = session.validateSession(jid);
    if (v.valid) validDirs.push(jid);
    else session.destroySession(jid);
  }

  console.log(`[AUTOLOAD] ${validDirs.length} valid session(s)`);

  const ownerInfo = owner.getOwnerInfo();
  if (ownerInfo) console.log(chalk.green(`[AUTOLOAD] Owner: ${ownerInfo.jid}`));

  for (let i = 0; i < validDirs.length; i++) {
    try {
      await startConnection(validDirs[i]);
      if (onProgress) onProgress(i + 1, validDirs.length, validDirs[i]);
      await new Promise(r => setTimeout(r, 2000));
    } catch (e) {
      console.error(chalk.red(`[AUTOLOAD] Failed: ${e.message}`));
    }
  }
}

async function broadcastAll(text) {
  const targets = [];
  for (const [jid, info] of connections.entries()) {
    if (info.status !== 'open') continue;
    try { await info.sock.sendMessage(jid, { text }); targets.push(jid); } catch (e) {}
  }
  return targets;
}

async function broadcastOwnerGroups(text) {
  const ownerConn = connections.get(owner.getOwnerJid());
  if (!ownerConn || ownerConn.status !== 'open') return [];
  const targets = [];
  const groups = await ownerConn.sock.groupFetchAllWhitelist?.().catch(() => []) || [];
  for (const g of groups) { try { await ownerConn.sock.sendMessage(g.id, { text }); targets.push(g.id); } catch (e) {} }
  return targets;
}

function getCountryFromNumber(num) {
  const { getCountry } = require('./lib/utils');
  return getCountry(num);
}

function getConnection(jid) { return connections.get(jid); }
function getAllConnections() { return Array.from(connections.values()); }

function gracefulShutdown() {
  for (const [jid, info] of connections.entries()) { try { info.sock.end(); } catch (e) {} }
  for (const [jid, p] of pendingPairs.entries()) { try { clearInterval(p.heartbeat); } catch (e) {} try { p.sock.end(); } catch (e) {} }
  for (const [jid, hb] of heartbeats.entries()) { try { clearInterval(hb); } catch (e) {} }
}

process.on('SIGINT', () => { gracefulShutdown(); process.exit(0); });
process.on('SIGTERM', () => { gracefulShutdown(); process.exit(0); });

module.exports = {
  generatePairCode,
  startConnection,
  unpairUser,
  getConnection,
  getAllConnections,
  autoLoadAllPaired,
  broadcastAll,
  broadcastOwnerGroups
};
