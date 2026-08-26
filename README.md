# Real or Not?

A voting game over image posts from [r/RealOrNotTCG](https://www.reddit.com/r/RealOrNotTCG/):
you see the photos someone posted of a trading card and call it **real**, **not real**, or
**can't tell** — and if you can't tell, you say why. Then you see how everyone else voted and
can jump to the Reddit thread for the actual verdict.

**Live site:** _(set after the first deploy)_

## How it fits together

There is no server. Three moving parts:

| Part | What it does |
| --- | --- |
| **GitHub Actions** (`.github/workflows/deploy.yml`) | Every 30 minutes, pulls the subreddit through Reddit's official API and writes `site/posts.json` — the deck. Credentials live in repo secrets, never in the page. |
| **GitHub Pages** | Serves `site/` as a static page. Card photos are hotlinked from `i.redd.it` with `referrerpolicy="no-referrer"`. |
| **Firestore** | Holds the votes. The browser signs in with Firebase anonymous auth and writes one document per (post, person). |

Tallies are read back with Firestore **aggregation count queries** rather than a stored counter,
so there is no number in the database for a client to forge — a tally is always a recount of the
individual votes, and the rules pin each vote's document id to `<postId>__<uid>`.

## Voting

Three verdicts. Choosing **can't tell** asks a follow-up, because on this subreddit "I can't
tell" almost always means the post is missing something:

- Image too blurry
- Need more photos
- Need closer photos

Those reasons are tallied separately and shown under the bar, so a poster can see *why* people
couldn't call it.

Keyboard: `←` not real · `↓` can't tell · `→` real · `1` `2` `3` pick a reason · `space` next
card · `[` `]` flip between photos on a multi-photo post.

## Local development

```bash
npm run dev        # builds the deck, then serves http://localhost:4571
```

Without Reddit credentials the deck falls back to the public Atom feed, which only exposes one
image per post — enough to work on the UI. With `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` set
you get the real thing, galleries included.

Without Firebase config the dev server stands in for Firestore and keeps votes in
`data/dev-votes.json`, so the whole flow works offline. A banner tells you which mode you're in.

```bash
npm run test:rules   # runs the security rules against the Firestore emulator (needs JDK 21+)
npm run emulators    # firestore + auth emulators; then open /?emulator to point the app at them
npm run rules        # deploys firestore.rules + indexes (needs firebase login)
```

## Setup

First-time deployment steps — Reddit app, Firebase project, GitHub Pages — are in
[SETUP.md](SETUP.md).

## Known limits

- **Anonymous voting is not fraud-proof.** One vote per anonymous Firebase user, but anyone
  willing to clear site data can get a fresh identity. Fine for a for-fun tally; don't treat the
  numbers as authoritative.
- **All vote documents are publicly readable** (that's what makes the counts work). They contain
  an anonymous uid, a post id, and a verdict — no personal data.
- **The deck is at most 30 minutes stale**, and only covers the ~100 newest and hottest image
  posts. Text posts and link posts are skipped; so are NSFW and stickied posts.
- **Photos are hotlinked from Reddit.** If Reddit takes an image down it disappears here too, and
  the card shows a load failure instead.
