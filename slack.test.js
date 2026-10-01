import assert from 'node:assert/strict';

process.env.GIT_HELP_DB = ':memory:';
process.env.SLACK_USER_TOKEN = 'xoxp-test';
const { plainText, link, sync, links, threads, unlink, db } = await import('./slack.js');

// --- plainText ---
const names = new Map([['U1', 'sanjay']]);
assert.equal(plainText('hi <@U1>, see <#C9|brewlog-dev>', names), 'hi @sanjay, see #brewlog-dev');
assert.equal(plainText('<!here> fixed in <https://github.com/o/r/pull/13|PR 13> &amp; <https://x.dev>'),
  '@here fixed in PR 13 & https://x.dev');
assert.equal(plainText('a &lt;b&gt; <@U404>'), 'a <b> @U404');

// --- sync against a fake Slack API ---
const now = Math.floor(Date.now() / 1000);
const ts = (secondsAgo) => `${now - secondsAgo}.000100`;
const parent = { type: 'message', ts: ts(3600), thread_ts: ts(3600), user: 'U1', reply_count: 1,
  text: 'CSV export breaks on commas, <@U2> can you look?' };
const reply = { type: 'message', ts: ts(3000), thread_ts: parent.ts, user: 'U2', text: 'fixed in &lt;#14&gt;' };
let history = [
  parent,
  { type: 'message', ts: ts(7200), user: 'U2', text: 'morning' },
  { type: 'message', subtype: 'channel_join', ts: ts(7300), user: 'U3', text: 'joined' },
  { type: 'message', ts: ts(100 * 86400), user: 'U1', text: 'older than the 90-day backfill' },
];
const calls = [];
globalThis.fetch = async (url) => {
  const u = new URL(url);
  const method = u.pathname.split('/').pop();
  const p = Object.fromEntries(u.searchParams);
  calls.push({ method, ...p });
  const ok = (body) => new Response(JSON.stringify({ ok: true, ...body }));
  switch (method) {
    case 'auth.test': return ok({ url: 'https://ws.slack.com/', team: 'T', user: 'me' });
    case 'conversations.info': return ok({ channel: { id: 'C1', name: 'brewlog-dev', is_private: false } });
    case 'conversations.history': {
      const all = history.filter((m) => Number(m.ts) >= Number(p.oldest));
      // two pages, to exercise cursor pagination
      return p.cursor ? ok({ messages: all.slice(1) }) : ok({ messages: all.slice(0, 1), response_metadata: { next_cursor: 'page2' } });
    }
    case 'conversations.replies': return ok({ messages: [parent, reply] });
    case 'users.info': return ok({ user: { profile: { display_name: { U1: 'sanjay', U2: 'alex' }[p.user] } } });
    default: throw new Error(`unexpected Slack call ${method}`);
  }
};

await link('o/brewlog', 'C1');
assert.deepEqual(await sync('C1'), { channel_id: 'C1', fetched: 3 }); // 2 messages + 1 reply; join and old skipped
assert.equal(links()[0].messages, 3);
const firstOldest = Number(calls.find((c) => c.method === 'conversations.history').oldest);
assert(Math.abs(firstOldest - (now - 90 * 86400)) < 5, 'first sync goes back 90 days');

// Incremental sync resumes from the newest message minus the 7-day overlap, and doesn't duplicate.
calls.length = 0;
history = [{ type: 'message', ts: ts(60), user: 'U1', text: 'new message' }, ...history];
await sync('C1');
const nextOldest = Number(calls.find((c) => c.method === 'conversations.history').oldest);
assert(Math.abs(nextOldest - (Number(parent.ts) - 7 * 86400)) < 1, 'resume from latest - overlap');
assert.equal(links()[0].messages, 4);
assert(!calls.some((c) => c.method === 'users.info'), 'known users are not looked up again');

// Threads come back newest first, with names resolved, replies attached and Slack permalinks.
const t = await threads('o/brewlog');
assert.deepEqual(t.map((x) => x.text), ['new message', 'CSV export breaks on commas, @alex can you look?', 'morning']);
assert.equal(t[1].author, 'sanjay');
assert.deepEqual(t[1].replies.map((r) => [r.author, r.text]), [['alex', 'fixed in <#14>']]);
assert.equal(t[1].permalink, `https://ws.slack.com/archives/C1/p${parent.ts.replace('.', '')}`);
assert.match(t[1].replies[0].permalink, /\?thread_ts=.+&cid=C1$/);

// Unlinking the last repo deletes the channel's local copy.
unlink('o/brewlog', 'C1');
assert.equal(links().length, 0);
assert.equal(db().prepare('SELECT COUNT(*) n FROM messages').get().n, 0);

console.log('ok');
