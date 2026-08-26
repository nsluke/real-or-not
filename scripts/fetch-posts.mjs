#!/usr/bin/env node
// Builds site/posts.json — the deck the static site plays through.
//
// Uses Reddit's official API when REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET are set
// (that path returns every image of a gallery post, which is what these threads
// need: front shot, back shot, close-ups). Falls back to the public Atom feed,
// which only exposes one image per post, so local dev works without credentials.

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SUBREDDIT = process.env.SUBREDDIT || 'RealOrNotTCG';
const OUT = process.env.OUT ||
  join(dirname(fileURLToPath(import.meta.url)), '..', 'site', 'posts.json');
const LIMIT = Math.min(Number(process.env.POST_LIMIT || 100), 100);
const UA = `web:real-or-not:1.0 (by /u/${process.env.REDDIT_USERNAME || 'nsluke'})`;

const { REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET } = process.env;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(url, init = {}, attempts = 4) {
  let last;
  for (let i = 0; i < attempts; i++) {
    if (i) await sleep(2000 * 2 ** (i - 1));
    const res = await fetch(url, { ...init, headers: { 'User-Agent': UA, ...init.headers } });
    if (res.ok) return res;
    last = new Error(`${url} → ${res.status} ${res.statusText}`);
    if (res.status !== 429 && res.status < 500) break;
    console.warn(`  retrying after ${res.status} (${i + 1}/${attempts})`);
  }
  throw last;
}

// ------------------------------------------------------------ official API ---

async function accessToken() {
  const basic = Buffer.from(`${REDDIT_CLIENT_ID}:${REDDIT_CLIENT_SECRET}`).toString('base64');
  const res = await request('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const { access_token: token } = await res.json();
  if (!token) throw new Error('reddit returned no access token');
  return token;
}

const EXT = { 'image/jpg': 'jpg', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif' };

/** Every image on a post, in the order the poster arranged them. */
function imagesOf(p) {
  if (p.is_gallery && p.media_metadata) {
    const order = p.gallery_data?.items?.map((i) => i.media_id) || Object.keys(p.media_metadata);
    const urls = order.map((id) => {
      const meta = p.media_metadata[id];
      if (!meta || meta.status !== 'valid') return null;
      const ext = EXT[meta.m];
      return ext ? `https://i.redd.it/${id}.${ext}` : meta.s?.u?.replace(/&amp;/g, '&') || null;
    });
    if (urls.some(Boolean)) return urls.filter(Boolean);
  }
  if (/^https:\/\/i\.redd\.it\/[\w-]+\.(jpg|jpeg|png|gif)/i.test(p.url || '')) return [p.url];
  const source = p.preview?.images?.[0]?.source?.url;
  if (source) return [source.replace(/&amp;/g, '&')];
  return [];
}

function normalize(p) {
  const images = imagesOf(p);
  if (!images.length || p.over_18 || p.stickied || p.removed_by_category) return null;
  return {
    id: p.id,
    title: p.title,
    author: p.author,
    permalink: `https://www.reddit.com${p.permalink}`,
    created: new Date(p.created_utc * 1000).toISOString(),
    body: (p.selftext || '').replace(/\s+/g, ' ').trim().slice(0, 500),
    flair: p.link_flair_text || null,
    comments: p.num_comments ?? 0,
    images,
  };
}

async function viaApi() {
  const token = await accessToken();
  const auth = { headers: { Authorization: `Bearer ${token}` } };
  const seen = new Map();
  for (const sort of ['new', 'hot']) {
    const res = await request(
      `https://oauth.reddit.com/r/${SUBREDDIT}/${sort}?limit=${LIMIT}&raw_json=1`, auth);
    const { data } = await res.json();
    for (const child of data.children) {
      const post = normalize(child.data);
      if (post && !seen.has(post.id)) seen.set(post.id, post);
    }
    console.log(`  /${sort}: ${data.children.length} posts, ${seen.size} usable so far`);
  }
  return [...seen.values()];
}

// ------------------------------------------------------------- rss fallback ---

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s = '') => s
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => ENTITIES[e]);

async function viaRss() {
  const res = await request(`https://www.reddit.com/r/${SUBREDDIT}/.rss?limit=${LIMIT}`);
  const xml = await res.text();
  const posts = [];
  for (const entry of xml.match(/<entry>[\s\S]*?<\/entry>/g) || []) {
    const pick = (t) => {
      const m = entry.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`));
      return m ? decode(m[1].trim()) : '';
    };
    const id = pick('id').replace(/^t3_/, '');
    const thumb = decode((entry.match(/<media:thumbnail url="([^"]+)"/) || [])[1] || '');
    // The feed only carries a 140px signed thumbnail, but its media id is the id
    // the full-size upload lives under.
    const full = thumb.match(/^https:\/\/preview\.redd\.it\/([\w-]+\.(?:jpg|jpeg|png|gif|webp))/i);
    if (!id || !full) continue;

    const content = entry.match(/<content[^>]*>([\s\S]*?)<\/content>/);
    const body = content
      ? decode(decode(content[1]))
          .replace(/<table[\s\S]*?<div class="md">/, '')
          .replace(/<[\s\S]*?>/g, ' ')
          .replace(/\s*submitted by[\s\S]*$/, '')
          .replace(/\s+/g, ' ')
          .trim()
      : '';

    posts.push({
      id,
      title: pick('title'),
      author: decode(((entry.match(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>/) || [])[1] || '')
        .trim()).replace(/^\/u\//, ''),
      permalink: decode((entry.match(/<link href="([^"]+)"/) || [])[1] || ''),
      created: pick('published'),
      body: body.slice(0, 500),
      flair: null,
      comments: 0,
      images: [`https://i.redd.it/${full[1]}`],
    });
  }
  return posts;
}

// -------------------------------------------------------------------- main ---

const useApi = Boolean(REDDIT_CLIENT_ID && REDDIT_CLIENT_SECRET);
console.log(`Fetching r/${SUBREDDIT} via ${useApi ? 'the official API' : 'the RSS feed (no credentials set)'}…`);

let fetched;
try {
  fetched = useApi ? await viaApi() : await viaRss();
} catch (err) {
  console.error(`\nFailed to build the deck: ${err.message}`);
  if (/access_token .* 401/.test(err.message)) {
    console.error('Reddit rejected the credentials. Check REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET —\n' +
      'the id is the short string under the app name at reddit.com/prefs/apps, not the app name.');
  } else if (/40[38]/.test(err.message) && !useApi) {
    console.error('Reddit blocks unauthenticated requests from datacenter IPs. Set\n' +
      'REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET to use the official API instead.');
  }
  process.exit(1);
}

const posts = fetched.sort((a, b) => new Date(b.created) - new Date(a.created));

if (!posts.length) {
  console.error('No usable image posts came back — refusing to write an empty deck.');
  process.exit(1);
}

const galleries = posts.filter((p) => p.images.length > 1).length;
const payload = {
  generatedAt: new Date().toISOString(),
  subreddit: SUBREDDIT,
  source: useApi ? 'api' : 'rss',
  count: posts.length,
  posts,
};

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(payload, null, 1));
console.log(`Wrote ${posts.length} posts (${galleries} multi-image) → ${OUT}`);
