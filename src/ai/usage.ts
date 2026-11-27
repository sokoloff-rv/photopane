/**
 * What PhotoPane itself has spent on the cloud services, kept on this computer by day: the services' own
 * figures cover the whole account, other programs with the same key too. A request the service refused costs
 * nothing and is not counted; one cancelled here after it was sent is (the service did the work and charged it).
 *
 * Kept apart from the settings and read afresh each time: two tabs of the web version each hold the settings as
 * they loaded them, and one saving them would write the other's charges away.
 */
import type { Service } from './cloud';

/** credits and requests */
type Count = [number, number];
interface Usage { days: Record<string, Partial<Record<Service, Count>>>; total: Partial<Record<Service, Count>> }

const STORE = 'pp.aiUsage';

/** a local date as YYYY-MM-DD (sorts as text) */
export const dayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const DAY = 86_400_000;

function load(): Usage {
  let u: Partial<Usage> | null = null;
  try { u = JSON.parse(localStorage.getItem(STORE) || 'null'); } catch {}
  return { days: u?.days ?? {}, total: u?.total ?? {} };
}

/** One request charged `credits` (0 when the price could not be found out), or credits added to one counted. */
export function recordSpent(s: Service, credits: number, request = true) {
  const u = load();
  const day = (u.days[dayKey()] ||= {});
  const a = (day[s] ||= [0, 0]); a[0] += credits; if (request) a[1] += 1;
  const tot = (u.total[s] ||= [0, 0]); tot[0] += credits; if (request) tot[1] += 1;
  // the days of the last year and a bit are kept (the totals stay)
  const cut = dayKey(new Date(Date.now() - 400 * DAY));
  for (const k of Object.keys(u.days)) if (k < cut) delete u.days[k];
  try { localStorage.setItem(STORE, JSON.stringify(u)); } catch {}
}

/** Credits and requests of the last `days` days, today included; `null`: since counting began. */
export function spentOver(s: Service, days: number | null): { credits: number; requests: number } {
  const u = load();
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
