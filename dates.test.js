import assert from 'node:assert/strict';
import { parseDate, dayLong } from './dates.js';

const mon = '2026-10-05'; // a Monday
const cases = [
  // weekdays: the next one; "next" never means today
  ['Friday', '2026-10-09'], ['by fri.', '2026-10-09'], ['I may be done Friday', '2026-10-09'], ['next Friday', '2026-10-09'],
  ['monday', mon], ['next monday', '2026-10-12'],
  // named dates; no year means this year unless that is more than a month gone
  ['Oct 9', '2026-10-09'], ['October 12th', '2026-10-12'], ['12 oct', '2026-10-12'], ['9th of October', '2026-10-09'],
  ['sept 30', '2026-09-30'], ['10/9', '2026-10-09'], ['2026-10-15', '2026-10-15'], ['Jan 5', '2027-01-05'],
  // relative
  ['today', mon], ['by EOD', mon], ['tomorrow', '2026-10-06'], ['in 3 days', '2026-10-08'], ['in a week', '2026-10-12'],
  ['in two weeks', '2026-10-19'], ['end of week', '2026-10-09'], ['next week', '2026-10-12'], ['end of the month', '2026-10-31'],
  // no date at all, including words that look like one
  ['I was sick', null], ['I sat on it all weekend', null], ['decide 5 things first', null], ['Feb 30', null], ['not sure', null],
];
for (const [text, want] of cases) assert.equal(parseDate(text, mon), want, `"${text}"`);

// Said on a Friday: "Friday" is today, "next Friday" a week out. Said on a Saturday: end of week is next Friday.
assert.equal(parseDate('friday', '2026-10-09'), '2026-10-09');
assert.equal(parseDate('next friday', '2026-10-09'), '2026-10-16');
assert.equal(parseDate('end of week', '2026-10-10'), '2026-10-16');

assert.equal(dayLong('2026-10-09'), 'Fri, Oct 9');
console.log('ok');
