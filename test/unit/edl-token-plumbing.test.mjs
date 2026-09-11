/**
 * EDL token plumbing — every remote-file load must carry an auth token.
 *
 * Regression guard for a bug where the Scene Catalog branch called
 * `handleRemoteFileSelect({url, name, size, type})` with no `token:` while its
 * four siblings passed one. Downstream that makes `cleanToken` undefined, so
 * `fetchHeaders` is undefined and h5chunk sends no Authorization header. The
 * DAAC then 302s to EDL's OAuth endpoint, which 401s — and the failure reads as
 * "your Earthdata token is invalid" when in fact no token was ever sent.
 *
 * The observed symptom was a proxy log line reading `auth=none` on the data
 * request, followed by a 401 on the OAuth hop.
 *
 * This is a source-shape test rather than a behavioural one: the call sites live
 * inside a 9k-line component that cannot be imported headlessly, and the defect
 * is precisely a missing argument at a call site.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const mainSrc = readFileSync(join(rootDir, 'app', 'main.jsx'), 'utf8');

/** Extract each `handleRemoteFileSelect({ ... })` call's argument object. */
function remoteSelectCalls(src) {
  const calls = [];
  const needle = 'handleRemoteFileSelect({';
  let from = 0;
  for (;;) {
    const start = src.indexOf(needle, from);
    if (start === -1) break;
    // Walk braces from the opening `{` to find the matching close.
    let i = start + needle.length - 1;
    let depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    const body = src.slice(start, i + 1);
    calls.push({ line: src.slice(0, start).split('\n').length, body });
    from = i + 1;
  }
  return calls;
}

test('every handleRemoteFileSelect call passes a token', () => {
  const calls = remoteSelectCalls(mainSrc);
  assert.ok(calls.length >= 4,
    `expected to find the remote-select call sites, found ${calls.length}`);

  const missing = calls
    .filter(c => !/\btoken\s*:/.test(c.body))
    .map(c => `app/main.jsx:${c.line}`);

  assert.deepEqual(missing, [],
    `remote-file loads without a token: ${missing.join(', ')} — the DAAC ` +
    `request goes out unauthenticated and 401s on EDL's OAuth redirect`);
});

test('the token reaches fetchHeaders as a Bearer Authorization header', () => {
  // cleanToken -> fetchHeaders -> URLFile/h5chunk. If this wiring is renamed,
  // the call-site test above would still pass while auth silently stopped.
  assert.match(mainSrc, /const\s+cleanToken\s*=/,
    'cleanToken is the single place the token is normalised');
  assert.match(mainSrc, /'Authorization':\s*`Bearer \$\{cleanToken\}`/,
    'fetchHeaders must send Authorization: Bearer <token>');
  assert.match(mainSrc, /handleRemoteFileSelect\._fetchHeaders\s*=\s*fetchHeaders/,
    'fetchHeaders must be stashed for the subsequent data loads');
});

test('a missing token on an Earthdata host is reported as an error, not a warning', () => {
  // The whole point: distinguish "no token was sent" from "the token was
  // rejected". Without this the user sees a bare 401 and blames their token.
  assert.match(mainSrc, /earthdatacloud\)\\?\.nasa\\?\.gov/,
    'should detect Earthdata DAAC hosts specifically');
  assert.match(mainSrc, /addStatusLog\(\s*'error',\s*\n?\s*'No Earthdata token/,
    'a DAAC URL with no token must surface as an error naming the real cause');
});

test('EDL validation failure shows the reason inline, not only in a title tooltip', () => {
  // `title` is invisible to touch and keyboard users, and it hid the one detail
  // that made the failure actionable.
  const failureBlock = mainSrc.match(
    /edlValidation && !edlValidation\.ok && \([\s\S]{0,700}?\)\}/);
  assert.ok(failureBlock, 'could not locate the EDL validation failure branch');
  assert.doesNotMatch(failureBlock[0], /title=\{edlValidation\.error\}/,
    'the error must not be hidden in a title tooltip');
  assert.match(failureBlock[0], /edlValidation\.error/,
    'the error text must be rendered');
  assert.match(failureBlock[0], /role="alert"/,
    'the failure should be announced to assistive technology');
});
