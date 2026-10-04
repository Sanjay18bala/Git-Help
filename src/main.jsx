import {
  Component, Fragment, StrictMode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import { createRoot } from 'react-dom/client';
import {
  BrowserRouter, Link, NavLink, Outlet, Route, Routes, useLocation, useNavigate, useParams, useSearchParams,
} from 'react-router';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';
import hljsBash from 'highlight.js/lib/languages/bash';
import hljsCss from 'highlight.js/lib/languages/css';
import hljsGo from 'highlight.js/lib/languages/go';
import hljsJava from 'highlight.js/lib/languages/java';
import hljsJs from 'highlight.js/lib/languages/javascript';
import hljsJson from 'highlight.js/lib/languages/json';
import hljsMd from 'highlight.js/lib/languages/markdown';
import hljsPy from 'highlight.js/lib/languages/python';
import hljsRust from 'highlight.js/lib/languages/rust';
import hljsSql from 'highlight.js/lib/languages/sql';
import hljsTs from 'highlight.js/lib/languages/typescript';
import hljsXml from 'highlight.js/lib/languages/xml';
import hljsYaml from 'highlight.js/lib/languages/yaml';
import './style.css';

// "3 days ago"; exact date and time on hover via <time title> where it's rendered as an element.
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
function ago(iso) {
  const secs = (Date.parse(iso) - Date.now()) / 1000;
  for (const [unit, size] of [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]]) {
    if (Math.abs(secs) >= size) return rtf.format(Math.round(secs / size), unit);
  }
  return 'just now';
}
const date = (s) => (s ? ago(s) : '');
const Time = ({ value }) => (value ? <time dateTime={value} title={new Date(value).toLocaleString()}>{ago(value)}</time> : null);

// Browser tab title per page, like GitHub's "#14 Title · owner/repo".
const useTitle = (title) => useEffect(() => { document.title = title ? `${title} · GitHelp` : 'GitHelp'; }, [title]);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// Milestone due dates are calendar dates (GitHub stores them as midnight UTC), so compare date parts: as a
// timestamp, "due Sep 29" would show as Sep 28 west of UTC. Same rule as daysLate() in rag.js.
const localDay = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const shortDay = (ymd) => new Date(`${ymd}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
function deadline(item) {
  const due = item.milestone?.due_on?.slice(0, 10);
  if (!due || item.state !== 'open') return null; // closed work isn't late
  const late = Math.round((Date.parse(localDay()) - Date.parse(due)) / 86_400_000);
  return {
    late,
    text: late > 0 ? `${plural(late, 'day')} late` : late === 0 ? 'Due today' : `Due ${shortDay(due)}`,
    title: `${item.milestone.title}: due ${shortDay(due)}`,
  };
}
function DueBadge({ item }) {
  const d = deadline(item);
  if (!d) return null;
  return <span className={`badge${d.late > 0 ? ' late' : d.late >= -3 ? ' soon' : ''}`} title={d.title}>{d.text}</span>;
}
// GitHub Actions run → badge tone: passed green, failed red, still going amber, skipped/cancelled neutral.
const runTone = (r) => (r.conclusion === 'success' ? 'ok'
  : ['failure', 'timed_out', 'startup_failure'].includes(r.conclusion) ? 'late'
    : r.conclusion ? '' : 'warn');
// State icons: GitHub Octicons (MIT, https://github.com/primer/octicons), colored like the badges.
const ICON_PATHS = {
  issueOpen: 'M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z',
  issueClosed: 'M11.28 6.78a.75.75 0 0 0-1.06-1.06L7.25 8.69 5.78 7.22a.75.75 0 0 0-1.06 1.06l2 2a.75.75 0 0 0 1.06 0l3.5-3.5ZM16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0Zm-1.5 0a6.5 6.5 0 1 0-13 0 6.5 6.5 0 0 0 13 0Z',
  issueSkipped: 'M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm9.78-2.22-5.5 5.5a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l5.5-5.5a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042Z',
  pr: 'M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z',
  merged: 'M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0 0 .005V3.25Z',
  prClosed: 'M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 5.5a.75.75 0 0 1 .75.75v3.378a2.251 2.251 0 1 1-1.5 0V7.25a.75.75 0 0 1 .75-.75Zm-2.03-5.273a.75.75 0 0 1 1.06 0l.97.97.97-.97a.748.748 0 0 1 1.265.332.75.75 0 0 1-.205.729l-.97.97.97.97a.751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018l-.97-.97-.97.97a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l.97-.97-.97-.97a.75.75 0 0 1 0-1.06ZM2.5 12.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm9.5 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm-9-9.5a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z',
  comment: 'M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 13.25 12H9.06l-2.573 2.573A1.458 1.458 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h4.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z',
};
const Octicon = ({ name, tone, label, size = 16 }) => (
  <svg className={`octicon ${tone ?? ''}`} viewBox="0 0 16 16" width={size} height={size} fill="currentColor" role="img" aria-label={label}>
    <path d={ICON_PATHS[name]} />
  </svg>
);
function StateIcon({ item }) {
  if (item.pull_request || item.head) { // a PR (from the issues API or the pulls API)
    const merged = item.merged_at ?? item.pull_request?.merged_at;
    if (merged) return <Octicon name="merged" tone="merged" label="merged" />;
    if (item.state === 'closed') return <Octicon name="prClosed" tone="muted" label="closed" />;
    return <Octicon name="pr" tone={item.draft ? 'muted' : 'ok'} label={item.draft ? 'draft' : 'open'} />;
  }
  if (item.state === 'open') return <Octicon name="issueOpen" tone="ok" label="open" />;
  return item.state_reason === 'not_planned'
    ? <Octicon name="issueSkipped" tone="muted" label="closed as not planned" />
    : <Octicon name="issueClosed" tone="merged" label="closed" />;
}
// Right side of a row: comment count and assignee avatars.
function RowMeta({ item }) {
  return (
    <span className="row-meta">
      {item.comments > 0 && <span className="row-comments" title={plural(item.comments, 'comment')}><Octicon name="comment" label="comments" size={14} />{item.comments}</span>}
      {item.assignees?.length > 0 && (
        <span className="avatars" title={`assigned to ${item.assignees.map((a) => a.login).join(', ')}`}>
          {item.assignees.slice(0, 3).map((a) => <img key={a.login} src={a.avatar_url} alt={a.login} width="20" height="20" />)}
        </span>
      )}
    </span>
  );
}
const milestoneText = (m) => (m ? `${m.title}${m.due_on ? ` (due ${shortDay(m.due_on.slice(0, 10))})` : ''}` : '');
const dateTime = (s) => (s ? new Date(s).toLocaleString() : 'never');
const slackTime = (ts) => new Date(Number(ts) * 1000).toLocaleString();

// Same request within a few seconds (e.g. the tab counts and the Overview both want /attention): share one fetch.
const apiCache = new Map();
function apiCached(path, ttlMs = 10_000) {
  const hit = apiCache.get(path);
  if (hit && Date.now() - hit.at < ttlMs) return hit.promise;
  const promise = api(path);
  apiCache.set(path, { at: Date.now(), promise });
  promise.catch(() => apiCache.delete(path));
  return promise;
}

// JSON calls to our own /api routes (server.js); throws the server's message on failure.
async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body && JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.message ?? `HTTP ${r.status}`);
  return data;
}

// Slack connection status + every repo↔channel link, shared by the link buttons, Slack tab and chat panel.
const SlackContext = createContext({ status: null, links: [], reload: async () => {} });

function useSlackState() {
  const [state, setState] = useState({ status: null, links: [] });
  const reload = useCallback(async () => {
    const [status, links] = await Promise.all([api('/slack/status'), api('/slack/links')]);
    setState({ status, links });
  }, []);
  useEffect(() => {
    reload().catch(() => {});
  }, [reload]);
  return { ...state, reload };
}

const linksFor = (links, repo) => links.filter((l) => l.repo === repo);

// LLM settings (provider/model, never API keys), shared by the chat panel header and the settings page.
const LlmContext = createContext({ settings: null, reload: async () => {} });

function useLlmSettings() {
  const [settings, setSettings] = useState(null);
  const reload = useCallback(async () => setSettings(await api('/settings')), []);
  useEffect(() => {
    reload().catch(() => {});
  }, [reload]);
  return { settings, reload };
}

// Asks GitHub to include `body_html` (rendered Markdown) next to `body`.
const FULL = 'application/vnd.github.full+json';

const EMPTY = { key: null, data: null, error: null, next: null, busy: false };
// Last successful result per request, so revisiting a tab renders at once while it refreshes in the background
// (stale-while-revalidate). ponytail: unbounded within a session; plenty for one user's browsing.
const ghCache = new Map();

// Fetches a GitHub endpoint through our proxy. Arrays get "Load more" via the Link header.
function useGitHub(path, accept) {
  const nav = useNavigate();
  const key = `${accept ?? ''} ${path}`;
  const [s, set] = useState(EMPTY);
  const ac = useRef(null); // aborts in-flight requests (incl. "Load more") when path changes or on unmount

  const load = useCallback(async (page, signal) => {
    // Use only the page number from Link: GitHub's next URLs sometimes use /repositories/:id, which the allowlist rejects.
    const url = `/api/gh/${path}${page ? `${path.includes('?') ? '&' : '?'}page=${page}` : ''}`;
    const r = await fetch(url, { signal, headers: accept ? { Accept: accept } : {} });
    if (r.status === 401) return nav('/');
    // GitHub labels rendered HTML as "application/vnd.github.html+json", so "json" in the type isn't enough.
    const type = r.headers.get('content-type') ?? '';
    const body = type.includes('json') && !/vnd\.github\.(html|raw)/.test(type) ? await r.json() : await r.text();
    if (signal.aborted) return;
    if (!r.ok) return set((p) => ({ ...p, key, error: body.message ?? (r.statusText || `HTTP ${r.status}`), busy: false }));
    const items = body.workflow_runs ?? body; // actions/runs wraps its list in an object
    const next = r.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
    set((p) => {
      const fresh = {
        key,
        // "Load more" appends to what's on screen, which may be the cached copy rather than this hook's state
        data: page ? [...(p.key === key ? p.data : ghCache.get(key)?.data ?? []), ...items] : items,
        error: null,
        next: next && new URL(next).searchParams.get('page'),
        busy: false,
      };
      ghCache.set(key, fresh);
      return fresh;
    });
  }, [key, path, accept, nav]);

  const fail = useCallback(
    (e) => e.name !== 'AbortError' && set((p) => ({ ...p, key, error: e.message, busy: false })),
    [key],
  );

  useEffect(() => {
    const c = (ac.current = new AbortController());
    load(null, c.signal).catch(fail);
    return () => c.abort();
  }, [load, fail]);

  // State is tagged with the request it belongs to. When the path changes, the component re-renders before the
  // new fetch finishes; returning the previous path's data then would hand e.g. commits to the pull-request renderer.
  const cur = s.key === key ? s : ghCache.get(key) ?? EMPTY;
  const more = cur.next && !cur.busy && (() => {
    set((p) => ({ ...p, busy: true }));
    load(cur.next, ac.current.signal).catch(fail);
  });
  return { ...cur, more };
}

// GitHub already renders and sanitizes body_html; DOMPurify is defense in depth since it goes into innerHTML.
const Markdown = ({ html, empty }) => (html
  ? <div className="markdown" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(html) }} />
  : empty ? <p className="muted">{empty}</p> : null);

// Shows a message instead of unmounting the whole app (a blank page) if a page throws while rendering.
class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="alert" role="alert">
        <span className="alert-label">Something went wrong on this page</span>
        {this.state.error.message}
        <button className="btn btn-ghost btn-sm" onClick={() => window.location.reload()}>reload page</button>
      </div>
    );
  }
}

// Placeholder rows shaped like the list that's coming, so the page doesn't jump when it arrives.
const Skeleton = ({ rows = 4 }) => (
  <ul className="list skeleton" aria-busy="true" aria-label="Loading">
    {Array.from({ length: rows }, (_, i) => <li key={i}><span /><span /></li>)}
  </ul>
);

function Status({ error, data }) {
  if (error) return <p className="error">{error}</p>;
  if (!data) return <Skeleton />;
  return null;
}

// Brief confirmation at the bottom of the screen: toast('Saved'). Rendered by <Toasts /> in Layout.
const toast = (text) => window.dispatchEvent(new CustomEvent('git-help:toast', { detail: text }));
function Toasts() {
  const [items, setItems] = useState([]);
  useEffect(() => {
    const add = (e) => {
      const id = Math.random();
      setItems((t) => [...t, { id, text: e.detail }]);
      setTimeout(() => setItems((t) => t.filter((x) => x.id !== id)), 2600);
    };
    window.addEventListener('git-help:toast', add);
    return () => window.removeEventListener('git-help:toast', add);
  }, []);
  return <div className="toasts" role="status" aria-live="polite">{items.map((t) => <div key={t.id} className="toast">{t.text}</div>)}</div>;
}

function List({ path, render, keep, accept, empty = 'Nothing here.' }) {
  const { data, error, more, busy } = useGitHub(path, accept);
  if (error || !data) return <Status error={error} data={data} />;
  const items = keep ? data.filter(keep) : data;
  return (
    <>
      {items.length ? <ul className="list">{items.map(render)}</ul> : <p className="muted">{empty}</p>}
      {(more || busy) && <button className="btn" onClick={more || undefined} disabled={busy}>{busy ? 'Loading…' : 'Load more'}</button>}
    </>
  );
}

const Ext = ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>;

const Logo = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" aria-hidden="true">
    <circle cx="6" cy="5" r="2.5" /><circle cx="6" cy="19" r="2.5" /><circle cx="18" cy="8" r="2.5" />
    <path d="M6 7.5v9M18 10.5c0 4.5-6 3.5-11 6.5" />
  </svg>
);

const GitHubMark = () => (
  <svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor" aria-hidden="true">
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
  </svg>
);

const Brand = ({ to }) => <Link to={to} className="brand"><Logo />GitHelp</Link>;

const HashIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5"
    strokeLinecap="round" aria-hidden="true">
    <path d="M6 2 4.5 14M11.5 2 10 14M2.5 5.5h11.5M2 10.5h11.5" />
  </svg>
);

const ArrowUp = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
  </svg>
);

function SlackLinkButton({ repo }) {
  const { links } = useContext(SlackContext);
  const [open, setOpen] = useState(false);
  const mine = linksFor(links, repo);
  return (
    <>
      <button type="button" className={`chip-btn${mine.length ? ' linked' : ''}`} onClick={() => setOpen(true)}
        aria-label={mine.length ? `Slack channels for ${repo}: ${mine.map((l) => l.name).join(', ')}` : `Link a Slack channel to ${repo}`}>
        <HashIcon />
        <span className="chip-label">{mine.length ? mine.map((l) => l.name).join(', ') : 'Link Slack channel'}</span>
      </button>
      {open && <SlackLinkDialog repo={repo} onClose={() => setOpen(false)} />}
    </>
  );
}

function SlackLinkDialog({ repo, onClose }) {
  const { status, links, reload } = useContext(SlackContext);
  const ref = useRef(null);
  const [channels, setChannels] = useState(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(null); // id of the channel being linked/unlinked
  const [error, setError] = useState(null);
  const linked = new Set(linksFor(links, repo).map((l) => l.channel_id));

  useEffect(() => {
    ref.current.showModal();
    ref.current.querySelector('input')?.focus(); // showModal() focuses the first button ("close") otherwise
  }, []);
  useEffect(() => {
    if (status?.configured) api('/slack/channels').then(setChannels, (e) => setError(e.message));
  }, [status?.configured]);

  const toggle = async (c) => {
    setBusy(c.id);
    setError(null);
    try {
      if (linked.has(c.id)) await api(`/slack/links?${new URLSearchParams({ repo, channel_id: c.id })}`, { method: 'DELETE' });
      else await api('/slack/links', { method: 'POST', body: { repo, channel_id: c.id } });
      await reload();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  const shown = channels?.filter((c) => c.name.includes(q.toLowerCase().replace(/^#/, '')));
  return (
    // Clicking the backdrop (the <dialog> itself, outside .dialog-inner) closes it.
    <dialog ref={ref} className="dialog" onClose={onClose} onClick={(e) => e.target === ref.current && ref.current.close()}>
      <div className="dialog-inner">
        <header className="dialog-head">
          <div>
            <h2 className="chat-title">Link a Slack channel</h2>
            <div className="chat-context">{repo}{status?.configured && ` · ${status.team}`}</div>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => ref.current.close()}>close</button>
        </header>

        {status && !status.configured ? (
          <div className="dialog-body">
            <p>{status.error ?? "Slack isn't connected yet."}</p>
            <p className="muted">
              Create a Slack app from the manifest in the README, install it to your workspace, put its User OAuth
              Token in <code>.env</code> as <code>SLACK_USER_TOKEN</code>, then restart <code>npm run dev</code>.
            </p>
          </div>
        ) : (
          <div className="dialog-body">
            <input type="search" placeholder="Filter channels…" aria-label="Filter channels" value={q}
              onChange={(e) => setQ(e.target.value)} />
            {error && <p className="error" role="alert">{error}</p>}
            {!shown ? <p className="muted">Loading channels…</p>
              : !shown.length ? <p className="muted">No channels match. You can only link channels you're a member of.</p>
                : (
                  <ul className="channel-list">
                    {shown.map((c) => (
                      <li key={c.id}>
                        <button type="button" onClick={() => toggle(c)} disabled={busy !== null} aria-pressed={linked.has(c.id)}>
                          <span className="channel-name">
                            #{c.name}{c.is_private && <span className="badge">private</span>}
                          </span>
                          <span className="channel-action">
                            {busy === c.id ? (linked.has(c.id) ? 'Unlinking…' : 'Linking and syncing…')
                              : linked.has(c.id) ? 'linked · unlink' : 'link'}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
            <p className="hint">
              Linking copies the last 90 days of messages and threads into a local file on this machine
              (<code>.data/</code>). Unlinking deletes that copy.
            </p>
          </div>
        )}
      </div>
    </dialog>
  );
}

function SlackTab({ repo }) {
  const { links, reload } = useContext(SlackContext);
  const mine = linksFor(links, repo);
  const total = mine.reduce((n, l) => n + l.messages, 0);
  const [threads, setThreads] = useState(null);
  const [error, setError] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [index, setIndex] = useState(null);

  const loadIndex = useCallback(() => api(`/index?${new URLSearchParams({ repo })}`).then(setIndex, () => {}), [repo]);
  useEffect(() => {
    loadIndex();
  }, [loadIndex, total]);

  useEffect(() => {
    if (!mine.length) return;
    let live = true;
    api(`/slack/threads?${new URLSearchParams({ repo })}`).then((t) => live && setThreads(t), (e) => live && setError(e.message));
    return () => { live = false; };
  }, [repo, total, mine.length]);

  const syncNow = async (full) => {
    setSyncing(true);
    setError(null);
    try {
      const { index_error } = await api('/slack/sync', { method: 'POST', body: { repo, full } });
      if (index_error) setError(index_error);
      await reload();
      await loadIndex();
      toast(full ? 'Resynced from scratch' : 'Synced');
    } catch (e) {
      setError(e.message);
    } finally {
      setSyncing(false);
    }
  };

  const rebuild = async () => {
    setSyncing(true);
    setError(null);
    try {
      setIndex(await api('/index', { method: 'POST', body: { repo } }));
    } catch (e) {
      setError(e.message);
    } finally {
      setSyncing(false);
    }
  };

  const indexRow = index && ['search index', index.indexed_at || index.slack
    ? `${plural(index.github, 'GitHub chunk')} · ${plural(index.slack, 'Slack chunk')} · ${index.model.split(':').slice(1).join(':')}`
    : 'not built yet: it builds the first time you ask the chat about this repo'];

  return (
    <>
      {mine.length ? (
        <Rows rows={[
          ...mine.map((l) => [`#${l.name}`, `${plural(l.messages, 'message')} · synced ${dateTime(l.synced_at)}`]),
          ...(indexRow ? [indexRow] : []),
        ]} />
      ) : (
        <p className="muted">No Slack channel is linked to this repo yet. Link one to see its conversations here.</p>
      )}
      {/* The link button keeps the same place in the tree whether or not anything is linked, so the picker
          dialog it owns stays open after the first link instead of unmounting with the empty state. */}
      <div className="actions">
        {mine.length > 0 && (
          <>
            <button type="button" className="btn btn-primary" onClick={() => syncNow(false)} disabled={syncing}>{syncing ? 'Syncing…' : 'Sync now'}</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => syncNow(true)} disabled={syncing}>Full resync</button>
          </>
        )}
        <button type="button" className="btn btn-ghost btn-sm" onClick={rebuild} disabled={syncing}>rebuild index</button>
        <SlackLinkButton repo={repo} />
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {mine.length > 0 && <SlackThreads threads={threads} />}
    </>
  );
}

function SlackThreads({ threads }) {
  return (
    <>
      <h3>Recent conversations</h3>
      {!threads ? <Skeleton />
        : !threads.length ? <p className="muted">No messages in the last 90 days.</p>
          : (
            <ul className="list">
              {threads.map((t) => (
                <li key={t.channel_id + t.ts}>
                  <b>{t.author}</b>
                  <span className="muted">#{t.channel} · {slackTime(t.ts)} · <Ext href={t.permalink}>open in slack ↗</Ext></span>
                  <p className="slack-text">{t.text}</p>
                  {t.replies.length > 0 && (
                    <details className="replies">
                      <summary>{plural(t.replies.length, 'reply', 'replies')}</summary>
                      {t.replies.map((r) => (
                        <div key={r.ts} className="reply">
                          <b>{r.author}</b> <span className="muted">{slackTime(r.ts)}</span>
                          <p className="slack-text">{r.text}</p>
                        </div>
                      ))}
                    </details>
                  )}
                </li>
              ))}
            </ul>
          )}
    </>
  );
}

// Replies the assignee gave the Git-Help bot about this issue being late (alerts.js).
function LateReasons({ repo, number }) {
  const [rows, setRows] = useState([]);
  useEffect(() => {
    api(`/followups?${new URLSearchParams({ repo, number })}`).then(setRows, () => setRows([]));
  }, [repo, number]);
  if (!rows.length) return null;
  return (
    <>
      <h3>Why it's late</h3>
      <ul className="list">
        {rows.map((r) => (
          <li key={r.created_at}>
            <b>{r.github_login}</b> <span className="muted">{dateTime(r.created_at)}{r.permalink && <> · <Ext href={r.permalink}>open in slack ↗</Ext></>}</span>
            <p className="slack-text">{r.text}</p>
          </li>
        ))}
      </ul>
    </>
  );
}

const SUGGESTIONS = {
  repo: [
    "What's blocking the open pull requests?",
    'What decisions were made recently, and why?',
    'Who is working on what right now?',
  ],
  general: [
    'Which repos have open bugs right now?',
    'Summarize recent decisions across projects',
    'What changed in the latest releases?',
  ],
};

// POST /api/chat and yield its NDJSON events (status, sources, token, done, error) as they arrive.
async function* chatStream(body, signal) {
  const r = await fetch('/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
  });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw new Error(data.message ?? `HTTP ${r.status}`);
  }
  const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) yield JSON.parse(line);
    }
  }
  if (buf.trim()) yield JSON.parse(buf);
}

const CITATION = /(\[\d+(?:\s*,\s*\d+)*\])/g;
const citationNumbers = (part) => part.match(/^\[([\d,\s]+)\]$/)?.[1].split(',').map((n) => Number(n.trim()));

// Answer text with its [1] / [2, 3] citations turned into links to the sources (unknown numbers stay plain text).
function AnswerText({ text, sources = [] }) {
  return (
    <p>
      {text.split(CITATION).map((part, i) => {
        const nums = citationNumbers(part);
        if (!nums || !nums.every((n) => sources[n - 1])) return part;
        return (
          <span key={i} className="cites">
            {nums.map((n) => (
              <a key={n} className="cite" href={sources[n - 1].url} target="_blank" rel="noreferrer" title={sources[n - 1].title}>[{n}]</a>
            ))}
          </span>
        );
      })}
    </p>
  );
}

// Only the sources the answer actually cites; small talk cites none, so it shows no list.
function SourceList({ text, sources }) {
  const used = new Set(text.split(CITATION).flatMap((part) => citationNumbers(part) ?? []));
  const cited = sources.filter((s) => used.has(s.n));
  if (!cited.length) return null;
  return (
    <details className="sources">
      <summary>{plural(cited.length, 'source')}</summary>
      <ol>
        {cited.map((s) => (
          <li key={s.n} value={s.n}>
            <span className="badge">{s.source}</span> <Ext href={s.url}>{s.title}</Ext>
          </li>
        ))}
      </ol>
    </details>
  );
}

const StopIcon = () => (
  <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="1.5" /></svg>
);

// Chat over the repo's (or all repos') indexed GitHub data and linked Slack channels. See rag.js.
function ChatPanel({ repo, open, onClose }) {
  const [threads, setThreads] = useState({}); // one conversation per repo (or "*" for the repo list)
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const stop = useRef(null);
  const log = useRef(null);
  const input = useRef(null);
  const key = repo ?? '*';
  const messages = threads[key] ?? [];
  const subject = repo ? repo.split('/')[1] : 'your repos';
  const { links } = useContext(SlackContext);
  const { settings } = useContext(LlmContext);
  const linked = repo ? linksFor(links, repo) : links;
  const slackStatus = !linked.length ? 'slack not linked'
    : repo ? `${linked.map((l) => `#${l.name}`).join(', ')} · ${plural(linked.reduce((n, l) => n + l.messages, 0), 'message')}`
      : `${plural(new Set(links.map((l) => l.channel_id)).size, 'channel')} linked`;
  const last = messages.at(-1);

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [messages.length, last?.text, last?.status]);

  const send = async (e, question) => {
    e?.preventDefault();
    const q = (question ?? text).trim();
    if (!q || busy) return;
    const k = key; // the user may switch repos while this answer streams
    const history = [...messages.filter((m) => m.text.trim() && !m.error), { role: 'user', text: q }];
    const update = (fn) => setThreads((t) => {
      const list = [...(t[k] ?? [])];
      list[list.length - 1] = fn(list.at(-1));
      return { ...t, [k]: list };
    });
    setThreads((t) => ({ ...t, [k]: [...(t[k] ?? []), { role: 'user', text: q }, { role: 'assistant', text: '', pending: true }] }));
    setText('');
    setBusy(true);
    const ac = new AbortController();
    stop.current = ac;
    try {
      const body = { repo, messages: history.map((m) => ({ role: m.role, content: m.text })) };
      for await (const ev of chatStream(body, ac.signal)) {
        if (ev.type === 'status') update((m) => ({ ...m, status: ev.text }));
        else if (ev.type === 'sources') update((m) => ({ ...m, sources: ev.sources, status: null }));
        else if (ev.type === 'token') update((m) => ({ ...m, text: m.text + ev.text }));
        else if (ev.type === 'error') update((m) => ({ ...m, error: ev.message }));
      }
    } catch (err) {
      if (err.name !== 'AbortError') update((m) => ({ ...m, error: err.message }));
    } finally {
      update((m) => ({ ...m, pending: false, status: null, stopped: ac.signal.aborted }));
      setBusy(false);
    }
  };

  // Latest send() for the window events below (they're registered once).
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => {
    const focus = () => input.current?.focus();
    const ask = (e) => { sendRef.current(null, e.detail); focus(); };
    window.addEventListener('git-help:focus', focus);
    window.addEventListener('git-help:ask', ask);
    return () => { window.removeEventListener('git-help:focus', focus); window.removeEventListener('git-help:ask', ask); };
  }, []);

  return (
    <aside className="chat" data-open={open} aria-label="Ask" hidden={!open}>
      <header className="chat-head">
        <div>
          <div className="chat-title">Ask</div>
          <div className="chat-context">
            {repo ?? 'all repositories'} · <span className={`dot${linked.length ? ' on' : ''}`} aria-hidden="true" />{slackStatus}
          </div>
          {settings && (
            <div className="chat-context">
              <Link to="/settings" className="model-link">
                {settings.chat.model} · {settings.chat.provider === 'ollama' ? 'local' : settings.chat.provider}
              </Link>
            </div>
          )}
        </div>
        <div className="chat-head-actions">
          {messages.length > 0 && !busy && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setThreads((t) => ({ ...t, [key]: [] }))}>New question</button>
          )}
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close Ask">Close</button>
        </div>
      </header>

      <div className="chat-log" ref={log} role="log" aria-live="polite">
        {messages.length === 0 ? (
          <div className="chat-empty">
            <h2>Ask about {subject}</h2>
            <p>
              {repo
                ? "Answers come from this repo's issues, pull requests and README, plus its linked Slack channels, with links to every source."
                : "Answers come from every repo you've chatted about and all linked Slack channels, with links to every source."}
            </p>
            <div className="suggestions">
              {SUGGESTIONS[repo ? 'repo' : 'general'].map((s) => (
                <button key={s} type="button" onClick={() => { setText(s); input.current?.focus(); }}>{s}</button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m, i) => (m.role === 'user' ? (
            <div key={i} className="msg msg-user"><p>{m.text}</p></div>
          ) : (
            <div key={i} className="msg msg-assistant">
              <span className="msg-author">
                GitHelp{m.pending && !m.text && <span className="typing"> · {m.status ?? 'searching…'}</span>}
              </span>
              {m.text && <AnswerText text={m.text} sources={m.sources} />}
              {m.stopped && <p className="muted">stopped</p>}
              {m.error && <p className="error" role="alert">{m.error}</p>}
              {!m.pending && m.sources?.length > 0 && <SourceList text={m.text} sources={m.sources} />}
            </div>
          )))
        )}
      </div>

      <form className="composer" onSubmit={send}>
        <div className="composer-box">
          <textarea ref={input} rows={1} value={text} placeholder={`Ask about ${subject}…`} aria-label="Message"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) send(e); }} />
          {busy ? (
            <button type="button" className="send" onClick={() => stop.current?.abort()} aria-label="Stop"><StopIcon /></button>
          ) : (
            <button type="submit" className="send" disabled={!text.trim()} aria-label="Send"><ArrowUp /></button>
          )}
        </div>
        <p className="composer-hint">Enter to send · Shift+Enter for a new line · {KEY}J to close</p>
      </form>
    </aside>
  );
}

const Section = ({ title, children }) => (
  <section className="section"><h2 className="section-title">{title}</h2>{children}</section>
);

const Rows = ({ rows }) => (
  <dl className="rows">
    {rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
  </dl>
);

// Light, Dark A (graphite) and Dark B (slate). index.html applies the saved choice before first paint.
const THEMES = [['light', 'Light'], ['graphite', 'Graphite'], ['slate', 'Slate']];
function ThemeToggle() {
  const system = () => (matchMedia('(prefers-color-scheme: dark)').matches ? 'graphite' : 'light');
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? system());
  const pick = (t) => {
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem('theme', t); } catch {}
    setTheme(t);
  };
  return (
    <div className="theme-switch" role="group" aria-label="Theme">
      {THEMES.map(([t, label]) => <button key={t} type="button" aria-pressed={theme === t} onClick={() => pick(t)}>{label}</button>)}
    </div>
  );
}


const SIGN_IN_ERRORS = {
  access_denied: 'You cancelled the request on GitHub. Nothing was shared.',
  state_mismatch: 'That sign-in link expired. Please try again.',
  bad_verification_code: 'The sign-in code expired. Please try again.',
  incorrect_client_credentials: 'The OAuth client ID or secret in .env is wrong. See the README.',
  redirect_uri_mismatch: 'The OAuth App callback URL must be http://localhost:5173/auth/callback.',
};

function Home() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const error = params.get('error');
  useEffect(() => {
    fetch('/api/gh/user').then((r) => r.ok && nav('/repos')).catch(() => {});
  }, [nav]);
  return (
    <main className="landing">
      <section className="landing-copy">
        <Brand to="/" />
        <h1>See what's late in your repos, and why.</h1>
        <p className="lead">GitHelp tracks your GitHub deadlines, asks owners in Slack why late work is late, and answers with the reason.</p>
        {error && (
          <div className="alert" role="alert">
            <span className="alert-label">Sign-in failed</span>
            {SIGN_IN_ERRORS[error] ?? error}
          </div>
        )}
        <a className="btn btn-primary btn-lg" href="/auth/login"><GitHubMark />Continue with GitHub</a>
        <p className="hint">Read-only access. Your password never reaches GitHelp.</p>
      </section>
      <LandingDemo />
    </main>
  );
}

// The core loop on the sign-in page, built from the app's own styles: a late issue, the bot's Slack DM and its
// reply, then Ask answering with the reason. Advances every few seconds unless the visitor prefers reduced motion
// or picks a step. Demo data: the brewlog demo repo under the fictional owner "maya".
const DEMO_STEPS = ['Spot what’s late', 'The bot asks why', 'Ask and get the reason'];
function LandingDemo() {
  const [step, setStep] = useState(0);
  const [auto, setAuto] = useState(() => !matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    if (!auto) return undefined;
    const t = setTimeout(() => setStep((s) => (s + 1) % DEMO_STEPS.length), 4500);
    return () => clearTimeout(t);
  }, [auto, step]);
  const pick = (i) => { setAuto(false); setStep(i); };
  return (
    <section className="demo" aria-label="How GitHelp works, with a demo repository">
      <div className={`demo-steps${auto ? ' auto' : ''}`} role="tablist" aria-label="Demo steps">
        {DEMO_STEPS.map((label, i) => (
          <button key={label} type="button" role="tab" aria-selected={step === i} aria-controls="demo-panel" onClick={() => pick(i)}>
            <span className="ref">{i + 1}</span> {label}
          </button>
        ))}
      </div>
      <div className="demo-frame" id="demo-panel" role="tabpanel" aria-live="polite">
        <div className="demo-bar"><span>maya/brewlog</span><span>{['Overview', 'Slack · direct message', 'Ask'][step]}</span></div>
        {step === 0 && (
          <div className="demo-body" key="s0">
            <p className="demo-lead">4 items in v0.3.0 are past due. None has a reason from the assignee yet.</p>
            <div className="ledger-row">
              <div className="ledger-item">
                <span className="ledger-title">Add grind size field to brews</span>
                <p className="ledger-meta"><span className="ref">#6</span> · Issue · maya · <span className="late-text">4 days late</span></p>
              </div>
              <div className="ledger-why"><p className="muted">No reason yet. Asked Oct 1, no reply.</p></div>
            </div>
            <div className="ledger-row">
              <div className="ledger-item">
                <span className="ledger-title">Run tests on every push and pull request</span>
                <p className="ledger-meta"><span className="ref">#8</span> · Issue · maya · <span className="late-text">4 days late</span></p>
              </div>
              <div className="ledger-why"><p className="muted">No reason yet. Asked Oct 1, no reply.</p></div>
            </div>
          </div>
        )}
        {step === 1 && (
          <div className="demo-body demo-dm" key="s1">
            <div className="dm-msg"><b>GitHelp</b><p>Hi! #6 Add grind size field to brews in maya/brewlog was due Sep 29 (milestone v0.3.0) and is still open. What's holding it up?</p></div>
            <div className="dm-msg"><b>maya</b><p className="dm-reply">I was sick</p></div>
            <div className="dm-msg"><b>GitHelp</b><p>Thanks, noted for #6. I'll share it when someone asks why it's late.</p></div>
          </div>
        )}
        {step === 2 && (
          <div className="demo-body" key="s2">
            <p className="demo-q">Why is #6 late?</p>
            <p>Issue #6 "Add grind size field to brews" is late because maya said they were sick <span className="cite">[1]</span><span className="cite">[2]</span>.</p>
            <ol className="demo-sources">
              <li>Issue #6, status and reason <span className="muted">· GitHub</span></li>
              <li>maya's reply to the overdue alert <span className="muted">· Slack DM, Oct 1</span></li>
            </ol>
          </div>
        )}
      </div>
    </section>
  );
}

// ⌘K / Ctrl+K: jump to a page, a repo, or an issue/PR in the current repo ("#14" goes straight there).
const REPOS_PATH = 'user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member';
function QuickSearch({ repo, onClose }) {
  const nav = useNavigate();
  const ref = useRef(null);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const repos = useGitHub(REPOS_PATH);
  // Hooks can't be conditional; outside a repo this re-reads the cached repo list and is ignored.
  const items = useGitHub(repo ? `repos/${repo}/issues?state=all&per_page=100` : REPOS_PATH);
  useEffect(() => { ref.current.showModal(); }, []);

  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hit = (text) => words.every((w) => text.toLowerCase().includes(w));
  const num = q.match(/^#?(\d+)$/)?.[1];
  const go = (to) => () => { onClose(); nav(to); };
  const results = [];
  if (repo && num) {
    const i = items.data?.find?.((x) => x.number === Number(num));
    results.push({ key: `n${num}`, group: 'Go to', icon: i && <StateIcon item={i} />, label: i ? `#${num} ${i.title}` : `#${num}`,
      run: go(`/repos/${repo}/${i?.pull_request ? 'pulls' : 'issues'}/${num}`) });
  }
  const pages = [['Repositories', '/repos'], ['Settings', '/settings'],
    ...(repo ? Object.entries(TABS).map(([k, label]) => [`${label} · ${repo.split('/')[1]}`, `/repos/${repo}/${k === 'code' ? 'commits' : k}`]) : [])];
  for (const [label, to] of pages) if (hit(label)) results.push({ key: to, group: 'Pages', label, run: go(to) });
  if (repo && Array.isArray(items.data)) {
    for (const i of items.data.filter((x) => !num && hit(`#${x.number} ${x.title}`)).slice(0, 8)) {
      results.push({ key: `i${i.id}`, group: `Issues & pull requests · ${repo.split('/')[1]}`, icon: <StateIcon item={i} />,
        label: `#${i.number} ${i.title}`, run: go(`/repos/${repo}/${i.pull_request ? 'pulls' : 'issues'}/${i.number}`) });
    }
  }
  for (const r of (repos.data ?? []).filter((r) => hit(r.full_name)).slice(0, 6)) {
    results.push({ key: `r${r.id}`, group: 'Repositories', label: r.full_name, run: go(`/repos/${r.full_name}`) });
  }
  const active = Math.min(sel, results.length - 1);

  const onKey = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % Math.max(results.length, 1));
    } else if (e.key === 'Enter' && results[active]) {
      e.preventDefault();
      results[active].run();
    }
  };
  useEffect(() => { ref.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [active]);

  return (
    <dialog ref={ref} className="dialog palette" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()} aria-label="Quick search">
      <input type="search" autoFocus placeholder={repo ? `Search ${repo.split('/')[1]}, repos and pages… (#14 jumps to an issue)` : 'Search repos and pages…'}
        value={q} onChange={(e) => { setQ(e.target.value); setSel(0); }} onKeyDown={onKey}
        role="combobox" aria-expanded="true" aria-controls="palette-results" aria-activedescendant={results[active] ? `pr-${results[active].key}` : undefined} />
      <ul id="palette-results" role="listbox" className="palette-results">
        {results.map((r, i) => (
          <Fragment key={r.key}>
            {r.group !== results[i - 1]?.group && <li role="presentation" className="palette-group">{r.group}</li>}
            <li id={`pr-${r.key}`} role="option" aria-selected={i === active} onMouseMove={() => setSel(i)} onClick={r.run}>
              {r.icon}<span>{r.label}</span>
            </li>
          </Fragment>
        ))}
        {!results.length && <li className="palette-empty">{repos.data ? 'No matches' : 'Loading…'}</li>}
      </ul>
      <p className="palette-foot"><kbd>↑</kbd><kbd>↓</kbd> move · <kbd>↵</kbd> open · <kbd>esc</kbd> close</p>
    </dialog>
  );
}

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const KEY = isMac ? '⌘' : 'Ctrl ';

function Layout() {
  const nav = useNavigate();
  const { pathname } = useLocation();
  const { data: me } = useGitHub('user');
  const slack = useSlackState();
  const llm = useLlmSettings();
  const [searching, setSearching] = useState(false);
  // Ask is a side panel you open when you want it; the choice is remembered. The panel stays mounted while
  // closed so conversations survive.
  const [askOpen, setAskOpen] = useState(() => { try { return localStorage.getItem('ask') === 'open'; } catch { return false; } });
  const showAsk = useCallback((open) => {
    setAskOpen(open);
    try { localStorage.setItem('ask', open ? 'open' : 'closed'); } catch {}
  }, []);
  // ⌘K search, ⌘J Ask, "/" opens Ask and focuses it; "ask why" buttons open it too (git-help:ask).
  useEffect(() => {
    const focusAsk = () => requestAnimationFrame(() => window.dispatchEvent(new Event('git-help:focus')));
    const onKey = (e) => {
      const k = e.key.toLowerCase();
      if (k === 'k' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); setSearching((v) => !v); return; }
      if (k === 'j' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); setAskOpen((v) => { const next = !v; if (next) focusAsk(); try { localStorage.setItem('ask', next ? 'open' : 'closed'); } catch {} return next; }); return; }
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || e.target.closest?.('input, textarea, select, [contenteditable]')) return;
      e.preventDefault();
      showAsk(true);
      focusAsk();
    };
    const open = () => showAsk(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('git-help:ask', open);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('git-help:ask', open); };
  }, [showAsk]);
  const repo = pathname.match(/^\/repos\/([^/]+\/[^/]+)/)?.[1] ?? null;
  const logout = async () => {
    await fetch('/auth/logout', { method: 'POST' });
    nav('/');
  };
  const model = llm.settings?.chat;
  return (
    <SlackContext.Provider value={slack}>
    <LlmContext.Provider value={llm}>
      <div className={`app${askOpen ? ' ask-open' : ''}`}>
        <aside className="sidebar">
          <Brand to="/repos" />
          <button type="button" className="side-search" onClick={() => setSearching(true)}>
            <span>Search</span><kbd>{KEY}K</kbd>
          </button>
          <nav className="side-nav" aria-label="Main">
            <NavLink to="/repos" end>Repositories</NavLink>
            {repo && <NavLink to={`/repos/${repo}`} className="side-repo" title={repo}>{repo.split('/')[1]}</NavLink>}
            <NavLink to="/settings">Settings</NavLink>
          </nav>
          <button type="button" className="side-ask" aria-pressed={askOpen} onClick={() => showAsk(!askOpen)}>
            <span>{askOpen ? 'Close Ask' : 'Ask a question'}</span><kbd>{KEY}J</kbd>
          </button>
          <div className="side-foot">
            <div className="side-status">
              <span>GitHub · read-only</span>
              <span>Slack · {slack.status?.configured ? (slack.links.length ? `${plural(new Set(slack.links.map((l) => l.channel_id)).size, 'channel')} linked` : 'no channels linked') : 'not connected'}</span>
              {model && <Link to="/settings">Model · {model.model}{model.provider === 'ollama' ? ' on this machine' : ''}</Link>}
            </div>
            {me && (
              <div className="side-me">
                <img src={me.avatar_url} alt="" width="20" height="20" />
                <span>{me.login}</span>
                <button type="button" className="link-like" onClick={logout}>Sign out</button>
              </div>
            )}
          </div>
        </aside>
        <main className="page-body">
          <ErrorBoundary key={pathname}><Outlet /></ErrorBoundary>
        </main>
        <ChatPanel repo={repo} open={askOpen} onClose={() => showAsk(false)} />
        <Toasts />
        {searching && <QuickSearch repo={repo} onClose={() => setSearching(false)} />}
      </div>
    </LlmContext.Provider>
    </SlackContext.Provider>
  );
}

const PROVIDER_NAMES = { ollama: 'Ollama (local)', anthropic: 'Anthropic (Claude)', openai: 'OpenAI-compatible API' };

const toForm = (s) => ({
  chat: { ...s.chat },
  embed: { ...s.embed },
  ollamaUrl: s.ollama.url,
  openaiUrl: s.openai.url,
  openaiKey: '',
  anthropicKey: '',
  clear: {}, // keys to remove on save
});

// An empty key field keeps the saved key; "remove" sends null.
const toPatch = (f) => ({
  chat: f.chat,
  embed: f.embed,
  ollama: { url: f.ollamaUrl },
  openai: { url: f.openaiUrl, key: f.clear.openai ? null : f.openaiKey || undefined },
  anthropic: { key: f.clear.anthropic ? null : f.anthropicKey || undefined },
});

// A settings section: what it is on the left, its fields on the right (stacked on narrow screens).
const Setting = ({ title, desc, children }) => (
  <section className="setting">
    <div className="setting-info"><h2>{title}</h2>{desc && <p>{desc}</p>}</div>
    <div className="setting-body">{children}</div>
  </section>
);

// Short local times for logs: "Oct 1, 7:19 PM".
const shortTime = (iso) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function KeyField({ label, id, state, value, cleared, onChange, onClear }) {
  const hint = cleared ? 'Will be removed when you save' : state === 'saved' ? 'Saved. Leave blank to keep it'
    : state === 'env' ? 'Set in .env. Enter one to override' : 'Not set';
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="field-row">
        <input id={id} type="password" autoComplete="off" value={value} placeholder={hint}
          onChange={(e) => onChange(e.target.value)} />
        {state === 'saved' && !cleared && <button type="button" className="btn btn-ghost btn-sm" onClick={onClear}>Remove</button>}
      </div>
    </div>
  );
}

function ModelField({ id, label, value, options, onChange, hint }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} list={`${id}-list`} value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} />
      <datalist id={`${id}-list`}>{options?.map((m) => <option key={m} value={m} />)}</datalist>
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}

const MATCH_LABEL = { email: 'Matched by email', name: 'Matched by name', handle: 'Matched by handle', 'first-name': 'First name only', manual: 'Set by you' };

// Who the bot may message: GitHub logins linked to Slack users. Uncertain matches wait for a confirm.
function BotSettings() {
  const [status, setStatus] = useState(null);
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    api('/bot/status').then(setStatus, (e) => setError(e.message));
    api('/people').then(setData, () => setData({ people: [], slackUsers: [] }));
  }, []);
  const run = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      const { people } = await fn();
      setData((d) => ({ ...d, people }));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const setLink = (login, slackUserId) => run(() => api(`/people/${encodeURIComponent(login)}`, { method: 'PUT', body: { slack_user_id: slackUserId || null } }));

  if (!status) return <Skeleton />;
  if (!status.configured) {
    return (
      <p className="muted">
        {status.error ?? "The Slack bot isn't set up."} Add the bot scopes from the README manifest, reinstall the app, and put
        {' '}<code>SLACK_BOT_TOKEN</code> and <code>SLACK_APP_TOKEN</code> in <code>.env</code>.
      </p>
    );
  }
  return (
    <>
      <p className="setting-status">
        Connected as <b>@{status.user}</b> in {status.team}{status.socket ? '' : '. SLACK_APP_TOKEN is missing, so replies can\'t be received'}.
      </p>
      {error && <p className="error" role="alert">{error}</p>}
      {!data ? <p className="muted">Loading people…</p> : (
        <ul className="list people">
          {data.people.length === 0 && <li className="muted">No people yet: match them from your indexed repos.</li>}
          {data.people.map((p) => (
            <li key={p.github_login} className="person">
              <span className="person-login">{p.github_login}</span>
              <select aria-label={`Slack user for ${p.github_login}`} value={p.slack_user_id ?? ''} disabled={busy}
                onChange={(e) => setLink(p.github_login, e.target.value)}>
                <option value="">Don't notify</option>
                {data.slackUsers.map((u) => <option key={u.id} value={u.id}>{u.display || u.real || u.handle}</option>)}
              </select>
              <span className="person-how">
                {p.slack_user_id && <span className={`badge ${p.confirmed ? 'ok' : 'soon'}`}>{MATCH_LABEL[p.method] ?? p.method}</span>}
                {p.slack_user_id && !p.confirmed && (
                  <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setLink(p.github_login, p.slack_user_id)}>Confirm</button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div>
        <button type="button" className="btn" disabled={busy} onClick={() => run(async () => { const r = await api('/people/match', { method: 'POST' }); toast('People matched'); return r; })}>
          {busy ? 'Matching…' : 'Match people from indexed repos'}
        </button>
      </div>
    </>
  );
}

// Per repo: whether the bot may DM assignees about overdue issues, who it would message now, and what it sent.
function RepoAlerts({ repo }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const load = useCallback(() => api(`/alerts?${new URLSearchParams({ repo })}`).then(setData, (e) => setError(e.message)), [repo]);
  useEffect(() => { load(); }, [load]);
  const act = async (fn) => {
    setBusy(true);
    setError(null);
    try { await fn(); await load(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  if (!data) return <li className="muted">{repo}</li>;
  return (
    <li className="repo-alerts">
      <label className="toggle-row">
        <input type="checkbox" checked={data.enabled} disabled={busy}
          onChange={(e) => act(() => api('/alerts', { method: 'PUT', body: { repo, enabled: e.target.checked } }))} />
        <span>{repo}</span>
      </label>
      {error && <p className="error" role="alert">{error}</p>}
      {data.enabled && (
        <>
          <p className="muted">
            {data.send.length
              ? `Would message now: ${data.send.map((a) => `${a.login} about #${a.number} (${plural(a.days_late, 'day')} late${a.kind === 'reminder' ? ', reminder' : ''})`).join('; ')}.`
              : 'Nobody to message right now.'}
          </p>
          {data.cannot.length > 0 && (
            <p className="muted">Can't notify: {data.cannot.map((c) => `#${c.number} ${c.login ?? ''} (${c.reason})`).join('; ')}.</p>
          )}
          {data.send.length > 0 && (
            <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => act(async () => { const { sent } = await api('/alerts/send', { method: 'POST', body: { repo } }); toast(sent.length ? `Sent ${plural(sent.length, 'DM')}` : 'Nothing new to send'); })}>
              {busy ? 'Sending…' : 'Send now'}
            </button>
          )}
          {data.log.length > 0 && (
            <ul className="alert-log">
              {data.log.map((a) => (
                <li key={a.id}>
                  <span className="muted">{shortTime(a.sent_at)} · {a.kind === 'reminder' ? 'Reminded' : 'Asked'} {a.github_login} about #{a.number}</span>
                  {a.reply ? <p className="slack-text">“{a.reply}”</p> : <span className="muted"> · No reply yet</span>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </li>
  );
}

function AlertSettings() {
  const [repos, setRepos] = useState(null);
  useEffect(() => { api('/repos/indexed').then(setRepos, () => setRepos([])); }, []);
  if (!repos) return <Skeleton />;
  if (!repos.length) return <p className="muted">No repos indexed yet. Open a repo's Overview first.</p>;
  return <ul className="list">{repos.map((r) => <RepoAlerts key={r} repo={r} />)}</ul>;
}

function SettingsPage() {
  useTitle('Settings');
  const { settings, reload } = useContext(LlmContext);
  const [form, setForm] = useState(null);
  const [models, setModels] = useState({}); // provider -> model ids, or an error message
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState(null);
  const [test, setTest] = useState(null);

  useEffect(() => {
    if (settings && !form) setForm(toForm(settings));
  }, [settings, form]);

  const loadModels = useCallback((provider) => {
    api(`/settings/models?provider=${provider}`).then(
      (list) => setModels((m) => ({ ...m, [provider]: list })),
      (e) => setModels((m) => ({ ...m, [provider]: e.message })),
    );
  }, []);
  // Lists come from the saved connection settings, so reload them after each save.
  useEffect(() => {
    if (!settings) return;
    for (const p of new Set([settings.chat.provider, settings.embed.provider])) loadModels(p);
  }, [settings, loadModels]);

  if (!settings || !form) return <Skeleton />;
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const setProvider = (kind, provider) => set({ [kind]: { provider, model: settings.defaults[kind][provider] ?? '' } });
  const modelList = (provider) => (Array.isArray(models[provider]) ? models[provider] : undefined);
  const listHint = (provider) => (typeof models[provider] === 'string' ? `Couldn't list models: ${models[provider]}` : null);
  const cloud = [form.chat.provider, form.embed.provider].filter((p) => p !== 'ollama');

  const save = async (andTest) => {
    setSaving(true);
    setNotice(null);
    setTest(null);
    try {
      const next = await api('/settings', { method: 'PUT', body: toPatch(form) });
      setForm(toForm(next));
      await reload();
      setNotice(null);
      toast('Settings saved');
      if (andTest) setTest(await api('/settings/test', { method: 'POST' }));
    } catch (e) {
      setNotice({ ok: false, text: e.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings">
      <h1>Settings</h1>

      <Setting title="Appearance" desc="Applies right away and is remembered on this browser.">
        <ThemeToggle />
      </Setting>

      <form onSubmit={(e) => { e.preventDefault(); save(false); }}>
        <Setting title="Chat model" desc="Answers questions in Ask.">
          <div className="field-pair">
            <div className="field">
              <label htmlFor="chat-provider">Provider</label>
              <select id="chat-provider" value={form.chat.provider} onChange={(e) => setProvider('chat', e.target.value)}>
                {['ollama', 'anthropic', 'openai'].map((p) => <option key={p} value={p}>{PROVIDER_NAMES[p]}</option>)}
              </select>
            </div>
            <ModelField id="chat-model" label="Model" value={form.chat.model} options={modelList(form.chat.provider)}
              onChange={(model) => set({ chat: { ...form.chat, model } })} hint={listHint(form.chat.provider)} />
          </div>
        </Setting>

        <Setting title="Embedding model" desc="Indexes issues and Slack for search. Changing it re-indexes on the next question.">
          <div className="field-pair">
            <div className="field">
              <label htmlFor="embed-provider">Provider</label>
              <select id="embed-provider" value={form.embed.provider} onChange={(e) => setProvider('embed', e.target.value)}>
                {['ollama', 'openai'].map((p) => <option key={p} value={p}>{PROVIDER_NAMES[p]}</option>)}
              </select>
            </div>
            <ModelField id="embed-model" label="Model" value={form.embed.model} options={modelList(form.embed.provider)}
              onChange={(model) => set({ embed: { ...form.embed, model } })} hint={listHint(form.embed.provider)} />
          </div>
        </Setting>

        <Setting title="Connections" desc="Where the models run. Keys are encrypted on this machine and never sent back to the browser.">
          <div className="field">
            <label htmlFor="ollama-url">Ollama URL</label>
            <input id="ollama-url" type="url" value={form.ollamaUrl} onChange={(e) => set({ ollamaUrl: e.target.value })} />
          </div>
          <KeyField label="Anthropic API key" id="anthropic-key" state={settings.anthropic.key} value={form.anthropicKey}
            cleared={form.clear.anthropic} onChange={(v) => set({ anthropicKey: v })}
            onClear={() => set({ clear: { ...form.clear, anthropic: true } })} />
          <div className="field-pair">
            <div className="field">
              <label htmlFor="openai-url">OpenAI-compatible base URL</label>
              <input id="openai-url" type="url" value={form.openaiUrl} onChange={(e) => set({ openaiUrl: e.target.value })} />
            </div>
            <KeyField label="API key" id="openai-key" state={settings.openai.key} value={form.openaiKey}
              cleared={form.clear.openai} onChange={(v) => set({ openaiKey: v })}
              onClear={() => set({ clear: { ...form.clear, openai: true } })} />
          </div>
          <p className="hint">Works with OpenAI, Groq, OpenRouter, Together, LM Studio and vLLM.</p>

          {cloud.length > 0 && (
            <p className="alert" role="note">
              <span className="alert-label">Privacy</span>
              Questions, and the Slack messages and GitHub text that match them, will be sent to {[...new Set(cloud)].map((p) => PROVIDER_NAMES[p]).join(' and ')}.
            </p>
          )}
          <div className="setting-actions">
            <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</button>
            <button type="button" className="btn" disabled={saving} onClick={() => save(true)}>Save and test</button>
          </div>
          {notice && <p className={notice.ok ? 'muted' : 'error'} role="status">{notice.text}</p>}
          {test && (
            <ul className="test-results">
              <li className={test.chat.ok ? '' : 'error'}><b>Chat</b> {test.chat.ok ? 'works' : 'failed'}: {test.chat.detail}</li>
              <li className={test.embed.ok ? '' : 'error'}><b>Embeddings</b> {test.embed.ok ? 'work' : 'failed'}: {test.embed.detail}</li>
            </ul>
          )}
        </Setting>
      </form>

      <Setting title="Slack bot" desc="Who the bot may message about late work. Only confirmed links get messages. Changes save immediately.">
        <BotSettings />
      </Setting>

      <Setting title="Overdue alerts" desc="When an issue passes its milestone date, the bot asks its assignee why, reminds them once after 3 days, and records the reply. Checks run every 15 minutes.">
        <AlertSettings />
      </Setting>
    </div>
  );
}

function Repos() {
  const { data, error, more } = useGitHub(
    'user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member',
  );
  useTitle('Repositories');
  const [q, setQ] = useState('');
  const [summary, setSummary] = useState({}); // repo -> counts, for repos indexed so far
  useEffect(() => { api('/attention/summary').then(setSummary, () => {}); }, []);
  if (error || !data) return <Status error={error} data={data} />;
  const shown = data.filter((r) => r.full_name.toLowerCase().includes(q.toLowerCase()));
  const late = Object.values(summary).reduce((n, c) => n + c.overdue, 0);
  const lateRepos = Object.values(summary).filter((c) => c.overdue > 0).length;
  return (
    <>
      <h1>Repositories</h1>
      <p className="kicker">
        {data.length} loaded · recently updated first
        {late > 0 && <> · <span className="late-text">{plural(late, 'overdue item')} in {plural(lateRepos, 'repo')}</span></>}
      </p>
      <input type="search" placeholder="Filter repositories…" aria-label="Filter repositories"
        value={q} onChange={(e) => setQ(e.target.value)} />
      <ul className="list">
        {shown.map((r) => (
          <li key={r.id} className="repo-row">
            <div>
              <Link to={`/repos/${r.full_name}`} className="title">{r.full_name}</Link>
              {r.private && <span className="badge">private</span>}
              {r.fork && <span className="badge">fork</span>}
              {summary[r.full_name]?.overdue > 0 && <span className="badge late">{summary[r.full_name].overdue} overdue</span>}
              {r.description && <p className="desc">{r.description}</p>}
              <span className="muted">
                {[r.language, `★ ${r.stargazers_count}`, `updated ${date(r.pushed_at)}`].filter(Boolean).join(' · ')}
              </span>
            </div>
            <SlackLinkButton repo={r.full_name} />
          </li>
        ))}
      </ul>
      {more && <button className="btn" onClick={more}>Load more</button>}
    </>
  );
}

const TABS = { overview: 'Overview', pulls: 'Pull requests', issues: 'Issues', actions: 'Actions', slack: 'Slack', code: 'Code' };
// "Code" groups the browse-only tabs; their own URLs (…/commits etc.) keep working.
const CODE_TABS = ['commits', 'branches', 'releases', 'contributors'];

// Ask the chat panel a question from anywhere (e.g. "ask why" on an overdue issue). ChatPanel listens.
const askChat = (question) => window.dispatchEvent(new CustomEvent('git-help:ask', { detail: question }));

const dayMonth = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function Reason({ r }) {
  return (
    <div className="reason">
      <p className="reason-text">“{r.text}”</p>
      <p className="reason-meta">{r.github_login}, {dayMonth(r.created_at)}{r.permalink && <> · <Ext href={r.permalink}>Open in Slack</Ext></>}</p>
    </div>
  );
}

// Issue titles use Markdown backticks for code ("Colorize `brewlog list` output"); show those as code.
const Title = ({ text }) => text.split(/`([^`]+)`/).map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part));

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const word = (n) => WORDS[n] ?? String(n);
const cap = (t) => t[0].toUpperCase() + t.slice(1);

// The Overview's opening line: what is late and how much of it is explained, in words a lead reads in two seconds.
function leadSentence({ counts, overdue, due_soon: soon }) {
  if (!counts.overdue) {
    return soon.length ? `Nothing is past due. ${cap(plural(soon.length, 'item is', 'items are'))} due in the next two weeks.`
      : 'Nothing is past due, and nothing is due in the next two weeks.';
  }
  const milestones = [...new Set(overdue.map((i) => i.milestone))];
  const head = `${plural(counts.overdue, 'item', 'items')}${milestones.length === 1 ? ` in ${milestones[0]}` : ''} ${counts.overdue === 1 ? 'is' : 'are'} past due.`;
  const reasoned = overdue.filter((i) => i.reason).length;
  const waiting = overdue.filter((i) => !i.reason && i.assignees.length).length;
  const unowned = overdue.filter((i) => !i.reason && !i.assignees.length).length;
  const parts = [
    reasoned && `${word(reasoned)} ${reasoned === 1 ? 'has a reason' : 'have reasons'} from ${reasoned === 1 ? 'its owner' : 'their owners'}`,
    waiting && `${word(waiting)} ${waiting === 1 ? 'is' : 'are'} waiting on a reply`,
    unowned && `${word(unowned)} ${unowned === 1 ? 'has' : 'have'} no owner`,
  ].filter(Boolean);
  const tail = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0];
  return `${head} ${cap(tail)}.`;
}

// Milestones on a dated line with today marked: shows at a glance how far past (or before) each deadline we are.
function MilestoneLine({ overdue, soon }) {
  const ms = new Map();
  for (const i of [...overdue, ...soon]) {
    if (!i.due_on) continue;
    const m = ms.get(i.milestone) ?? { name: i.milestone, due: i.due_on, late: i.days_late > 0, days: i.days_late, open: 0 };
    m.open += 1;
    ms.set(i.milestone, m);
  }
  if (!ms.size) return null;
  const day = (ymd) => Date.parse(`${ymd}T12:00:00`);
  const today = day(localDay());
  const times = [...ms.values()].map((m) => day(m.due)).concat(today);
  const pad = 3 * 86_400_000;
  const lo = Math.min(...times) - pad;
  const hi = Math.max(...times) + pad;
  const at = (t) => ((t - lo) / (hi - lo)) * 100;
  const anchor = (x) => (x < 18 ? 'start' : x > 82 ? 'end' : 'middle');
  return (
    <div className="ms-line" role="img" aria-label={[...ms.values()].map((m) => `${m.name} due ${shortDay(m.due)}${m.late ? `, ${plural(m.days, 'day')} late` : ''}`).join('; ')}>
      <div className="ms-rule" />
      <div className="ms-today" style={{ left: `${at(today)}%` }}><span className={`ms-label below today ${anchor(at(today))}`}>Today</span></div>
      {[...ms.values()].map((m) => {
        const x = at(day(m.due));
        return (
          <div key={m.name} className={`ms-point${m.late ? ' late' : ''}`} style={{ left: `${x}%` }}>
            <span className={`ms-label above ${anchor(x)}`}><b>{m.name}</b> {shortDay(m.due)}</span>
            <span className={`ms-label below ${anchor(x)}${m.late ? ' late-text' : ''}`}>
              {m.late ? `${plural(m.days, 'day')} late` : `${plural(m.open, 'item')} · ${m.days === 0 ? 'due today' : `in ${plural(-m.days, 'day')}`}`}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function Attention({ repo }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let live = true;
    setData(null);
    apiCached(`/attention?${new URLSearchParams({ repo })}`).then((d) => live && setData(d), (e) => live && setError(e.message));
    return () => { live = false; };
  }, [repo]);
  const link = (i) => `/repos/${repo}/${i.kind === 'pr' ? 'pulls' : 'issues'}/${i.number}`;
  if (error) return <p className="error">{error}</p>;
  if (!data) return <Skeleton rows={3} />;
  const kind = (i) => (i.kind === 'pr' ? 'Pull request' : 'Issue');
  const owners = (i) => (i.assignees.length ? i.assignees.join(', ') : 'no owner');
  const bySoon = Map.groupBy ? Map.groupBy(data.due_soon, (i) => i.milestone) : new Map([[null, data.due_soon]]);
  return (
    <>
      <p className="lead-line">{leadSentence(data)}</p>
      <MilestoneLine overdue={data.overdue} soon={data.due_soon} />

      {data.overdue.length > 0 && (
        <section className="ledger" aria-labelledby="late-h">
          <header className="ledger-head">
            <h2 id="late-h">Past due, and why</h2>
            <span>Reasons come from owners' replies to the Slack bot</span>
          </header>
          {data.overdue.map((i) => (
            <div key={i.number} className="ledger-row">
              <div className="ledger-item">
                <Link to={link(i)} className="ledger-title"><Title text={i.title} /></Link>
                <p className="ledger-meta">
                  <span className="ref">#{i.number}</span> · {kind(i)} · {owners(i)} · <span className="late-text">{plural(i.days_late, 'day')} late</span>
                </p>
              </div>
              <div className="ledger-why">
                {i.reason ? <Reason r={i.reason} /> : (
                  <>
                    <p className="muted">
                      {!i.assignees.length ? 'No owner, so nobody has been asked.'
                        : i.alerted_at ? `No reason yet. Asked ${dayMonth(i.alerted_at)}, no reply.`
                          : 'No reason yet. Nobody has been asked.'}
                    </p>
                    <button type="button" className="btn btn-sm" onClick={() => askChat(`Why is #${i.number} late?`)}>
                      {i.assignees.length ? "Ask why it's late" : 'Ask about it'}
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </section>
      )}

      {[...bySoon].map(([milestone, items]) => (
        <section key={milestone ?? 'soon'} className="ledger" aria-label={`Due soon${milestone ? `: ${milestone}` : ''}`}>
          <header className="ledger-head">
            <h2>Next up{milestone ? ` · ${milestone}, due ${new Date(`${items[0].due_on}T12:00:00`).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}` : ''}</h2>
          </header>
          {items.map((i) => (
            <div key={i.number} className="ledger-row compact">
              <div className="ledger-item"><Link to={link(i)}><Title text={i.title} /></Link> <span className="ref">#{i.number}</span></div>
              <div className="ledger-side">{i.draft ? 'Draft pull request' : kind(i)} · {owners(i)}</div>
            </div>
          ))}
        </section>
      ))}

      {data.review.length > 0 && (
        <section className="ledger" aria-labelledby="review-h">
          <header className="ledger-head"><h2 id="review-h">Waiting for review</h2></header>
          {data.review.map((i) => (
            <div key={i.number} className="ledger-row compact">
              <div className="ledger-item"><Link to={link(i)}><Title text={i.title} /></Link> <span className="ref">#{i.number}</span></div>
              <div className="ledger-side">{owners(i)}</div>
            </div>
          ))}
        </section>
      )}
    </>
  );
}

function Overview({ base }) {
  const { data: info, error } = useGitHub(base);
  const { data: langs } = useGitHub(`${base}/languages`);
  const { data: readme, error: noReadme } = useGitHub(`${base}/readme`, 'application/vnd.github.html+json');
  if (error || !info) return <Status error={error} data={info} />;
  return (
    <>
      <Attention repo={base.slice('repos/'.length)} />
      <h3>About this repository</h3>
      {info.description && <p>{info.description}</p>}
      <p className="muted">
        {info.visibility} · default branch <code>{info.default_branch}</code> · ★ {info.stargazers_count} ·{' '}
        {info.forks_count} forks · {info.open_issues_count} open issues + PRs
        {langs && Object.keys(langs).length > 0 && ` · ${Object.keys(langs).join(', ')}`}
      </p>
      <h3>README</h3>
      {noReadme ? <p className="muted">No README.</p>
        : readme ? <Markdown html={readme} /> : <Skeleton />}
    </>
  );
}

function Repo() {
  const { owner, repo, tab: rawTab = 'overview' } = useParams();
  const tab = rawTab === 'code' ? 'commits' : rawTab;
  const [params, setParams] = useSearchParams();
  const [reasons, setReasons] = useState({}); // issue number -> latest reason given to the bot
  const [counts, setCounts] = useState(null);
  useEffect(() => {
    apiCached(`/attention?${new URLSearchParams({ repo: `${owner}/${repo}` })}`).then((d) => setCounts(d.counts), () => {});
  }, [owner, repo]);
  useTitle(`${CODE_TABS.includes(tab) ? 'Code' : TABS[tab] ?? ''} · ${owner}/${repo}`);
  const tabCount = { pulls: counts?.open_prs, issues: counts?.open_issues };
  useEffect(() => {
    if (tab !== 'issues') return;
    api(`/followups?${new URLSearchParams({ repo: `${owner}/${repo}` })}`)
      .then((rows) => setReasons(Object.fromEntries(rows.map((r) => [r.number, r]))), () => {});
  }, [tab, owner, repo]);
  const state = params.get('state') ?? 'open';
  const base = `repos/${owner}/${repo}`;
  const to = (p) => `/repos/${owner}/${repo}/${p}`;

  const body = {
    overview: () => <Overview base={base} />,
    branches: () => (
      <List path={`${base}/branches?per_page=100`} render={(b) => (
        <li key={b.name}><code>{b.name}</code>{b.protected && <span className="badge">protected</span>}</li>
      )} />
    ),
    pulls: () => (
      <List path={`${base}/pulls?state=${state}&per_page=50`} empty={`No ${state === 'all' ? '' : `${state} `}pull requests.`} render={(p) => (
        <li key={p.id} className="row">
          <StateIcon item={p} />
          <div>
          <Link to={to(`pulls/${p.number}`)}><Title text={p.title} /> <span className="ref">#{p.number}</span></Link>
          {p.draft && <span className="badge warn">draft</span>}
          <DueBadge item={p} />
          <span className="muted">{p.user?.login} · {p.head.ref} → {p.base.ref} · <Time value={p.created_at} />{p.milestone && ` · ${milestoneText(p.milestone)}`}</span>
          </div>
          <RowMeta item={p} />
        </li>
      )} />
    ),
    issues: () => (
      // GitHub's issues endpoint also returns pull requests; hide them here.
      <List path={`${base}/issues?state=${state}&per_page=50`} keep={(i) => !i.pull_request}
        empty={`No ${state === 'all' ? '' : `${state} `}issues.`} render={(i) => (
        <li key={i.id} className="row">
          <StateIcon item={i} />
          <div>
          <Link to={to(`issues/${i.number}`)}><Title text={i.title} /> <span className="ref">#{i.number}</span></Link>
          <DueBadge item={i} />
          <span className="muted">
            {i.user?.login} · <Time value={i.created_at} />
            {i.milestone && ` · ${milestoneText(i.milestone)}`}
            {i.labels.length > 0 && ` · ${i.labels.map((l) => l.name).join(', ')}`}
          </span>
          {reasons[i.number] && <Reason r={reasons[i.number]} />}
          </div>
          <RowMeta item={i} />
        </li>
      )} />
    ),
    commits: () => (
      <List path={`${base}/commits?per_page=50`} render={(c) => (
        <li key={c.sha}>
          <Ext href={c.html_url}><code>{c.sha.slice(0, 7)}</code></Ext> {c.commit.message.split('\n')[0]}
          <span className="muted">{c.author?.login ?? c.commit.author.name} · {date(c.commit.author.date)}</span>
        </li>
      )} />
    ),
    actions: () => (
      <List path={`${base}/actions/runs?per_page=30`} render={(r) => (
        <li key={r.id}>
          <Ext href={r.html_url}>{r.display_title || r.name}</Ext>
          <span className={`badge ${runTone(r)}`}>{r.conclusion ?? r.status}</span>
          <span className="muted">{r.name} · {r.head_branch} · {r.event} · {date(r.created_at)}</span>
        </li>
      )} />
    ),
    releases: () => (
      <List path={`${base}/releases?per_page=30`} render={(r) => (
        <li key={r.id}>
          <Ext href={r.html_url}>{r.name || r.tag_name}</Ext>
          {r.prerelease && <span className="badge warn">pre-release</span>}
          {r.draft && <span className="badge warn">draft</span>}
          <span className="muted"><code>{r.tag_name}</code> · {date(r.published_at)}</span>
        </li>
      )} />
    ),
    slack: () => <SlackTab repo={`${owner}/${repo}`} />,
    contributors: () => (
      <List path={`${base}/contributors?per_page=100`} render={(c) => (
        <li key={c.id ?? c.login}>
          <img src={c.avatar_url} alt="" width="20" height="20" /> {c.login}
          <span className="muted">{plural(c.contributions, 'commit')}</span>
        </li>
      )} />
    ),
  }[tab];

  return (
    <>
      <div className="repo-head">
        <div>
          <h1><Link to="/repos" className="crumb">{owner}</Link> / {repo}</h1>
          <p className="kicker"><Ext href={`https://github.com/${owner}/${repo}`}>View on GitHub ↗</Ext></p>
        </div>
        <SlackLinkButton repo={`${owner}/${repo}`} />
      </div>
      <nav className="tabs">
        {Object.entries(TABS).map(([k, label]) => {
          const active = k === tab || (k === 'code' && CODE_TABS.includes(tab));
          return (
            <Link key={k} to={to(k === 'code' ? 'commits' : k)} aria-current={active ? 'page' : undefined}>
              {label}{tabCount[k] > 0 && <span className="count">{tabCount[k]}</span>}
            </Link>
          );
        })}
      </nav>
      {CODE_TABS.includes(tab) && (
        <nav className="toggle" aria-label="Code">
          {CODE_TABS.map((k) => <Link key={k} to={to(k)} aria-current={k === tab ? 'page' : undefined}>{k[0].toUpperCase() + k.slice(1)}</Link>)}
        </nav>
      )}
      {(tab === 'pulls' || tab === 'issues') && (
        <div className="toggle">
          {['open', 'closed', 'all'].map((s) => (
            <button key={s} aria-pressed={s === state} onClick={() => setParams({ state: s })}>{s[0].toUpperCase() + s.slice(1)}</button>
          ))}
        </div>
      )}
      {body ? body() : <p className="error">Unknown tab.</p>}
    </>
  );
}

// One line of the activity timeline for events that aren't comments ("added label bug", "mentioned this in #13").
function eventText(e, link) {
  const ref = (i) => <Link to={link(i)}>#{i.number} <Title text={i.title} /></Link>;
  switch (e.event) {
    case 'labeled': return <>added {e.labels.map((l) => <Label key={l.name} label={l} />)}</>;
    case 'unlabeled': return <>removed {e.labels.map((l) => <Label key={l.name} label={l} />)}</>;
    case 'milestoned': return <>added this to <b>{e.milestone.title}</b></>;
    case 'demilestoned': return <>removed this from <b>{e.milestone.title}</b></>;
    case 'assigned': return e.assignee?.login === e.actor?.login ? 'self-assigned this' : <>assigned <b>{e.assignee?.login}</b></>;
    case 'unassigned': return <>unassigned <b>{e.assignee?.login}</b></>;
    case 'closed': return e.state_reason === 'not_planned' ? 'closed this as not planned' : <>closed this{e.commit_id && <> in <code>{e.commit_id.slice(0, 7)}</code></>}</>;
    case 'reopened': return 'reopened this';
    case 'merged': return <>merged commit <code>{e.commit_id?.slice(0, 7)}</code></>;
    case 'renamed': return <>changed the title from <s>{e.rename.from}</s></>;
    case 'cross-referenced': return e.source?.issue ? <>mentioned this in {ref(e.source.issue)}</> : null;
    case 'referenced': return <>referenced this in commit <code>{e.commit_id?.slice(0, 7)}</code></>;
    case 'committed': return <>committed <code>{e.sha.slice(0, 7)}</code> {e.message.split('\n')[0]}</>;
    case 'review_requested': return <>requested a review from <b>{e.requested_reviewer?.login ?? e.requested_team?.name}</b></>;
    case 'ready_for_review': return 'marked this ready for review';
    case 'convert_to_draft': return 'marked this as draft';
    case 'head_ref_deleted': return 'deleted the branch';
    default: return null; // subscribed, mentioned, etc.: noise
  }
}

// GitHub label: a dot in the label's own color, text in ours (label colors are user-picked and often low-contrast).
const Label = ({ label }) => (
  <span className="label"><i style={{ background: `#${label.color}` }} />{label.name}</span>
);

// Back-to-back label changes by the same person in the same minute read as one line, like on GitHub.
function groupEvents(events) {
  const out = [];
  for (const e of events) {
    const prev = out.at(-1);
    const at = e.created_at?.slice(0, 16);
    if (prev && ['labeled', 'unlabeled'].includes(e.event) && prev.event === e.event
      && prev.actor?.login === e.actor?.login && prev.created_at?.slice(0, 16) === at) {
      if (!prev.labels.some((l) => l.name === e.label.name)) prev.labels.push(e.label);
    } else out.push(['labeled', 'unlabeled'].includes(e.event) ? { ...e, labels: [e.label] } : e);
  }
  return out;
}

const REVIEW_STATE = { approved: ['approved these changes', 'ok'], changes_requested: ['requested changes', 'late'], commented: ['reviewed', ''] };

function Timeline({ events, link }) {
  return (
    <ol className="timeline">
      {groupEvents(events).map((e, i) => {
        const who = e.actor ?? e.user;
        if (e.event === 'commented' || (e.event === 'reviewed' && e.body_html)) {
          const [verb, tone] = REVIEW_STATE[e.state] ?? [];
          return (
            <li key={e.id ?? i} className="tl-comment">
              {who && <img className="tl-avatar" src={who.avatar_url} alt="" width="32" height="32" />}
              <div className="tl-card">
                <div className="tl-head">
                  <b>{who?.login}</b> {verb && <span className={`badge ${tone}`}>{verb}</span>} <Time value={e.created_at ?? e.submitted_at} />
                </div>
                <Markdown html={e.body_html} />
              </div>
            </li>
          );
        }
        if (e.event === 'reviewed') {
          const [verb, tone] = REVIEW_STATE[e.state] ?? ['reviewed', ''];
          return <li key={e.id ?? i} className="tl-event"><b>{who?.login}</b> <span className={`badge ${tone}`}>{verb}</span> <Time value={e.submitted_at} /></li>;
        }
        const text = eventText(e, link);
        if (!text) return null;
        return (
          <li key={e.id ?? e.sha ?? i} className="tl-event">
            {who?.avatar_url ? <img src={who.avatar_url} alt="" width="18" height="18" /> : <i className="tl-dot" />}
            <span>{(who?.login ?? e.author?.name) && <b>{who?.login ?? e.author.name}</b>} {text} <Time value={e.created_at ?? e.author?.date} /></span>
          </li>
        );
      })}
    </ol>
  );
}

// Right-hand column: who, what, when, and what it's linked to.
function DetailSidebar({ item, events, link }) {
  const linked = new Map();
  for (const e of events ?? []) {
    const i = e.event === 'cross-referenced' && e.source?.issue;
    if (i && !linked.has(i.number)) linked.set(i.number, i);
  }
  const people = (list) => (list?.length
    ? list.map((u) => <div key={u.login} className="side-person"><img src={u.avatar_url} alt="" width="20" height="20" />{u.login}</div>)
    : <span className="muted">None</span>);
  return (
    <aside className="detail-side">
      <section><h4>Assignees</h4>{people(item.assignees)}</section>
      {item.requested_reviewers && <section><h4>Reviewers</h4>{people(item.requested_reviewers)}</section>}
      <section>
        <h4>Labels</h4>
        {item.labels?.length ? <div className="side-labels">{item.labels.map((l) => <Label key={l.name} label={l} />)}</div> : <span className="muted">None</span>}
      </section>
      <section>
        <h4>Milestone</h4>
        {item.milestone ? <><div>{item.milestone.title}</div><div className="muted">{item.milestone.due_on ? `due ${shortDay(item.milestone.due_on.slice(0, 10))}` : 'no due date'} <DueBadge item={item} /></div></> : <span className="muted">None</span>}
      </section>
      <section>
        <h4>Linked</h4>
        {linked.size ? [...linked.values()].map((i) => (
          <div key={i.number} className="side-link"><StateIcon item={i} /><Link to={link(i)}>#{i.number} <Title text={i.title} /></Link></div>
        )) : <span className="muted">{events ? 'Nothing linked' : '…'}</span>}
      </section>
    </aside>
  );
}

// ---------- PR diff ----------
// Only these languages are bundled (highlight.js/lib/core keeps the build small); other files render plain.
for (const [name, lang] of Object.entries({ bash: hljsBash, css: hljsCss, go: hljsGo, java: hljsJava, javascript: hljsJs, json: hljsJson,
  markdown: hljsMd, python: hljsPy, rust: hljsRust, sql: hljsSql, typescript: hljsTs, xml: hljsXml, yaml: hljsYaml })) hljs.registerLanguage(name, lang);
const LANG_BY_EXT = { js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  json: 'json', css: 'css', html: 'xml', xml: 'xml', svg: 'xml', md: 'markdown', py: 'python', go: 'go', rs: 'rust', java: 'java',
  sh: 'bash', zsh: 'bash', bash: 'bash', yml: 'yaml', yaml: 'yaml', sql: 'sql' };
const langOf = (path) => LANG_BY_EXT[path.split('.').pop().toLowerCase()];

// highlight.js escapes the source text and only adds <span class="hljs-…">, so its output is safe for innerHTML.
const highlight = (code, lang) => (lang ? hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
  : code.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]));

// Unified-diff patch → rows with old/new line numbers. Lines are highlighted one at a time (as on GitHub), so a
// construct spanning lines, like a block comment, may color imperfectly.
function parsePatch(patch) {
  const rows = [];
  let a = 0;
  let b = 0;
  for (const line of patch.split('\n')) {
    const h = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/);
    if (h) { a = Number(h[1]); b = Number(h[2]); rows.push({ type: 'hunk', text: line }); continue; }
    if (line.startsWith('\\')) continue; // "\ No newline at end of file"
    const type = line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : 'ctx';
    rows.push({ type, text: line.slice(1), old: type === 'add' ? null : a++, new: type === 'del' ? null : b++ });
  }
  return rows;
}

function FileDiff({ file, comments }) {
  const [open, setOpen] = useState(file.status !== 'removed' && (file.changes ?? 0) < 400);
  const lang = langOf(file.filename);
  const rows = useMemo(() => (open && file.patch ? parsePatch(file.patch) : []), [open, file.patch]);
  const at = (r) => (r.type === 'del' ? [] : comments.filter((c) => (c.line ?? c.original_line) === r.new && c.side !== 'LEFT'));
  const placed = new Set(rows.flatMap((r) => at(r).map((c) => c.id)));
  return (
    <div className="file-diff">
      <button type="button" className="file-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="file-chevron">{open ? '▾' : '▸'}</span>
        <code>{file.previous_filename ? `${file.previous_filename} → ` : ''}{file.filename}</code>
        <span className="file-stat"><span className="add">+{file.additions}</span> <span className="del">−{file.deletions}</span></span>
        {file.status !== 'modified' && <span className="badge">{file.status}</span>}
      </button>
      {open && (file.patch ? (
        <table className="diff">
          <colgroup><col className="ln-col" /><col className="ln-col" /><col /></colgroup>
          <tbody>
            {rows.map((r, i) => (r.type === 'hunk'
              ? <tr key={i} className="diff-hunk"><td colSpan="3">{r.text}</td></tr>
              : (
                <Fragment key={i}>
                  <tr className={`diff-${r.type}`}>
                    <td className="ln">{r.old ?? ''}</td>
                    <td className="ln">{r.new ?? ''}</td>
                    <td className="code"><span className="sign">{{ add: '+', del: '−', ctx: ' ' }[r.type]}</span><span dangerouslySetInnerHTML={{ __html: highlight(r.text, lang) }} /></td>
                  </tr>
                  {at(r).map((c) => (
                    <tr key={c.id} className="diff-comment"><td colSpan="3">
                      <div className="tl-card">
                        <div className="tl-head"><b>{c.user?.login}</b> <Time value={c.created_at} /></div>
                        <Markdown html={c.body_html} />
                      </div>
                    </td></tr>
                  ))}
                </Fragment>
              )))}
          </tbody>
        </table>
      ) : <p className="muted diff-none">{file.status === 'renamed' ? 'Renamed without changes.' : 'Binary or too large to show; view it on GitHub.'}</p>)}
      {open && comments.filter((c) => !placed.has(c.id)).map((c) => (
        <div key={c.id} className="tl-card diff-outdated">
          <div className="tl-head"><b>{c.user?.login}</b> <span className="badge">outdated</span> <Time value={c.created_at} /></div>
          <Markdown html={c.body_html} />
        </div>
      ))}
    </div>
  );
}

function PullDiff({ base, n }) {
  const files = useGitHub(`${base}/pulls/${n}/files?per_page=100`);
  const comments = useGitHub(`${base}/pulls/${n}/comments?per_page=100`, FULL);
  if (files.error || !files.data) return <Status error={files.error} data={files.data} />;
  return (
    <>
      {files.data.map((f) => <FileDiff key={f.filename} file={f} comments={(comments.data ?? []).filter((c) => c.path === f.filename)} />)}
      {files.more && <button className="btn" onClick={files.more}>Load more files</button>}
    </>
  );
}

function Detail({ kind }) {
  const { owner, repo, n } = useParams();
  const base = `repos/${owner}/${repo}`;
  const { data: item, error } = useGitHub(`${base}/${kind}/${n}`, FULL);
  const timeline = useGitHub(`${base}/issues/${n}/timeline?per_page=100`, FULL);
  useTitle(item ? `#${item.number} ${item.title} · ${owner}/${repo}` : `#${n} · ${owner}/${repo}`);
  if (error || !item) return <Status error={error} data={item} />;
  const isPR = kind === 'pulls';
  const link = (i) => `/repos/${owner}/${repo}/${i.pull_request ? 'pulls' : 'issues'}/${i.number}`;
  const status = item.merged ? 'merged'
    : item.draft ? 'draft'
    : item.state === 'closed' && item.state_reason === 'not_planned' ? 'not planned'
    : item.state;
  return (
    <>
      <p className="kicker"><Link to={`/repos/${owner}/${repo}/${kind}`}>← {owner}/{repo}</Link></p>
      <h1><Title text={item.title} /> <span className="num">#{n}</span></h1>
      <p className="detail-meta">
        <span className={`badge status-${status.replace(' ', '-')}`}>{status}</span>
        <span><b>{item.user?.login}</b> opened this <Time value={item.created_at} /> · {plural(item.comments, 'comment')}</span>
        <Ext href={item.html_url}>View on GitHub ↗</Ext>
      </p>
      {isPR && (
        <p className="kicker">
          <code>{item.head.ref}</code> → <code>{item.base.ref}</code> · {plural(item.commits, 'commit')} ·{' '}
          {plural(item.changed_files, 'file')} · <span className="add">+{item.additions}</span> <span className="del">−{item.deletions}</span>
        </p>
      )}
      <div className="detail">
        <div className="detail-main">
          <div className="tl-comment">
            <img className="tl-avatar" src={item.user?.avatar_url} alt="" width="32" height="32" />
            <div className="tl-card">
              <div className="tl-head"><b>{item.user?.login}</b> <Time value={item.created_at} /></div>
              <Markdown html={item.body_html} empty="No description provided." />
            </div>
          </div>
          {!isPR && <LateReasons repo={`${owner}/${repo}`} number={n} />}
          <h3>Activity</h3>
          {timeline.error || !timeline.data ? <Status error={timeline.error} data={timeline.data} />
            : timeline.data.length ? <Timeline events={timeline.data} link={link} /> : <p className="muted">No activity yet.</p>}
          {timeline.more && <button className="btn" onClick={timeline.more}>Load more</button>}
        </div>
        <DetailSidebar item={item} events={timeline.data} link={link} />
      </div>
      {isPR && (
        <>
          <h3>Files changed <span className="h-count">{item.changed_files}</span></h3>
          <PullDiff base={base} n={n} />
        </>
      )}
    </>
  );
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route element={<Layout />}>
          <Route path="/repos" element={<Repos />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/repos/:owner/:repo/:tab?" element={<Repo />} />
          <Route path="/repos/:owner/:repo/pulls/:n" element={<Detail kind="pulls" />} />
          <Route path="/repos/:owner/:repo/issues/:n" element={<Detail kind="issues" />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
