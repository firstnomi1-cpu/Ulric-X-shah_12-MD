/**
 * Ulric-X MD - Main Message Handler / Command Dispatcher
 *
 * FIXES in V11:
 * 1. Message unwrapping (ephemeralMessage, viewOnceMessage, etc.)
 *    — This was the #1 cause of "commands not executing"
 * 2. Connected SMS fires on connection.open (not just registered=true)
 *    — With retry logic (attempt 1 → 3s → attempt 2 → 5s)
 * 3. All event listeners properly attached to retry sockets
 * 4. Clean logging (only ERROR, WARN, CONNECTED, PAIR, SESSION, COMMAND_FAIL)
 */
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const config = require('./config');
const store  = require('./lib/store');
const utils  = require('./lib/utils');
const menu   = require('./lib/menu');
const ownerMod = require('./lib/owner');
const session = require('./lib/session');
const messageStore = require('./lib/messageStore');
const antiSystem = require('./lib/antiSystem');
const verified = require('./lib/verifiedReply');
const watchdog = require('./lib/watchdog');
const normalizer = require('./lib/normalizer');

// ─── Command Registry ────────────────────────────────────────────
const commands = new Map();
const categories = new Map();
let totalCount = 0;

function loadCommands() {
  const dir = path.join(__dirname, 'commands');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
  let total = 0;
  for (const f of files) {
    try {
      delete require.cache[path.join(dir, f)];
      const mod = require(path.join(dir, f));
      if (!Array.isArray(mod)) continue;
      for (const cmd of mod) {
        if (!cmd || !cmd.name || typeof cmd.handler !== 'function') continue;
        const safeFn = watchdog.safeHandler(cmd.handler);
        const safeCmd = { ...cmd, handler: safeFn };
        const names = [cmd.name, ...(cmd.alias || [])].map(s => String(s).toLowerCase());
        for (const n of names) {
          if (!commands.has(n)) commands.set(n, safeCmd);
        }
        const cat = cmd.category || 'misc';
        if (!categories.has(cat)) categories.set(cat, []);
        categories.get(cat).push(safeCmd);
        total++;
      }
    } catch (e) {
      console.error(chalk.red(`[CMD LOAD] Failed ${f}: ${e.message}`));
    }
  }
  totalCount = total;
  console.log(`[CMD] Loaded ${total} commands across ${categories.size} categories.`);
  return { total, categories: categories.size };
}

function getCommandsByCategory(cat) { return categories.get(cat) || []; }
function getCommand(name) { return commands.get(name.toLowerCase()); }
function getTotalCommands() { return totalCount; }
function getAllCategories() { return Array.from(categories.keys()); }

// ─── Build Context ───────────────────────────────────────────────
async function buildContext(sock, m) {
  if (!m || !m.message || !m.key) return null;

  const jid = m.key.remoteJid;
  if (!jid) return null;

  const sender = m.key.participant || m.key.remoteJid || '';
  const senderNumber = sender.split('@')[0].split(':')[0];
  const isGroup = jid.endsWith('@g.us');
  const isBot = !!m.key.fromMe;

  // Group metadata
  let groupMetadata = null, groupAdmins = [];
  if (isGroup) {
    try {
      groupMetadata = await sock.groupMetadata(jid);
      groupAdmins = utils.getGroupAdmins(groupMetadata.participants);
    } catch {}
  }

  // Owner check
  const isOwner = ownerMod.isOwner(sender) || (sender === config.BOT_OWNER_JID) || (senderNumber === config.BOT_OWNER_NUM);
  const isAdmin = isOwner || store.isAdmin(sender);
  const isPremiumUser = store.isPremium(sender);
  const isBotAdmin = isGroup && groupAdmins.some(a => a === sock.user?.id || a.includes(sock.user?.id?.split(':')[0]));
  const isBanned = store.isBanned(sender);

  const pushname = m.pushName || senderNumber;

  // ═══════════════════════════════════════════════════════════════
  // CRITICAL FIX: Use normalizer to unwrap ALL message wrappers.
  // ephemeralMessage, viewOnceMessage, editedMessage, etc.
  // Without this, commands from private chats are NEVER detected.
  // ═══════════════════════════════════════════════════════════════
  const body = normalizer.extractBody(m.message) || '';

  // Detect prefix
  const prefixMatch = body.match(/^([.!#,?~`*-])/);
  const prefix = prefixMatch ? prefixMatch[1] : config.BOT_PREFIX;
  const isCmd = body.startsWith(prefix) && body.length > prefix.length;

  let command = '', args = [], text = '', q = '';
  if (isCmd) {
    const withoutPrefix = body.slice(prefix.length).trim();
    const parts = withoutPrefix.split(/\s+/).filter(Boolean);
    command = (parts[0] || '').toLowerCase();
    args = parts.slice(1);
    text = args.join(' ');
  }

  // Quoted message
  let quoted = null;
  try {
    const baileys = require('@whiskeysockets/baileys');
    const realType = normalizer.getRealContentType(m.message);
    if (realType && m.message[realType]?.contextInfo?.quotedMessage) {
      const qMsg = m.message[realType].contextInfo.quotedMessage;
      quoted = {
        text: normalizer.extractBody(qMsg) || '',
        type: normalizer.getRealContentType(qMsg),
        sender: m.message[realType].contextInfo.participant || '',
        key: {
          remoteJid: jid,
          fromMe: (m.message[realType].contextInfo.participant === sock.user?.id),
          id: m.message[realType].contextInfo.stanzaId || ''
        }
      };
    }
  } catch {}
  if (!quoted) q = text;
  else q = quoted.text || text;

  // ─── Reply helpers (VERIFIED WhatsApp badge) ─────────────────
  const reply = async (txt, opts = {}) => {
    if (typeof txt !== 'string') txt = String(txt ?? '');
    return verified.sendVerified(sock, jid, {
      text: txt,
      mentions: utils.parseMention(txt),
      ...opts
    }, { quoted: m });
  };
  const replyImg = async (url, caption = '', opts = {}) => verified.sendVerified(sock, jid, {
    image: { url }, caption, ...opts
  }, { quoted: m });
  const replyAudio = async (url, opts = {}) => verified.sendVerified(sock, jid, {
    audio: { url }, mimetype: 'audio/mpeg', ...opts
  }, { quoted: m });
  const replySticker = async (buffer, opts = {}) => sock.sendMessage(jid, {
    sticker: buffer, ...opts
  }, { quoted: m });
  const react = async (emoji) => {
    try { await sock.sendMessage(jid, { react: { text: emoji || '✅', key: m.key } }); } catch {}
  };

  const downloadQuoted = async () => {
    if (!quoted) return null;
    try {
      return await utils.downloadMediaMessage({ message: { [quoted.type]: { ...quoted } } }, sock);
    } catch { return null; }
  };
  const downloadMsg = async () => {
    try { return await utils.downloadMediaMessage(m, sock); } catch { return null; }
  };

  return {
    sock, m, jid, from: jid, sender, senderNumber, isGroup, isBot, isOwner,
    isAdmin, isPremium: isPremiumUser, isBotAdmin, isBanned,
    reply, replyImg, replyAudio, replySticker, react,
    args, q, text, command, prefix, body, quoted, pushname,
    downloadQuoted, downloadMsg, groupMetadata, groupAdmins,
    store, lib: utils, menu, config,
    antiSystem, messageStore, verified
  };
}

// ─── Message Upsert Handler ──────────────────────────────────────
async function onMessage(sock, m) {
  if (!m || !m.message) return;

  try {
    watchdog.trackMessage();

    // Store message for anti-delete/edit recovery
    try { messageStore.storeMessage(m.key.remoteJid, m.key, m.message); } catch {}

    const ctx = await buildContext(sock, m).catch(e => {
      console.error(chalk.red(`[HANDLER] Context build failed: ${e.message}`));
      return null;
    });
    if (!ctx) return;

    // Auto-read & presence
    try {
      if (config.AUTO_READ) await sock.sendReadReceipt(ctx.jid, ctx.sender, [m.key]);
      if (config.AUTO_PRESENCE) await sock.sendPresenceUpdate(config.AUTO_PRESENCE, ctx.jid);
    } catch {}

    // Auto-status view
    if (m.key.remoteJid === 'status@broadcast') {
      if (config.AUTO_VIEW_STATUS) {
        try { await sock.readMessages([m.key]); } catch {}
      }
      return;
    }

    const { isCmd, command, isBanned } = ctx;

    // Ban check
    if (isBanned && isCmd) {
      return ctx.reply('╭━━❖ ❌ 𝐁𝐀𝐍𝐍𝐄𝐃 ❖━┈⊷\n┃\n┃ You are banned from using this bot.\n┃ Contact owner to appeal.\n╰━━━━━━━━━━━━━━━┈⊷');
    }

    if (!isCmd) return;

    // Increment command count
    try {
      const sockUserJid = sock.user?.id?.split(':')[0] + '@s.whatsapp.net';
      store.incCommandCount(sockUserJid);
    } catch {}

    // Dispatch
    const cmd = getCommand(command);
    if (!cmd) return;  // Unknown command → silent ignore

    // Owner-only check
    if (cmd.category === 'owner' && !ctx.isOwner) {
      return ctx.reply('❌ Owner only command');
    }

    await cmd.handler(ctx);
  } catch (e) {
    console.error(chalk.red(`[COMMAND_FAIL] ${e.message}`));
    try {
      await sock.sendMessage(m.key?.remoteJid, { text: '⚠️ System busy, retry...' });
    } catch {}
  }
}

// ─── Messages Update Handler (Anti-Delete + Anti-Edit) ──────────
async function onMessagesUpdate(sock, updates) {
  try {
    await antiSystem.handleMessagesUpdate(sock, updates);
  } catch (e) {
    console.error(chalk.red(`[ANTI] Error: ${e.message}`));
  }
}

// ─── Group Join/Leave ────────────────────────────────────────────
async function onGroupUpdate(sock, ev) {
  // Welcome/goodbye could be implemented here
}

module.exports = {
  loadCommands, getCommandsByCategory, getCommand, getTotalCommands, getAllCategories,
  buildContext, onMessage, onGroupUpdate, onMessagesUpdate
};
