// Slack, read-only: the user token from .env reads channels, and linked channels are copied into a local SQLite file.
import { db } from './db.js';

export { db }; // slack.test.js reads tables through it

const DAY = 86400;
export const BACKFILL_DAYS = 90; // how far back the first sync of a channel goes
const OVERLAP_DAYS = 7; // every sync re-reads this much, to pick up edits and late thread replies

export class SlackError extends Error {}

const FRIENDLY = {
  not_configured: "Slack isn't set up: add SLACK_USER_TOKEN to .env (see README).",
  not_authed: 'The Slack token in .env is missing or malformed.',
  invalid_auth: 'The Slack token in .env is invalid. Copy the User OAuth Token again.',
  token_revoked: 'The Slack token in .env was revoked. Reinstall the Slack app and copy the new token.',
  missing_scope: 'The Slack app is missing a permission. Compare its scopes with the manifest in the README.',
  channel_not_found: "Channel not found, or you're not a member of it.",
};
export const friendly = (code) => FRIENDLY[code] ?? `Slack error: ${code}`;


const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function slack(method, params = {}) {
  const token = process.env.SLACK_USER_TOKEN;
  if (!token) throw new SlackError('not_configured');
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`https://slack.com/api/${method}?${new URLSearchParams(params)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (r.status === 429 && attempt < 5) {
      await sleep((Number(r.headers.get('retry-after')) || 1) * 1000);
      continue;
    }
    const body = await r.json();
    if (!body.ok) throw new SlackError(body.error ?? `http_${r.status}`);
    return body;
  }
}

async function* pages(method, params, key) {
  let cursor;
  do {
    const body = await slack(method, cursor ? { ...params, cursor } : params);
    yield* body[key] ?? [];
    cursor = body.response_metadata?.next_cursor;
  } while (cursor);
}

let team;
export const workspace = async () => (team ??= await slack('auth.test'));

// Channels the token's user is a member of.
export async function listChannels() {
  const out = [];
  const params = { types: 'public_channel,private_channel', exclude_archived: true, limit: 200 };
  for await (const c of pages('users.conversations', params, 'channels')) {
    out.push({ id: c.id, name: c.name, is_private: Boolean(c.is_private) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function link(repo, channelId) {
  const { channel: c } = await slack('conversations.info', { channel: channelId });
  db().prepare(`INSERT INTO channels (id, name, is_private) VALUES (?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET name = excluded.name`).run(c.id, c.name, c.is_private ? 1 : 0);
  db().prepare('INSERT OR IGNORE INTO links VALUES (?, ?, ?)').run(repo, c.id, new Date().toISOString());
}

export function unlink(repo, channelId) {
  const d = db();
  d.prepare('DELETE FROM links WHERE repo = ? AND channel_id = ?').run(repo, channelId);
  // No other repo uses this channel: delete its local copy too.
  if (!d.prepare('SELECT 1 FROM links WHERE channel_id = ?').get(channelId)) {
    d.prepare('DELETE FROM messages WHERE channel_id = ?').run(channelId);
    d.prepare('DELETE FROM channels WHERE id = ?').run(channelId);
    d.prepare('DELETE FROM chunks WHERE channel_id = ?').run(channelId); // its RAG index too
    d.prepare('DELETE FROM chunks WHERE channel_id = ?').run(channelId); // its RAG index too
  }
}

export const links = () => db().prepare(`
  SELECT l.repo, c.id AS channel_id, c.name, c.is_private, c.synced_at,
    (SELECT COUNT(*) FROM messages m WHERE m.channel_id = c.id) AS messages
  FROM links l JOIN channels c ON c.id = l.channel_id
  ORDER BY l.repo, c.name`).all();

const keep = (m) => m.type === 'message' && !/^(channel|group)_/.test(m.subtype ?? ''); // skip joins, renames, …
const MENTION = /<@([UW][A-Z0-9]+)/g;

const syncing = new Map(); // channel id -> in-flight sync, so double clicks share one run
export function sync(channelId, { full = false } = {}) {
  if (!syncing.has(channelId)) {
    syncing.set(channelId, runSync(channelId, full).finally(() => syncing.delete(channelId)));
  }
  return syncing.get(channelId);
}

async function runSync(channelId, full) {
  const d = db();
  const state = d.prepare('SELECT latest_ts FROM channels WHERE id = ?').get(channelId);
  if (!state) throw new SlackError('channel_not_linked');

  const now = Date.now() / 1000;
  // ponytail: replies added to threads whose parent is older than `oldest`, and deleted messages, are missed
  // by an incremental sync; a full sync re-reads everything.
  const oldest = full ? 0
    : state.latest_ts ? Number(state.latest_ts) - OVERLAP_DAYS * DAY
      : now - BACKFILL_DAYS * DAY;

  const upsert = d.prepare(`INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (channel_id, ts) DO UPDATE SET
      text = excluded.text, reply_count = excluded.reply_count, user_name = excluded.user_name`);
  const people = new Set();
  const save = (m) => {
    upsert.run(channelId, m.ts, m.thread_ts ?? null, m.user ?? m.bot_id ?? null,
      m.username ?? m.bot_profile?.name ?? null, m.text ?? '', m.reply_count ?? 0);
    if (m.user) people.add(m.user);
    for (const [, id] of (m.text ?? '').matchAll(MENTION)) people.add(id);
  };

  let fetched = 0;
  let latest = state.latest_ts;
  const history = { channel: channelId, oldest: oldest.toFixed(6), limit: 200 };
  for await (const m of pages('conversations.history', history, 'messages')) {
    if (!keep(m)) continue;
    save(m);
    fetched++;
    if (!latest || Number(m.ts) > Number(latest)) latest = m.ts;
    if (!m.reply_count) continue;
    for await (const r of pages('conversations.replies', { channel: channelId, ts: m.ts, limit: 200 }, 'messages')) {
      if (r.ts === m.ts || !keep(r)) continue; // the first reply page repeats the parent
      save(r);
      fetched++;
    }
  }

  await resolveUsers(people);
  d.prepare('UPDATE channels SET latest_ts = ?, synced_at = ? WHERE id = ?')
    .run(latest ?? null, new Date().toISOString(), channelId);
  return { channel_id: channelId, fetched };
}

async function resolveUsers(ids) {
  const d = db();
  const known = d.prepare('SELECT 1 FROM users WHERE id = ?');
  const insert = d.prepare('INSERT OR REPLACE INTO users VALUES (?, ?)');
  for (const id of ids) {
    if (known.get(id)) continue;
    try {
      const { user: u } = await slack('users.info', { user: id });
      insert.run(id, u.profile?.display_name || u.real_name || u.name || id);
    } catch (e) {
      if (!(e instanceof SlackError) || e.message !== 'user_not_found') throw e;
      insert.run(id, id); // deleted or external user: keep the id so we don't look it up every sync
    }
  }
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>' };

// Slack's markup ("<@U123>", "<#C1|general>", "<https://x|label>", &amp;) to readable plain text.
export function plainText(text, names = new Map()) {
  return text
    .replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id) => `@${names.get(id) ?? id}`)
    .replace(/<#[CG][A-Z0-9]+\|([^>]+)>/g, '#$1')
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, '@$1')
    .replace(/<!subteam\^[A-Z0-9]+\|([^>]+)>/g, '$1')
    .replace(/<([^>|]+)\|([^>]+)>/g, '$2')
    .replace(/<([^>]+)>/g, '$1')
    .replace(/&(amp|lt|gt);/g, (e) => ENTITIES[e]);
}

// Latest top-level messages across a repo's linked channels, each with its thread replies.
export async function threads(repo, limit = 50) {
  const d = db();
  const { url } = await workspace();
  const names = new Map(d.prepare('SELECT id, name FROM users').all().map((u) => [u.id, u.name]));
  const permalink = (m) => `${url}archives/${m.channel_id}/p${m.ts.replace('.', '')}`
    + (m.thread_ts && m.thread_ts !== m.ts ? `?thread_ts=${m.thread_ts}&cid=${m.channel_id}` : '');
  const shape = (m) => ({
    ts: m.ts,
    channel_id: m.channel_id,
    channel: m.channel,
    author: names.get(m.user_id) ?? m.user_name ?? m.user_id ?? 'unknown',
    text: plainText(m.text, names),
    permalink: permalink(m),
  });

  const parents = d.prepare(`
    SELECT m.*, c.name AS channel FROM messages m
    JOIN links l ON l.channel_id = m.channel_id AND l.repo = ?
    JOIN channels c ON c.id = m.channel_id
    WHERE m.thread_ts IS NULL OR m.thread_ts = m.ts
    ORDER BY CAST(m.ts AS REAL) DESC LIMIT ?`).all(repo, limit);
  const replies = d.prepare(`
    SELECT m.*, c.name AS channel FROM messages m JOIN channels c ON c.id = m.channel_id
    WHERE m.channel_id = ? AND m.thread_ts = ? AND m.ts != m.thread_ts
    ORDER BY CAST(m.ts AS REAL)`);

  return parents.map((p) => ({ ...shape(p), replies: p.reply_count ? replies.all(p.channel_id, p.ts).map(shape) : [] }));
}
