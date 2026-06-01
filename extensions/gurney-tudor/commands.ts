// gurney-tudor entrypoint. Registers the `/learn` Telegram command, which kicks
// off a course build. The rich, interactive experience lives in the panel's
// Learn tab — generation writes to the shared DB, so the command and the panel
// observe the same course. Generation can take minutes on a local model, so the
// command returns immediately and points the user at the panel to watch it build.

import type { Host } from '../../src/core/extensions.js';
import type { Depth, Generator } from './lib/types.js';
import { startCourse } from './lib/service.js';

export function register(host: Host): void {
  host.telegram.command(
    'learn',
    async (ctx) => {
      const topic = ctx.args.trim();
      if (!topic) {
        await ctx.reply(
          'Tell me what to teach you. Try: /learn the basics of how neural networks learn',
        );
        return;
      }
      const generator =
        (host.settings.get<string>('default_generator', 'local') as Generator) || 'local';
      const depth = (host.settings.get<string>('default_depth', 'standard') as Depth) || 'standard';
      const useWebsearch = host.settings.get<boolean>('use_websearch', false) === true;
      const useWebImages = host.settings.get<boolean>('use_web_images', true) !== false;
      try {
        startCourse(
          { db: host.db, llm: host.llm, log: host.log },
          { topic, depth, generator, useWebsearch, useWebImages },
        );
        await ctx.reply(
          `📚 Building your course on “${topic}”.\n\n` +
            `Open the Learn tab in the Gurney panel to watch it build and start learning. ` +
            `Lessons unlock as they finish — the first is usually ready in under a minute on local models.`,
        );
      } catch (e) {
        host.log.warn('tudor: /learn failed to start', {
          error: e instanceof Error ? e.message : String(e),
        });
        await ctx.reply('Could not start a course right now. Check that Ollama is reachable.');
      }
    },
    'Build an interactive course on a topic',
  );

  host.prompts.contribute(
    'Gurney-Tudor turns a topic into a full interactive course in the web panel. ' +
      'If the user asks you to teach them something or build a course/lesson, tell them ' +
      'to run /learn <topic> (or open the Learn tab in the panel).',
  );
}
