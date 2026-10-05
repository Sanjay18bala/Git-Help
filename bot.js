// The GitHelp Slack bot (SLACK_BOT_TOKEN): who's who between GitHub and Slack, and later DMs about overdue work.
// slack.js reads channels as the user; this file is the only place that acts as the bot.
import { db } from './db.js';
import { SlackError } from './slack.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function bot(method, params = {}) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new SlackError('bot_not_configured');
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
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

let identity;
export const botIdentity = async () => (identity ??= await bot('auth.test'));

// ---------- people: GitHub login ↔ Slack user ----------

const norm = (s) => (s ?? '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '');
const first = (s) => norm((s ?? '').trim().split(/\s+/)[0]);
const isNoreply = (email) => /noreply\.github\.com$/i.test(email);

export async function slackPeople() {
  const out = [];
  let cursor;
  do {
    const body = await bot('users.list', cursor ? { limit: 200, cursor } : { limit: 200 });
    for (const u of body.members) {
      if (u.deleted || u.is_bot || u.id === 'USLACKBOT') continue;
      out.push({
        id: u.id,
        handle: u.name,
        real: u.profile?.real_name || '',
        display: u.profile?.display_name || '',
        email: (u.profile?.email || '').toLowerCase(),
      });
    }
    cursor = body.response_metadata?.next_cursor;
  } while (cursor);
  return out;
}

const slackName = (u) => u.display || u.real || u.handle;

async function gh(token, path) {
  const r = await fetch(`https://api.github.com/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (!r.ok) return null; // a missing profile or empty repo just means fewer signals
  return r.json();
}

// Everyone who can be assigned work in these repos, with the names and emails GitHub exposes for them:
// profile names, and commit author names/emails (usually the same work email they use for Slack).
export async function githubPeople(repos, token) {
  const people = new Map();
  const person = (login) => {
    if (!people.has(login)) people.set(login, { login, names: new Set(), emails: new Set() });
    return people.get(login);
  };
  const d = db();
  for (const repo of repos) {
    for (const row of d.prepare('SELECT assignees, author FROM items WHERE repo = ?').all(repo)) {
      for (const login of [row.author, ...row.assignees.split(', ')].filter(Boolean)) person(login);
    }
    for (const c of (await gh(token, `repos/${repo}/contributors?per_page=100`)) ?? []) if (c.type === 'User') person(c.login);
    for (const c of (await gh(token, `repos/${repo}/commits?per_page=100`)) ?? []) {
      if (!c.author?.login) continue;
      const p = person(c.author.login);
      if (c.commit.author.name) p.names.add(c.commit.author.name);
      if (c.commit.author.email && !isNoreply(c.commit.author.email)) p.emails.add(c.commit.author.email.toLowerCase());
    }
  }
  for (const p of [...people.values()].slice(0, 100)) {
    const profile = await gh(token, `users/${p.login}`);
    if (profile?.name) p.names.add(profile.name);
    if (profile?.email) p.emails.add(profile.email.toLowerCase());
  }
  return [...people.values()];
}

// Strongest signal wins; a signal that fits more than one Slack user is skipped, never guessed.
export function matchPerson(gh, slackUsers) {
  const unique = (method, confidence, hits) => (hits.length === 1 ? { user: hits[0], method, confidence } : null);
  const names = [...gh.names];
  const fullNames = new Set(names.filter((n) => n.trim().includes(' ')).map(norm));
  const firstNames = new Set(names.map(first).filter(Boolean));
  return unique('email', 'high', slackUsers.filter((u) => u.email && gh.emails.has(u.email)))
    ?? unique('name', 'high', slackUsers.filter((u) => fullNames.has(norm(u.real)) || fullNames.has(norm(u.display))))
    ?? unique('handle', 'medium', slackUsers.filter((u) => norm(gh.login) === norm(u.handle) || norm(gh.login) === norm(u.display)))
    ?? unique('first-name', 'low', slackUsers.filter((u) => firstNames.has(first(u.real)) || firstNames.has(first(u.display))));
}

// Re-run matching for these repos. High-confidence matches link automatically; medium/low are stored as
// suggestions to confirm; anything the user set by hand is never overwritten.
export async function refreshPeople(repos, token) {
  const [ghPeople, slackUsers] = await Promise.all([githubPeople(repos, token), slackPeople()]);
  const d = db();
  const existing = d.prepare('SELECT method FROM people WHERE github_login = ?');
  const upsert = d.prepare(`INSERT INTO people VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (github_login) DO UPDATE SET slack_user_id = excluded.slack_user_id, slack_name = excluded.slack_name,
      method = excluded.method, confidence = excluded.confidence, confirmed = excluded.confirmed, updated_at = excluded.updated_at`);
  const now = new Date().toISOString();
  for (const p of ghPeople) {
    if (existing.get(p.login)?.method === 'manual') continue;
    const m = matchPerson(p, slackUsers);
    upsert.run(p.login, m?.user.id ?? null, m ? slackName(m.user) : null, m?.method ?? null, m?.confidence ?? null,
      m?.confidence === 'high' ? 1 : 0, now);
  }
  return listPeople();
}

export const listPeople = () => db().prepare('SELECT * FROM people ORDER BY github_login COLLATE NOCASE').all();

// The user confirms a suggestion or picks someone else (or nobody: slackUserId null).
export function setPerson(login, slackUserId, slackDisplayName) {
  db().prepare(`INSERT INTO people VALUES (?, ?, ?, 'manual', 'manual', ?, ?)
    ON CONFLICT (github_login) DO UPDATE SET slack_user_id = excluded.slack_user_id, slack_name = excluded.slack_name,
      method = 'manual', confidence = 'manual', confirmed = excluded.confirmed, updated_at = excluded.updated_at`)
    .run(login, slackUserId, slackUserId ? slackDisplayName : null, slackUserId ? 1 : 0, new Date().toISOString());
  return listPeople();
}

// The Slack user the bot may message about this GitHub login, or null. Only confirmed links count.
export const slackUserFor = (login) =>
  db().prepare('SELECT slack_user_id FROM people WHERE github_login = ? AND confirmed = 1').get(login)?.slack_user_id ?? null;
