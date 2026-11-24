// Google sign-in (Google Identity Services) and the few Drive v3 calls the app needs.
// The scope is drive.file: only files created by this app (the same Google Cloud project as the
// phone app) are visible.

import { kvSet } from './kv.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const BASE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

export class AuthError extends Error {}

let tokenClient = null;
let token = null;
let expiresAt = 0;
let pending = null;

export function initAuth(clientId) {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: SCOPE,
    callback: async (resp) => {
      const p = pending;
      pending = null;
      if (resp.error) {
        p?.reject(new AuthError(resp.error_description || resp.error));
        return;
      }
      token = resp.access_token;
      expiresAt = Date.now() + (Number(resp.expires_in) || 3600) * 1000;
      await kvSet('token', { token, expiresAt }); // for the video streaming worker
      p?.resolve(token);
    },
    error_callback: (err) => {
      const p = pending;
      pending = null;
      p?.reject(new AuthError(err?.message || 'Sign-in was closed'));
    },
  });
}

/** Opens Google's sign-in popup (must be called from a click). */
export function signIn(prompt = '') {
  return new Promise((resolve, reject) => {
    pending = { resolve, reject };
    tokenClient.requestAccessToken({ prompt });
  });
}

export const signedIn = () => token != null && Date.now() < expiresAt - 60_000;

export function signOut() {
  if (token) google.accounts.oauth2.revoke(token, () => {});
  token = null;
  expiresAt = 0;
  return kvSet('token', undefined);
}

async function request(method, url, { body, headers = {}, contentType } = {}) {
  if (!signedIn()) throw new AuthError('Signed out');
  const h = { Authorization: `Bearer ${token}`, ...headers };
  if (contentType) h['Content-Type'] = contentType;
  const r = await fetch(url, { method, headers: h, body });
  if (r.status === 401) {
    token = null;
    throw new AuthError('Session expired');
  }
  return r;
}

async function require(r, what) {
  if (!r.ok) throw new Error(`${what} failed (${r.status}): ${(await r.text()).slice(0, 300)}`);
  return r;
}

export async function findByName(name, parent, folder = false) {
  let q = `name = '${name.replace(/'/g, "\\'")}' and trashed = false`;
  if (folder) q += " and mimeType = 'application/vnd.google-apps.folder'";
  if (parent) q += ` and '${parent}' in parents`;
  const r = await require(await request('GET', `${BASE}/files?q=${encodeURIComponent(q)}&fields=files(id)&spaces=drive`), 'Search');
  const files = (await r.json()).files || [];
  return files.length ? files[0].id : null;
}

/** A file's version (it goes up with every change), or null if the file is gone. */
export async function version(id) {
  const r = await request('GET', `${BASE}/files/${id}?fields=version,trashed`);
  if (r.status === 404) return null;
  await require(r, 'Check file');
  const j = await r.json();
  return j.trashed ? null : Number(j.version);
}

export async function download(id) {
  const r = await require(await request('GET', `${BASE}/files/${id}?alt=media`), 'Download');
  return new Uint8Array(await r.arrayBuffer());
}

export async function downloadOrNull(id) {
  const r = await request('GET', `${BASE}/files/${id}?alt=media`);
  if (r.status === 404) return null;
  await require(r, 'Download');
  return new Uint8Array(await r.arrayBuffer());
}

/** Replaces a file's content. Returns the new version. */
export async function putContent(id, bytes, mime) {
  const r = await require(
    await request('PATCH', `${UPLOAD}/files/${id}?uploadType=media&fields=version`, { body: bytes, contentType: mime }),
    'Save file',
  );
  return Number((await r.json()).version);
}

export async function createFile(name, parent, mime) {
  const meta = JSON.stringify({ name, mimeType: mime, parents: [parent] });
  const r = await require(await request('POST', `${BASE}/files?fields=id`, { body: meta, contentType: 'application/json' }), 'Create file');
  return (await r.json()).id;
}

export async function createFolder(name, parent) {
  const meta = JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parent] });
  const r = await require(await request('POST', `${BASE}/files?fields=id`, { body: meta, contentType: 'application/json' }), 'Create folder');
  return (await r.json()).id;
}

/** Creates a small file with its content in one request. Returns its id. */
export async function uploadSmall(name, parent, mime, bytes) {
  const boundary = `mm${Date.now()}${Math.random().toString(16).slice(2)}`;
  const meta = JSON.stringify({ name, parents: [parent] });
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`,
    `--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`,
    bytes,
    `\r\n--${boundary}--\r\n`,
  ]);
  const r = await require(
    await request('POST', `${UPLOAD}/files?uploadType=multipart&fields=id`, { body, contentType: `multipart/related; boundary=${boundary}` }),
    'Upload',
  );
  return (await r.json()).id;
}

/** Starts a resumable upload of [size] bytes. Returns the session URL to send the parts to. */
export async function startUpload(name, parent, mime, size) {
  const r = await require(await request('POST', `${UPLOAD}/files?uploadType=resumable&fields=id,size`, {
    body: JSON.stringify({ name, parents: [parent] }),
    contentType: 'application/json; charset=UTF-8',
    headers: { 'X-Upload-Content-Type': mime, 'X-Upload-Content-Length': String(size) },
  }), 'Start upload');
  const session = r.headers.get('Location');
  if (!session) throw new Error('Start upload: no session URL');
  return session;
}

/** Sends bytes [start, start + part.length) of a resumable upload. Returns the file when it's complete. */
export async function uploadPart(session, part, start, total) {
  const end = start + part.byteLength - 1;
  const r = await request('PUT', session, {
    body: part,
    contentType: 'application/octet-stream',
    headers: { 'Content-Range': part.byteLength ? `bytes ${start}-${end}/${total}` : `bytes */${total}` },
  });
  if (r.status === 308) return null;
  await require(r, 'Upload');
  return r.json();
}

export async function deleteFile(id) {
  const r = await request('DELETE', `${BASE}/files/${id}`);
  if (!r.ok && r.status !== 404) await require(r, 'Delete');
}
