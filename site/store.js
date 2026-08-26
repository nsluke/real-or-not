// Where votes live. Two backends with the same shape:
//   • firestore — production, one vote doc per (post, anonymous user)
//   • local     — the dev server, so the UI can be exercised without Firebase
//
// Tallies are counted server-side with aggregation queries rather than kept in a
// denormalized counter, so a client can never write a number nobody voted for.

export const VERDICTS = ['real', 'fake', 'unsure'];
export const REASONS = ['blurry', 'more', 'closer'];

const SDK = 'https://www.gstatic.com/firebasejs/12.18.0';
const configured = (c) => Boolean(c?.projectId) && !c.projectId.startsWith('YOUR_');

async function firestoreStore(config) {
  const [{ initializeApp }, { getAuth, signInAnonymously, connectAuthEmulator }, fs] =
    await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-auth.js`),
    import(`${SDK}/firebase-firestore.js`),
  ]);

  const app = initializeApp(config);
  const db = fs.getFirestore(app);
  const auth = getAuth(app);

  // Local rules/queries testing: `npm run emulators`, then open /?emulator
  if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)
      && new URLSearchParams(location.search).has('emulator')) {
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    fs.connectFirestoreEmulator(db, '127.0.0.1', 8080);
  }

  const { user } = await signInAnonymously(auth);
  const votes = fs.collection(db, 'votes');
  const countOf = async (...clauses) =>
    (await fs.getCountFromServer(fs.query(votes, ...clauses))).data().count;

  return {
    kind: 'firestore',
    uid: user.uid,

    async myVotes() {
      const snap = await fs.getDocs(
        fs.query(votes, fs.where('uid', '==', user.uid), fs.limit(1000)));
      const mine = {};
      snap.forEach((d) => {
        const { postId, verdict, reason } = d.data();
        mine[postId] = { verdict, reason: reason || null };
      });
      return mine;
    },

    async castVote(postId, verdict, reason) {
      await fs.setDoc(fs.doc(db, 'votes', `${postId}__${user.uid}`), {
        postId,
        uid: user.uid,
        verdict,
        reason: reason || null,
        at: fs.serverTimestamp(),
      });
    },

    async tally(postId) {
      const post = fs.where('postId', '==', postId);
      const [real, fake, unsure, blurry, more, closer] = await Promise.all([
        countOf(post, fs.where('verdict', '==', 'real')),
        countOf(post, fs.where('verdict', '==', 'fake')),
        countOf(post, fs.where('verdict', '==', 'unsure')),
        countOf(post, fs.where('reason', '==', 'blurry')),
        countOf(post, fs.where('reason', '==', 'more')),
        countOf(post, fs.where('reason', '==', 'closer')),
      ]);
      return { real, fake, unsure, reasons: { blurry, more, closer } };
    },
  };
}

async function localStore() {
  const res = await fetch('/api/health');
  if (!res.ok) throw new Error('no dev server');
  const post = (path, body) => fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());

  return {
    kind: 'local',
    async myVotes() { return (await fetch('/api/mine').then((r) => r.json())).votes; },
    async castVote(postId, verdict, reason) { await post('/api/vote', { postId, verdict, reason }); },
    async tally(postId) { return fetch(`/api/tally?id=${postId}`).then((r) => r.json()); },
  };
}

const readOnly = {
  kind: 'readonly',
  async myVotes() { return {}; },
  async castVote() { throw new Error('voting is not configured'); },
  async tally() { return { real: 0, fake: 0, unsure: 0, reasons: { blurry: 0, more: 0, closer: 0 } }; },
};

export async function openStore(config) {
  if (configured(config)) {
    try {
      return await firestoreStore(config);
    } catch (err) {
      console.error('Firestore unavailable:', err);
      return { ...readOnly, error: `Voting is offline: ${err.message}` };
    }
  }
  try {
    return await localStore();
  } catch {
    return { ...readOnly, error: 'Voting is disabled — Firebase is not configured yet.' };
  }
}
