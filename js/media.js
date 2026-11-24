// Getting pictures out of Drive: thumbnails (kept in the browser's cache, so each is downloaded
// once), whole pictures/GIFs, and stream URLs for videos (served by the worker in sw.js).

import * as drive from './drive.js';
import * as cr from './crypto.js';

const THUMBS = 'mm-thumbs-v1';
const urls = new Map(); // Drive id -> object URL (in memory for this visit)
const inflight = new Map();
let active = 0;
const queue = [];

// At most 6 downloads at a time; the most recently requested go first (what's on screen now).
function limited(task) {
  return new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    pump();
  });
}

function pump() {
  while (active < 6 && queue.length) {
    const { task, resolve, reject } = queue.pop();
    active++;
    task().then(resolve, reject).finally(() => {
      active--;
      pump();
    });
  }
}

/** Object URL for a thumbnail picture uploaded by the library sync. */
export function thumbUrl(lib, id) {
  if (!id) return Promise.resolve(null);
  if (urls.has(id)) return Promise.resolve(urls.get(id));
  if (inflight.has(id)) return inflight.get(id);
  const p = (async () => {
    const cache = await caches.open(THUMBS);
    const hit = await cache.match(`/thumb/${id}`);
    let blob;
    if (hit) {
      blob = await hit.blob();
    } else {
      const bytes = await limited(() => drive.downloadOrNull(id));
      if (!bytes) return null;
      blob = new Blob([await lib.unprotect(bytes)], { type: 'image/jpeg' });
      await cache.put(`/thumb/${id}`, new Response(blob));
    }
    const url = URL.createObjectURL(blob);
    urls.set(id, url);
    return url;
  })().finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

// Whole files (pictures and GIFs): the last few stay in memory for quick back-and-forth.
const full = new Map();

export async function fileUrl(lib, item) {
  if (item.web) return item.key; // straight from the website
  if (full.has(item.key)) {
    const url = full.get(item.key);
    full.delete(item.key);
    full.set(item.key, url); // most recent last
    return url;
  }
  const bytes = await drive.download(item.fileId);
  const plain = item.encrypted ? await cr.openFile(lib.key, bytes, item.size) : bytes;
  const url = URL.createObjectURL(new Blob([plain], { type: item.mime }));
  full.set(item.key, url);
  while (full.size > 12) {
    const [k, u] = full.entries().next().value;
    URL.revokeObjectURL(u);
    full.delete(k);
  }
  return url;
}

/** URL the <video> element plays from: the worker fetches (and decrypts) only the parts it needs. */
export function streamUrl(item) {
  const q = new URLSearchParams({ size: item.size, enc: item.encrypted ? '1' : '0', mime: item.mime });
  return new URL(`stream/${item.fileId}?${q}`, location.href).href;
}

export async function clearCaches() {
  for (const u of urls.values()) URL.revokeObjectURL(u);
  urls.clear();
  await caches.delete(THUMBS);
}
