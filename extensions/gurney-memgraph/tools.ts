// LLM-callable tools backed by the memgraph bridge. recall_memory is the one
// the model reaches for routinely; store_memory exists for the rare case the
// user explicitly tells the assistant to remember something mid-turn.

import type { Host } from '../../src/core/extensions.js';
import { getClient } from './helpers.js';

export function register(host: Host): void {
  host.tools.register({
    name: 'recall_memory',
    description:
      'Search LONG-TERM MEMORY (the persistent knowledge graph of facts the user has shared across past conversations) for facts relevant to a query. ' +
      "Use when the user references something you cannot see in the current conversation: 'remember when I mentioned X', 'what did I tell you about Y', 'who is Z' — or proactively, when the user names a person/project/preference you don't recognize. " +
      "Do NOT use for the user's calendar, tasks, journal, or habits — those each have their own tools. " +
      'Returns a short list of recalled facts; empty list means no matches (do NOT fabricate facts in that case).',
    tier: 'auto',
    parameters: {
      type: 'object',
      required: ['query'],
      properties: {
        query: {
          type: 'string',
          description:
            'Natural-language query to match facts against. Phrase it as the topic, not a question — "wife birthday", "favourite coffee shop", "kids names".',
        },
        top_k: {
          type: 'number',
          description: 'Max facts to return. Defaults to the configured recall_top_k (usually 5).',
        },
      },
    },
    invoke: async (args) => {
      const c = getClient(host);
      if (!c) return 'Memory bridge is not configured.';
      const a = args as { query: string; top_k?: number };
      const topK = a.top_k ?? Number(host.settings.get<number>('recall_top_k', 5));
      try {
        const facts = await c.recall(a.query, topK);
        if (facts.length === 0) return 'No matching memories.';
        return facts.map((f) => `- ${f.text}`).join('\n');
      } catch (e) {
        return `Memory recall failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  host.tools.register({
    name: 'store_memory',
    description:
      'Persist a SINGLE fact to long-term memory immediately. ' +
      "Use ONLY when the user explicitly asks you to remember something: 'remember that X', 'save this: Y', 'don't forget Z'. " +
      'Do NOT call this proactively — the background memory extractor already mines facts from every conversation. Calling this for ambient facts produces duplicates.',
    tier: 'auto',
    parameters: {
      type: 'object',
      required: ['text'],
      properties: {
        text: {
          type: 'string',
          description:
            'The fact to store, in concise natural language. Phrase as a standalone statement that will make sense weeks from now without conversation context.',
        },
      },
    },
    invoke: async (args) => {
      const c = getClient(host);
      if (!c) return 'Memory bridge is not configured.';
      const text = String((args as { text: string }).text ?? '').trim();
      if (!text) return 'Nothing to store.';
      try {
        const n = await c.store('user_explicit', [{ text, created_at: Date.now(), role: 'user' }]);
        return `Stored ${n} memory.`;
      } catch (e) {
        return `Memory store failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });
}
