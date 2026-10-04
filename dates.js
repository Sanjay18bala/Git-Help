// Reading a finish date out of a Slack reply ("Friday", "Oct 9", "in 3 days", "end of week"). Pure; see dates.test.js.

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const COUNTS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, ten: 10 };
// Exact names only, so words like "decide 5" or "I sat on it" don't read as dates.
const MONTH = '(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)';
const WEEKDAY = '(sunday|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thu|friday|fri|saturday)';

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// The date a reply names, as YYYY-MM-DD, relative to `today` (YYYY-MM-DD); null when it names none. Dates without
// a year are this year, or next year when that would be more than a month in the past. Weekdays mean the next one
// (today counts for "by Friday" said on a Friday; "next Friday" never means today).
export function parseDate(text, today) {
  const t = ` ${String(text).toLowerCase().replace(/[,.!?]/g, ' ').replace(/\s+/g, ' ')} `;
  const base = new Date(`${today}T12:00:00`);
  const plus = (n) => { const d = new Date(base); d.setDate(d.getDate() + n); return ymd(d); };
  const onDay = (month, day) => {
    if (month < 0 || month > 11 || day < 1 || day > 31) return null;
    const d = new Date(base.getFullYear(), month, day, 12);
    if (d.getMonth() !== month) return null; // e.g. Feb 30
    if (base - d > 31 * 86_400_000) d.setFullYear(d.getFullYear() + 1);
    return ymd(d);
  };
  let m;
  if ((m = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = t.match(new RegExp(`\\b${MONTH} (\\d{1,2})(?:st|nd|rd|th)?\\b`)))) return onDay(MONTHS.indexOf(m[1].slice(0, 3)), Number(m[2]));
  if ((m = t.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)? (?:of )?${MONTH}\\b`)))) return onDay(MONTHS.indexOf(m[2].slice(0, 3)), Number(m[1]));
  if ((m = t.match(/\b(\d{1,2})\/(\d{1,2})\b/))) return onDay(Number(m[1]) - 1, Number(m[2])); // US month/day
  if (/\b(today|tonight|eod|end of (the )?day)\b/.test(t)) return plus(0);
  if (/\b(tomorrow|tmrw|tmr)\b/.test(t)) return plus(1);
  if ((m = t.match(/\bin (\d+|a|an|one|two|three|four|five|six|seven|ten) (day|days|week|weeks)\b/))) {
    const n = COUNTS[m[1]] ?? Number(m[1]);
    return plus(m[2].startsWith('week') ? n * 7 : n);
  }
  if (/\b(eow|end of (the )?week)\b/.test(t)) {
    const toFri = (5 - base.getDay() + 7) % 7;
    return plus(base.getDay() === 6 ? 6 : toFri); // Saturday: next Friday
  }
  if (/\bnext week\b/.test(t)) return plus(((1 - base.getDay() + 7) % 7) || 7); // next Monday
  if (/\b(eom|end of (the )?month)\b/.test(t)) return ymd(new Date(base.getFullYear(), base.getMonth() + 1, 0, 12));
  if ((m = t.match(new RegExp(`\\b(next )?${WEEKDAY}\\b`)))) {
    const delta = (DAYS.indexOf(m[2].slice(0, 3)) - base.getDay() + 7) % 7;
    return plus(m[1] && delta === 0 ? 7 : delta);
  }
  return null;
}

// "Fri, Oct 9" for a YYYY-MM-DD date.
export const dayLong = (date) => new Date(`${date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
