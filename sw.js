// Streams videos from Drive to the <video> element: the page asks for stream/<id>?size=..&enc=..,
// the browser sends byte ranges while playing and seeking, and this worker downloads just the
// encrypted chunks that cover each range, decrypts them and answers with the plain bytes.
// Self-contained on purpose (no imports), so it runs in every browser.

const CHUNK = 1 << 20;
const TAG = 16;
const HEADER = 12;
const MAX_REPLY = 4 * CHUNK; // the browser asks again for the rest

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const at = url.pathname.lastIndexOf('/stream/');
  if (url.origin !== location.origin || at < 0) return;
  event.respondWith(stream(url.pathname.slice(at + 8), url.searchParams, event.request.headers.get('range')));
});

// ---- Token and key, written by the page to IndexedDB ----

function kvGet(key) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('media-manager', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const req = open.result.transaction('kv').objectStore('kv').get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    };
  });
}

let keyCache = null;
async function aesKey() {
  const b64 = await kvGet('key');
  if (!b64) throw new Error('locked');
  if (keyCache?.b64 !== b64) {
    const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    keyCache = { b64, key: await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']) };
  }
  return keyCache.key;
}

async function driveRange(id, start, end) {
  const t = await kvGet('token');
  if (!t) throw new Error('signed out');
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`, {
    headers: { Authorization: `Bearer ${t.token}`, Range: `bytes=${start}-${end}` },
  });
  if (!r.ok) throw new Error(`Drive ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

// ---- Decrypted chunks, kept for a while (seeking back, the next request) ----

const headers = new Map();
const chunks = new Map(); // `${id}:${i}` -> Uint8Array, oldest first

function remember(k, v) {
  chunks.set(k, v);
  while (chunks.size > 24) chunks.delete(chunks.keys().next().value);
}

function nonce(header, i) {
  const n = new Uint8Array(12);
  n.set(header.subarray(4, 12));
  new DataView(n.buffer).setUint32(8, i);
  return n;
}

const plainLen = (size, i) => Math.max(0, Math.min(CHUNK, size - i * CHUNK));
const encStart = (i) => HEADER + i * (CHUNK + TAG);

/** Plain chunks first..last of an encrypted file (downloaded together in one request). */
async function encryptedChunks(id, size, first, last) {
  const missing = [];
  for (let i = first; i <= last; i++) if (!chunks.has(`${id}:${i}`)) missing.push(i);
  if (missing.length) {
    const key = await aesKey();
    if (!headers.has(id)) headers.set(id, await driveRange(id, 0, HEADER - 1));
    const header = headers.get(id);
    const a = missing[0];
    const b = missing[missing.length - 1];
    const bytes = await driveRange(id, encStart(a), encStart(b) + plainLen(size, b) + TAG - 1);
    for (let i = a; i <= b; i++) {
      const s = encStart(i) - encStart(a);
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: nonce(header, i), tagLength: 128 },
        key,
        bytes.subarray(s, s + plainLen(size, i) + TAG),
      );
      remember(`${id}:${i}`, new Uint8Array(plain));
    }
  }
  const out = [];
  for (let i = first; i <= last; i++) out.push(chunks.get(`${id}:${i}`));
  return out;
}

async function stream(id, params, range) {
  try {
    const size = Number(params.get('size'));
    const mime = params.get('mime') || 'video/mp4';
    let start = 0;
    let end = size - 1;
    const m = /bytes=(\d*)-(\d*)/.exec(range || '');
    if (m) {
      if (m[1] === '' && m[2] !== '') {
        start = Math.max(0, size - Number(m[2]));
      } else {
        start = Number(m[1] || 0);
        if (m[2] !== '') end = Math.min(size - 1, Number(m[2]));
      }
    }
    if (start >= size) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    }
    end = Math.min(end, start + MAX_REPLY - 1);

    let body;
    if (params.get('enc') === '1') {
      const first = Math.floor(start / CHUNK);
      const last = Math.floor(end / CHUNK);
      const parts = await encryptedChunks(id, size, first, last);
      body = new Uint8Array(end - start + 1);
      let pos = 0;
      parts.forEach((part, n) => {
        const base = (first + n) * CHUNK;
        const from = Math.max(start - base, 0);
        const to = Math.min(end - base + 1, part.length);
        body.set(part.subarray(from, to), pos);
        pos += to - from;
      });
    } else {
      body = await driveRange(id, start, end);
    }
    return new Response(body, {
      status: 206,
      headers: {
        'Content-Type': mime,
        'Content-Length': String(body.length),
        'Content-Range': `bytes ${start}-${start + body.length - 1}/${size}`,
        'Accept-Ranges': 'bytes',
      },
    });
  } catch (e) {
    return new Response(String(e.message || e), { status: 502 });
  }
}
