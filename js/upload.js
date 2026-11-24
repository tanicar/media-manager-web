// Uploading files from this computer into the Media Manager folder, the same way the phone does:
// encrypted in 1 MiB chunks when the folder has a password, with a small thumbnail for browsing.
// Large files are sent in 8 MiB parts, so they never have to fit in memory at once.

import * as drive from './drive.js';
import * as cr from './crypto.js';
import { durationMs } from './anim.js';

const PART = 8 << 20; // a multiple of Drive's 256 KiB upload unit
const IMAGES = 'Library images';
const THUMB_SIDE = 640;
export const THUMB_WAIT_MS = 10_000;

const MIME_BY_EXT = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', '3gp': 'video/3gpp',
};

export function mimeOf(file) {
  if (file.type) return file.type;
  return MIME_BY_EXT[file.name.split('.').pop().toLowerCase()] || 'application/octet-stream';
}

export const isMedia = (file) => /^(image|video)\//.test(mimeOf(file));

let imagesFolder = null;
async function imagesFolderId(lib) {
  imagesFolder ||= (await drive.findByName(IMAGES, lib.folder, true)) || (await drive.createFolder(IMAGES, lib.folder));
  return imagesFolder;
}

/** A small JPEG of the picture, or of the frame 1 s into a video. Null if the browser can't read it. */
export async function makeThumb(file, mime) {
  let source;
  let w;
  let hgt;
  if (mime.startsWith('video/')) {
    const url = URL.createObjectURL(file);
    try {
      const video = document.createElement('video');
      video.muted = true;
      video.preload = 'auto';
      video.src = url;
      await new Promise((resolve, reject) => {
        video.onloadeddata = resolve;
        video.onerror = () => reject(new Error('unreadable video'));
        // Some formats never load or fail in some browsers: don't hold up the upload queue for them.
        setTimeout(() => reject(new Error('video thumbnail timed out')), THUMB_WAIT_MS);
      });
      video.currentTime = Math.min(1, (video.duration || 0) / 2);
      await new Promise((resolve) => {
        video.onseeked = resolve;
        setTimeout(resolve, 3000);
      });
      source = video;
      w = video.videoWidth;
      hgt = video.videoHeight;
      return await drawThumb(source, w, hgt);
    } catch {
      return null;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  try {
    source = await createImageBitmap(file);
    w = source.width;
    hgt = source.height;
    return await drawThumb(source, w, hgt);
  } catch {
    return null;
  }
}

async function drawThumb(source, w, hgt) {
  if (!w || !hgt) return null;
  const scale = Math.min(1, THUMB_SIDE / Math.max(w, hgt));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(hgt * scale);
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

/**
 * Uploads one file and adds it to the library. [onProgress] gets the fraction sent (0..1).
 * Returns the new item's key.
 */
export async function uploadFile(lib, file, onProgress = () => {}) {
  const mime = mimeOf(file);
  const size = file.size;
  const encrypted = lib.encrypted;
  const total = encrypted ? cr.encryptedSize(size) : size;
  const name = encrypted ? `${crypto.randomUUID()}.mmv` : file.name;
  const session = await drive.startUpload(name, lib.folder, encrypted ? 'application/octet-stream' : mime, total);

  // Encrypted stream: header, then each 1 MiB chunk sealed; sent in 8 MiB parts.
  const header = encrypted ? cr.newHeader() : null;
  let pending = [];
  let pendingLen = 0;
  let sent = 0;
  let done = null;
  const queue = (bytes) => {
    pending.push(bytes);
    pendingLen += bytes.length;
  };
  const flush = async (final) => {
    const sendLen = final ? pendingLen : Math.floor(pendingLen / PART) * PART;
    if (!sendLen && !final) return;
    const buf = new Uint8Array(pendingLen);
    let o = 0;
    for (const p of pending) {
      buf.set(p, o);
      o += p.length;
    }
    done = await drive.uploadPart(session, buf.subarray(0, sendLen), sent, total);
    sent += sendLen;
    pending = sendLen < pendingLen ? [buf.slice(sendLen)] : [];
    pendingLen -= sendLen;
    onProgress(sent / total);
  };

  if (header) queue(header);
  const chunks = cr.chunkCount(size);
  for (let i = 0; i < chunks; i++) {
    const plain = new Uint8Array(await file.slice(i * cr.CHUNK, (i + 1) * cr.CHUNK).arrayBuffer());
    queue(encrypted ? await cr.seal(lib.key, header, i, plain) : plain);
    if (pendingLen >= PART) await flush(false);
  }
  await flush(true);
  if (!done) throw new Error(`Upload of ${file.name} didn't finish`);
  if (done.size != null && Number(done.size) !== total) {
    await drive.deleteFile(done.id);
    throw new Error(`Upload check failed for ${file.name}`);
  }

  // Thumbnail (shown in lists on every device).
  let thumbId = null;
  const thumb = await makeThumb(file, mime);
  if (thumb) {
    thumbId = await drive.uploadSmall(
      `${crypto.randomUUID()}${encrypted ? '.mmv' : '.jpg'}`,
      await imagesFolderId(lib),
      encrypted ? 'application/octet-stream' : 'image/jpeg',
      await lib.protect(thumb),
    );
  }

  // Animated WebP/PNG count as GIFs, like on the phone.
  let animated = null;
  if (mime.startsWith('image/') && mime !== 'image/gif') {
    const head = new Uint8Array(await file.slice(0, Math.min(size, 32 << 20)).arrayBuffer());
    animated = durationMs(head) != null;
  }

  const key = `upload:${crypto.randomUUID()}/${encodeURIComponent(file.name)}`;
  lib.addUploaded({
    key, fileId: done.id, name: file.name, mime, size, modified: file.lastModified || Date.now(), encrypted, thumbId, animated,
  });
  return key;
}
