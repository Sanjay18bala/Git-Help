// Chat and embedding providers (local Ollama, Anthropic, any OpenAI-compatible API) and their settings.
// Settings live in the database; API keys are encrypted with SESSION_SECRET and never sent to the browser.
import Anthropic from '@anthropic-ai/sdk';
import { db } from './db.js';
import { seal, unseal } from './secrets.js';

export class LlmError extends Error {}

export const CHAT_PROVIDERS = ['ollama', 'anthropic', 'openai'];
export const EMBED_PROVIDERS = ['ollama', 'openai'];
export const DEFAULT_MODELS = {
  chat: { ollama: 'gemma3:4b', anthropic: 'claude-opus-5-5', openai: '' },
  embed: { ollama: 'nomic-embed-text', openai: 'text-embedding-3-small' },
};
const NUM_CTX = 12288; // Ollama's default context window is small and it silently truncates; rag.js budgets prompts to fit
const ANSWER_EFFORT = 'medium';

// ---------- settings ----------

const stored = () => JSON.parse(db().prepare("SELECT value FROM settings WHERE key = 'llm'").get()?.value ?? '{}');
const openKey = (sealed) => (sealed && unseal(sealed)) || '';

// Effective settings, keys decrypted. Server-side only.
export function settings() {
  const s = stored();
  return {
    chat: { provider: 'ollama', model: DEFAULT_MODELS.chat.ollama, ...s.chat },
    embed: { provider: 'ollama', model: DEFAULT_MODELS.embed.ollama, ...s.embed },
    ollama: { url: s.ollama?.url || process.env.OLLAMA_URL || 'http://localhost:11434' },
    openai: {
      url: s.openai?.url || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      key: openKey(s.openai?.key) || process.env.OPENAI_API_KEY || '',
    },
    anthropic: { key: openKey(s.anthropic?.key) || process.env.ANTHROPIC_API_KEY || '' },
  };
}

const keyState = (sealed, env) => (openKey(sealed) ? 'saved' : process.env[env] ? 'env' : null);

// What the settings page sees: everything except key values.
export function publicSettings() {
  const s = stored();
  const e = settings();
  return {
    chat: e.chat,
    embed: e.embed,
    ollama: e.ollama,
    openai: { url: e.openai.url, key: keyState(s.openai?.key, 'OPENAI_API_KEY') },
    anthropic: { key: keyState(s.anthropic?.key, 'ANTHROPIC_API_KEY') },
    defaults: DEFAULT_MODELS,
  };
}

const bad = (msg) => { throw Object.assign(new LlmError(msg), { status: 400 }); };
const oneOf = (v, allowed, name) => (allowed.includes(v) ? v : bad(`Unknown ${name}: ${v}`));
const text = (v, name) => (typeof v === 'string' && v.trim() && v.length <= 300 ? v.trim() : bad(`${name} is required.`));
const httpUrl = (v, name) => {
  const u = text(v, name).replace(/\/+$/, '');
  return /^https?:\/\/\S+$/.test(u) ? u : bad(`${name} must start with http:// or https://`);
};
// A key in the patch: a string replaces it, "" or null removes it, leaving it out keeps the saved one.
const nextKey = (v, old) => (v === undefined ? old : v ? seal(text(v, 'API key')) : undefined);

export function saveSettings(patch = {}) {
  const s = stored();
  if (patch.chat) {
    s.chat = { provider: oneOf(patch.chat.provider, CHAT_PROVIDERS, 'chat provider'), model: text(patch.chat.model, 'Chat model') };
  }
  if (patch.embed) {
    s.embed = { provider: oneOf(patch.embed.provider, EMBED_PROVIDERS, 'embedding provider'), model: text(patch.embed.model, 'Embedding model') };
  }
  if (patch.ollama) s.ollama = { url: httpUrl(patch.ollama.url, 'Ollama URL') };
  if (patch.openai) {
    s.openai = { url: httpUrl(patch.openai.url, 'OpenAI-compatible base URL'), key: nextKey(patch.openai.key, s.openai?.key) };
  }
  if (patch.anthropic) s.anthropic = { key: nextKey(patch.anthropic.key, s.anthropic?.key) };
  db().prepare("INSERT INTO settings VALUES ('llm', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify(s));
  return publicSettings();
}

// ---------- HTTP helpers ----------

async function request(url, init, label, hint = '') {
  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new LlmError(`Can't reach ${label} at ${new URL(url).origin}.${label === 'Ollama' ? ' Is it running? Start it with `ollama serve`.' : ''}`);
  }
  if (res.ok) return res;
  const body = await res.text();
  let msg;
  try {
    const j = JSON.parse(body);
    msg = j.error?.message ?? j.error ?? j.message;
  } catch {
    msg = body.slice(0, 200);
  }
  throw new LlmError(`${label} error ${res.status}: ${msg}${res.status === 404 && hint ? `. ${hint}` : ''}`);
}

// Newline-delimited body (Ollama's NDJSON, or SSE "data:" lines).
async function* lines(res) {
  let buf = '';
  for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) yield line;
    }
  }
  if (buf.trim()) yield buf.trim();
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const pullHint = (model) => `Download it with: ollama pull ${model}`;

// ---------- providers ----------

const ollama = {
  async *chat({ model, system, messages, signal }, s) {
    const res = await request(`${s.ollama.url}/api/chat`, {
      method: 'POST',
      signal,
      headers: JSON_HEADERS,
      body: JSON.stringify({
        model,
        stream: true,
        messages: [{ role: 'system', content: system }, ...messages],
        options: { num_ctx: NUM_CTX, temperature: 0.2 },
      }),
    }, 'Ollama', pullHint(model));
    for await (const line of lines(res)) {
      const j = JSON.parse(line);
      if (j.error) throw new LlmError(`Ollama: ${j.error}`);
      if (j.message?.content) yield j.message.content;
    }
  },
  async embed(texts, model, s) {
    const res = await request(`${s.ollama.url}/api/embed`, {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ model, input: texts }),
    }, 'Ollama', pullHint(model));
    return (await res.json()).embeddings;
  },
  async models(s) {
    const res = await request(`${s.ollama.url}/api/tags`, {}, 'Ollama');
    return (await res.json()).models.map((m) => m.name.replace(/:latest$/, '')).sort();
  },
};

const openaiHeaders = (s) => ({ ...JSON_HEADERS, ...(s.openai.key && { Authorization: `Bearer ${s.openai.key}` }) });

// Any OpenAI-compatible API: OpenAI, Groq, OpenRouter, Together, LM Studio, vLLM, …
const openai = {
  async *chat({ model, system, messages, signal }, s) {
    const res = await request(`${s.openai.url}/chat/completions`, {
      method: 'POST',
      signal,
      headers: openaiHeaders(s),
      body: JSON.stringify({ model, stream: true, messages: [{ role: 'system', content: system }, ...messages] }),
    }, 'OpenAI-compatible API');
    for await (const line of lines(res)) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      const delta = JSON.parse(data).choices?.[0]?.delta?.content;
      if (delta) yield delta;
    }
  },
  async embed(texts, model, s) {
    const res = await request(`${s.openai.url}/embeddings`, {
      method: 'POST', headers: openaiHeaders(s), body: JSON.stringify({ model, input: texts }),
    }, 'OpenAI-compatible API');
    return (await res.json()).data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  },
  async models(s) {
    const res = await request(`${s.openai.url}/models`, { headers: openaiHeaders(s) }, 'OpenAI-compatible API');
    return (await res.json()).data.map((m) => m.id).sort();
  },
};

// Models that support effort and server-side refusal fallbacks ("default" mode).
const CURRENT_CLAUDE = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

function anthropicClient(s) {
  if (!s.anthropic.key) throw new LlmError('Add an Anthropic API key in Settings, or ANTHROPIC_API_KEY in .env.');
  return new Anthropic({ apiKey: s.anthropic.key });
}

function anthropicError(e) {
  if (e instanceof Anthropic.APIUserAbortError) return e;
  if (e instanceof Anthropic.AuthenticationError) return new LlmError('Anthropic rejected the API key. Check it in Settings.');
  if (e instanceof Anthropic.NotFoundError) return new LlmError("Anthropic doesn't recognise that model. Pick one from the list in Settings.");
  if (e instanceof Anthropic.RateLimitError) return new LlmError('Anthropic rate limit reached. Try again in a moment.');
  if (e instanceof Anthropic.APIConnectionError) return new LlmError("Can't reach the Anthropic API. Check your connection.");
  if (e instanceof Anthropic.APIError) return new LlmError(`Anthropic error ${e.status ?? ''}: ${e.message}`);
  return e;
}

const anthropic = {
  async *chat({ model, system, messages, signal }, s) {
    const client = anthropicClient(s);
    const current = CURRENT_CLAUDE.has(model);
    const params = {
      model,
      max_tokens: 16000,
      system,
      messages,
      // On current models: explicit effort, and fallbacks: "default" so a safety decline is retried server-side
      // on Anthropic's recommended fallback model instead of failing.
      ...(current && { output_config: { effort: ANSWER_EFFORT }, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }),
    };
    try {
      const stream = current ? client.beta.messages.stream(params, { signal }) : client.messages.stream(params, { signal });
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') yield event.delta.text;
      }
      const final = await stream.finalMessage();
      if (final.stop_reason === 'refusal') throw new LlmError('Claude declined to answer this request.');
    } catch (e) {
      throw anthropicError(e);
    }
  },
  async models(s) {
    try {
      const ids = [];
      for await (const m of anthropicClient(s).models.list()) ids.push(m.id);
      return ids;
    } catch (e) {
      throw anthropicError(e);
    }
  },
};

const PROVIDERS = { ollama, openai, anthropic };

// ---------- public API ----------

// Streams the answer text.
export function chat({ system, messages, signal }) {
  const s = settings();
  return PROVIDERS[s.chat.provider].chat({ model: s.chat.model, system, messages, signal }, s);
}

// nomic-embed-text was trained with task prefixes; retrieval is noticeably worse without them.
const withPrefix = (model, texts, kind) => (/nomic-embed/.test(model)
  ? texts.map((t) => `${kind === 'query' ? 'search_query' : 'search_document'}: ${t}`)
  : texts);

export async function embed(texts, kind) {
  const s = settings();
  const { provider, model } = s.embed;
  const vectors = await PROVIDERS[provider].embed(withPrefix(model, texts, kind), model, s);
  return vectors.map((v) => Float32Array.from(v));
}

// Stored next to each embedding: vectors from different models can't be compared.
export const embedModel = () => `${settings().embed.provider}:${settings().embed.model}`;

export const chatLabel = () => {
  const { provider, model } = settings().chat;
  return { provider, model, local: provider === 'ollama' };
};

export async function listModels(provider) {
  const p = PROVIDERS[oneOf(provider, CHAT_PROVIDERS, 'provider')];
  return p.models(settings());
}

// One real round trip each for chat and embeddings, so "test" proves the whole setup works.
export async function testSettings() {
  const result = {};
  try {
    let reply = '';
    for await (const t of chat({ system: 'You are a connection test.', messages: [{ role: 'user', content: 'Reply with the single word OK.' }] })) reply += t;
    result.chat = { ok: true, detail: `${chatLabel().model} replied: "${reply.trim().slice(0, 40)}"` };
  } catch (e) {
    result.chat = { ok: false, detail: e.message };
  }
  try {
    const [v] = await embed(['connection test'], 'query');
    result.embed = { ok: true, detail: `${settings().embed.model}: ${v.length}-dimensional vectors` };
  } catch (e) {
    result.embed = { ok: false, detail: e.message };
  }
  return result;
}
