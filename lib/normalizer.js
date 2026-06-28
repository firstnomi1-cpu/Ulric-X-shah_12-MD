/**
 * Ulric-X MD - Message Normalizer
 *
 * Unwraps ALL WhatsApp message wrappers and extracts body text.
 * This is the core fix for "commands not executing" — modern WhatsApp
 * wraps messages in ephemeralMessage, viewOnceMessage, etc.
 * Without unwrapping, getContentType returns the wrapper type
 * and body extraction fails silently.
 */
const baileys = require('@whiskeysockets/baileys');

/**
 * Unwrap nested message wrappers to get the actual content.
 * Handles: ephemeralMessage, viewOnceMessage, viewOnceMessageV2,
 * documentWithCaptionMessage, editedMessage, etc.
 */
function unwrapMessage(message) {
  if (!message) return null;

  // Try Baileys' built-in normalizer first (most reliable)
  try {
    if (baileys.normalizeMessageContent) {
      return baileys.normalizeMessageContent(message);
    }
  } catch {}

  // Manual unwrap fallback
  let msg = message;
  const wrappers = [
    'ephemeralMessage',
    'viewOnceMessage',
    'viewOnceMessageV2',
    'documentWithCaptionMessage',
    'editedMessage',
    'buttonsMessage',
    'templateMessage',
    'interactiveMessage'
  ];

  for (const wrapper of wrappers) {
    if (msg[wrapper]?.message) {
      msg = msg[wrapper].message;
    }
  }

  return msg;
}

/**
 * Extract body text from any message type.
 * Returns the text content (conversation, caption, button response, etc.)
 */
function extractBody(message) {
  if (!message) return '';

  // Unwrap first
  const unwrapped = unwrapMessage(message);
  if (!unwrapped) return '';

  const type = Object.keys(unwrapped)[0];
  if (!type) return '';

  const content = unwrapped[type];

  // Text-based messages
  if (type === 'conversation') return content || '';
  if (type === 'extendedTextMessage') return content?.text || '';
  if (type === 'imageMessage') return content?.caption || '';
  if (type === 'videoMessage') return content?.caption || '';

  // Response messages (buttons, lists)
  if (type === 'buttonsResponseMessage') return content?.selectedButtonId || '';
  if (type === 'listResponseMessage') return content?.singleSelectReply?.selectedRowId || '';
  if (type === 'templateButtonReplyMessage') return content?.selectedId || '';
  if (type === 'interactiveResponseMessage') {
    try {
      const parsed = JSON.parse(content?.nativeFlowResponseMessage?.nameJson || '{}');
      return parsed.name || '';
    } catch {
      return '';
    }
  }

  // Document with caption
  if (type === 'documentMessage') return content?.caption || '';
  if (type === 'documentWithCaptionMessage') {
    return content?.message?.documentMessage?.caption || '';
  }

  // Audio/voice (no text, but don't crash)
  if (type === 'audioMessage' || type === 'stickerMessage' || type === 'ptvMessage') return '';

  // Contact
  if (type === 'contactMessage') return content?.displayName || '';

  // Location
  if (type === 'locationMessage') return content?.name || content?.address || '';

  // Fallback: try common fields
  if (content?.text) return content.text;
  if (content?.caption) return content.caption;
  if (content?.conversation) return content.conversation;

  return '';
}

/**
 * Get the real content type (after unwrapping).
 */
function getRealContentType(message) {
  const unwrapped = unwrapMessage(message);
  if (!unwrapped) return null;
  return Object.keys(unwrapped)[0] || null;
}

/**
 * Get the actual message content object (after unwrapping).
 */
function getRealContent(message) {
  const unwrapped = unwrapMessage(message);
  if (!unwrapped) return null;
  const type = Object.keys(unwrapped)[0];
  return unwrapped[type];
}

module.exports = {
  unwrapMessage,
  extractBody,
  getRealContentType,
  getRealContent
};
