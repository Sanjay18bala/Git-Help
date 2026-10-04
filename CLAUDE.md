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

`npm run dev` refuses to start unless `.env` has `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `SESSION_SECRET` and the three Slack tokens `SLACK_USER_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` (`checkEnv()` in server.js; see `.env.example` / README). Slack is required, not optional: the bot and linked channels are the product's core. Port 5173 is fixed (`strictPort`) because it must match the GitHub OAuth App callback URL `http://localhost:5173/auth/callback`. Node >= 22.13 (for the built-in `node:sqlite`). The chat needs Ollama (`gemma3:4b` + `nomic-embed-text` by default) or a cloud provider configured on `/settings`.

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

### Slack bot, people and overdue alerts (`bot.js`, `alerts.js`)

- **Bot** (`bot.js`): acts as the GitHelp bot with `SLACK_BOT_TOKEN` (slack.js only ever reads as the user). `matchPerson()` links GitHub logins to Slack users: commit email (non-noreply) → unique full name (incl. commit author names) → handle → first name; a signal matching more than one Slack user is skipped. Only `high` (email/name) auto-confirms; the bot messages **confirmed** links only (`slackUserFor`). Manual choices (`method = 'manual'`) are never overwritten by re-matching.
- **Alerts** (`alerts.js`): off until enabled per repo (`settings` key `alerts`). `planAlerts()` is pure (dry run): open **issues** past their milestone date × assignees with a confirmed link → `first` alert, then one `reminder` after 3 days without a reply, then nothing until `due_on` changes (alerts are keyed by due date). `sendAlerts()` DMs via `conversations.open` + `chat.postMessage` and logs to `alerts`.
- **Replies**: Socket Mode (`SLACK_APP_TOKEN`, Node's built-in WebSocket) receives `message.im`; `recordReply()` maps a reply to its alert by `thread_ts`, else the latest alert in that DM, stores a `followups` row, thanks the user, and `indexFollowups()` makes it a chunk (`followup:` ids, excluded from GitHub re-indexing). `repoOverview()` adds the latest reason to each overdue line and precomputed "with a reason / no reason yet" counts (the 4B model misread the per-line text).
- **Background**: `startBackground()` (called from vite.config) runs a 15-minute check + the socket. It lives on `globalThis.__gitHelpAlerts` and a new start stops the old one, because Vite restarts re-import the module and old timers/sockets would otherwise keep running and double-send. It uses the signed-in user's GitHub token stored sealed in `settings` (`github`), saved on login/any authenticated request and deleted on sign-out.

### Slack digest and the Attention page

- **Digest** (`alerts.js`): per repo, off / daily (weekdays) / weekly (from Monday), stored in `settings` key `digest`. `digestPeriod()` decides which period is due (never before `DIGEST_HOUR` 9:00 local); `runDigests()` (in the 15-minute `checkNow`) posts once per period via `sendDigest()`, which posts `digestText()` (Slack mrkdwn built from `rag.attention()`: late items with days late and the reason, or why there is none, then "Next up" per milestone) to every channel linked to the repo and logs it in `digests`. A daily digest with nothing late or due within 3 days posts nothing (logged as a skip row). The bot must be in the channel: `not_in_channel` becomes an "/invite @GitHelp" instruction. Routes: `GET/PUT /api/digest`, `POST /api/digest/send`.
- **Attention page** (`/attention`, `AttentionPage`): everything late across indexed repos from `GET /api/attention/all` (local index only), reusing `LateLedger` with the Overview. The sidebar's Attention link shows the total from `/api/attention/summary`.

### Attention dashboard and chat accuracy rules

- **Overview tab** = `Attention` (from `rag.attention()` via `/api/attention`, local index only; first visit indexes the repo): a lead sentence (`leadSentence()`: how many items are past due, and how many have a reason / are waiting on a reply / have no owner), `MilestoneLine` (milestones and today on a to-scale dated line), the "Past due, and why" ledger (each row states days late and either the latest reason or exactly why there is none, with an ask button that dispatches `git-help:ask`, which opens Ask and sends the question), "Next up" grouped by milestone, and PRs waiting for review. The repo list shows per-repo overdue badges (`/api/attention/summary`).
- **Named issues**: when a question mentions `#N`, `issueFacts()` adds an exact fact sheet per issue as the first sources and the overview plus other issues' `followup:` chunks are left out. gemma3:4b otherwise attributed #6's reason to #8 even when told not to; removing the material worked where instructions didn't.
- **Dates**: deadlines (`due_on`) are calendar dates; event times (`sent_at`, `created_at`) are timestamps shown as the *local* date (`localDayOf`). Mixing them made "asked on Oct 2" appear before "today is Oct 1".
- **Tabs**: six top-level tabs; `code` groups commits/branches/releases/contributors (`CODE_TABS`), whose old URLs still work. Ask opens and closes with the sidebar button or ⌘J (persisted in localStorage `ask`); `/` opens and focuses it (`git-help:focus`). ⌘K opens search.

### `useGitHub(path, accept)` — the one data hook; its details matter

- State is tagged with a `key` (`accept + path`) and only returned when it matches the current request. This prevents a reused component (e.g. `List` across repo tabs) from rendering the previous tab's data with the new tab's renderer — that previously crashed the whole app (blank page). Keep this when touching the hook.
- An `AbortController` in a ref cancels in-flight loads, including "Load more", when the path changes.
- Pagination uses only the `page` number from GitHub's `Link` header (next URLs can be `/repositories/:id/...`, which the allowlist rejects).
- Body parsing: GitHub labels rendered HTML as `application/vnd.github.html+json`, so `vnd.github.html|raw` types are read as text even though the type contains "json".
- `actions/runs` returns `{ workflow_runs: [...] }`; the hook unwraps it.
- 401 → navigate to `/`.
- Successful results are cached per key in `ghCache` (stale-while-revalidate): a revisited tab renders at once and refetches in the background. Small `/api` reads that several components want (e.g. `/attention` for tab counts and the Overview) go through `apiCached` (10 s).

### Rendering GitHub Markdown

PR/issue bodies, comments and reviews are fetched with Accept `application/vnd.github.full+json` (the `FULL` constant) to get `body_html`; the README uses `application/vnd.github.html+json`. HTML is rendered via the `Markdown` component, which always runs `DOMPurify.sanitize` before `dangerouslySetInnerHTML`. Never inject GitHub HTML without it.

### Layout and design

- The product is called **GitHelp** in all UI text (the repo folder, package and `.data/git-help.db` keep their old names; `git-help:*` are internal event names).
- Signed-in pages use `.app`: a left **sidebar** (brand, search ⌘K, Repositories with the current repo under it, Settings, the Ask button ⌘J, connection status, account), the page in `.page-body`, and **Ask** (`ChatPanel`) as a right-hand panel only while open. ChatPanel stays mounted when closed (`hidden`) so conversations survive. Under 1100px Ask overlays the page; under 760px the sidebar becomes a compact top bar.
- `ErrorBoundary` wraps the routed page (keyed by pathname) so a render error shows a message instead of a blank page.
- **Visual direction: an engineering status report, not a dashboard template.** IBM Plex Sans for all UI text; IBM Plex Mono only for code, SHAs, issue numbers (`.ref`), counts, keyboard shortcuts and diffs. Sentence case everywhere ("Save changes", "View on GitHub"). Section titles are 15px semibold with a full-width rule under them; lists are rows separated by hairlines, not cards. Corners are `--radius` (3px). No gradients, glows, pills or decorative icons.
- **Three themes**: light (default), graphite ("Dark A") and slate ("Dark B"), set as `data-theme` on `<html>` by the switch under Settings › Appearance (saved in localStorage `theme`; an inline script in `index.html` applies it before first paint and maps an old saved `dark` to graphite). With no saved choice, the OS dark preference gets graphite. Colors must come from the CSS variables.
- **Color is a signal, not decoration.** `--danger` means *late* and is the only signal color: overdue milestones, "N days late", and lateness in lists (as plain text, no box). Waiting on a reply, has a reason, due later, open and merged are all neutral; icon shape and type carry them. `--warn` is reserved for items due within 3 days. Diff and syntax colors are the exception (code review conventions). Every text color passes 4.5:1 on `--bg`, `--panel` and `--subtle` in all three themes; re-check contrast when changing a token.
- Spacing uses the 4px scale and type sizes from the token block at the top of `style.css`. Every button is `.btn` plus a variant (`btn-primary`, default outline, `btn-ghost`) and optionally `btn-sm`/`btn-lg`; one primary per screen. Settings is built from `<Setting title desc>` sections (description column left, fields right; inputs share one compact style with a 3:1 border and a focus ring; related fields pair up in `.field-pair`); the Save buttons sit in the section they save (models and connections), while the Slack bot and alert controls save immediately. Loading states use `<Skeleton />`, confirmations `toast('Saved')`, page titles `useTitle()`, issue titles `<Title>` (renders Markdown backticks as code). Issue/PR list rows are `li.row` with `<StateIcon>` (Octicon paths inlined) and `<RowMeta>`. The issue/PR page has a sidebar and a timeline from `issues/:n/timeline`; PRs show a diff (`parsePatch` + highlight.js core with a few registered languages, inline review comments).

## Demo data

The Slack channel `#brew-log` (in the Git-Help workspace) is seeded with ~30 messages / 6 threads that mirror the brewlog issues and PRs, plus unrelated chatter, and is linked to `Sanjay18bala/brewlog`.

`Sanjay18bala/brewlog` (private) is a demo repo created for visual testing: correlated issues and PRs (merged fixes closing bugs, an open PR with an inline review that spawned a bug issue, a draft PR, a closed-unmerged experiment, a not-planned issue, releases v0.1.0/v0.2.0). Its CI workflow PR is not yet created — pushing `.github/workflows/` requires the `gh` token to have the `workflow` scope.
