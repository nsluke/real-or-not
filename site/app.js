import config from './firebase-config.js';
import { openStore } from './store.js';

const $ = (id) => document.getElementById(id);
const el = {
  status: $('status'), notice: $('notice'), card: $('card'),
  frame: $('frame'), photo: $('photo'), prevImg: $('prevImg'), nextImg: $('nextImg'), dots: $('dots'),
  title: $('title'), author: $('author'), when: $('when'), comments: $('comments'), body: $('body'),
  voteReal: $('voteReal'), voteFake: $('voteFake'), voteUnsure: $('voteUnsure'),
  reasons: $('reasons'), results: $('results'), yours: $('yours'), bar: $('bar'),
  segReal: $('segReal'), segFake: $('segFake'), segUnsure: $('segUnsure'),
  labelReal: $('labelReal'), labelFake: $('labelFake'), labelUnsure: $('labelUnsure'),
  tallyText: $('tallyText'), breakdown: $('breakdown'), flair: $('flair'),
  thread: $('thread'), next: $('next'), counter: $('counter'),
  skip: $('skip'), reshuffle: $('reshuffle'),
};

const REASON_LABEL = { blurry: 'too blurry', more: 'needs more photos', closer: 'needs closer photos' };
const VERDICT_LABEL = { real: 'REAL', fake: 'NOT REAL', unsure: "CAN'T TELL" };
const shuffle = (a) => a.map((v) => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map((p) => p[1]);

let store;
let deck = [];
let index = 0;
let shot = 0;          // which photo of the current post is showing

const current = () => deck[index];

function ago(iso) {
  const steps = [[60, 's'], [60, 'm'], [24, 'h'], [7, 'd'], [4.4, 'w'], [12, 'mo']];
  let n = (Date.now() - new Date(iso)) / 1000, unit = 's';
  for (const [size, next] of steps) {
    if (n < size) break;
    n /= size;
    unit = next;
  }
  return `${Math.max(1, Math.round(n))}${unit} ago`;
}

function updateCounter() {
  const judged = deck.filter((p) => p.myVote).length;
  el.counter.innerHTML = `<b>${judged}</b> judged · <b>${deck.length}</b> in deck`;
}

function showNotice(text) {
  el.notice.textContent = text;
  el.notice.hidden = !text;
}

// ------------------------------------------------------------------ photos ---

function showPhoto(post, i) {
  shot = (i + post.images.length) % post.images.length;
  const url = post.images[shot];
  el.photo.className = 'loading';
  el.photo.src = url;
  el.photo.alt = post.images.length > 1
    ? `${post.title} — photo ${shot + 1} of ${post.images.length}`
    : post.title;
  el.frame.href = url;

  const many = post.images.length > 1;
  el.prevImg.hidden = el.nextImg.hidden = el.dots.hidden = !many;
  if (many) {
    el.dots.innerHTML = post.images
      .map((_, n) => `<span class="dot${n === shot ? ' on' : ''}"></span>`).join('') +
      `<span>${shot + 1}/${post.images.length}</span>`;
    const ahead = post.images[(shot + 1) % post.images.length];
    if (ahead) new Image().src = ahead;
  }
}

el.photo.addEventListener('load', () => el.photo.classList.remove('loading'));
el.photo.addEventListener('error', () => {
  el.photo.classList.remove('loading');
  el.photo.alt = 'This photo could not be loaded from Reddit.';
});
el.prevImg.addEventListener('click', () => showPhoto(current(), shot - 1));
el.nextImg.addEventListener('click', () => showPhoto(current(), shot + 1));

let touchX = null;
el.frame.addEventListener('touchstart', (e) => { touchX = e.changedTouches[0].clientX; }, { passive: true });
el.frame.addEventListener('touchend', (e) => {
  if (touchX === null) return;
  const dx = e.changedTouches[0].clientX - touchX;
  touchX = null;
  if (Math.abs(dx) < 45 || current().images.length < 2) return;
  e.preventDefault();                       // a swipe shouldn't also open the photo
  showPhoto(current(), shot + (dx < 0 ? 1 : -1));
});

// ----------------------------------------------------------------- results ---

function paintVerdictButtons(post) {
  const picked = post.myVote?.verdict;
  const asking = el.reasons.dataset.open === post.id;
  el.voteReal.classList.toggle('picked', picked === 'real');
  el.voteFake.classList.toggle('picked', picked === 'fake');
  el.voteUnsure.classList.toggle('picked', picked === 'unsure' || asking);

  const showReasons = picked === 'unsure' || asking;
  el.reasons.hidden = !showReasons;
  for (const chip of el.reasons.querySelectorAll('.chip')) {
    chip.classList.toggle('picked', showReasons && chip.dataset.reason === post.myVote?.reason);
  }
}

function showResults(post, { pending = false } = {}) {
  const reveal = el.results.hidden;
  el.results.hidden = false;

  const v = post.myVote;
  el.yours.innerHTML = v
    ? `You called it <b class="${v.verdict}">${VERDICT_LABEL[v.verdict]}</b>` +
      (v.reason ? ` — ${REASON_LABEL[v.reason]}.` : '.')
    : '';

  const t = post.tally || { real: 0, fake: 0, unsure: 0, reasons: {} };
  const total = t.real + t.fake + t.unsure;
  const pct = (n) => (total ? Math.round((n / total) * 100) : 0);
  const [pr, pu] = [pct(t.real), pct(t.unsure)];
  const pf = total ? 100 - pr - pu : 0;

  if (reveal) {
    // Grow out of nothing on first reveal. The reflow pins the starting value without
    // waiting on a frame callback, which never fires in a background tab.
    el.segReal.style.flexBasis = el.segFake.style.flexBasis = el.segUnsure.style.flexBasis = '0%';
    void el.bar.offsetWidth;
  }
  el.segReal.style.flexBasis = `${pr}%`;
  el.segUnsure.style.flexBasis = `${pu}%`;
  el.segFake.style.flexBasis = `${pf}%`;
  el.labelReal.textContent = pr >= 14 ? `${pr}% real` : '';
  el.labelUnsure.textContent = pu >= 18 ? `${pu}% unsure` : '';
  el.labelFake.textContent = pf >= 14 ? `${pf}% fake` : '';

  if (pending) el.tallyText.textContent = 'Counting votes…';
  else if (total === 1) el.tallyText.textContent = "You're the first vote on this one.";
  else el.tallyText.textContent =
    `${total} votes · ${t.real} real · ${t.fake} not real · ${t.unsure} can't tell`;

  const reasons = Object.entries(t.reasons || {}).filter(([, n]) => n > 0);
  el.breakdown.hidden = !reasons.length;
  el.breakdown.textContent = reasons.length
    ? `Of the “can't tell” votes: ${reasons.map(([k, n]) => `${n} ${REASON_LABEL[k]}`).join(' · ')}`
    : '';

  el.flair.hidden = !post.flair;
  el.flair.innerHTML = post.flair ? `Thread flair: <b>${post.flair}</b>` : '';
  el.thread.href = post.permalink;
}

// -------------------------------------------------------------------- deck ---

function render() {
  const post = current();
  if (!post) {
    el.card.hidden = true;
    el.status.hidden = false;
    el.status.className = 'status';
    el.status.textContent = 'That’s the whole deck. Shuffle to go again, or come back later — new posts land every few minutes.';
    updateCounter();
    return;
  }

  el.status.hidden = true;
  el.card.hidden = false;
  el.reasons.dataset.open = '';

  showPhoto(post, 0);
  el.title.textContent = post.title;
  el.author.textContent = 'u/' + post.author;
  el.when.textContent = ago(post.created);
  el.comments.textContent = `${post.comments} comment${post.comments === 1 ? '' : 's'}`;
  el.body.textContent = post.body || '';
  el.body.hidden = !post.body;
  el.thread.href = post.permalink;

  paintVerdictButtons(post);
  el.results.hidden = true;                       // hide first so the bar re-animates
  if (post.myVote) {
    showResults(post, { pending: !post.tally });
    refreshTally(post);                           // numbers may have moved since last seen
  } else {
    // Don't leave the previous card's numbers sitting in the hidden panel.
    el.yours.textContent = el.tallyText.textContent = '';
    el.breakdown.hidden = el.flair.hidden = true;
  }

  updateCounter();
  const upcoming = deck[index + 1];
  if (upcoming) new Image().src = upcoming.images[0];
}

async function refreshTally(post) {
  try {
    post.tally = await store.tally(post.id);
    if (current() === post && !el.results.hidden) showResults(post);
  } catch (err) {
    if (current() === post) el.tallyText.textContent = `Couldn’t load the tally: ${err.message}`;
  }
}

async function vote(verdict, reason = null) {
  const post = current();
  if (!post) return;

  if (verdict === 'unsure' && !reason) {         // ask why before recording anything
    el.reasons.dataset.open = post.id;
    paintVerdictButtons(post);
    el.reasons.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return;
  }

  const previous = post.myVote;
  if (previous?.verdict === verdict && previous?.reason === reason) return;

  post.myVote = { verdict, reason };
  paintVerdictButtons(post);
  showResults(post, { pending: true });
  el.results.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  updateCounter();

  try {
    await store.castVote(post.id, verdict, reason);
    await refreshTally(post);
  } catch (err) {
    post.myVote = previous;
    paintVerdictButtons(post);
    el.tallyText.textContent = `Vote didn’t save: ${err.message}`;
    updateCounter();
  }
}

function advance(step = 1) {
  index = Math.min(index + step, deck.length);
  render();
}

el.voteReal.addEventListener('click', () => vote('real'));
el.voteFake.addEventListener('click', () => vote('fake'));
el.voteUnsure.addEventListener('click', () => vote('unsure'));
for (const chip of el.reasons.querySelectorAll('.chip')) {
  chip.addEventListener('click', () => vote('unsure', chip.dataset.reason));
}
el.next.addEventListener('click', () => advance());
el.skip.addEventListener('click', () => advance());
el.reshuffle.addEventListener('click', () => { deck = shuffle(deck); index = 0; render(); });

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target instanceof Element && e.target.closest('input, textarea, [contenteditable]')) return;
  const keys = {
    arrowleft: () => vote('fake'),
    f: () => vote('fake'),
    arrowright: () => vote('real'),
    r: () => vote('real'),
    arrowdown: () => vote('unsure'),
    c: () => vote('unsure'),
    1: () => vote('unsure', 'blurry'),
    2: () => vote('unsure', 'more'),
    3: () => vote('unsure', 'closer'),
    ' ': () => advance(),
    enter: () => advance(),
    '[': () => current() && showPhoto(current(), shot - 1),
    ']': () => current() && showPhoto(current(), shot + 1),
  };
  const run = keys[e.key.toLowerCase()];
  if (!run || el.card.hidden) return;
  e.preventDefault();
  run();
});

// -------------------------------------------------------------------- boot ---

async function load() {
  try {
    const [deckRes, opened] = await Promise.all([
      fetch('./posts.json', { cache: 'no-cache' }),
      openStore(config),
    ]);
    store = opened;
    if (store.error) showNotice(store.error);
    else if (store.kind === 'local') showNotice('Dev mode — votes are saved to this machine, not Firestore.');

    if (!deckRes.ok) throw new Error(`the deck failed to load (${deckRes.status})`);
    const data = await deckRes.json();
    if (!data.posts?.length) throw new Error('the deck came back empty');

    let mine = {};
    try {
      mine = await store.myVotes();
    } catch (err) {
      showNotice(`Couldn’t load your past votes: ${err.message}`);
    }
    for (const post of data.posts) post.myVote = mine[post.id] || null;

    // Unseen cards first, so a returning voter picks up where they left off.
    deck = [...shuffle(data.posts.filter((p) => !p.myVote)), ...data.posts.filter((p) => p.myVote)];
    index = 0;
    render();
  } catch (err) {
    el.card.hidden = true;
    el.status.hidden = false;
    el.status.className = 'status error';
    el.status.textContent = `Couldn’t start: ${err.message}`;
  }
}

load();
