/** Ulric-X MD - Anti-Delete + Anti-Edit System */
const config = require('../config');
const messageStore = require('./messageStore');
const verified = require('./verifiedReply');

const antiSettings = new Map();
const processedIds = new Set();
const MAX_PROCESSED = 500;

function getSettings(jid) { return antiSettings.get(jid) || { delete: 'off', edit: 'off' }; }
function setDeleteMode(jid, mode) { const s = getSettings(jid); s.delete = mode; antiSettings.set(jid, s); return s; }
function setEditMode(jid, mode) { const s = getSettings(jid); s.edit = mode; antiSettings.set(jid, s); return s; }
function setModeAll(jid, mode) { const s = { delete: mode, edit: mode }; antiSettings.set(jid, s); return s; }
function markProcessed(id) { processedIds.add(id); if (processedIds.size > MAX_PROCESSED) { const a = [...processedIds]; processedIds.clear(); a.slice(-MAX_PROCESSED/2).forEach(x => processedIds.add(x)); } }
function isProcessed(id) { return processedIds.has(id); }
function getStatus(jid) { return getSettings(jid); }

async function handleMessagesUpdate(sock, updates) {
  for (const update of updates) {
    try {
      if (update.key?.id && isProcessed(update.key.id)) continue;
      const jid = update.key?.remoteJid;
      if (!jid) continue;
      if (update.message?.protocolMessage?.type === 0) await handleDelete(sock, update, jid);
      else if (update.message?.protocolMessage?.type === 15) await handleEdit(sock, update, jid);
    } catch (e) { console.error('[ANTI] Error:', e.message); }
  }
}

async function handleDelete(sock, update, jid) {
  const settings = getSettings(jid);
  if (settings.delete === 'off') return;
  const deletedMsgId = update.message.protocolMessage.key?.id;
  const targetJid = update.message.protocolMessage.key?.remoteJid || jid;
  if (!deletedMsgId) return;
  markProcessed(deletedMsgId);
  const original = messageStore.getMessage(targetJid, deletedMsgId);
  if (!original) return;
  const sender = original.sender || update.key.participant || jid;
  const senderNum = sender.split('@')[0];
  const notice = `🛡️ *ANTI-DELETE*\n\n👤 Sender: @${senderNum}\n🗑️ Deleted at: ${new Date().toLocaleString()}\n💬 Original:`;
  const targetChat = settings.delete === 'pm' ? config.BOT_OWNER_JID : jid;
  try { await verified.sendVerified(sock, targetChat, { text: notice, mentions: [sender] }); } catch (e) {}
  await resendMessage(sock, targetChat, original.message);
}

async function handleEdit(sock, update, jid) {
  const settings = getSettings(jid);
  if (settings.edit === 'off') return;
  const editedMsgId = update.message.protocolMessage.key?.id;
  const targetJid = update.message.protocolMessage.key?.remoteJid || jid;
  if (!editedMsgId) return;
  markProcessed(editedMsgId + '-edit');
  const original = messageStore.getMessage(targetJid, editedMsgId);
  if (!original) return;
  const sender = original.sender || update.key.participant || jid;
  const senderNum = sender.split('@')[0];
  const notice = `📝 *ANTI-EDIT*\n\n👤 Sender: @${senderNum}\n✏️ Edited at: ${new Date().toLocaleString()}\n💬 Original:`;
  const targetChat = settings.edit === 'pm' ? config.BOT_OWNER_JID : jid;
  try { await verified.sendVerified(sock, targetChat, { text: notice, mentions: [sender] }); } catch (e) {}
  await resendMessage(sock, targetChat, original.message);
}

async function resendMessage(sock, jid, message) {
  if (!message) { try { await verified.sendVerified(sock, jid, { text: '_(empty)_' }); } catch {} return; }
  try {
    if (message.conversation) { await verified.sendVerified(sock, jid, { text: message.conversation }); return; }
    if (message.extendedTextMessage?.text) { await verified.sendVerified(sock, jid, { text: message.extendedTextMessage.text }); return; }
    if (message.imageMessage) { const b = await downloadMedia(sock, message, 'image'); if (b) await sock.sendMessage(jid, { image: b, caption: message.imageMessage.caption || '', contextInfo: verified.verifiedContext() }); return; }
    if (message.videoMessage) { const b = await downloadMedia(sock, message, 'video'); if (b) await sock.sendMessage(jid, { video: b, caption: message.videoMessage.caption || '', contextInfo: verified.verifiedContext() }); return; }
    if (message.audioMessage) { const b = await downloadMedia(sock, message, 'audio'); if (b) await sock.sendMessage(jid, { audio: b, mimetype: message.audioMessage.mimetype || 'audio/mpeg', contextInfo: verified.verifiedContext() }); return; }
    if (message.stickerMessage) { const b = await downloadMedia(sock, message, 'sticker'); if (b) await sock.sendMessage(jid, { sticker: b, contextInfo: verified.verifiedContext() }); return; }
    if (message.documentMessage) { const b = await downloadMedia(sock, message, 'document'); if (b) await sock.sendMessage(jid, { document: b, fileName: message.documentMessage.fileName || 'doc', contextInfo: verified.verifiedContext() }); return; }
    await verified.sendVerified(sock, jid, { text: '_(unsupported type)_' });
  } catch (e) { console.error('[ANTI] Resend failed:', e.message); }
}

async function downloadMedia(sock, message, type) {
  try {
    const baileys = require('@whiskeysockets/baileys');
    const { downloadContentFromMessage } = baileys;
    const m = message[type + 'Message'];
    if (!m) return null;
    const stream = await downloadContentFromMessage(m, type);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
  } catch (e) { return null; }
}

module.exports = { handleMessagesUpdate, setDeleteMode, setEditMode, setModeAll, getSettings, getStatus };
