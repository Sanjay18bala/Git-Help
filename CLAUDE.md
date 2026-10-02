# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install
npm run dev     # Vite dev server on http://localhost:5173 (also serves the API — there is no separate backend process)
npm test        # node --test: runs every *.test.js (plain node:assert scripts, no framework); no linter
node slack.test.js  # run a single test file
node eval/rag-eval.js  # RAG answer key against the real dev server + models (needs the brewlog demo data and `gh` auth)
npx vite build  # sanity-check that the frontend compiles (dist/ is gitignored)
```

`npm run dev` refuses to start unless `.env` has `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and `SESSION_SECRET` (see `.env.example` / README). Port 5173 is fixed (`strictPort`) because it must match the GitHub OAuth App callback URL `http://localhost:5173/auth/callback`. Node >= 22.13 (for the built-in `node:sqlite`). `SLACK_USER_TOKEN` is optional; without it the Slack UI explains how to set it up. The chat needs Ollama (`gemma3:4b` + `nomic-embed-text` by default) or a cloud provider configured on `/settings`.

## Architecture

A read-only GitHub dashboard: Express backend + React SPA, both served by one Vite dev server.

- **`server.js`** exports an Express `app`; **`vite.config.js`** mounts it as middleware via a plugin (`configureServer`). So `/auth/*` and `/api/gh/*` are handled in-process by Vite. `server.js` loads `.env` itself with `process.loadEnvFile()`.
- **Auth:** GitHub OAuth web flow (`/auth/login` → GitHub → `/auth/callback`) with a random `state` cookie. The access token is stored in an AES-256-GCM-encrypted `HttpOnly` cookie (`seal`/`unseal` in `secrets.js`, keyed by `SESSION_SECRET`, re-exported from `server.js`); the token never reaches browser JS. `/api/slack`, `/api/settings`, `/api/index` and `/api/chat` share `requireSession`, which sets `req.token`.
- **Proxy:** `/api/gh/<path>` forwards to `api.github.com/<path>` with the user's token. It is **GET-only and allowlisted** (`ALLOWED` regexes in `server.js`). Read-only is enforced here, not by OAuth scope (`repo` grants write, but GitHub has no read-only private-repo scope). To show new GitHub data: add the pattern to `ALLOWED`, add a case to `server.test.js`, then fetch it in the UI. The proxy forwards only `application/vnd.github.*` Accept headers and passes through `Link` and `x-ratelimit-remaining`.
- **Frontend is a single file, `src/main.jsx`** (routes, pages, components), plus `src/style.css`. React Router routes: `/` (login/onboarding), and under `Layout`: `/repos`, `/repos/:owner/:repo/:tab?`, `/repos/:owner/:repo/(pulls|issues)/:n`.

### Slack (`slack.js` + `/api/slack/*` in `server.js`)

- Read-only Slack access via a **user token** (`xoxp-`, from a Slack app the user installs from the manifest in the README). It can read channels the user is a member of; no bot, no Slack OAuth flow (Slack requires HTTPS redirects).
- Linked channels are copied into SQLite at `.data/git-help.db`. **`db.js` owns the whole schema** (Slack tables, `settings`, `chunks` + `chunks_fts`, `indexed_repos`); `GIT_HELP_DB` overrides the path and tests use `:memory:`. `db()` opens lazily, so importing `server.js` doesn't create the file. Slack tables: `links` (repo↔channel), `channels` (sync state: `latest_ts`, `synced_at`), `messages` (thread replies have `thread_ts` ≠ `ts`), `users` (id → display name).
- `sync()`: first run backfills 90 days; later runs resume from `latest_ts` minus a 7-day overlap and upsert, so edits within the overlap are picked up. Threads are fetched with `conversations.replies` for any parent with `reply_count`. Join/leave-type subtypes are skipped. 429s are retried using `Retry-After`. Concurrent syncs of one channel share one promise.
- Unlinking the last repo from a channel deletes that channel's messages and its RAG chunks. Link and sync routes re-index the channel afterwards; an indexing failure (e.g. Ollama down) is returned as `index_error` rather than failing the sync.
- Messages are stored in Slack markup; `plainText()` converts mentions/links/entities when reading, using the `users` table.
- Routes require a GitHub session and validate `repo` (`owner/name`) and channel ids. Slack API errors become 502s with friendly messages (`friendly()`).
- Single-user by design: one token and one database for the whole app.
- Frontend: `SlackContext` (status + all links, loaded once in `Layout`) feeds `SlackLinkButton` (opens `SlackLinkDialog`, a native `<dialog>`), the repo's **Slack** tab (`SlackTab`) and the chat panel's status line. `SlackTab` keeps the link button at a fixed tree position so its dialog survives the first link.

### Chat / RAG (`rag.js`, `llm.js`, `/api/chat`)

- **Providers (`llm.js`):** chat via Ollama (`/api/chat`, `num_ctx` 12288 set explicitly because Ollama silently truncates), Anthropic (official `@anthropic-ai/sdk`, streaming; on current Claude models it sets `output_config.effort` and `fallbacks: "default"` with the `server-side-fallback-2026-07-01` beta) or any OpenAI-compatible API. Embeddings via Ollama or OpenAI-compatible (Anthropic has none). `nomic-embed-text` needs `search_document:` / `search_query:` prefixes (`withPrefix`). Settings are one JSON row in `settings`; API keys are sealed with `secrets.js`, env vars are fallbacks, and `publicSettings()` (what the browser gets) reports only `saved` / `env` / `null` for keys.
- **Chunks (`rag.js`):** a Slack thread = one chunk; other Slack messages are grouped into conversations split at 15-minute gaps; each GitHub issue/PR is a chunk plus one for its comments (titled `… (comments)`, reused without refetching when `updated_at` is unchanged); the README is split by lines. `split()` caps chunks at 1800 chars with one line of overlap. `store()` upserts by content hash, so unchanged chunks keep their embeddings; `embedPending()` embeds anything missing or from a different `embedModel()` (switching models re-embeds). Index runs are serialized (`serial`).
- **Scope:** with `repo`, retrieval is limited to that repo's GitHub chunks and its linked channels; without, to all indexed repos and linked channels. `rag.test.js` asserts the isolation.
- **Retrieval:** FTS5 BM25 (`ftsQuery()` quotes every term so user text can't be an FTS syntax error) + brute-force cosine over embeddings (marked `ponytail:`; `sqlite-vec` past ~50k chunks), fused with reciprocal rank fusion; top 8, capped at 24k chars of context.
- **Routing (`route()`):** every message first gets a short PROJECT/CHAT classification call (few-shot `ROUTER` prompt). CHAT (greetings, thanks, general git knowledge) skips indexing and retrieval and uses `smallTalkPrompt()`: small local models cite any sources they're given, even for "hello". Safety net that doesn't depend on the model: a CHAT verdict becomes PROJECT when 2+ of the message's keywords appear together in one indexed chunk in scope (`sharedTerms()`; co-occurrence matters, otherwise generic words like "git"/"merge" scattered across chunks trigger it).
- **Deadlines:** an issue/PR's deadline is its **milestone `due_on`** (GitHub has no per-issue due date; Projects date fields would need GraphQL + `read:project`). Due dates are calendar dates stored as midnight UTC, so compare **date parts only** (`daysLate()`/`localDate()` in rag.js, `deadline()` in main.jsx): as a timestamp "Sep 29" becomes Sep 28 west of UTC. Only open items are overdue. UI: `DueBadge` (overdue = `.badge.late`), milestone in list rows and the detail header.
- **Exact counts:** retrieval only sees ~8 chunks, so it can't count. `indexGithub()` also fills the `items` table (one row per issue/PR: state, labels, assignees…), and `repoOverview()` turns it into a source that is always source [1] in repo scope. Its format is deliberate for small models: a labelled "Counts:" block first (one count per line; totals say "open and closed" explicitly, because gemma3:4b once read "6 pull requests" total as open), then one item per line under Overdue / Upcoming deadlines / Open issues / … headings (top 5 indexed repos in general scope). GitHub data older than `REFRESH_MINUTES` (10) is re-fetched before answering a PROJECT question.
- **Answering:** sources go in `<source id="n">` tags inside the final user message; `systemPrompt()` requires answers only from sources, inline `[n]` citations, counts from the overview, no "based on the provided sources", plain text, and treating source text as data. The last 2 user turns form the retrieval query (follow-ups keep their topic); earlier answers' `[n]` markers are stripped from the history. With nothing indexed, the model is told so rather than given sources.
- **`/api/chat`** routes first, then (PROJECT only) runs `ensureIndexed`, and streams NDJSON events: `status`, `sources`, `token`…, then `done` or `error`. Client disconnect aborts the model request.
- **Frontend:** `ChatPanel` keeps one conversation per repo key, reads the stream with `chatStream()`, renders `[n]` citations as links (`AnswerText`) plus a collapsible `SourceList` of only the sources the answer cites, and has a stop button. `LlmContext` (loaded in `Layout`) feeds the panel's model label and `SettingsPage` (`/settings`); an empty key field keeps the saved key, "remove" sends `null`.
- **Quality check:** `eval/rag-eval.js` (14 cases: project questions with expected sources, exact counts, small talk / general questions that must not cite, and a casually worded project question). Last run with `gemma3:4b` + `nomic-embed-text`: 14/14, ~1.4 s to first token for project answers, ~0.5 s for small talk. Run it after changing prompts, routing or retrieval; the 4B model still occasionally adds unsupported details or uses Markdown despite instructions.

### `useGitHub(path, accept)` — the one data hook; its details matter

- State is tagged with a `key` (`accept + path`) and only returned when it matches the current request. This prevents a reused component (e.g. `List` across repo tabs) from rendering the previous tab's data with the new tab's renderer — that previously crashed the whole app (blank page). Keep this when touching the hook.
- An `AbortController` in a ref cancels in-flight loads, including "Load more", when the path changes.
- Pagination uses only the `page` number from GitHub's `Link` header (next URLs can be `/repositories/:id/...`, which the allowlist rejects).
- Body parsing: GitHub labels rendered HTML as `application/vnd.github.html+json`, so `vnd.github.html|raw` types are read as text even though the type contains "json".
- `actions/runs` returns `{ workflow_runs: [...] }`; the hook unwraps it.
- 401 → navigate to `/`.

### Rendering GitHub Markdown

PR/issue bodies, comments and reviews are fetched with Accept `application/vnd.github.full+json` (the `FULL` constant) to get `body_html`; the README uses `application/vnd.github.html+json`. HTML is rendered via the `Markdown` component, which always runs `DOMPurify.sanitize` before `dangerouslySetInnerHTML`. Never inject GitHub HTML without it.

### Layout and design

- Signed-in pages use a two-column shell (`.app` / `.shell`): GitHub content on the left, `ChatPanel` sticky on the right. Under 900px the chat becomes a full-screen overlay opened by `.chat-fab`.
- `ChatPanel` is the RAG chat described above; its header shows the scope, Slack link status and the active model (linking to `/settings`).
- `ErrorBoundary` wraps the routed page (keyed by pathname) so a render error shows a message instead of a blank page.
- Visual style mirrors the owner's portfolio: Geist / Geist Mono (Google Fonts in `index.html`), monochrome tokens on `:root`, lowercase mono labels, section titles with a trailing rule. Colors must come from the CSS variables; dark mode is defined both under `prefers-color-scheme` and `[data-theme="dark"]` (the footer toggle sets `data-theme` and saves it in `localStorage`; an inline script in `index.html` applies it before first paint).

## Demo data

The Slack channel `#brew-log` (in the Git-Help workspace) is seeded with ~30 messages / 6 threads that mirror the brewlog issues and PRs, plus unrelated chatter, and is linked to `Sanjay18bala/brewlog`.

`Sanjay18bala/brewlog` (private) is a demo repo created for visual testing: correlated issues and PRs (merged fixes closing bugs, an open PR with an inline review that spawned a bug issue, a draft PR, a closed-unmerged experiment, a not-planned issue, releases v0.1.0/v0.2.0). Its CI workflow PR is not yet created — pushing `.github/workflows/` requires the `gh` token to have the `workflow` scope.
