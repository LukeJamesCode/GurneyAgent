import type { Host } from '../../src/core/extensions.js';
import { duckduckgoSearch, searxngSearch, formatResults } from './api.js';

export function register(host: Host): void {
  host.tools.register({
    name: 'web_search',
    description:
      'Search the web for current information, news, prices, sports scores, recent events, or any fact that could have changed since training. ' +
      "Use whenever the user asks about something time-sensitive ('latest', 'today', 'this week', 'recent', a date in the current year), about specific external entities (companies, products, public figures), or about facts you are not 100% sure of. " +
      "Do NOT use for questions answerable from the conversation, the user's own data (calendar/tasks/journal — those have their own tools), or pure reasoning/code questions. " +
      'Returns ranked snippets with URLs — cite them in your reply.',
    tier: 'auto',
    parameters: {
      type: 'object',
      required: ['query'],
      properties: {
        query: {
          type: 'string',
          description:
            'Search query. Phrase it like a human would type into Google — keywords, not a full sentence. ' +
            "Include the year for time-sensitive queries ('rust async runtimes 2026'). For a person/place, include a disambiguator.",
        },
        max_results: {
          type: 'number',
          description:
            'Max results to return. Default 5. Bump up only for broad research questions.',
        },
      },
    },
    invoke: async (args) => {
      const a = args as { query: string; max_results?: number };
      const max = a.max_results ?? host.settings.get<number>('max_results', 5);
      const searxngUrl = host.settings.get<string>('searxng_url');
      try {
        const results = searxngUrl
          ? await searxngSearch(searxngUrl, a.query, max)
          : await duckduckgoSearch(a.query, max);
        return formatResults(results);
      } catch (e) {
        return `Search failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });
}
