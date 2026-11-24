// Adding a video, GIF or picture from a link, like the phone's "Add from a link" (WebResolver.kt).
// The file stays on its website; the library only keeps the link, its name and a thumbnail.
//
// A web page can only read another website when that site allows it (CORS), so the browser does what
// it can without that permission:
// - links to a media file (by its name, or by trying to play/show it) work everywhere;
// - Reddit posts are read through Reddit's JSON, which allows it;
// - other pages (og:video, <video>…) only when the site allows it. Otherwise add the link from the
//   phone: it shows up here after syncing.

import { HLS, DASH } from './library.js';
import { durationMs } from './anim.js';
import { videoThumb, drawThumb, saveThumb } from './upload.js';

const PROBE_MS = 15_000;
const MAX_IMAGE = 80 << 20;

export class LinkError extends Error {}

/** Picks the first http(s) link out of shared text like "Look at this https://… (via app)". */
export function extractUrl(text) {
  const m = /https?:\/\/[^\s"'<>]+/.exec(text || '');
  return m ? m[0].replace(/[.,)\]!?]+$/, '') : null;
}

export function mimeFromName(url) {
  let path;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return null;
  }
  const ends = (...x) => x.some((e) => path.endsWith(e));
  if (ends('.mp4', '.m4v')) return 'video/mp4';
  if (ends('.webm')) return 'video/webm';
  if (ends('.mov')) return 'video/quicktime';
  if (ends('.mkv')) return 'video/x-matroska';
  if (ends('.m3u8')) return HLS;
  if (ends('.mpd')) return DASH;
  if (ends('.gif')) return 'image/gif';
  if (ends('.jpg', '.jpeg')) return 'image/jpeg';
  if (ends('.png')) return 'image/png';
  if (ends('.webp')) return 'image/webp';
  return null;
}

const isMediaType = (t) => t.startsWith('video/') || t.startsWith('image/') || t === HLS || t === 'application/vnd.apple.mpegurl' || t === DASH;
const normalize = (t) => (t === 'application/vnd.apple.mpegurl' ? HLS : t);

function nameFor(url) {
  try {
    const u = new URL(url);
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    return last || u.host || 'Web file';
  } catch {
    return 'Web file';
  }
}

function unescape(s) {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x2F;/g, '/');
}

const cleanName = (t) => (t ? unescape(t).replace(/\s+/g, ' ').trim().slice(0, 120) || null : null);
const absolute = (base, link) => new URL(unescape(link.trim()), base).toString();

/**
 * What the link leads to: {url, mime, name, page, poster}. Throws a LinkError with a message for the
 * user when it can't tell.
 */
export async function resolveLink(text) {
  const start = extractUrl(text);
  if (!start) throw new LinkError('That doesn\'t look like a link');
  if (isReddit(start)) return resolveReddit(start);

  const byName = mimeFromName(start);
  if (byName) return { url: start, mime: byName, name: nameFor(start), page: null, poster: null };

  // Ask the site (only possible when it allows other pages to read it).
  let res = null;
  try {
    res = await fetch(start, { redirect: 'follow' });
  } catch {
    res = null;
  }
  if (res) {
    if (!res.ok) throw new LinkError(res.status === 401 || res.status === 403 ? `The site refused access (${res.status})` : `The site answered ${res.status}`);
    const finalUrl = res.url || start;
    const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (isMediaType(type)) {
      res.body?.cancel().catch(() => {});
      return { url: finalUrl, mime: normalize(type), name: nameFor(finalUrl), page: null, poster: null };
    }
    if (isReddit(finalUrl)) return resolveReddit(finalUrl);
    if (type && !type.includes('html') && !type.includes('xml')) {
      const guessed = mimeFromName(finalUrl);
      if (guessed && (type === 'application/octet-stream' || type === 'binary/octet-stream')) {
        return { url: finalUrl, mime: guessed, name: nameFor(finalUrl), page: null, poster: null };
      }
      throw new LinkError(`That link doesn't lead to a video or picture (${type})`);
    }
    return fromPage(finalUrl, await res.text());
  }

  // The site doesn't allow it: try showing the link itself as a video, then as a picture.
  const probed = await probeElement(start);
  if (probed) return { url: start, mime: probed, name: nameFor(start), page: null, poster: null };
  throw new LinkError('This website doesn\'t let other pages look inside it, so the browser can\'t find the video on it. '
    + 'Add this link from the phone app instead: it shows up here after syncing. (Direct links to a file and Reddit posts work here.)');
}

/** Tries the link as a video, then as a picture. Returns a media type, or null. */
function probeElement(url) {
  const attempt = (make) => new Promise((resolve) => {
    const el = make();
    const done = (v) => {
      clearTimeout(timer);
      el.onloadedmetadata = el.onload = el.onerror = null;
      el.removeAttribute('src');
      resolve(v);
    };
    const timer = setTimeout(() => done(false), PROBE_MS);
    el.onloadedmetadata = () => done(true);
    el.onload = () => done(true);
    el.onerror = () => done(false);
    el.src = url;
  });
  return (async () => {
    if (await attempt(() => Object.assign(document.createElement('video'), { muted: true, preload: 'metadata' }))) return 'video/mp4';
    if (await attempt(() => Object.assign(new Image(), { referrerPolicy: 'no-referrer' }))) return 'image/jpeg';
    return null;
  })();
}

// ---- Web pages ----

function meta(html, property) {
  const p = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const a = new RegExp(`<meta\\b[^>]*?(?:property|name)\\s*=\\s*["']${p}["'][^>]*?content\\s*=\\s*["']([^"']*)["']`, 'is');
  const b = new RegExp(`<meta\\b[^>]*?content\\s*=\\s*["']([^"']*)["'][^>]*?(?:property|name)\\s*=\\s*["']${p}["']`, 'is');
  const m = a.exec(html) || b.exec(html);
  const v = m ? unescape(m[1]) : null;
  return v && v.trim() ? v : null;
}

/** The media type of a candidate link: from its name, or by asking the server. Null if it isn't media. */
async function mediaType(url) {
  const byName = mimeFromName(url);
  if (byName) return byName;
  try {
    const r = await fetch(url, { headers: { Range: 'bytes=0-0' } });
    r.body?.cancel().catch(() => {});
    const t = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    return isMediaType(t) ? normalize(t) : null;
  } catch {
    return null;
  }
}

export async function fromPage(pageUrl, html) {
  const titleTag = /<title[^>]*>(.*?)<\/title>/is.exec(html);
  const name = cleanName(meta(html, 'og:title') || (titleTag && titleTag[1])) || nameFor(pageUrl);
  const posterRaw = meta(html, 'og:image:secure_url') || meta(html, 'og:image') || meta(html, 'twitter:image');
  const poster = posterRaw ? absolute(pageUrl, posterRaw) : null;
  const tags = [meta(html, 'og:video:secure_url'), meta(html, 'og:video:url'), meta(html, 'og:video'), meta(html, 'twitter:player:stream')]
    .filter(Boolean);
  for (const m of html.matchAll(/<(?:video|source)\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gis)) tags.push(m[1]);
  for (const raw of [...new Set(tags.map((t) => absolute(pageUrl, t)))]) {
    const mime = await mediaType(raw);
    if (mime) return { url: raw, mime, name, page: pageUrl, poster };
  }
  // No video: the page's main picture (often the GIF or image itself).
  if (poster) {
    const mime = await mediaType(poster);
    if (mime) return { url: poster, mime, name, page: pageUrl, poster: null };
  }
  throw new LinkError('No video or picture found on that page');
}

// ---- Reddit ----

function isReddit(url) {
  try {
    const host = new URL(url).host;
    return (host === 'reddit.com' || host.endsWith('.reddit.com')) && url.includes('/comments/');
  } catch {
    return false;
  }
}

async function resolveReddit(postUrl) {
  const clean = postUrl.split('?')[0].replace(/\/+$/, '');
  let data;
  try {
    const r = await fetch(`${clean}.json?raw_json=1`);
    if (!r.ok) throw new Error(String(r.status));
    data = (await r.json())[0].data.children[0].data;
  } catch {
    throw new LinkError('Couldn\'t read that Reddit post from the browser. Try adding it from the phone app.');
  }
  const post = data.crosspost_parent_list?.[0] || data;
  const name = cleanName(post.title) || 'Reddit post';
  const poster = post.preview?.images?.[0]?.source?.url || null;
  const video = post.secure_media?.reddit_video || post.media?.reddit_video || post.preview?.reddit_video_preview;
  if (video) {
    if (video.hls_url) return { url: video.hls_url, mime: HLS, name, page: clean, poster };
    if (video.fallback_url) return { url: video.fallback_url, mime: 'video/mp4', name, page: clean, poster };
  }
  // Galleries: the first item.
  const firstId = post.gallery_data?.items?.[0]?.media_id;
  const s = firstId && post.media_metadata?.[firstId]?.s;
  if (s) {
    if (s.mp4) return { url: s.mp4, mime: 'video/mp4', name, page: clean, poster };
    if (s.gif) return { url: s.gif, mime: 'image/gif', name, page: clean, poster };
    if (s.u) return { url: s.u, mime: mimeFromName(s.u) || 'image/jpeg', name, page: clean, poster: null };
  }
  // Link posts (i.redd.it pictures and GIFs, imgur, …): the linked file or page.
  const linked = post.url_overridden_by_dest || post.url || '';
  if (linked.startsWith('http') && !linked.includes('/comments/')) {
    const r = await resolveLink(linked);
    return { ...r, name, page: r.page || clean, poster: r.poster || poster };
  }
  throw new LinkError('No video or picture found in that post');
}

// ---- Adding ----

/** A thumbnail for the web file, when the site lets the browser read it; and whether a picture is animated. */
async function webThumb(found) {
  const pictureThumb = async (url) => {
    const r = await fetch(url);
    if (!r.ok) return null;
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (bytes.length > MAX_IMAGE) return null;
    const bitmap = await createImageBitmap(new Blob([bytes]));
    return { thumb: await drawThumb(bitmap, bitmap.width, bitmap.height), bytes };
  };
  if (found.mime.startsWith('image/')) {
    try {
      const got = await pictureThumb(found.url);
      const animated = found.mime !== 'image/gif' && got ? durationMs(got.bytes.subarray(0, 32 << 20)) != null : null;
      return { thumb: got?.thumb || null, animated };
    } catch {
      return { thumb: null, animated: null };
    }
  }
  let thumb = null;
  if (found.mime.startsWith('video/')) thumb = await videoThumb(found.url, true);
  if (!thumb && found.poster) {
    try {
      thumb = (await pictureThumb(found.poster))?.thumb || null;
    } catch {
      thumb = null;
    }
  }
  return { thumb, animated: null };
}

/** The library record for a file that stays on its website: the same "W:" record the phone writes. */
function addWebRecord(lib, w) {
  const o = { n: w.name, m: w.mime };
  if (w.page) o.p = w.page;
  o.a = w.added;
  if (w.thumbId) o.t = w.thumbId;
  lib.change(() => {
    lib.records.set(`W:${w.url}`, JSON.stringify(o));
    if (w.animated != null) lib.records.set(`X:${w.url}`, JSON.stringify([w.added, w.animated ? 1 : 0]));
  });
}

/** Looks at the link and adds what it leads to. Returns the item's key (also when it was already there). */
export async function addFromLink(lib, text, onStep = () => {}) {
  onStep('Looking at the link…');
  const found = await resolveLink(text);
  if (lib.itemByKey.has(found.url)) return { key: found.url, existed: true };
  onStep('Making a thumbnail…');
  const { thumb, animated } = await webThumb(found);
  const thumbId = thumb ? await saveThumb(lib, thumb).catch(() => null) : null;
  addWebRecord(lib, { url: found.url, name: found.name, mime: found.mime, page: found.page, added: Date.now(), thumbId, animated });
  return { key: found.url, existed: false };
}
