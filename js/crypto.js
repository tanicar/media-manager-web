// Encryption, byte-for-byte compatible with the Android app (Crypto.kt).
//
// File layout: 12-byte header ("MMV1" + 8 random bytes), then the content in 1 MiB chunks, each
// sealed with AES-256-GCM (16-byte tag). Chunk i uses nonce = header[4..12] + i (4 bytes, big endian).
// Small payloads (library, thumbnails, password check) are a header plus one sealed chunk.

export const CHUNK = 1 << 20;
export const TAG = 16;
export const HEADER = 12;

const subtle = globalThis.crypto.subtle;

export async function deriveKey(password, salt, iterations) {
  const base = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, 256);
  return new Uint8Array(bits);
}

const keyCache = new Map();
export async function importKey(raw) {
  const id = b64(raw);
  if (!keyCache.has(id)) {
    keyCache.set(id, subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']));
  }
  return keyCache.get(id);
}

function nonce(header, index) {
  const n = new Uint8Array(12);
  n.set(header.subarray(4, 12), 0);
  new DataView(n.buffer).setUint32(8, index);
  return n;
}

export async function open(key, header, index, data) {
  const plain = await subtle.decrypt({ name: 'AES-GCM', iv: nonce(header, index), tagLength: 128 }, key, data);
  return new Uint8Array(plain);
}

export async function seal(key, header, index, data) {
  const out = await subtle.encrypt({ name: 'AES-GCM', iv: nonce(header, index), tagLength: 128 }, key, data);
  return new Uint8Array(out);
}

export function newHeader() {
  const h = new Uint8Array(HEADER);
  h.set([0x4d, 0x4d, 0x56, 0x31]); // "MMV1"
  globalThis.crypto.getRandomValues(h.subarray(4));
  return h;
}

export async function openBlob(key, blob) {
  const b = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  return open(key, b.subarray(0, HEADER), 0, b.subarray(HEADER));
}

export async function sealBlob(key, plain) {
  const h = newHeader();
  const body = await seal(key, h, 0, plain);
  const out = new Uint8Array(HEADER + body.length);
  out.set(h);
  out.set(body, HEADER);
  return out;
}

export const chunkCount = (plainSize) => (plainSize === 0 ? 1 : Math.ceil(plainSize / CHUNK));
export const encryptedSize = (plainSize) => HEADER + plainSize + chunkCount(plainSize) * TAG;
export const encStart = (i) => HEADER + i * (CHUNK + TAG);
export const plainLen = (plainSize, i) => Math.max(0, Math.min(CHUNK, plainSize - i * CHUNK));

/** Decrypts a whole chunked file (pictures and GIFs, which are downloaded in one go). */
export async function openFile(key, bytes, plainSize) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const header = b.subarray(0, HEADER);
  const out = new Uint8Array(plainSize);
  const n = chunkCount(plainSize);
  for (let i = 0; i < n; i++) {
    const len = plainLen(plainSize, i);
    const s = encStart(i);
    out.set(await open(key, header, i, b.subarray(s, s + len + TAG)), i * CHUNK);
  }
  return out;
}

export function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function unb64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function gzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
