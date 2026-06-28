/**
 * Ulric-X MD - Dynamic Owner Assignment
 *
 * Rule: Whoever pairs FIRST becomes the owner.
 * - Owner number is stored in database/owner.json
 * - On restart, owner is loaded from this file
 * - Owner is persistent — never changes unless file is deleted
 * - Owner has full admin access (commands, broadcast, etc.)
 *
 * If no one has paired yet, the config.BOT_OWNER_NUM is used as
 * a "fallback owner" (for the bot creator to test).
 */
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const config = require('../config');
const { ensureDir, readJSON, writeJSON } = require('./utils');

const DB_DIR = config.DB_DIR;
ensureDir(DB_DIR);

const OWNER_FILE = path.join(DB_DIR, 'owner.json');

/**
 * Get current owner JID.
 * Returns:
 *   - Stored owner (if any)
 *   - Fallback to config.BOT_OWNER_JID if no one has paired yet
 */
function getOwnerJid() {
  const stored = readJSON(OWNER_FILE, null);
  if (stored && stored.jid) {
    return stored.jid;
  }
  return config.BOT_OWNER_JID;  // fallback (configured owner)
}

/**
 * Get current owner number (without @s.whatsapp.net).
 */
function getOwnerNumber() {
  return getOwnerJid().split('@')[0];
}

/**
 * Check if a JID is the owner.
 */
function isOwner(jid) {
  return jid === getOwnerJid();
}

/**
 * Assign owner (only first user to pair becomes owner).
 * Returns true if assigned, false if owner already exists.
 */
function assignOwner(jid, extra = {}) {
  const existing = readJSON(OWNER_FILE, null);

  if (existing && existing.jid) {
    // Owner already assigned — don't overwrite
    console.log(chalk.blue(`[OWNER] Already assigned to ${existing.jid} (since ${existing.assignedAtISO})`));
    return false;
  }

  const owner = {
    jid,
    number: jid.split('@')[0],
    assignedAt: Date.now(),
    assignedAtISO: new Date().toISOString(),
    ...extra
  };

  writeJSON(OWNER_FILE, owner);
  console.log(chalk.green(`[OWNER] 👑 Owner assigned: ${jid}`));
  console.log(chalk.green(`[OWNER]    Number: ${owner.number}`));
  console.log(chalk.green(`[OWNER]    At: ${owner.assignedAtISO}`));
  return true;
}

/**
 * Get owner info (for dashboard).
 */
function getOwnerInfo() {
  return readJSON(OWNER_FILE, null);
}

/**
 * Clear owner (admin only — used for debugging/testing).
 */
function clearOwner() {
  try {
    if (fs.existsSync(OWNER_FILE)) {
      fs.unlinkSync(OWNER_FILE);
      console.log(chalk.yellow('[OWNER] Owner cleared'));
    }
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = {
  getOwnerJid,
  getOwnerNumber,
  isOwner,
  assignOwner,
  getOwnerInfo,
  clearOwner
};
