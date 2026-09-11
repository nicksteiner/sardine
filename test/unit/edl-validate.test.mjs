/**
 * validateEDLToken — local JWT inspection, no network.
 *
 * Regression guard for a misdiagnosis: the validator used to POST the user's
 * token to `urs.earthdata.nasa.gov/api/users/user`, which is an endpoint for
 * registered EDL *applications*. A perfectly good user token comes back 401
 * there with:
 *
 *   {"error":"invalid_token",
 *    "error_description":"The required client id is missing from the request"}
 *
 * The same token streams DAAC data fine (verified: HTTP 206 with HDF5 magic
 * bytes on a NISAR GCOV granule). So "Test token" reported failure for a token
 * that worked, and the UI compounded it by calling the 401 "expired or
 * incomplete". Validation is now local and structural.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEDLToken } from '../../src/utils/proxy.js';

/** Build an unsigned JWT with the given payload — signature is never checked. */
function jwt(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ typ: 'JWT', alg: 'RS256' })}.${b64(payload)}.c2ln`;
}

const DAY = 86400;
const now = () => Math.floor(Date.now() / 1000);

test('a live token is accepted, with uid and days remaining', () => {
  // Shaped exactly like a real EDL user token.
  const r = validateEDLToken(jwt({
    type: 'User', uid: 'nsteiner',
    iat: now() - DAY, exp: now() + 59 * DAY,
    iss: 'https://urs.earthdata.nasa.gov',
  }));
  assert.equal(r.ok, true);
  assert.equal(r.username, 'nsteiner');
  assert.equal(r.daysLeft, 58);          // 59 days minus the elapsed partial day
  assert.ok(r.expiresAt instanceof Date);
});

test('a "Bearer " prefix is tolerated', () => {
  const t = jwt({ uid: 'nsteiner', exp: now() + DAY });
  assert.equal(validateEDLToken(`Bearer ${t}`).ok, true);
  assert.equal(validateEDLToken(`  ${t}  `).ok, true);
});

test('an expired token is rejected, and says when it expired', () => {
  const r = validateEDLToken(jwt({ uid: 'nsteiner', exp: now() - DAY }));
  assert.equal(r.ok, false);
  assert.match(r.error, /expired/i);
  assert.match(r.error, /\d{4}-\d{2}-\d{2}/, 'names the expiry date');
});

test('the token NAME (not the token) is rejected with a useful message', () => {
  // The EDL profile page shows a short token label beside the token itself;
  // pasting the label is the most common mistake.
  const r = validateEDLToken('my-sardine-token');
  assert.equal(r.ok, false);
  assert.match(r.error, /3 dot-separated parts/);
});

test('a truncated token is rejected as unreadable, not as expired', () => {
  const r = validateEDLToken('eyJ0eXAiOiJKV1QifQ.not-valid-base64!!.sig');
  assert.equal(r.ok, false);
  assert.match(r.error, /not readable|truncated/i);
});

test('empty input is rejected', () => {
  assert.equal(validateEDLToken('').ok, false);
  assert.equal(validateEDLToken(null).ok, false);
  assert.equal(validateEDLToken(undefined).ok, false);
});

test('a JWT with no expiry claim is not treated as an EDL token', () => {
  const r = validateEDLToken(jwt({ uid: 'nsteiner' }));
  assert.equal(r.ok, false);
  assert.match(r.error, /expiry/i);
});

test('validation makes no network call', () => {
  // The whole point of the fix: a wrong endpoint must not be able to fail a
  // good token again.
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('validateEDLToken must not fetch'); };
  try {
    assert.equal(validateEDLToken(jwt({ uid: 'nsteiner', exp: now() + DAY })).ok, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});
