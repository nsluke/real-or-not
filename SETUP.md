# Setup

Three things have to exist before the site works: a Reddit API app (fetches the deck), a
Firebase project (stores votes), and GitHub Pages turned on (serves the page). Each is free.

Two of these need you to sign in to accounts, so they're yours to do — the exact clicks and
commands are below.

---

## 1. Reddit API app

Reddit blocks unauthenticated requests from GitHub's IP ranges, so the scheduled build needs
credentials. This also unlocks every photo on a gallery post instead of just the first.

1. Go to <https://www.reddit.com/prefs/apps> → **create another app…**
2. Name: `real-or-not`. Type: **script**. Redirect URI: `http://localhost` (unused, but required).
3. Create it. You now have two strings:
   - **client id** — the short string directly under the app name (not the app name itself)
   - **secret** — the field labelled `secret`
4. Store them as repo secrets:

```bash
gh secret set REDDIT_CLIENT_ID --repo nsluke/real-or-not
gh secret set REDDIT_CLIENT_SECRET --repo nsluke/real-or-not
```

Each command prompts for the value, so it never lands in your shell history. Optionally set
`gh variable set REDDIT_USERNAME --body "<your reddit username>" --repo nsluke/real-or-not` —
Reddit asks that the User-Agent identify a person.

## 2. Firebase project

The free **Spark** plan is enough; no billing account needed.

1. <https://console.firebase.google.com> → **Add project** (name it whatever, e.g. `real-or-not`).
   Analytics is unnecessary — turn it off.
2. **Build → Firestore Database → Create database** → production mode → pick a region near you.
3. **Build → Authentication → Get started → Anonymous → Enable.**
   Every voter is an anonymous account; this is what makes one-vote-per-person possible.
4. **Project settings (gear) → Your apps → Web (`</>`)** → register an app (no Hosting needed).
   Copy the `firebaseConfig` values into [`site/firebase-config.js`](site/firebase-config.js):
   `apiKey`, `authDomain`, `projectId`, `appId`. These are public by design — the rules, not
   secrecy, are what protect the data.
5. Push the security rules and indexes:

```bash
npx firebase-tools login
npx firebase-tools use --add          # pick the project you just made
npm run rules                         # deploys firestore.rules + firestore.indexes.json
```

**Don't skip the rules deploy.** Firestore's default rules either block all writes (voting fails)
or allow all writes (anyone can rewrite anyone's vote). The rules in this repo allow exactly one
vote document per person per post and nothing else — `npm run test:rules` proves it against the
emulator (needs a JDK 21+ on PATH; on this Mac: `export PATH=/opt/homebrew/opt/openjdk@21/bin:$PATH`).

The indexes matter too: the tallies use aggregation count queries over `(postId, verdict)` and
`(postId, reason)`, and Firestore refuses those without a composite index. If you skip it, the
card shows "Couldn't load the tally" with a link in the browser console to create the index.

## 3. GitHub Pages

The deploy workflow is **disabled** right now, so nothing runs on a schedule until the steps
above are done. Turn it back on when they are:

```bash
gh workflow enable "Build deck and deploy" --repo nsluke/real-or-not
gh workflow run "Build deck and deploy" --repo nsluke/real-or-not
```

1. Repo → **Settings → Pages → Build and deployment → Source: GitHub Actions** (already set).
2. Enable and run the workflow with the commands above.

The workflow rebuilds the deck every 30 minutes and redeploys. It fails loudly if the Reddit
credentials are missing, and warns (but still deploys) if the Firebase config is still
placeholder text.

### Custom domain (optional)

`nsluke.org` is on Namecheap DNS pointing at GitHub Pages today, so a subdomain is easy: add a
`CNAME` record for `realornot` → `nsluke.github.io`, put `realornot.nsluke.org` in
**Settings → Pages → Custom domain**, and add a `site/CNAME` file containing the same hostname so
deploys don't clear it.

---

## Checking it worked

- Open the live URL. The banner at the top should be **absent** — a yellow banner means the
  Firebase config is still placeholder text or Firestore is unreachable.
- Vote on a card. The bar should appear with "You're the first vote on this one."
- Reload. Your vote should still be there (anonymous auth persists in the browser).
- Firebase console → Firestore → `votes` should show a document named `<postId>__<uid>`.
