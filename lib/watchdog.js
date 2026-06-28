/** Ulric-X MD - Watchdog / Stability Monitor */
const config = require('../config');
let lastMessageAt = Date.now();
let commandsProcessed = 0;
let errorsCount = 0;
let startTime = Date.now();

function trackMessage() { lastMessageAt = Date.now(); }
function trackCommand() { commandsProcessed++; }
function trackError() { errorsCount++; }
function getStats() {
  return { uptime: Date.now() - startTime, commandsProcessed, errorsCount, lastMessageAgo: Date.now() - lastMessageAt, memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024) };
}

function safeHandler(handler) {
  return async (ctx) => {
    try {
      const timeoutPromise = new Promise((_, reject) => { setTimeout(() => reject(new Error('Command timeout (30s)')), 30000); });
      await Promise.race([handler(ctx), timeoutPromise]);
    } catch (e) {
      trackError();
      console.error(`[COMMAND_FAIL] ${ctx.command}: ${e.message}`);
      try { await ctx.reply(`⚠️ System busy, retry...\n\nError: ${e.message.slice(0, 100)}`); } catch {}
    }
  };
}

function checkMemory() {
  const mem = process.memoryUsage();
  const rssMB = mem.rss / 1024 / 1024;
  if (rssMB > 400 && global.gc) { global.gc(); }
  return rssMB;
}

function startWatchdog(pairMgr) {
  setInterval(() => {
    try {
      const stats = getStats();
      checkMemory();
      const conns = pairMgr.getAllConnections();
      const activeConns = conns.filter(c => c.status === 'open');
      if (stats.lastMessageAgo > 10 * 60 * 1000 && activeConns.length === 0 && conns.length > 0) {
        for (const conn of conns) {
          try { require('../pair').startConnection(conn.jid).catch(() => {}); } catch {}
        }
      }
    } catch (e) {}
  }, 5 * 60 * 1000);
}

module.exports = { trackMessage, trackCommand, trackError, getStats, safeHandler, checkMemory, startWatchdog };
