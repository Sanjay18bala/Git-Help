import assert from 'node:assert/strict';

process.env.GIT_HELP_DB = ':memory:';
const { matchPerson, setPerson, slackUserFor, listPeople } = await import('./bot.js');
const { db } = await import('./db.js');

const slack = [
  { id: 'U1', handle: 'maya', real: 'Maya Chen', display: 'maya', email: 'maya@acme.dev' },
  { id: 'U2', handle: 'alex.k', real: 'Alex Kim', display: '', email: 'alex@acme.dev' },
  { id: 'U3', handle: 'alexr', real: 'Alex Rivera', display: 'Alex R', email: '' },
  { id: 'U4', handle: 'sam', real: 'Sam Lee', display: '', email: '' },
];
const person = (login, names = [], emails = []) => ({ login, names: new Set(names), emails: new Set(emails) });
const m = (p) => { const r = matchPerson(p, slack); return r && [r.user.id, r.method, r.confidence]; };

assert.deepEqual(m(person('mchen', ['Maya'], ['maya@acme.dev'])), ['U1', 'email', 'high'], 'email beats everything');
assert.deepEqual(m(person('akim', ['Alex Kim'])), ['U2', 'name', 'high'], 'unique full name');
assert.deepEqual(m(person('sam', [])), ['U4', 'handle', 'medium'], 'login equals Slack handle');
assert.deepEqual(m(person('xyz', ['Maya'])), ['U1', 'first-name', 'low'], 'first name only is a weak guess');
assert.equal(m(person('ar', ['Alex'])), null, 'ambiguous first name (two Alexes): no guess');
assert.equal(m(person('nobody', ['Zed Zed'], ['zed@x.dev'])), null);

// Only confirmed links let the bot message someone; a manual choice is kept as manual.
db().prepare("INSERT INTO people VALUES ('akim', 'U2', 'Alex Kim', 'first-name', 'low', 0, 'x')").run();
assert.equal(slackUserFor('akim'), null, 'unconfirmed suggestion: no DMs');
setPerson('akim', 'U2', 'Alex Kim');
assert.equal(slackUserFor('akim'), 'U2');
assert.equal(listPeople()[0].method, 'manual');
setPerson('akim', null);
assert.equal(slackUserFor('akim'), null, 'set to nobody');

console.log('ok');
