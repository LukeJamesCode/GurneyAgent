import type { Host } from '../../../src/core/extensions.js';
import { register as registerCalendar } from './calendar.js';
import { register as registerTasks } from './tasks.js';
import { register as registerReminders } from './reminders.js';
import { register as registerWeather } from './weather.js';
import { register as registerBriefing } from './briefing.js';
import { register as registerPlanning } from './planning.js';

export function register(host: Host): void {
  registerCalendar(host);
  registerTasks(host);
  registerReminders(host);
  registerWeather(host);
  registerBriefing(host);
  registerPlanning(host);
}
