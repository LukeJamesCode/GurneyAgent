// Slash-commands the user can hit directly. Convenience wrappers over the
// same client the LLM tools use; no LLM round-trip when the user just wants
// to peek at memory.

import type { Host } from '../../src/core/extensions.js';
import { formatFactLine, getClient } from './helpers.js';

export function register(host: Host): void {
  host.telegram.command(
    'memory',
    async (ctx) => {
      const c = getClient(host);
      if (!c) {
        await ctx.reply(
          'Memory bridge is not configured. Set bridge_url via `gurney config gurney-memgraph`.',
        );
        return;
      }
      const query = ctx.args.trim();
      if (!query) {
        await ctx.reply('Usage: /memory <query>');
        return;
      }
      const topK = Number(host.settings.get<number>('recall_top_k', 5));
      try {
        const facts = await c.recall(query, topK);
        if (facts.length === 0) {
          await ctx.reply('No matching memories.');
          return;
        }
        await ctx.reply(facts.map(formatFactLine).join('\n'));
      } catch (e) {
        await ctx.reply(`Recall failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    'Search long-term memory',
  );

  host.telegram.command(
    'remember',
    async (ctx) => {
      const c = getClient(host);
      if (!c) {
        await ctx.reply('Memory bridge is not configured.');
        return;
      }
      const text = ctx.args.trim();
      if (!text) {
        await ctx.reply('Usage: /remember <text>');
        return;
      }
      try {
        await c.store('slash_remember', [{ text, created_at: Date.now(), role: 'user' }]);
        await ctx.reply('Stored.');
      } catch (e) {
        await ctx.reply(`Store failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    'Store a fact: /remember <text>',
  );

  host.telegram.command(
    'forget',
    async (ctx) => {
      const c = getClient(host);
      if (!c) {
        await ctx.reply('Memory bridge is not configured.');
        return;
      }
      try {
        await c.forget();
        // Wipe sync bookkeeping so the next sweep re-extracts from scratch.
        host.db.prepare(`DELETE FROM memgraph_sync_state`).run();
        await ctx.reply('Long-term memory wiped.');
      } catch (e) {
        await ctx.reply(`Forget failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    'Wipe long-term memory',
  );
}
