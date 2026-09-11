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

test('there is exactly one EDL token store — panels must not keep their own', () => {
  // NISARSearch used to hold `useState('')` for its own token, "stored in
  // memory only". A token pasted into the Earthdata Login panel was therefore
  // invisible to it, and every search-initiated load went out unauthenticated —
  // producing a 401 whose message told the user to set the token they had set.
  const search = readFileSync(
    join(rootDir, 'src', 'components', 'NISARSearch.jsx'), 'utf8');

  assert.match(search, /import\s*\{[^}]*getEDLToken[^}]*\}\s*from\s*'\.\.\/utils\/proxy\.js'/,
    'NISARSearch must import the shared token store');
  assert.match(search, /useState\(\(\)\s*=>\s*getEDLToken\(\)\)/,
    'the token state must be SEEDED from the shared store, not from an empty string');
  assert.match(search, /setEDLToken\(/,
    'NISARSearch must write back to the shared store');
  assert.doesNotMatch(search, /const \[token, setToken\] = useState\(\s*''\s*\)/,
    'the token must not be panel-local state');
  assert.doesNotMatch(search, /Stored in memory only/,
    'stale help text: the token is shared and persisted');
});

test('setEDLToken notifies same-tab listeners', () => {
  // `storage` fires only in OTHER tabs, so without an explicit event a second
  // panel in this tab never sees a token pasted in the first.
  const proxy = readFileSync(join(rootDir, 'src', 'utils', 'proxy.js'), 'utf8');
  const fn = proxy.match(/export function setEDLToken[\s\S]{0,400}?\n}/);
  assert.ok(fn, 'setEDLToken not found');
  assert.match(fn[0], /dispatchEvent/,
    'setEDLToken must broadcast so other panels resync');
});

test('a 401 with a valid token is not blamed on the token', () => {
  // The old hint told the user to regenerate a token that was fine, and pointed
  // at a curl command against an endpoint that rejects user tokens.
  assert.doesNotMatch(mainSrc, /Token may be expired\. Run: curl/,
    'stale advice: that endpoint needs Basic auth, not the user token');
  assert.match(mainSrc, /const tokenState = validateEDLToken\(/,
    'the auth-error hint must identify which token was actually sent');
  // An earlier version asserted the 401 meant an unaccepted product EULA. That
  // was never observed — the same granule returns 206 for a current token — so
  // the hint must report what was sent and name the plausible causes (stale
  // page, revoked or superseded token) without asserting one.
  assert.doesNotMatch(mainSrc, /likely a permissions issue/,
    'do not assert a cause that was never reproduced');
  assert.match(mainSrc, /rejected the token sent/,
    'the hint must say which token the server rejected');
  assert.match(mainSrc, /reload the page/,
    'a token mismatch after pasting is usually a stale bundle — say so');
});

test('every remote fetch uses the CURRENT token, not the one captured at select', () => {
  // Regression: `currentFetchHeaders` was introduced so a token pasted between
  // selecting a scene and loading it would take effect. Three data-load call
  // sites used it; the NISAR *metadata* read still used the `fetchHeaders`
  // const built from `fileInfo.token` at select time. When a scene was selected
  // without a token — every CMR-search result, whose token comes from the
  // shared store rather than the granule — that const was `undefined`, so the
  // metadata request went out unauthenticated and 401'd while the later data
  // load would have succeeded. The helper existed but was never called.
  const helper = /const currentFetchHeaders = useCallback\(/;
  assert.match(mainSrc, helper, 'currentFetchHeaders helper must exist');

  // It must actually be used — a defined-but-uncalled helper is the bug.
  const uses = mainSrc.match(/currentFetchHeaders\(\)/g) || [];
  assert.ok(uses.length >= 4,
    `expected every remote load to call currentFetchHeaders(), found ${uses.length}`);

  // No remote loader may be handed the select-time const instead.
  assert.doesNotMatch(mainSrc, /listNISARDatasetsFromUrl\([^)]*\{\s*fetchHeaders\s*,/,
    'metadata read must use currentFetchHeaders(), not the select-time const');
});

test('the remote-failure message does not stutter its prefix', () => {
  // nisar-loader already throws "Failed to read remote NISAR file: ...", so
  // re-prefixing in the UI produced that phrase twice in one sentence.
  assert.doesNotMatch(mainSrc, /setError\(`Failed to read remote NISAR file: \$\{e\.message\}/,
    'loader already names this failure — do not prefix it again');
});
