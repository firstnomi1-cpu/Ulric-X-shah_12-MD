/** Ulric-X MD - Anti-System Commands */
const antiSystem = require('../lib/antiSystem');

module.exports = [
  {
    name: 'anti', alias: ['antisystem'], category: 'owner', desc: 'Anti-delete + anti-edit control',
    handler: async (ctx) => {
      if (!ctx.isOwner && !ctx.isAdmin) return ctx.reply('❌ Admin only');
      const sub = (ctx.args[0] || '').toLowerCase();
      const mode = (ctx.args[1] || '').toLowerCase();
      const target = (ctx.args[2] || '').toLowerCase();

      if (sub === 'mode') {
        if (mode === 'on') {
          antiSystem.setModeAll(ctx.jid, 'public');
          return ctx.reply(`╭━━❖ 🛡️ 𝐀𝐍𝐓𝐈 𝐒𝐘𝐒𝐓𝐄𝐌 ❖━┈⊷\n┃\n┃ ✅ ALL anti features ENABLED\n┃ • Anti-delete: PUBLIC\n┃ • Anti-edit: PUBLIC\n╰━━━━━━━━━━━━━━━┈⊷`);
        } else if (mode === 'off') {
          antiSystem.setModeAll(ctx.jid, 'off');
          return ctx.reply(`╭━━❖ 🛡️ 𝐀𝐍𝐓𝐈 𝐒𝐘𝐒𝐓𝐄𝐌 ❖━┈⊷\n┃\n┃ ❌ ALL anti features DISABLED\n╰━━━━━━━━━━━━━━━┈⊷`);
        }
      }
      if (sub === 'delete') {
        if (mode === 'on' && (target === 'pm' || target === 'public')) {
          antiSystem.setDeleteMode(ctx.jid, target);
          return ctx.reply(`✅ Anti-delete: ON (${target.toUpperCase()})`);
        } else if (mode === 'off') { antiSystem.setDeleteMode(ctx.jid, 'off'); return ctx.reply('❌ Anti-delete: OFF'); }
      }
      if (sub === 'edit') {
        if (mode === 'on' && (target === 'pm' || target === 'public')) {
          antiSystem.setEditMode(ctx.jid, target);
          return ctx.reply(`✅ Anti-edit: ON (${target.toUpperCase()})`);
        } else if (mode === 'off') { antiSystem.setEditMode(ctx.jid, 'off'); return ctx.reply('❌ Anti-edit: OFF'); }
      }
      if (sub === 'status' || sub === 'info') {
        const s = antiSystem.getStatus(ctx.jid);
        return ctx.reply(`╭━━❖ 🛡️ 𝐀𝐍𝐓𝐈 𝐒𝐓𝐀𝐓𝐔𝐒 ❖━┈⊷\n┃\n┃ • Anti-delete: ${s.delete.toUpperCase()}\n┃ • Anti-edit: ${s.edit.toUpperCase()}\n╰━━━━━━━━━━━━━━━┈⊷`);
      }
      return ctx.reply(`╭━━❖ 🛡️ 𝐀𝐍𝐓𝐈 𝐒𝐘𝐒𝐓𝐄𝐌 ❖━┈⊷\n┃\n┃ • .anti mode on/off\n┃ • .anti delete on pm/public\n┃ • .anti delete off\n┃ • .anti edit on pm/public\n┃ • .anti edit off\n┃ • .anti status\n╰━━━━━━━━━━━━━━━┈⊷`);
    }
  }
];
