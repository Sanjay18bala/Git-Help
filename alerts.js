// Overdue alerts: the bot DMs the assignee of an open issue that is past its milestone due date, records their
// reply ("followup"), and makes it available to the issue page and the chat. Off until enabled per repo.
import { db } from './db.js';
import { bot, slackUserFor } from './bot.js';
import { seal, unseal } from './secrets.js';
import { attention, daysLate, indexGithub, indexFollowups, latestEta, localDate } from './rag.js';
import { dayLong, parseDate } from './dates.js';
import { links as slackLinks } from './slack.js';

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
        const eta = latestEta(repo, i.number);
        if (eta && eta.due_date >= today) continue; // they named a date that hasn't come yet: wait for it
        if (eta) { // that date passed and the issue is still open: ask once per missed date
          const nudged = d.prepare("SELECT 1 FROM alerts WHERE repo = ? AND number = ? AND github_login = ? AND kind = 'eta' AND due_on = ?")
            .get(repo, i.number, login, eta.due_date);
          if (!nudged) send.push({ ...base, login, slack_user_id: slackUser, kind: 'eta', due_on: eta.due_date, eta: eta.due_date });
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
  if (a.kind === 'eta') {
    return `${link} in ${a.repo} was expected by ${dayLong(a.eta)} and is still open. Any update? When do you now expect to finish it?`;
  }
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
  const text = event.text ?? '';
  const now = new Date().toISOString();
  const today = localDate();
  const n = `#${alert.number}`;
  const saveReason = () => d.prepare(`INSERT OR IGNORE INTO followups (alert_id, repo, number, github_login, slack_user_id, text, ts, permalink, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(alert.id, alert.repo, alert.number, alert.github_login, event.user, text, event.ts, permalink, now);
  const saveEta = (date) => d.prepare(`INSERT OR IGNORE INTO etas (alert_id, repo, number, github_login, due_date, text, ts, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(alert.id, alert.repo, alert.number, alert.github_login, date, text, event.ts, now);
  // The first reply to an alert is the reason; then the bot asks for a date until it gets one. A reply that names
  // a date (even inside the reason, "sick, done by Friday") sets the expected date.
  const date = parseDate(text, today);
  const hasReason = d.prepare('SELECT 1 FROM followups WHERE alert_id = ?').get(alert.id);
  const hasEta = d.prepare('SELECT 1 FROM etas WHERE alert_id = ?').get(alert.id);
  let reply;
  if (!hasReason) {
    saveReason();
    if (date && date >= today) {
      saveEta(date);
      reply = `Thanks, noted for ${n}, expected by ${dayLong(date)}. I'll share it when someone asks why it's late.`;
    } else {
      reply = `Thanks, noted for ${n}. When do you expect to finish it? A day or a date is fine, like Friday or Oct 9.`;
    }
  } else if (date && date >= today) {
    saveEta(date);
    reply = `Got it: ${n} by ${dayLong(date)}. I'll check in if it's still open after that.`;
  } else if (date) {
    reply = `${dayLong(date)} has already passed. When do you expect to finish ${n}?`;
  } else if (!hasEta) {
    reply = `I couldn't find a date in that. When do you expect to finish ${n}? For example Friday, Oct 9, or in 3 days.`;
  } else {
    saveReason();
    reply = `Thanks, noted for ${n}.`;
  }
  await bot('chat.postMessage', { channel: event.channel, thread_ts: event.thread_ts ?? event.ts, text: reply });
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

// ---------- digest: what's late, posted to the repo's linked Slack channels ----------

export const DIGEST_HOUR = 9; // local time; the first background check after it posts
export const digestSchedules = () => getSetting('digest', { repos: {} }).repos;
export function setDigest(repo, schedule) {
  const repos = { ...digestSchedules() };
  if (schedule === 'off') delete repos[repo]; else repos[repo] = schedule;
  putSetting('digest', { repos });
}

// Which digest is due at `now`: one per weekday ("daily") or one per week from Monday ("weekly"), never before
// DIGEST_HOUR. Returns that period's id, or null when nothing is due yet.
export function digestPeriod(schedule, now = new Date()) {
  if (now.getHours() < DIGEST_HOUR) return null;
  const day = now.getDay();
  if (schedule === 'daily') return day === 0 || day === 6 ? null : localDate(now);
  if (schedule === 'weekly') {
    const monday = new Date(now);
    monday.setDate(now.getDate() - ((day + 6) % 7));
    return `week of ${localDate(monday)}`;
  }
  return null;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clip = (t, n) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
const eventDay = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

// The digest message (Slack mrkdwn) for a repo, from the same data as the Overview. A daily digest with nothing
// late and nothing due within 3 days returns null, so quiet days stay quiet; a weekly one always posts.
export function digestText(repo, att, { schedule = 'weekly' } = {}) {
  const name = repo.split('/')[1];
  const late = att.overdue;
  const soon = att.due_soon.filter((i) => schedule === 'weekly' || i.days_late >= -3);
  if (schedule === 'daily' && !late.length && !soon.length) return null;
  const lines = [];
  const milestones = [...new Set(late.map((i) => i.milestone))];
  lines.push(late.length
    ? `*${esc(name)}* · ${plural(late.length, 'item')} past due${milestones.length === 1 ? ` in ${esc(milestones[0])}` : ''}`
    : `*${esc(name)}* · nothing is past due`);
  for (const i of late.slice(0, 10)) {
    const who = i.assignees.join(', ');
    const expect = !i.eta ? '' : i.eta.days_past > 0 ? ` · missed ${eventDay(`${i.eta.date}T12:00:00`)}` : ` · expects ${eventDay(`${i.eta.date}T12:00:00`)}`;
    const why = i.reason ? `${esc(i.reason.github_login)}: “${esc(clip(i.reason.text.replace(/\s+/g, ' '), 140))}”${expect}`
      : !who ? 'no owner'
        : i.alerted_at ? `${esc(who)} · asked ${eventDay(i.alerted_at)}, no reply` : `${esc(who)} · not asked yet`;
    lines.push(`• <${i.url}|#${i.number} ${esc(i.title)}> · ${plural(i.days_late, 'day')} late · ${why}`);
  }
  if (late.length > 10) lines.push(`…and ${late.length - 10} more`);
  const byMilestone = new Map();
  for (const i of soon) byMilestone.set(i.milestone, [...(byMilestone.get(i.milestone) ?? []), i]);
  for (const [m, items] of byMilestone) {
    const days = -items[0].days_late;
    lines.push(`Next up: ${esc(m)} due ${eventDay(`${items[0].due_on}T12:00:00`)} (${days === 0 ? 'today' : `in ${plural(days, 'day')}`}) · ${plural(items.length, 'item')}`);
  }
  return lines.join('\n');
}

// Post the digest to every channel linked to the repo. Returns one result per channel; a channel the bot can't
// post in gets an instruction instead of failing the others.
export async function sendDigest(repo, { period = null, schedule = 'weekly' } = {}) {
  const text = digestText(repo, attention(repo), { schedule });
  const channels = slackLinks().filter((l) => l.repo === repo);
  const log = db().prepare('INSERT INTO digests (repo, channel_id, channel_name, period, sent_at, ts) VALUES (?, ?, ?, ?, ?, ?)');
  if (!text) {
    if (period) log.run(repo, '', null, period, new Date().toISOString(), null);
    return [];
  }
  const results = [];
  for (const c of channels) {
    try {
      const msg = await bot('chat.postMessage', { channel: c.channel_id, text, unfurl_links: 'false', unfurl_media: 'false' });
      log.run(repo, c.channel_id, c.name, period, new Date().toISOString(), msg.ts);
      results.push({ channel: c.name, ok: true });
    } catch (e) {
      results.push({ channel: c.name, ok: false,
        error: e.message === 'not_in_channel' ? `Add the GitHelp bot to #${c.name} first: type /invite @GitHelp in that channel.` : e.message });
    }
  }
  return results;
}

export const digestLog = (repo, limit = 5) => db().prepare(`SELECT channel_name, period, sent_at FROM digests
  WHERE repo = ? AND channel_id != '' ORDER BY sent_at DESC LIMIT ?`).all(repo, limit);

// Scheduled digests that are due and not yet posted for their period.
export async function runDigests(now = new Date()) {
  const done = db().prepare('SELECT 1 FROM digests WHERE repo = ? AND period = ?');
  const sent = [];
  for (const [repo, schedule] of Object.entries(digestSchedules())) {
    const period = digestPeriod(schedule, now);
    if (!period || done.get(repo, period)) continue;
    sent.push({ repo, results: await sendDigest(repo, { period, schedule }) });
  }
  return sent;
}

// ---------- background ----------

export async function checkNow() {
  const token = storedGithubToken();
  if (!token) return { skipped: 'no stored GitHub token yet: sign in once' };
  const repos = new Set([...alertRepos(), ...Object.keys(digestSchedules())]);
  for (const repo of repos) await indexGithub(repo, token); // fresh states and due dates before deciding
  return { sent: await sendAlerts(), digests: await runDigests() };
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
