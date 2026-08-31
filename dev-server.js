// Local dev only. Serves site/ and stands in for Firestore so the UI can be
// exercised without a Firebase project. Production is GitHub Pages + Firestore;
// nothing in this file ships.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Resolved from the module URL rather than cwd — this project's directory name
// contains a space and a '?', which percent-encode in the raw URL path.
const ROOT = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 4571);
const SITE_DIR = path.join(ROOT, 'site');
const VOTES_FILE = path.join(ROOT, 'data', 'dev-votes.json');

/** @type {Record<string, {postId: string, uid: string, verdict: string, reason: string|null}>} */
let votes = {};
try { votes = JSON.parse(fs.readFileSync(VOTES_FILE, 'utf8')); } catch { /* first run */ }

let timer = null;
function saveSoon() {
  if (timer) return;
  timer = setTimeout(async () => {
    timer = null;
    await fsp.mkdir(path.dirname(VOTES_FILE), { recursive: true });
    await fsp.writeFile(VOTES_FILE, JSON.stringify(votes));
  }, 300);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
               '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
               '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function sendJSON(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(payload);
}

function uidOf(req, res) {
  const cookies = Object.fromEntries(
    (req.headers.cookie || '').split(';').map((c) => c.trim().split('=').map(decodeURIComponent)));
  let uid = cookies.ron_dev_uid;
  if (!uid || !/^[\w-]{8,64}$/.test(uid)) {
    uid = crypto.randomUUID();
    res.setHeader('Set-Cookie', `ron_dev_uid=${uid}; Path=/; Max-Age=31536000; SameSite=Lax`);
  }
  return uid;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 4096) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const VERDICTS = new Set(['real', 'fake', 'unsure']);
const REASONS = new Set(['blurry', 'more', 'closer']);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const uid = uidOf(req, res);

  if (url.pathname === '/api/health') return sendJSON(res, 200, { ok: true, mode: 'dev' });

  if (url.pathname === '/api/mine') {
    const mine = {};
    for (const v of Object.values(votes)) {
      if (v.uid === uid) mine[v.postId] = { verdict: v.verdict, reason: v.reason };
    }
    return sendJSON(res, 200, { votes: mine });
  }

  if (url.pathname === '/api/tally') {
    const postId = url.searchParams.get('id');
    const t = { real: 0, fake: 0, unsure: 0, reasons: { blurry: 0, more: 0, closer: 0 } };
    for (const v of Object.values(votes)) {
      if (v.postId !== postId) continue;
      t[v.verdict] += 1;
      if (v.reason && v.reason in t.reasons) t.reasons[v.reason] += 1;
    }
    return sendJSON(res, 200, t);
  }

  if (url.pathname === '/api/vote' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch { return sendJSON(res, 400, { error: 'bad body' }); }
    const { postId, verdict } = body;
    const reason = body.reason || null;
    if (!postId || !VERDICTS.has(verdict)) return sendJSON(res, 400, { error: 'bad vote' });
    if (reason && (verdict !== 'unsure' || !REASONS.has(reason))) {
      return sendJSON(res, 400, { error: 'bad reason' });
    }
    if (verdict === 'unsure' && !reason) return sendJSON(res, 400, { error: 'reason required' });
    votes[`${postId}__${uid}`] = { postId, uid, verdict, reason };
    saveSoon();
    return sendJSON(res, 200, { ok: true });
  }

  if (req.method !== 'GET') return res.writeHead(405).end();

  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.join(SITE_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(SITE_DIR)) return res.writeHead(403).end();
  fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
                         'Cache-Control': 'no-store' });
    res.end(data);
  });
});

server.listen(PORT, () => console.log(`dev → http://localhost:${PORT}`));
