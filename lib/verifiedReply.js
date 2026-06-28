/** Ulric-X MD - Verified WhatsApp-Style Reply (blue checkmark) */
const config = require('../config');
const WHATSAPP_NEWSLETTER_JID = config.BOT_CHANNEL_JID || '120363404551577200@newsletter';

function verifiedContext(extra = {}) {
  return {
    forwardingScore: 999,
    isForwarded: true,
    forwardedNewsletterMessageInfo: {
      newsletterJid: WHATSAPP_NEWSLETTER_JID,
      newsletterName: 'WhatsApp',
      serverMessageId: -1,
      ...extra
    },
    externalAdReply: {
      title: 'Ulric-X MD',
      body: 'Verified WhatsApp Bot',
      thumbnailUrl: config.BOT_LOGO,
      sourceUrl: config.BOT_CHANNEL_URL || 'https://whatsapp.com',
      mediaType: 1,
      renderLargerThumbnail: false,
      showAdAttribution: false
    }
  };
}

async function sendVerified(sock, jid, messageContent, opts = {}) {
  const finalMessage = { ...messageContent };
  finalMessage.contextInfo = { ...(messageContent.contextInfo || {}), ...verifiedContext() };
  return sock.sendMessage(jid, finalMessage, opts);
}

function makeVerifiedReply(sock, jid, m) {
  return async (txt, opts = {}) => {
    if (typeof txt !== 'string') txt = String(txt ?? '');
    return sendVerified(sock, jid, { text: txt, mentions: (txt.match(/@\d{5,16}/g) || []).map(s => s.slice(1) + '@s.whatsapp.net') }, { quoted: m, ...opts });
  };
}

module.exports = { verifiedContext, sendVerified, makeVerifiedReply, WHATSAPP_NEWSLETTER_JID };
