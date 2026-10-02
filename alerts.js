// Overdue alerts: the bot DMs the assignee of an open issue that is past its milestone due date, records their
// reply ("followup"), and makes it available to the issue page and the chat. Off until enabled per repo.
import { db } from './db.js';
import { bot, slackUserFor } from './bot.js';
import { seal, unseal } from './secrets.js';
import { daysLate, indexGithub, indexFollowups, localDate } from './rag.js';

const REMIND_AFTER_DAYS = 3; // one reminder if there's been no reply; then nothing until the due date changes
const CHECK_EVERY_MS = 15 * 60_000;

// ---------- settings: which repos may send alerts, and the GitHub token the background job uses ----------

const getSetting = (key, fallback) => JSON.parse(db().prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? JSON.stringify(fallback));
const putSetting = (key, value) => db().prepare('INSERT INTO settings VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
  .run(key, JSON.stringify(value));

export const alertRepos = () => getSetting('alerts', { repos: [] }).repos;
export function setAlerts(repo, enabled) {
  const repos = new Set(alertRepos());
  if (enabled) repos.add(repo); else repos.delete(repo);
  putSetting('alerts', { repos: [...repos].sort() });
}

// The background check runs with nobody's browser open, so it needs a GitHub token of its own: the signed-in
// user's, sealed with SESSION_SECRET, removed on sign-out. ponytail: single-user app, so one stored token.
export function rememberGithubToken(token) {
  if (unseal(getSetting('github', {}).token ?? '')?.token !== token) putSetting('github', { token: seal({ token }) });
}
export const forgetGithubToken = () => db().prepare("DELETE FROM settings WHERE key = 'github'").run();
const storedGithubToken = () => unseal(getSetting('github', {}).token ?? '')?.token ?? null;

// ---------- planning ----------

// Who would be messaged right now, and who can't be. Pure: reads the database, sends nothing.
export function planAlerts(today = localDate(), now = Date.now()) {
  const d = db();
  const send = [];
  const cannot = [];
  const lastAlert = d.prepare(`SELECT * FROM alerts WHERE repo = ? AND number = ? AND github_login = ? AND due_on = ?
    ORDER BY sent_at DESC LIMIT 1`);
  const replied = d.prepare('SELECT 1 FROM followups WHERE alert_id IN (SELECT id FROM alerts WHERE repo = ? AND number = ? AND github_login = ?) LIMIT 1');
  for (const repo of alertRepos()) {
    const overdue = d.prepare("SELECT * FROM items WHERE repo = ? AND kind = 'issue' AND state = 'open' AND due_on IS NOT NULL").all(repo)
      .filter((i) => daysLate(i.due_on, today) > 0);
    for (const i of overdue) {
      const base = { repo, number: i.number, title: i.title, url: i.url, milestone: i.milestone, due_on: i.due_on, days_late: daysLate(i.due_on, today) };
      if (!i.assignees) {
        cannot.push({ ...base, login: null, reason: 'nobody is assigned' });
        continue;
      }
      for (const login of i.assignees.split(', ')) {
        const slackUser = slackUserFor(login);
        if (!slackUser) {
          cannot.push({ ...base, login, reason: 'no confirmed Slack link (Settings → slack bot)' });
          continue;
        }
        const last = lastAlert.get(repo, i.number, login, i.due_on);
        if (!last) send.push({ ...base, login, slack_user_id: slackUser, kind: 'first' });
        else if (last.kind === 'first' && !replied.get(repo, i.number, login)
          && now - Date.parse(last.sent_at) >= REMIND_AFTER_DAYS * 86_400_000) {
          send.push({ ...base, login, slack_user_id: slackUser, kind: 'reminder' });
        }
      }
    }
  }
  return { send, cannot };
}

const dayLabel = (ymd) => new Date(`${ymd}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

export function alertText(a) {
  const link = `<${a.url}|#${a.number} ${a.title.replace(/[<>|]/g, '')}>`;
  const late = `${a.days_late} day${a.days_late === 1 ? '' : 's'} ago`;
  return a.kind === 'reminder'
    ? `Quick reminder: ${link} in ${a.repo} is still open (due ${dayLabel(a.due_on)}, ${late}). What's holding it up? `
      + 'Reply in this thread and I\'ll pass it on when someone asks.'
    : `Hi! ${link} in ${a.repo} was due ${dayLabel(a.due_on)} (milestone ${a.milestone}, ${late}) and is still open. `
      + 'What\'s holding it up? Reply in this thread and I\'ll pass it on when someone asks. '
      + 'If the date is wrong, update the milestone on GitHub.';
}

// ---------- sending ----------

export async function sendAlerts() {
  const { send } = planAlerts();
  const log = db().prepare(`INSERT INTO alerts (repo, number, github_login, slack_user_id, due_on, kind, sent_at, channel_id, message_ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const sent = [];
  for (const a of send) {
    const { channel } = await bot('conversations.open', { users: a.slack_user_id });
    const msg = await bot('chat.postMessage', { channel: channel.id, text: alertText(a), unfurl_links: 'false' });
    log.run(a.repo, a.number, a.login, a.slack_user_id, a.due_on, a.kind, new Date().toISOString(), channel.id, msg.ts);
    sent.push(a);
  }
  return sent;
}

export const alertLog = (repo, limit = 20) => db().prepare(`SELECT a.*, f.text AS reply, f.created_at AS replied_at FROM alerts a
  LEFT JOIN followups f ON f.alert_id = a.id WHERE a.repo = ? ORDER BY a.sent_at DESC LIMIT ?`).all(repo, limit);

// ---------- replies (Socket Mode) ----------

// A DM reply belongs to the alert it threads under, or else to the latest alert in that DM.
export async function recordReply(event) {
  const d = db();
  const alert = (event.thread_ts && d.prepare('SELECT * FROM alerts WHERE channel_id = ? AND message_ts = ?').get(event.channel, event.thread_ts))
    ?? d.prepare('SELECT * FROM alerts WHERE channel_id = ? AND sent_at <= ? ORDER BY sent_at DESC LIMIT 1')
      .get(event.channel, new Date(Number(event.ts) * 1000).toISOString());
  if (!alert) return null; // just chatting with the bot
  let permalink = null;
  try {
    permalink = (await bot('chat.getPermalink', { channel: event.channel, message_ts: event.ts })).permalink;
  } catch { /* the reply is still worth keeping without a link */ }
  d.prepare(`INSERT OR IGNORE INTO followups (alert_id, repo, number, github_login, slack_user_id, text, ts, permalink, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(alert.id, alert.repo, alert.number, alert.github_login, event.user, event.text ?? '', event.ts, permalink, new Date().toISOString());
  await bot('chat.postMessage', {
    channel: event.channel, thread_ts: event.thread_ts ?? event.ts,
    text: `Thanks, noted for #${alert.number}. I'll share it when someone asks why it's late.`,
  });
  await indexFollowups(alert.repo).catch(() => {}); // searchable now; re-indexing also picks it up later
  return alert;
}

export const followupsFor = (repo, number) => db().prepare(`SELECT github_login, text, permalink, created_at FROM followups
  WHERE repo = ? AND number = ? ORDER BY created_at DESC`).all(repo, number);

const seen = new Set(); // Slack can redeliver an event; handle each once
// One background job per process, even across Vite's server restarts (each restart re-imports this module but the
// previous copy's timers and socket keep running), so it lives on globalThis and a new start stops the old one.
const job = () => (globalThis.__gitHelpAlerts ??= { state: 'off', stopped: true, timers: [], ws: null });
export const socketState = () => job().state;

export async function connectSocket(me = job()) {
  const appToken = process.env.SLACK_APP_TOKEN;
  if (!appToken || !process.env.SLACK_BOT_TOKEN || me.stopped) return;
  const socket = me;
  socket.state = 'connecting';
  try {
    const r = await fetch('https://slack.com/api/apps.connections.open', { method: 'POST', headers: { Authorization: `Bearer ${appToken}` } });
    const { ok, url, error } = await r.json();
    if (!ok) throw new Error(error);
    if (me.stopped) return;
    const ws = new WebSocket(url);
    me.ws = ws;
    ws.onmessage = async ({ data }) => {
      const msg = JSON.parse(data);
      if (msg.type === 'hello') socket.state = 'connected';
      if (msg.type === 'disconnect') ws.close();
      if (msg.envelope_id) ws.send(JSON.stringify({ envelope_id: msg.envelope_id })); // ack within 3s or Slack retries
      const event = msg.payload?.event;
      const id = msg.payload?.event_id;
      if (msg.type !== 'events_api' || !event || seen.has(id)) return;
      seen.add(id);
      if (seen.size > 500) seen.delete(seen.values().next().value);
      if (event.type === 'message' && event.channel_type === 'im' && !event.bot_id && !event.subtype && event.user) {
        await recordReply(event).catch((e) => console.error('[alerts] could not record reply:', e.message));
      }
    };
    ws.onclose = () => {
      if (me.stopped) return;
      socket.state = 'reconnecting';
      me.timers.push(setTimeout(() => connectSocket(me), 5000));
    };
  } catch (e) {
    socket.state = `error: ${e.message}`;
    if (!me.stopped) me.timers.push(setTimeout(() => connectSocket(me), 60_000));
  }
}

// ---------- background ----------

export async function checkNow() {
  const token = storedGithubToken();
  if (!token) return { skipped: 'no stored GitHub token yet: sign in once' };
  for (const repo of alertRepos()) await indexGithub(repo, token); // fresh states and due dates before deciding
  return { sent: await sendAlerts() };
}

export function stopBackground() {
  const old = globalThis.__gitHelpAlerts;
  if (!old) return;
  old.stopped = true;
  old.timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
  old.ws?.close();
  delete globalThis.__gitHelpAlerts;
}

export function startBackground() {
  stopBackground(); // replaces a job left running by a previous copy of this module
  const me = job();
  me.stopped = false;
  connectSocket(me);
  const tick = () => checkNow().catch((e) => console.error('[alerts] check failed:', e.message));
  me.timers.push(setTimeout(tick, 30_000), setInterval(tick, CHECK_EVERY_MS));
}
