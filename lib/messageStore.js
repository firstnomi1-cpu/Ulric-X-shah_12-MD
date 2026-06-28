/** Ulric-X MD - Message Store (for anti-delete/edit) */
const store = new Map();
const MAX_PER_CHAT = 100;

function storeMessage(jid, key, message) {
  if (!store.has(jid)) store.set(jid, new Map());
  const chat = store.get(jid);
  chat.set(key.id, { key, message, timestamp: Date.now(), sender: key.participant || key.remoteJid });
  if (chat.size > MAX_PER_CHAT) {
    const oldest = [...chat.entries()][0];
    chat.delete(oldest[0]);
  }
}

function getMessage(jid, msgId) { return store.get(jid)?.get(msgId) || null; }
function extractText(message) {
  if (!message) return '';
  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
  if (message.imageMessage?.caption) return message.imageMessage.caption;
  if (message.videoMessage?.caption) return message.videoMessage.caption;
  return '';
}
function clearChat(jid) { store.delete(jid); }
function getStats() { let t=0; for (const [,c] of store) t+=c.size; return { chats: store.size, totalMessages: t }; }

module.exports = { storeMessage, getMessage, clearChat, getStats, extractText };
