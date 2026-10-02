// Retrieval + answer check for the RAG chat, against the brewlog demo data
// (Sanjay18bala/brewlog linked to the seeded #brew-log channel). Runs through the real dev server.
//
//   npm run dev            # in another terminal
//   node eval/rag-eval.js  # uses GITHUB_TOKEN, or the `gh` CLI's token
//
// Each case can check: `expect` (a source title regex that must come back), `answer` (a regex the answer must
// match), and `cite` (whether the answer should contain [n] citations: false for small talk).
import { execFileSync } from 'node:child_process';

process.loadEnvFile();
const { seal } = await import('../secrets.js');
const BASE = process.env.APP_URL ?? 'http://localhost:5173';
const REPO = process.env.EVAL_REPO ?? 'Sanjay18bala/brewlog';
const token = process.env.GITHUB_TOKEN ?? execFileSync('gh', ['auth', 'token']).toString().trim();
const cookie = `session=${seal({ token })}`;

const CASES = [
  { q: 'Why did we decide to keep JSON instead of moving to SQLite?', expect: /#9\b|#16\b|brew-log thread/ },
  { q: "What's blocking the CSV export from being merged?", expect: /#14\b|#13\b|brew-log thread/ },
  { q: 'How was the 1:Infinity ratio bug fixed?', expect: /#1\b|#10\b|brew-log thread/ },
  { q: 'Why did evening brews show up under the next day?', expect: /#4\b|#11\b|brew-log thread/ },
  { q: 'Who is working on the grind size feature?', expect: /#6\b|brew-log/ },
  { q: 'Why was the espresso shot timing request declined?', expect: /#7\b|brew-log/ },
  { q: 'What still needs to happen before the colorize PR is ready?', expect: /#15\b|brew-log thread/ },
  { q: "Why aren't our tests running in CI yet?", expect: /#8\b|brew-log thread/ },
  // Counting needs the overview source; brewlog has issues #2 #3 #6 #8 #14 and PRs #13 #15 open.
  { q: 'How many open issues are there?', expect: /overview/, answer: /\b5\b|\bfive\b/i },
  { q: 'How many open pull requests are there?', expect: /overview/, answer: /\b2\b|\btwo\b/i },
  // Deadlines come from milestone due dates (demo: v0.3.0 was due Sep 29 with #14, #8, #6; v0.4.0 due Oct 15).
  { q: 'Which issues are overdue?', expect: /overview/, answer: /(?=[\s\S]*#14)(?=[\s\S]*#8)(?=[\s\S]*#6)/ },
  { q: "What's due in the next couple of weeks?", expect: /overview/, answer: /#3|#2|v0\.4\.0|Oct(ober)? 15|10-15/i },
  // Reasons people gave the Git-Help bot (demo: Sanjay18bala replied "I was sick" about #6).
  { q: "Why isn't #6 done yet?", answer: /sick/i },
  // #8 has no reason yet: it must not borrow #6's "I was sick" (the model once did).
  { q: "Why isn't #8 done yet?", answer: /^(?![\s\S]*\bsick\b)[\s\S]*(no reason|not (been )?given|no reply|workflow|scope)/i },
  { q: 'Which overdue issues still have no reason from the assignee?', expect: /overview/, answer: /^(?=[\s\S]*#14)(?=[\s\S]*#8)(?![\s\S]*#6\b[^\n]*(no reason|not given))/ },
  // Small talk and general questions: answered naturally, no citations, no "sources" talk.
  { q: 'hello, how are you?', cite: false, answer: /^(?![\s\S]*(provided sources|pull request))/i },
  { q: 'What is the difference between git merge and git rebase?', cite: false, answer: /rebase/i },
  { q: 'thanks, that helps!', cite: false },
  // Casual wording, but about the project: must still be looked up.
  { q: 'hey, any idea why some brews end up on the wrong day?', expect: /#4\b|#11\b|brew-log thread/ },
];

async function ask(question, repo) {
  const started = Date.now();
  const r = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ repo, messages: [{ role: 'user', content: question }] }),
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  let sources = [];
  let text = '';
  let firstToken = null;
  let error = null;
  let buf = '';
  for await (const chunk of r.body.pipeThrough(new TextDecoderStream())) { // read as it streams, for real timings
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines.filter(Boolean)) {
      const ev = JSON.parse(line);
      if (ev.type === 'sources') sources = ev.sources;
      if (ev.type === 'token') { firstToken ??= Date.now() - started; text += ev.text; }
      if (ev.type === 'error') error = ev.message;
    }
  }
  return { sources, text, firstToken, error, total: Date.now() - started };
}

let failed = 0;
for (const c of CASES) {
  const res = await ask(c.q, REPO);
  const cites = /\[\d/.test(res.text);
  const problems = [
    res.error && `error: ${res.error}`,
    c.expect && !res.sources.some((s) => c.expect.test(s.title)) && 'expected source not retrieved',
    c.answer && !c.answer.test(res.text) && 'answer did not match',
    (c.cite ?? true) !== cites && (cites ? 'cited sources in small talk' : 'no citations'),
  ].filter(Boolean);
  failed += problems.length ? 1 : 0;
  console.log(`\n${problems.length ? `FAIL (${problems.join('; ')})` : 'PASS'}  ${c.q}`);
  console.log(`  top sources: ${res.sources.slice(0, 3).map((s) => `[${s.n}] ${s.title}`).join(' | ')}`);
  console.log(`  answer (${res.firstToken ?? '-'} ms to first token, ${res.total} ms total): ${res.text.replace(/\s+/g, ' ').slice(0, 240)}`);
}
console.log(`\n${CASES.length - failed}/${CASES.length} passed`);
process.exitCode = failed ? 1 : 0;
