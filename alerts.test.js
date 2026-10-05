import assert from 'node:assert/strict';

process.env.GIT_HELP_DB = ':memory:';
process.env.SLACK_BOT_TOKEN = 'xoxb-test';
process.env.SESSION_SECRET = 'test-secret';
const { db } = await import('./db.js');
const alerts = await import('./alerts.js');
const rag = await import('./rag.js');

// Fake Slack: record bot calls. Fake Ollama embeddings for indexing the reply.
const posted = [];
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  if (u.pathname === '/api/embed') {
    const { input } = JSON.parse(init.body);
    return new Response(JSON.stringify({ embeddings: input.map(() => Array(8).fill(0.1)) }));
  }
  const method = u.pathname.split('/').pop();
  const p = Object.fromEntries(new URLSearchParams(init.body ?? ''));
  const ok = (b) => new Response(JSON.stringify({ ok: true, ...b }));
  if (method === 'conversations.open') return ok({ channel: { id: `D-${p.users}` } });
  if (method === 'chat.postMessage' && p.channel === 'C-NOBOT') return new Response(JSON.stringify({ ok: false, error: 'not_in_channel' }));
  if (method === 'chat.postMessage') { posted.push(p); return ok({ ts: `${1_790_000_000 + posted.length}.000100` }); }
  if (method === 'chat.getPermalink') return ok({ permalink: `https://ws.slack.com/archives/${p.channel}/p${p.message_ts}` });
  throw new Error(`unexpected ${url}`);
};

const d = db();
const item = d.prepare(`INSERT INTO items (repo, number, kind, state, draft, title, url, labels, assignees, author, created_at, updated_at, milestone, due_on)
  VALUES ('o/r', ?, 'issue', ?, 0, ?, ?, '', ?, 'x', 'x', 'x', 'v1', ?)`);
item.run(14, 'open', 'CSV breaks', 'https://github.com/o/r/issues/14', 'priya', '2026-09-29');
item.run(8, 'open', 'Add CI', 'https://github.com/o/r/issues/8', 'zed', '2026-09-29'); // zed has no Slack link
item.run(6, 'open', 'Grind size', 'https://github.com/o/r/issues/6', '', '2026-09-29'); // nobody assigned
item.run(3, 'open', 'Colors', 'https://github.com/o/r/issues/3', 'priya', '2026-10-15'); // not due yet
item.run(1, 'closed', 'Old bug', 'https://github.com/o/r/issues/1', 'priya', '2026-09-01'); // closed: never late
d.prepare("INSERT INTO people VALUES ('priya', 'UPRIYA', 'Priya', 'email', 'high', 1, 'x')").run();

const today = '2026-10-01';
assert.deepEqual(alerts.planAlerts(today).send, [], 'alerts are off until a repo is enabled');
alerts.setAlerts('o/r', true);

let plan = alerts.planAlerts(today);
assert.deepEqual(plan.send.map((a) => [a.number, a.login, a.kind, a.days_late]), [[14, 'priya', 'first', 2]]);
assert.deepEqual(plan.cannot.map((c) => [c.number, c.login, c.reason]).sort(), [
  [6, null, 'nobody is assigned'], [8, 'zed', 'no confirmed Slack link (Settings → slack bot)']]);
assert.match(alerts.alertText(plan.send[0]), /^Hi! <https:\/\/github\.com\/o\/r\/issues\/14\|#14 CSV breaks> in o\/r was due Sep 29 \(milestone v1, 2 days ago\)/);

// Send: one DM, logged; planning again sends nothing new.
const realPlan = alerts.planAlerts;
await (async () => {
  const sent = await alerts.sendAlerts();
  assert.equal(sent.length, 1);
})();
assert.equal(posted.length, 1);
assert.equal(posted[0].channel, 'D-UPRIYA');
assert.deepEqual(realPlan(today).send, [], 'no duplicate alert');

// Reminder only after 3 days without a reply.
const sentAt = Date.parse(d.prepare('SELECT sent_at FROM alerts').get().sent_at);
assert.deepEqual(realPlan(today, sentAt + 2 * 86_400_000).send, []);
assert.deepEqual(realPlan(today, sentAt + 3 * 86_400_000).send.map((a) => a.kind), ['reminder']);

// A reply in the alert's thread is stored, acknowledged, and becomes the reason in the chat overview.
const alertTs = d.prepare('SELECT message_ts FROM alerts').get().message_ts;
const got = await alerts.recordReply({ channel: 'D-UPRIYA', user: 'UPRIYA', text: 'Waiting on review of the quoting fix', ts: '1790000100.000200', thread_ts: alertTs });
assert.equal(got.number, 14);
assert.deepEqual(alerts.followupsFor('o/r', 14).map((f) => [f.github_login, f.text]), [['priya', 'Waiting on review of the quoting fix']]);
assert.match(posted.at(-1).text, /Thanks, noted for #14/);
assert.equal(posted.at(-1).thread_ts, alertTs);
d.prepare("INSERT INTO indexed_repos VALUES ('o/r', '2026-10-01T00:00:00Z')").run();
assert.match(rag.repoOverview('o/r').text, /#14 CSV breaks \(issue; assigned to priya; milestone v1, due 2026-09-29, \d+ days late; reason given by priya on \d{4}-\d\d-\d\d: "Waiting on review of the quoting fix"\)/);
assert.match(d.prepare("SELECT text FROM chunks WHERE id LIKE 'followup:%'").get().text, /priya \(the assignee\) replied to the GitHelp bot about overdue issue #14 "CSV breaks"/);

// After a reply: no reminder. A message with no alert in that DM is ignored.
assert.deepEqual(realPlan(today, sentAt + 5 * 86_400_000).send, []);
assert.equal(await alerts.recordReply({ channel: 'D-OTHER', user: 'U9', text: 'hi', ts: '1790000200.0001' }), null);

// ---------- expected finish date ----------
const { parseDate } = await import('./dates.js');
const realToday = rag.localDate();
// The reason came without a date, so the bot asked for one.
assert.match(posted.at(-1).text, /When do you expect to finish it\?/);
// A reply with no date isn't stored as a new reason; the bot asks again.
await alerts.recordReply({ channel: 'D-UPRIYA', user: 'UPRIYA', text: 'not sure yet', ts: '1790000110.000200', thread_ts: alertTs });
assert.match(posted.at(-1).text, /couldn't find a date/);
assert.deepEqual(alerts.followupsFor('o/r', 14).map((f) => f.text), ['Waiting on review of the quoting fix']);
// A date answer is stored and confirmed.
await alerts.recordReply({ channel: 'D-UPRIYA', user: 'UPRIYA', text: 'by end of week', ts: '1790000120.000200', thread_ts: alertTs });
const eta = parseDate('end of week', realToday);
assert.match(posted.at(-1).text, /^Got it: #14 by \w{3}, \w{3} \d+\./);
assert.equal(rag.latestEta('o/r', 14).due_date, eta);
// It shows up for the chat, the Overview data and the digest.
assert.match(rag.repoOverview('o/r').text, new RegExp(`priya expects to finish by ${eta}`));
assert.equal(rag.attention('o/r').overdue.find((i) => i.number === 14).eta.date, eta);
assert.match(alerts.digestText('o/r', rag.attention('o/r')), /priya: “Waiting on review of the quoting fix” · (expects|missed) \w{3} \d+/);
// While the date is ahead, no reminders; once it has passed, one nudge per missed date.
assert.deepEqual(realPlan(realToday, Date.now() + 10 * 86_400_000).send.filter((a) => a.number === 14), []);
const afterEta = '2026-12-31';
const nudge = realPlan(afterEta).send.filter((a) => a.number === 14);
assert.deepEqual(nudge.map((a) => [a.kind, a.due_on]), [['eta', eta]]);
assert.match(alerts.alertText(nudge[0]), /was expected by \w{3}, \w{3} \d+ and is still open\. Any update\?/);
// Log the nudge as sent (sendAlerts plans with the real date, which isn't past the expected date yet).
d.prepare(`INSERT INTO alerts (repo, number, github_login, slack_user_id, due_on, kind, sent_at, channel_id, message_ts)
  VALUES ('o/r', 14, 'priya', 'UPRIYA', ?, 'eta', ?, 'D-UPRIYA', '1790000300.0001')`).run(eta, new Date().toISOString());
assert.deepEqual(realPlan(afterEta).send.filter((a) => a.number === 14), [], 'one nudge per missed date');

// The stored background token is sealed, and removed on sign-out.
alerts.rememberGithubToken('gho_secret');
assert(!d.prepare("SELECT value FROM settings WHERE key = 'github'").get().value.includes('gho_secret'));
alerts.forgetGithubToken();
assert.equal(d.prepare("SELECT 1 FROM settings WHERE key = 'github'").get(), undefined);

// ---------- digest ----------
// When a scheduled digest is due: weekdays from 9:00 (daily), or once per week from Monday 9:00 (weekly).
assert.equal(alerts.digestPeriod('daily', new Date(2026, 9, 5, 8, 59)), null, 'never before 9:00');
assert.equal(alerts.digestPeriod('daily', new Date(2026, 9, 5, 9, 0)), '2026-10-05');
assert.equal(alerts.digestPeriod('daily', new Date(2026, 9, 4, 12)), null, 'no daily digest on Sunday');
assert.equal(alerts.digestPeriod('weekly', new Date(2026, 9, 8, 15)), 'week of 2026-10-05', 'weekly: the week from Monday');

// The message: what's late and why (or why not), then what's next.
const att = rag.attention('o/r', 14, today);
for (const i of att.overdue) i.eta = null; // expected dates in the digest are tested above
assert.equal(alerts.digestText('o/r', att, { schedule: 'weekly' }), [
  '*r* · 3 items past due in v1',
  '• <https://github.com/o/r/issues/6|#6 Grind size> · 2 days late · no owner',
  '• <https://github.com/o/r/issues/8|#8 Add CI> · 2 days late · zed · not asked yet',
  '• <https://github.com/o/r/issues/14|#14 CSV breaks> · 2 days late · priya: “Waiting on review of the quoting fix”',
  'Next up: v1 due Oct 15 (in 14 days) · 1 item',
].join('\n'));
assert.doesNotMatch(alerts.digestText('o/r', att, { schedule: 'daily' }), /Next up/, 'daily: only what is due within 3 days');
const quiet = { ...att, overdue: [], due_soon: [] };
assert.equal(alerts.digestText('o/r', quiet, { schedule: 'daily' }), null, 'a quiet day posts nothing');
assert.equal(alerts.digestText('o/r', quiet, { schedule: 'weekly' }), '*r* · nothing is past due');

// Posting: every linked channel; one the bot isn't in gets an instruction, the others still post.
d.prepare("INSERT INTO channels (id, name, is_private) VALUES ('C-OK', 'dev', 0), ('C-NOBOT', 'random', 0)").run();
d.prepare("INSERT INTO links VALUES ('o/r', 'C-OK', 'x'), ('o/r', 'C-NOBOT', 'x')").run();
const before = posted.length;
const results = await alerts.sendDigest('o/r');
assert.deepEqual(results.map((r) => [r.channel, r.ok]), [['dev', true], ['random', false]]);
assert.match(results[1].error, /\/invite @GitHelp/);
assert.equal(posted.length, before + 1);
assert.equal(posted.at(-1).channel, 'C-OK');
assert.deepEqual(alerts.digestLog('o/r').map((l) => l.channel_name), ['dev']);

// Scheduled: posts once per period, however often the background check runs.
alerts.setDigest('o/r', 'weekly');
const monday = new Date(2026, 9, 5, 10);
assert.equal((await alerts.runDigests(monday)).length, 1);
assert.equal((await alerts.runDigests(monday)).length, 0, 'not twice in the same week');
assert.equal((await alerts.runDigests(new Date(2026, 9, 7, 10))).length, 0, 'still the same week');
alerts.setDigest('o/r', 'off');
assert.deepEqual(alerts.digestSchedules(), {});

console.log('ok');
