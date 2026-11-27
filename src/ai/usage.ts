/**
 * What PhotoPane itself has spent on the cloud services, kept on this computer by day: the services' own
 * figures cover the whole account, other programs with the same key too. A request the service refused costs
 * nothing and is not counted; one cancelled here after it was sent is (the service did the work and charged it).
 */
import { app } from '../app';
import type { Service } from './cloud';

/** credits and requests */
type Count = [number, number];
interface Usage { days: Record<string, Partial<Record<Service, Count>>>; total: Partial<Record<Service, Count>>; since: string }

/** a local date as YYYY-MM-DD (sorts as text) */
export const dayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const DAY = 86_400_000;

function usage(): Usage {
  const u = (app.settings.aiUsage ||= {}) as Usage;
  u.days ||= {};
  u.total ||= {};
  u.since ||= dayKey();
  return u;
}

export function recordSpent(s: Service, credits: number) {
  const u = usage();
  const day = (u.days[dayKey()] ||= {});
  const a = (day[s] ||= [0, 0]); a[0] += credits; a[1] += 1;
  const tot = (u.total[s] ||= [0, 0]); tot[0] += credits; tot[1] += 1;
  // the days of the last year and a bit are kept (the totals stay)
  const cut = dayKey(new Date(Date.now() - 400 * DAY));
  for (const k of Object.keys(u.days)) if (k < cut) delete u.days[k];
  app.saveSettings();
}

/** Credits and requests of the last `days` days, today included; `null`: since counting began. */
export function spentOver(s: Service, days: number | null): { credits: number; requests: number } {
  const u = usage();
  if (days == null) { const [credits, requests] = u.total[s] ?? [0, 0]; return { credits, requests }; }
  // (noon: a day of 23 or 25 hours does not move the first day)
  const now = new Date(); now.setHours(12, 0, 0, 0);
  const from = dayKey(new Date(now.getTime() - (days - 1) * DAY));
  let credits = 0, requests = 0;
  for (const [k, v] of Object.entries(u.days)) {
    const c = v[s];
    if (k >= from && c) { credits += c[0]; requests += c[1]; }
  }
  return { credits, requests };
}

/** The day counting began (YYYY-MM-DD). */
export const usageSince = () => usage().since;
