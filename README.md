# Git-Help

A read-only dashboard for everything in your GitHub account. Sign in with GitHub, pick a repository, and browse its
branches, pull requests, issues, commits, Actions runs, releases and contributors in one place.

It runs on your own machine. You sign in through GitHub's own login page, so the app never sees your password.

## Features

- Sign in with GitHub (OAuth)
- All your repositories: personal, collaborator and organization, with a filter box
- For each repository:
  - Overview: stats, languages and README
  - Branches
  - Pull requests (open, closed or all), each with its description, changed files, reviews and comments
  - Issues (open, closed or all), each with its labels, assignees and comments
  - Commits
  - GitHub Actions runs
  - Releases
  - Contributors
- **Slack (optional):** link Slack channels to a repo and read their conversations and threads next to the code
- **Chat (optional):** ask questions in the side panel and get answers grounded in the repo's issues, pull requests,
  README and linked Slack channels, with links to every source. Runs on a local model through Ollama by default;
  Anthropic (Claude) or any OpenAI-compatible API can be chosen on the **Settings** page.
- Light and dark mode, following your system setting

## Requirements

- [Node.js](https://nodejs.org/) **22.13 or newer**. Check with `node -v`.
- For the chat: [Ollama](https://ollama.com) (free, runs locally), or an API key for a cloud model.
- A GitHub account

## Quick start

These steps take about 5 minutes and work on macOS, Linux and Windows.

### 1. Clone and install

```bash
git clone <this-repo-url> git-help
cd git-help
npm install
```

### 2. Create a GitHub OAuth App

Each person running Git-Help creates their own OAuth App. This is free and takes a minute.

1. Go to **GitHub → Settings → Developer settings → OAuth Apps → New OAuth App**,
   or open <https://github.com/settings/applications/new> directly.
2. Fill in the form **exactly** like this:

   | Field | Value |
   |---|---|
   | Application name | `Git-Help (local)`, or any name you like |
   | Homepage URL | `http://localhost:5173` |
   | Authorization callback URL | `http://localhost:5173/auth/callback` |
   | Enable Device Flow | leave unchecked |

3. Click **Register application**.
4. Copy the **Client ID**.
5. Click **Generate a new client secret** and copy the secret. GitHub shows it only once.

### 3. Configure your `.env`

Copy the example file:

```bash
cp .env.example .env        # macOS / Linux
copy .env.example .env      # Windows
```

Open `.env` and fill in all three values:

```ini
GITHUB_CLIENT_ID=Iv1.xxxxxxxxxxxxxxxx      # from step 2
GITHUB_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxx  # from step 2
SESSION_SECRET=                            # see below
```

`SESSION_SECRET` is any long random string. It encrypts your login cookie. Generate one with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`.env` is listed in `.gitignore`. **Never commit it.**

### 4. Run

```bash
npm run dev
```

Open <http://localhost:5173> and click **Sign in with GitHub**.

### 5. Connect Slack (optional)

Git-Help reads Slack with a token from a small Slack app that you install into your own workspace. The app can only
read; it can't post, edit or delete anything.

1. Go to <https://api.slack.com/apps> → **Create New App** → **From a manifest**, and pick your workspace.
2. Replace the example manifest with this one:

   ```json
   {
       "display_information": {
           "name": "Git-Help",
           "description": "Read-only access so Git-Help can search channel history linked to GitHub repos."
       },
       "oauth_config": {
           "scopes": {
               "user": ["channels:read", "channels:history", "groups:read", "groups:history", "users:read"]
           }
       },
       "settings": {
           "org_deploy_enabled": false,
           "socket_mode_enabled": false,
           "is_hosted": false,
           "token_rotation_enabled": false
       }
   }
   ```

   The `groups:` scopes cover private channels you're in. Remove them if you only want public channels.
3. Click **Create**, then **Install to Workspace** → **Allow**. Some workspaces need an admin to approve this.
4. Open **OAuth & Permissions**, copy the **User OAuth Token** (`xoxp-…`) and add it to `.env`:

   ```ini
   SLACK_USER_TOKEN=xoxp-...
   ```

5. Restart `npm run dev`. On any repo, click **# link slack channel** and pick a channel. You can link channels
   you're a member of.

Linking copies the channel's last 90 days of messages and thread replies into `.data/git-help.db` on your machine.
Open the repo's **Slack** tab to read them, **sync now** to fetch new messages, or **full resync** to re-read
everything. Unlinking a channel deletes its local copy.

### 6. Set up the chat (optional)

The chat panel answers questions using retrieval-augmented generation (RAG): it searches the repo's issues, pull
requests, comments and README plus its linked Slack channels, then asks a language model to answer from what it
found and cite it.

**Local (default, nothing leaves your machine):** install [Ollama](https://ollama.com), then download a chat model and
an embedding model:

```bash
ollama pull gemma3:4b          # chat model (~3 GB). Larger ones like qwen3:8b give better answers if you have the RAM.
ollama pull nomic-embed-text   # embedding model, used for search
```

**Cloud:** open **Settings** in the app, pick **Anthropic** or an **OpenAI-compatible API** (OpenAI, Groq,
OpenRouter, LM Studio…), enter the API key and click **save & test connection**. Keys are stored encrypted in
`.data/` and can also come from `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENAI_BASE_URL` in `.env`. With a cloud
provider, your question and the matching Slack and GitHub text are sent to that provider.

**Context:** inside a repo, the chat searches only that repo and its linked channels. On the repository list it
searches everything indexed so far. A repo is indexed the first time you ask about it; linked channels are re-indexed
on every Slack sync, and the repo's **Slack** tab has a **rebuild index** button.

## Troubleshooting

| What you see | Fix |
|---|---|
| `Missing GITHUB_CLIENT_ID, ... in .env` when starting | You skipped step 3, or `.env` isn't in the project root. |
| GitHub says **"The redirect_uri is not associated with this application"** | The callback URL in your OAuth App must be exactly `http://localhost:5173/auth/callback`. |
| `Port 5173 is in use` | Something else is using the port. Stop it; the port can't change without also changing your OAuth App URLs. |
| `Sign-in failed: state_mismatch` | Start the sign-in again from <http://localhost:5173>. Don't reuse an old GitHub tab. |
| `Sign-in failed: bad_verification_code` | The login code expired. Sign in again. |
| `Sign-in failed: incorrect_client_credentials` | The client ID or secret in `.env` is wrong. Copy them again and restart `npm run dev`. |
| Slack: "isn't set up" or "token is invalid" | Check `SLACK_USER_TOKEN` in `.env` (it starts with `xoxp-`) and restart `npm run dev`. |
| Slack: a channel is missing from the picker | You can only link channels you're a member of. Join it in Slack first. |
| Slack: "missing a permission" | Compare your Slack app's **User Token Scopes** with the manifest above, then reinstall the app. |
| Chat: "Can't reach Ollama" | Start Ollama (`ollama serve`, or open the Ollama app), or fix the URL in **Settings**. |
| Chat: "model … not found" | Download it with `ollama pull <model>`, or pick an installed one in **Settings**. |
| Chat answers are vague or wrong | Small local models make mistakes. Check the cited sources, or try a larger model in **Settings**. |
| An organization's repositories are missing | The organization restricts third-party apps. Open <https://github.com/settings/applications>, select your app, and click **Grant** or **Request** next to the organization. |
| `API rate limit exceeded` | GitHub allows 5,000 requests per hour. Wait for the limit to reset. |

## Permissions and security

- **Scopes requested:** `repo` and `read:org`. GitHub has no read-only scope for private repositories, so `repo` is
  the minimum that lets you see them.
- **Read-only:** the local server forwards only `GET` requests, and only to the specific endpoints the UI uses (see
  `ALLOWED` in `server.js`). Nothing in Git-Help can change your repositories.
- **Token storage:** your GitHub token is kept in an encrypted, `HttpOnly` cookie. It never reaches the page's
  JavaScript, and nothing is stored on disk or sent anywhere except `api.github.com`.
- **Slack data stays local:** linked channels are copied into `.data/git-help.db` on your machine (gitignored) and
  are only sent to your own browser. The Slack token never leaves the server.
- **Revoke access** at any time from <https://github.com/settings/applications> (GitHub) and your Slack app's
  settings page (Slack).

## How it works

```
Browser (React)  ──/api/gh/*────▶  server.js  ──Bearer token──▶  api.github.com
                 ──/api/slack/*─▶  (inside the   ──user token──▶  slack.com/api
                 ◀──────────────   Vite server)  ──▶ .data/git-help.db (linked channels)
```

| File | What it does |
|---|---|
| `server.js` | OAuth login and logout, the encrypted session cookie, and the read-only GitHub proxy with its endpoint allowlist |
| `slack.js` | Slack API calls (with rate-limit retries) and channel sync |
| `rag.js` | Chat retrieval: chunking Slack and GitHub content, embeddings, hybrid keyword + vector search, cited answers |
| `llm.js` | Model providers (Ollama, Anthropic, OpenAI-compatible) and the settings behind the Settings page |
| `db.js`, `secrets.js` | The local SQLite database (`.data/git-help.db`), and the encryption used for cookies and API keys |
| `vite.config.js` | Runs `server.js` inside the Vite dev server, so there's one command and one port |
| `src/main.jsx` | The whole UI: routes, pages and the `useGitHub(path)` data hook |
| `src/style.css` | Styles, with light and dark themes |
| `*.test.js` | Allowlist and cookie encryption; Slack sync and the RAG pipeline against fake Slack, GitHub and Ollama APIs |
| `eval/rag-eval.js` | Answer key for the chat against the brewlog demo data, run through the real dev server and models |

## Contributing

Contributions are welcome.

1. Fork the repository and create a branch.
2. Make your change and run the tests:
   ```bash
   npm test
   ```
3. Open a pull request that describes what changed and why.

**Showing new GitHub data:** add the endpoint pattern to `ALLOWED` in `server.js`, add a matching case in
`server.test.js`, then fetch it in the UI with `useGitHub('repos/owner/repo/...')` or `<List path=... />`.

**Write actions** (commenting, merging and so on) are deliberately out of scope for now. Please open an issue to
discuss them before sending a pull request.

## License

[MIT](LICENSE)
