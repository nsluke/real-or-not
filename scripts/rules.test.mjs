// Security-rules tests. Run with:  npm run test:rules
// (starts the Firestore emulator, so no Firebase project or network access is needed)

import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails, assertSucceeds }
  from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, deleteDoc, serverTimestamp } from 'firebase/firestore';

const env = await initializeTestEnvironment({
  projectId: 'real-or-not-rules-test',
  firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8'),
               host: '127.0.0.1', port: 8080 },
});

const ALICE = 'alice123';
const BOB = 'bob456';
const POST = 'abc123';

const asAlice = env.authenticatedContext(ALICE).firestore();
const asBob = env.authenticatedContext(BOB).firestore();
const anon = env.unauthenticatedContext().firestore();

const vote = (over = {}) => ({
  postId: POST, uid: ALICE, verdict: 'real', reason: null, at: serverTimestamp(), ...over,
});
const at = (db, id) => doc(db, 'votes', id);
const ok = `${POST}__${ALICE}`;

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}\n      ${err.message.split('\n')[0]}`); failed++; }
}

console.log('votes rules');
await check('a signed-in user can cast their own vote',
  () => assertSucceeds(setDoc(at(asAlice, ok), vote())));
await check('…and can change it later',
  () => assertSucceeds(setDoc(at(asAlice, ok), vote({ verdict: 'fake' }))));
await check('…including an unsure vote with a valid reason',
  () => assertSucceeds(setDoc(at(asAlice, ok), vote({ verdict: 'unsure', reason: 'blurry' }))));
await check('anyone can read votes (the tallies are public)',
  () => assertSucceeds(getDoc(at(anon, ok))));

await check('signed-out users cannot vote',
  () => assertFails(setDoc(at(anon, ok), vote())));
await check('a user cannot write a vote under someone else’s id',
  () => assertFails(setDoc(at(asBob, ok), vote({ uid: BOB }))));
await check('a user cannot claim another uid in the body',
  () => assertFails(setDoc(at(asAlice, ok), vote({ uid: BOB }))));
await check('a user cannot hold a second vote on the same post',
  () => assertFails(setDoc(at(asAlice, `${POST}__${ALICE}__2`), vote())));
await check('the doc id must match the postId in the body',
  () => assertFails(setDoc(at(asAlice, `other__${ALICE}`), vote())));

await check('an unknown verdict is rejected',
  () => assertFails(setDoc(at(asAlice, ok), vote({ verdict: 'maybe' }))));
await check('an unknown reason is rejected',
  () => assertFails(setDoc(at(asAlice, ok), vote({ verdict: 'unsure', reason: 'vibes' }))));
await check('a reason on a real/fake vote is rejected',
  () => assertFails(setDoc(at(asAlice, ok), vote({ verdict: 'real', reason: 'blurry' }))));
await check('extra fields are rejected',
  () => assertFails(setDoc(at(asAlice, ok), vote({ score: 9999 }))));
await check('a client-chosen timestamp is rejected',
  () => assertFails(setDoc(at(asAlice, ok), vote({ at: new Date('2000-01-01') }))));
await check('a postId outside reddit\u2019s id alphabet is rejected',
  () => assertFails(setDoc(at(asAlice, `Ev!l-Post__${ALICE}`), vote({ postId: 'Ev!l-Post' }))));
await check('an over-long postId is rejected',
  () => assertFails(setDoc(at(asAlice, `${'a'.repeat(40)}__${ALICE}`), vote({ postId: 'a'.repeat(40) }))));
await check('votes cannot be deleted',
  () => assertFails(deleteDoc(at(asAlice, ok))));

await env.cleanup();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
