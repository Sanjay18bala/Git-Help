import assert from 'node:assert/strict';

process.env.GIT_HELP_DB = ':memory:';
process.env.SLACK_USER_TOKEN = 'xoxp-test';
const { db } = await import('./db.js');
const rag = await import('./rag.js');

// --- pure helpers ---
assert.deepEqual(rag.split('short'), ['short']);
const long = Array.from({ length: 50 }, (_, i) => `line ${i} ${'x'.repeat(60)}`).join('\n');
const parts = rag.split(long, 500);
assert(parts.every((p) => p.length <= 500), 'pieces respect the limit');
assert(parts.length > 1 && parts[1].startsWith(parts[0].split('\n').at(-1)), 'one line of overlap');
assert(rag.split('y'.repeat(1200), 500).every((p) => p.length <= 500), 'over-long lines are cut');

assert.equal(rag.ftsQuery('Why did we drop SQLite? (#9) "quotes"'), '"drop" OR "sqlite" OR "quotes"');
assert.equal(rag.ftsQuery('what is it'), ''); // only stopwords: no keyword search
assert.deepEqual(rag.rrf([['a', 'b', 'c'], ['c', 'a']]), ['a', 'c', 'b']);

// --- fake Slack, GitHub and Ollama ---
// Embeddings: a bag-of-words hash, so texts sharing words are close.
const fakeVector = (text) => {
  const v = new Array(64).fill(0);
  for (const w of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) v[[...w].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 64, 7)] += 1;
  return v;
};
const calls = { embed: 0, embedTexts: [], chat: [] };
const ndjson = (events) => new Response(events.map((e) => JSON.stringify(e)).join('\n'));
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  if (u.host === 'slack.com') return new Response(JSON.stringify({ ok: true, url: 'https://ws.slack.com/' }));
  if (u.pathname === '/api/embed') {
    const { input } = JSON.parse(init.body);
    calls.embed++;
    calls.embedTexts.push(...input);
    return new Response(JSON.stringify({ embeddings: input.map(fakeVector) }));
  }
  if (u.pathname === '/api/chat') {
    const body = JSON.parse(init.body);
    calls.chat.push(body);
    if (body.messages[0].content.startsWith('You route')) { // the router: small talk is CHAT
      return ndjson([{ message: { content: /hello|thanks/i.test(body.messages[1].content) ? 'CHAT' : 'PROJECT' } }]);
    }
    return ndjson([{ message: { content: 'We kept JSON ' } }, { message: { content: 'for now [1].' } }, { done: true }]);
  }
  if (u.host === 'api.github.com') {
    if (u.pathname.endsWith('/issues')) {
      return new Response(JSON.stringify([
        { number: 9, title: 'Storage: JSON or SQLite?', state: 'closed', state_reason: 'completed', body: 'Is rewriting brews.json a problem?',
          user: { login: 'sanjay' }, labels: [{ name: 'question' }], assignees: [], comments: 1,
          created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-02T00:00:00Z', html_url: 'https://github.com/o/brewlog/issues/9' },
        { number: 16, title: 'experiment: SQLite storage backend', state: 'closed', body: 'Spike.', draft: false,
          pull_request: { merged_at: null }, user: { login: 'sanjay' }, labels: [], assignees: [], comments: 0,
          created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-02T00:00:00Z', html_url: 'https://github.com/o/brewlog/pull/16' },
      ]));
    }
    if (u.pathname.endsWith('/comments')) {
      return new Response(JSON.stringify([{ user: { login: 'sanjay' }, created_at: '2026-09-02T00:00:00Z', body: 'Decision: staying on JSON.' }]));
    }
    if (u.pathname.endsWith('/readme')) return new Response('# brewlog\nLog coffee brews.');
  }
  throw new Error(`unexpected fetch ${url}`);
};

// --- Slack chunking ---
const d = db();
const now = 1_790_000_000;
d.prepare("INSERT INTO channels VALUES ('C1', 'brew-log', 0, NULL, NULL)").run();
d.prepare("INSERT INTO links VALUES ('o/brewlog', 'C1', 'x')").run();
d.prepare("INSERT INTO users VALUES ('U1', 'sanjay')").run();
const msg = d.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, NULL, ?, ?)');
msg.run('C1', `${now}.000100`, `${now}.000100`, 'U1', 'Should we move to SQLite? <@U1>', 1);
msg.run('C1', `${now + 60}.000100`, `${now}.000100`, 'U1', 'Decision: staying on JSON &amp; closing the spike.', 0);
msg.run('C1', `${now + 120}.000100`, null, 'U1', 'lunch?', 0);
msg.run('C1', `${now + 180}.000100`, null, 'U1', 'ramen at noon', 0);
msg.run('C1', `${now + 7200}.000100`, null, 'U1', 'wifi is down again', 0); // > 15 min later: new conversation

const slackDocs = await rag.slackChunks('C1');
assert.deepEqual(slackDocs.map((c) => c.title.split(',')[0]), ['#brew-log thread', '#brew-log conversation', '#brew-log conversation']);
assert.equal(slackDocs[0].text, 'sanjay: Should we move to SQLite? @sanjay\nsanjay: Decision: staying on JSON & closing the spike.');
assert.equal(slackDocs[1].text, 'sanjay: lunch?\nsanjay: ramen at noon');
assert.equal(slackDocs[0].url, `https://ws.slack.com/archives/C1/p${now}000100`);

// --- indexing: embed once, skip unchanged ---
assert.equal(await rag.indexSlack('C1'), 3);
assert.equal(await rag.indexSlack('C1'), 0, 'unchanged chunks are not re-embedded');
assert(calls.embedTexts.every((t) => t.startsWith('search_document: ')), 'nomic document prefix');

await rag.indexGithub('o/brewlog', 'gh-token');
const ghIds = d.prepare("SELECT id FROM chunks WHERE source = 'github' ORDER BY id").all().map((r) => r.id);
assert.deepEqual(ghIds, ['gh:o/brewlog:#16', 'gh:o/brewlog:#9', 'gh:o/brewlog:#9:comments:0', 'gh:o/brewlog:readme:0']);
assert.match(d.prepare("SELECT text FROM chunks WHERE id = 'gh:o/brewlog:#16'").get().text, /State: closed\./);

// Items table + overview: exact counts that retrieval alone can't give.
assert.deepEqual(d.prepare("SELECT number, kind, state FROM items WHERE repo = 'o/brewlog' ORDER BY number").all().map((r) => ({ ...r })),
  [{ number: 9, kind: 'issue', state: 'closed' }, { number: 16, kind: 'pr', state: 'closed' }]);
const overview = rag.repoOverview('o/brewlog');
assert.match(overview.text, /Total: 1 issues and 1 pull requests\./);
assert.match(overview.text, /Open issues: 0\./);
assert.match(overview.text, /Closed issues: 1 \(#9 Storage: JSON or SQLite\? \[question\]\)\./);
assert.match(overview.text, /Closed pull requests that were not merged: 1 \(#16 experiment: SQLite storage backend\)\./);
assert.equal(rag.repoOverview('nobody/none'), null);

// Another repo's data, which repo scope must never return.
d.prepare("INSERT INTO chunks (id, source, repo, title, text, url, hash) VALUES ('gh:other/app:#1', 'github', 'other/app', 'other/app issue #1', 'SQLite migration for other app', 'u', 'h')").run();
await rag.ensureIndexed(null, 'gh-token');

// --- retrieval ---
const hits = await rag.retrieve('Why did we stay on JSON instead of SQLite?', 'o/brewlog');
assert(hits.length > 0 && hits.every((h) => h.repo === 'o/brewlog' || h.channel_id === 'C1'), 'repo scope is isolated');
assert(hits.slice(0, 3).some((h) => h.id === 'gh:o/brewlog:#9:comments:0' || h.id.startsWith('slack:C1:')), 'decision ranks near the top');
const general = await rag.retrieve('SQLite migration', null);
assert(general.some((h) => h.repo === 'other/app'), 'general scope spans repos');

// --- answering ---
const events = [];
for await (const e of rag.answer({ repo: 'o/brewlog', messages: [
  { role: 'assistant', content: 'leading assistant turns are dropped' },
  { role: 'user', content: 'hi' },
  { role: 'assistant', content: 'Hello! See [3] and [1, 2].' },
  { role: 'user', content: 'Why did we stay on JSON?' },
] })) events.push(e);
assert.equal(events[0].type, 'sources');
assert.match(events[0].sources[0].title, /overview/, 'the repo overview is always source [1]');
assert(events[0].sources.length > 1 && events[0].sources.every((src, i) => src.n === i + 1 && src.url));
assert.equal(events.slice(1).map((e) => e.text).join(''), 'We kept JSON for now [1].');
const sent = calls.chat.at(-1);
assert.equal(sent.messages[0].role, 'system');
assert.match(sent.messages[0].content, /viewing the repository o\/brewlog/);
assert.equal(sent.messages[1].role, 'user', 'conversation starts with the user');
assert.equal(sent.messages[2].content, 'Hello! See and.', "earlier answers' citations are stripped");
assert.match(sent.messages.at(-1).content, /<source id="1" type="github" title="o\/brewlog overview/);
assert.match(sent.messages.at(-1).content, /Question: Why did we stay on JSON\?$/);
assert.equal(sent.options.num_ctx, 12288);

// Routing: small talk skips retrieval; project questions (and anything unclear) don't.
assert.equal(await rag.route([{ role: 'user', content: 'hello, how are you?' }]), 'chat');
assert.equal(await rag.route([{ role: 'user', content: 'How many open issues are there?' }]), 'project');
// The router says CHAT ("hello" in the fake), but the message shares 2+ keywords with the repo's data: PROJECT.
assert.equal(await rag.route([{ role: 'user', content: 'hello, why are we staying on JSON instead of SQLite?' }], undefined, 'o/brewlog'), 'project');
assert.equal(await rag.route([{ role: 'user', content: 'hello, JSON?' }], undefined, 'o/brewlog'), 'chat', 'one shared word is not enough');
// "brews" is only in the README chunk and "spike" only in the Slack thread: not together, so not a project signal.
assert.equal(await rag.route([{ role: 'user', content: 'hello, brews spike?' }], undefined, 'o/brewlog'), 'chat', 'words must co-occur in one chunk');
const smallTalk = [];
for await (const e of rag.answer({ repo: 'o/brewlog', mode: 'chat', messages: [{ role: 'user', content: 'hello, how are you?' }] })) smallTalk.push(e);
assert.deepEqual(smallTalk[0], { type: 'sources', sources: [] });
assert.match(calls.chat.at(-1).messages[0].content, /small talk or a general question/);
assert.equal(calls.chat.at(-1).messages.at(-1).content, 'hello, how are you?', 'no sources in a small-talk prompt');

// A project question with nothing indexed: the model is told nothing matched instead of being given sources.
const empty = [];
for await (const e of rag.answer({ repo: 'nobody/none', messages: [{ role: 'user', content: 'what is blocked?' }] })) empty.push(e);
assert.deepEqual(empty[0], { type: 'sources', sources: [] });
assert.match(calls.chat.at(-1).messages.at(-1).content, /No indexed GitHub data or Slack messages matched/);

console.log('ok');
