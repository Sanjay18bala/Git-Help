import express from 'express';
import crypto from 'node:crypto';
import { seal, unseal } from './secrets.js';
import * as alerts from './alerts.js';
import * as bot from './bot.js';
import * as llm from './llm.js';
import * as rag from './rag.js';
import * as slack from './slack.js';
import { db } from './db.js';

try {
  process.loadEnvFile(); // reads .env; missing keys are reported by checkEnv()
} catch {}

const {
  GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET,
  APP_URL = 'http://localhost:5173',
} = process.env;
const secure = APP_URL.startsWith('https') ? '; Secure' : '';

export { seal, unseal }; // server.test.js imports them from here

// Read-only allowlist: the proxy only reaches the endpoints the UI uses.
const R = 'repos/[\\w.-]+/[\\w.-]+';
const ALLOWED = [
  /^user$/,
  /^user\/repos$/,
  new RegExp(`^${R}(/(readme|languages|contributors|branches|commits|pulls|issues|releases|actions/runs))?$`),
  new RegExp(`^${R}/(pulls|issues)/\\d+(/(comments|files|reviews))?$`),
];
export const isAllowed = (p) =>
  !p.split('/').some((s) => s === '.' || s === '..') && ALLOWED.some((re) => re.test(p));

const cookies = (req) => Object.fromEntries(
  (req.headers.cookie ?? '').split(/;\s*/).filter(Boolean).map((c) => {
    const i = c.indexOf('=');
    return [c.slice(0, i), c.slice(i + 1)];
  }),
);
const cookie = (name, value, maxAge) =>
  `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;

export function checkEnv() {
  const missing = ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'SESSION_SECRET'].filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`Missing ${missing.join(', ')} in .env. Copy .env.example to .env and fill it in (see README).`);
  }
}

// Mounted into the Vite dev server by vite.config.js.
export const app = express();

app.get('/auth/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  res.append('Set-Cookie', cookie('oauth_state', state, 600));
  const q = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    redirect_uri: `${APP_URL}/auth/callback`,
    // OAuth Apps have no read-only private-repo scope; read-only is enforced by the proxy (GET + allowlist).
    scope: 'repo read:org',
    state,
  });
  res.redirect(`https://github.com/login/oauth/authorize?${q}`);
});

app.get('/auth/callback', async (req, res) => {
  const { code, state, error: denied } = req.query;
  res.append('Set-Cookie', cookie('oauth_state', '', 0));
  if (typeof denied === 'string') return res.redirect(`/?error=${encodeURIComponent(denied)}`); // e.g. access_denied
  if (!code || !state || state !== cookies(req).oauth_state) return res.redirect('/?error=state_mismatch');

  const r = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      client_secret: GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${APP_URL}/auth/callback`,
    }),
  });
  const { access_token, error } = await r.json();
  if (!access_token) return res.redirect(`/?error=${encodeURIComponent(error ?? 'oauth_failed')}`);

  res.append('Set-Cookie', cookie('session', seal({ token: access_token }), 60 * 60 * 24 * 30));
  alerts.rememberGithubToken(access_token); // for the overdue check, which runs with no browser open
  res.redirect('/repos');
});

app.post('/auth/logout', (req, res) => {
  res.append('Set-Cookie', cookie('session', '', 0));
  alerts.forgetGithubToken();
  res.sendStatus(204);
});

app.use('/api/gh', async (req, res) => {
  if (req.method !== 'GET') return res.sendStatus(405);
  const token = unseal(cookies(req).session ?? '')?.token;
  if (!token) return res.status(401).json({ message: 'Not signed in' });
  const path = req.path.slice(1);
  if (!isAllowed(path)) return res.status(403).json({ message: 'Endpoint not allowed' });

  const accept = req.get('accept') ?? '';
  const qs = req.originalUrl.split('?')[1];
  const gh = await fetch(`https://api.github.com/${path}${qs ? `?${qs}` : ''}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: /^application\/vnd\.github\.[\w.+-]+$/.test(accept) ? accept : 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  for (const h of ['content-type', 'link', 'x-ratelimit-remaining']) {
    const v = gh.headers.get(h);
    if (v) res.set(h, v);
  }
  if (gh.status === 401) res.append('Set-Cookie', cookie('session', '', 0)); // token revoked
  res.status(gh.status).send(Buffer.from(await gh.arrayBuffer()));
});

// ---- Slack: link channels to repos and keep a local copy of their messages (see slack.js) ----
// ponytail: one Slack token and one local database for the whole app, i.e. single-user; per-user storage if shared.
const REPO = /^[\w.-]+\/[\w.-]+$/;
const CHANNEL = /^[CG][A-Z0-9]+$/;
const slackApi = express.Router();

// Every /api/slack, /api/settings, /api/index and /api/chat route needs a GitHub session; req.token is its token.
const requireSession = (req, res, next) => {
  req.token = unseal(cookies(req).session ?? '')?.token;
  if (!req.token) return res.status(401).json({ message: 'Not signed in' });
  alerts.rememberGithubToken(req.token); // sessions from before this feature get stored too
  next();
};
slackApi.use(requireSession, express.json());

// Keep the RAG index in step with synced messages. Indexing needs the embedding model, so a failure there
// (e.g. Ollama not running) is reported alongside the sync instead of failing it.
const reindex = async (channelIds) => {
  try {
    for (const id of channelIds) await rag.indexSlack(id);
    return null;
  } catch (e) {
    return `Synced, but the search index wasn't updated: ${e.message}`;
  }
};

const repoParam = (v) => {
  if (typeof v !== 'string' || !REPO.test(v)) throw Object.assign(new Error('Invalid repo'), { status: 400 });
  return v;
};
const channelParam = (v) => {
  if (typeof v !== 'string' || !CHANNEL.test(v)) throw Object.assign(new Error('Invalid channel id'), { status: 400 });
  return v;
};
const syncRepo = async (repo, full) => {
  const ids = slack.links().filter((l) => l.repo === repo).map((l) => l.channel_id);
  const results = [];
  for (const id of ids) results.push(await slack.sync(id, { full })); // sequential: kinder to Slack's rate limits
  return results;
};

slackApi.get('/status', async (req, res) => {
  if (!process.env.SLACK_USER_TOKEN) return res.json({ configured: false });
  try {
    const { team, user, url } = await slack.workspace();
    res.json({ configured: true, team, user, url });
  } catch (e) {
    res.json({ configured: false, error: slack.friendly(e.message) });
  }
});

slackApi.get('/channels', async (req, res) => res.json(await slack.listChannels()));

slackApi.get('/links', (req, res) => res.json(slack.links()));

slackApi.post('/links', async (req, res) => {
  const repo = repoParam(req.body?.repo);
  const channelId = channelParam(req.body?.channel_id);
  await slack.link(repo, channelId);
  const result = await slack.sync(channelId);
  res.json({ links: slack.links(), result, index_error: await reindex([channelId]) });
});

slackApi.delete('/links', (req, res) => {
  slack.unlink(repoParam(req.query.repo), channelParam(req.query.channel_id));
  res.json({ links: slack.links() });
});

slackApi.post('/sync', async (req, res) => {
  const results = await syncRepo(repoParam(req.body?.repo), req.body?.full === true);
  res.json({ links: slack.links(), results, index_error: await reindex(results.map((r) => r.channel_id)) });
});

slackApi.get('/threads', async (req, res) => res.json(await slack.threads(repoParam(req.query.repo))));

// ---- LLM settings, RAG index and chat (see llm.js, rag.js) ----
const api = express.Router();
api.use(requireSession, express.json());

api.get('/settings', (req, res) => res.json(llm.publicSettings()));
api.put('/settings', (req, res) => res.json(llm.saveSettings(req.body)));
api.get('/settings/models', async (req, res) => res.json(await llm.listModels(req.query.provider)));
api.post('/settings/test', async (req, res) => res.json(await llm.testSettings()));

const optionalRepo = (v) => (v == null || v === '' ? null : repoParam(v));

api.get('/index', (req, res) => res.json(rag.indexStats(optionalRepo(req.query.repo))));
api.post('/index', async (req, res) => {
  const repo = repoParam(req.body?.repo);
  await rag.indexGithub(repo, req.token);
  for (const { channel_id } of slack.links().filter((l) => l.repo === repo)) await rag.indexSlack(channel_id);
  res.json(rag.indexStats(repo));
});

// ---- Slack bot: status and GitHub ↔ Slack people links (see bot.js) ----
api.get('/bot/status', async (req, res) => {
  if (!process.env.SLACK_BOT_TOKEN) return res.json({ configured: false });
  try {
    const { user, team } = await bot.botIdentity();
    res.json({ configured: true, user, team, socket: process.env.SLACK_APP_TOKEN ? alerts.socketState() : 'no SLACK_APP_TOKEN' });
  } catch (e) {
    res.json({ configured: false, error: slack.friendly(e.message) });
  }
});
const indexedRepos = () => db().prepare('SELECT repo FROM indexed_repos').all().map((r) => r.repo);
api.get('/repos/indexed', (req, res) => res.json(indexedRepos()));
api.get('/people', async (req, res) => res.json({ people: bot.listPeople(), slackUsers: await bot.slackPeople() }));
api.post('/people/match', async (req, res) => res.json({ people: await bot.refreshPeople(indexedRepos(), req.token) }));
api.put('/people/:login', async (req, res) => {
  const login = req.params.login;
  const id = req.body?.slack_user_id ?? null;
  if (!/^[\w-]{1,39}$/.test(login) || (id !== null && !/^[UW][A-Z0-9]+$/.test(id))) {
    throw Object.assign(new Error('Invalid login or Slack user'), { status: 400 });
  }
  const user = id && (await bot.slackPeople()).find((u) => u.id === id);
  if (id && !user) throw Object.assign(new Error('Unknown Slack user'), { status: 400 });
  res.json({ people: bot.setPerson(login, id, user && (user.display || user.real || user.handle)) });
});

// ---- Overdue alerts (see alerts.js) ----
api.get('/alerts', (req, res) => {
  const repo = repoParam(req.query.repo);
  const { send, cannot } = alerts.planAlerts();
  res.json({
    enabled: alerts.alertRepos().includes(repo),
    send: send.filter((a) => a.repo === repo),
    cannot: cannot.filter((a) => a.repo === repo),
    log: alerts.alertLog(repo),
  });
});
api.put('/alerts', (req, res) => {
  alerts.setAlerts(repoParam(req.body?.repo), req.body?.enabled === true);
  res.json({ repos: alerts.alertRepos() });
});
api.post('/alerts/send', async (req, res) => {
  const repo = repoParam(req.body?.repo);
  await rag.indexGithub(repo, req.token); // decide on fresh states and due dates
  res.json({ sent: (await alerts.sendAlerts()).filter((a) => a.repo === repo) });
});
api.get('/followups', (req, res) => {
  const number = Number(req.query.number);
  if (!Number.isInteger(number) || number < 1) throw Object.assign(new Error('Invalid number'), { status: 400 });
  res.json(alerts.followupsFor(repoParam(req.query.repo), number));
});

const chatMessages = (v) => {
  const ok = Array.isArray(v) && v.length > 0 && v.length <= 40 && v.at(-1)?.role === 'user'
    && v.every((m) => ['user', 'assistant'].includes(m?.role) && typeof m.content === 'string' && m.content.length <= 8000);
  if (!ok) throw Object.assign(new Error('Invalid messages'), { status: 400 });
  return v.map(({ role, content }) => ({ role, content }));
};

// Streams NDJSON events: status*, sources, token*, then done or error.
api.post('/chat', async (req, res) => {
  const repo = optionalRepo(req.body?.repo);
  const messages = chatMessages(req.body?.messages);
  const ac = new AbortController();
  res.on('close', () => ac.abort()); // the browser stopped or navigated away
  res.set({ 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
  const send = (event) => res.write(`${JSON.stringify(event)}\n`);
  try {
    const mode = await rag.route(messages, ac.signal, repo); // small talk skips indexing and retrieval
    if (mode === 'project') await rag.ensureIndexed(repo, req.token, (text) => send({ type: 'status', text }));
    for await (const event of rag.answer({ repo, messages, signal: ac.signal, mode })) send(event);
    send({ type: 'done' });
  } catch (e) {
    if (ac.signal.aborted) return res.end();
    const known = e instanceof llm.LlmError || e instanceof rag.RagError || e instanceof slack.SlackError;
    if (!known) console.error(e);
    send({ type: 'error', message: e instanceof slack.SlackError ? slack.friendly(e.message) : known ? e.message : 'Something went wrong. Check the terminal running npm run dev.' });
  }
  res.end();
});

const errors = (err, req, res, next) => { // the 4-argument signature is what makes this Express's error handler
  if (err.status) return res.status(err.status).json({ message: err.message });
  if (err instanceof slack.SlackError) return res.status(502).json({ message: slack.friendly(err.message) });
  if (err instanceof llm.LlmError || err instanceof rag.RagError) return res.status(502).json({ message: err.message });
  console.error(err);
  res.status(500).json({ message: 'Something went wrong. Check the terminal running npm run dev.' });
};
slackApi.use(errors);
api.use(errors);

app.use('/api/slack', slackApi);
app.use('/api', api);
