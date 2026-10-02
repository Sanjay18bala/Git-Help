import assert from 'node:assert/strict';
import { isAllowed, seal, unseal } from './server.js';

assert(isAllowed('user'));
assert(isAllowed('user/repos'));
assert(isAllowed('repos/octo/hello.js'));
assert(isAllowed('repos/octo/hello.js/pulls/12/files'));
assert(isAllowed('repos/octo/repo/actions/runs'));
assert(isAllowed('repos/octo/repo/issues/14/timeline'));
assert(!isAllowed('repos/octo/repo/issues/14/lock'));
assert(!isAllowed('repos/octo/repo/../../user/emails'));
assert(!isAllowed('repos/./repo'));
assert(!isAllowed('user/emails'));
assert(!isAllowed('repos/octo/repo/hooks'));
assert(!isAllowed('orgs/x/members'));

const s = seal({ token: 'abc' });
assert.deepEqual(unseal(s), { token: 'abc' });
assert.equal(unseal(s.slice(0, 20) + (s[20] === 'A' ? 'B' : 'A') + s.slice(21)), null);
assert.equal(unseal('garbage'), null);
assert.equal(unseal(''), null);

console.log('ok');
