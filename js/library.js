// The shared library in Drive, read and written in the same format as the phone (Sync.kt).
//
// The library is a set of records (key -> JSON):
//   L:<uid> tag/participant {k, n, t?, x?}   A:<media key>\t<label uid> assignment (1)
//   C:<media key> cover {p, t?}              D:<media key> file in Drive {f, n, m, s, d, e, t?}
//   W:<media key> file from the web {n, m, p?, a, t?}
//   S:<uid> scene {n, k: [keys], p: {label uid: bool}, t?}
//   X:<media key> animated-image check [modified, 0/1]
// "t" is the Drive id of a thumbnail picture, "x" a tag's description. Saving merges with what other devices wrote since:
// a record changed on one side takes that side's version; if both changed it, this device wins.

import * as drive from './drive.js';
import * as cr from './crypto.js';
import { kvSet } from './kv.js';

const FOLDER = 'Media Manager';
const VAULT = 'vault.json';
const CHECK = 'media-manager-vault';
export const HLS = 'application/x-mpegurl';
export const DASH = 'application/dash+xml';

export function merge(local, remote, base) {
  const out = new Map();
  const keys = new Set([...local.keys(), ...remote.keys(), ...base.keys()]);
  for (const k of keys) {
    const l = local.get(k);
    const r = remote.get(k);
    const b = base.get(k);
    let v;
    if (l === r) v = l;
    else if (l === b) v = r; // only the other side changed it
    else if (r === b) v = l; // only this side changed it
    else v = l ?? r; // both changed it: this side wins (a removal loses against an edit)
    if (v !== undefined) out.set(k, v);
  }
  return out;
}

/** Drops assignments whose tag/participant no longer exists. */
export function clean(records) {
  const labels = new Set();
  for (const k of records.keys()) if (k.startsWith('L:')) labels.add(k.slice(2));
  for (const k of [...records.keys()]) {
    if (k.startsWith('A:') && !labels.has(k.slice(k.lastIndexOf('\t') + 1))) records.delete(k);
  }
  return records;
}

export async function parseDoc(bytes) {
  const gz = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  const text = new TextDecoder().decode(gz ? await cr.gunzip(bytes) : bytes);
  const json = JSON.parse(text);
  if ((json.v || 0) > 2) throw new Error('The library was saved by a newer version of the app: reload this page.');
  const out = new Map();
  for (const [k, v] of Object.entries(json.records || {})) out.set(k, JSON.stringify(v));
  return out;
}

export async function serializeDoc(records) {
  const r = {};
  for (const k of [...records.keys()].sort()) r[k] = JSON.parse(records.get(k));
  const json = JSON.stringify({ v: 2, updated: Date.now(), records: r });
  return cr.gzip(new TextEncoder().encode(json));
}

export const newUid = () => {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
};

export function typeOf(mime, animated) {
  if (mime.startsWith('video/') || mime === HLS || mime === DASH) return 'video';
  if (mime === 'image/gif' || animated) return 'gif';
  return 'picture';
}

export class Library {
  constructor() {
    this.folder = null;
    this.encrypted = false;
    this.key = null; // CryptoKey, when the folder is password-protected
    this.docId = null;
    this.version = null;
    this.base = new Map(); // the library as last read from / written to Drive
    this.records = new Map(); // this browser's copy, with its edits
    this.dirty = false;
    this.saving = null;
    this.listeners = new Set();
    this.status = '';
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) fn();
  }

  setStatus(s) {
    this.status = s;
    this.emit();
  }

  // ---- Folder and password ----

  async openFolder() {
    this.folder = await drive.findByName(FOLDER, null, true);
    if (!this.folder) {
      throw new Error('No "Media Manager" folder in this Drive. Set up Cloud storage in the phone app, then sign in here with the same Google account.');
    }
    const vaultId = await drive.findByName(VAULT, this.folder);
    if (!vaultId) throw new Error('The Media Manager folder isn\'t set up yet: finish Cloud storage setup in the phone app.');
    this.vault = JSON.parse(new TextDecoder().decode(await drive.download(vaultId)));
    this.encrypted = !!this.vault.encrypted;
  }

  savedKeyName() {
    return `mm.key.${this.folder}`;
  }

  /** Uses the key remembered in this browser, if any. */
  async useSavedKey() {
    const saved = localStorage.getItem(this.savedKeyName());
    if (!saved) return false;
    const raw = cr.unb64(saved);
    if (!(await this.checkKey(raw))) {
      localStorage.removeItem(this.savedKeyName());
      return false;
    }
    await this.setKey(raw);
    return true;
  }

  async checkKey(raw) {
    try {
      const k = await cr.importKey(raw);
      const plain = await cr.openBlob(k, cr.unb64(this.vault.check));
      return new TextDecoder().decode(plain) === CHECK;
    } catch {
      return false;
    }
  }

  async setKey(raw) {
    this.key = await cr.importKey(raw);
    await kvSet('key', cr.b64(raw)); // for the video streaming worker
  }

  async unlock(password) {
    const raw = await cr.deriveKey(password, cr.unb64(this.vault.salt), this.vault.iterations);
    if (!(await this.checkKey(raw))) return false;
    localStorage.setItem(this.savedKeyName(), cr.b64(raw));
    await this.setKey(raw);
    return true;
  }

  forgetKey() {
    if (this.folder) localStorage.removeItem(this.savedKeyName());
    this.key = null;
    return kvSet('key', undefined);
  }

  async protect(bytes) {
    return this.encrypted ? cr.sealBlob(this.key, bytes) : bytes;
  }

  async unprotect(bytes) {
    return this.encrypted ? cr.openBlob(this.key, bytes) : bytes;
  }

  get libraryName() {
    return this.encrypted ? 'library.mmv' : 'library.json';
  }

  // ---- Loading and saving ----

  async load() {
    this.docId = await drive.findByName(this.libraryName, this.folder);
    if (!this.docId) {
      throw new Error('No library in Drive yet. Open the phone app once: it saves the library there automatically.');
    }
    this.version = await drive.version(this.docId);
    this.base = await parseDoc(await this.unprotect(await drive.download(this.docId)));
    this.records = new Map(this.base);
    this.derive();
    this.emit();
  }

  /** Picks up changes from other devices (if nothing is waiting to be saved here, else saving merges). */
  async refresh() {
    if (this.dirty || this.saving || !this.docId) return;
    const v = await drive.version(this.docId);
    if (v === this.version || v == null) return;
    const remote = await parseDoc(await this.unprotect(await drive.download(this.docId)));
    if (this.dirty || this.saving) return; // edited meanwhile: the next save merges
    this.base = remote;
    this.records = new Map(remote);
    this.version = v;
    this.derive();
    this.emit();
  }

  change(fn) {
    fn();
    this.dirty = true;
    this.derive();
    this.emit();
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save().catch((e) => this.setStatus(`Couldn't save: ${e.message}`)), 1500);
  }

  async save() {
    if (this.saving) {
      await this.saving;
      return this.save();
    }
    if (!this.dirty) return;
    this.saving = (async () => {
      this.dirty = false;
      this.setStatus('Saving…');
      try {
        const snapshot = new Map(this.records);
        let remote = this.base;
        const v = await drive.version(this.docId);
        if (v !== this.version) remote = await parseDoc(await this.unprotect(await drive.download(this.docId)));
        const merged = clean(merge(snapshot, remote, this.base));
        if (!sameMap(merged, remote)) {
          this.version = await drive.putContent(this.docId, await this.protect(await serializeDoc(merged)), 'application/octet-stream');
        } else {
          this.version = v;
        }
        this.base = merged;
        // Edits made while saving stay on top of what was saved.
        this.records = clean(merge(this.records, merged, snapshot));
        this.derive();
        this.setStatus('');
      } catch (e) {
        this.dirty = true;
        throw e;
      } finally {
        this.saving = null;
      }
    })();
    return this.saving;
  }

  // ---- Model ----

  derive() {
    const labels = new Map();
    const assign = new Map();
    const covers = new Map();
    const files = new Map();
    const web = new Map();
    const scenes = new Map();
    const anim = new Map();
    for (const [k, v] of this.records) {
      const id = k.slice(2);
      switch (k.slice(0, 2)) {
        case 'L:': {
          const o = JSON.parse(v);
          labels.set(id, { uid: id, kind: o.k, name: o.n, thumb: o.t || null, about: o.x || null });
          break;
        }
        case 'A:': {
          const tab = id.lastIndexOf('\t');
          const key = id.slice(0, tab);
          if (!assign.has(key)) assign.set(key, new Set());
          assign.get(key).add(id.slice(tab + 1));
          break;
        }
        case 'C:': {
          const o = JSON.parse(v);
          covers.set(id, { pos: o.p, thumb: o.t || null });
          break;
        }
        case 'D:':
          files.set(id, JSON.parse(v));
          break;
        case 'W:':
          web.set(id, JSON.parse(v));
          break;
        case 'S:': {
          const o = JSON.parse(v);
          scenes.set(id, { uid: id, name: o.n, keys: o.k || [], people: o.p || {}, thumb: o.t || null });
          break;
        }
        case 'X:':
          anim.set(id, JSON.parse(v)[1] === 1);
          break;
      }
    }
    const items = [];
    for (const [key, f] of files) {
      const animated = anim.get(key) === true;
      items.push({
        key, name: f.n, mime: f.m, size: f.s, modified: f.d, fileId: f.f, encrypted: !!f.e,
        thumb: covers.get(key)?.thumb || f.t || null, web: null, animated, type: typeOf(f.m, animated),
      });
    }
    for (const [key, w] of web) {
      if (files.has(key)) continue;
      const animated = anim.get(key) === true;
      items.push({
        key, name: w.n, mime: w.m, size: 0, modified: w.a, fileId: null, encrypted: false,
        thumb: covers.get(key)?.thumb || w.t || null, web: { page: w.p || null }, animated, type: typeOf(w.m, animated),
      });
    }
    items.sort((a, b) => b.modified - a.modified);
    const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    this.labels = [...labels.values()].sort(byName);
    this.labelById = labels;
    this.assign = assign;
    this.items = items;
    this.itemByKey = new Map(items.map((i) => [i.key, i]));
    this.scenes = [...scenes.values()].sort(byName);
    this.sceneById = scenes;
  }

  labelsOf(kind) {
    return this.labels.filter((l) => l.kind === kind);
  }

  labelsFor(item, kind) {
    const ids = this.assign.get(item.key);
    return ids ? this.labels.filter((l) => l.kind === kind && ids.has(l.uid)) : [];
  }

  itemsFor(uid) {
    return this.items.filter((i) => this.assign.get(i.key)?.has(uid));
  }

  sceneItems(scene) {
    return scene.keys.map((k) => this.itemByKey.get(k)).filter(Boolean);
  }

  /** Participants: from the scene's files, plus the ones added by hand, minus the ones removed. */
  sceneParticipants(scene) {
    const derived = new Set();
    for (const k of scene.keys) for (const uid of this.assign.get(k) || []) derived.add(uid);
    return this.labelsOf('PERSON').filter((l) => (l.uid in scene.people ? scene.people[l.uid] : derived.has(l.uid)));
  }

  defaultSceneName(items) {
    const ids = new Set(items.flatMap((i) => [...(this.assign.get(i.key) || [])]));
    const people = this.labelsOf('PERSON').filter((l) => ids.has(l.uid)).map((l) => l.name).join(', ');
    const tags = this.labelsOf('TAG').filter((l) => ids.has(l.uid)).map((l) => l.name).join(', ');
    if (people && tags) return `${people} - ${tags}`;
    return people || tags || `Scene ${this.scenes.length + 1}`;
  }

  // ---- Edits (values are built in the same field order as the phone) ----

  labelValue(kind, name, thumb, about) {
    const o = { k: kind, n: name };
    if (thumb) o.t = thumb;
    // A tag's description (set on the phone, used there for tag suggestions): kept as it is.
    if (about) o.x = about;
    return JSON.stringify(o);
  }

  sceneValue(name, keys, people, thumb) {
    const p = {};
    for (const uid of Object.keys(people).sort()) p[uid] = people[uid];
    const o = { n: name, k: keys, p };
    if (thumb) o.t = thumb;
    return JSON.stringify(o);
  }

  createLabel(kind, name) {
    name = name.trim();
    const existing = this.labels.find((l) => l.kind === kind && l.name.toLowerCase() === name.toLowerCase());
    if (existing) return existing.uid;
    const uid = newUid();
    this.change(() => this.records.set(`L:${uid}`, this.labelValue(kind, name)));
    return uid;
  }

  renameLabel(uid, name) {
    const l = this.labelById.get(uid);
    name = name.trim();
    if (!l || !name) return;
    if (this.labels.some((o) => o.uid !== uid && o.kind === l.kind && o.name.toLowerCase() === name.toLowerCase())) {
      throw new Error(`There is already a ${l.kind === 'PERSON' ? 'participant' : 'tag'} called "${name}"`);
    }
    this.change(() => this.records.set(`L:${uid}`, this.labelValue(l.kind, name, l.thumb, l.about)));
  }

  deleteLabel(uid) {
    this.change(() => {
      this.records.delete(`L:${uid}`);
      for (const k of [...this.records.keys()]) if (k.startsWith('A:') && k.endsWith(`\t${uid}`)) this.records.delete(k);
      for (const s of this.scenes) {
        if (uid in s.people) {
          const people = { ...s.people };
          delete people[uid];
          this.records.set(`S:${s.uid}`, this.sceneValue(s.name, s.keys, people, s.thumb));
        }
      }
    });
  }

  setAssigned(items, uid, on) {
    this.change(() => {
      for (const i of items) {
        if (on) this.records.set(`A:${i.key}\t${uid}`, '1');
        else this.records.delete(`A:${i.key}\t${uid}`);
      }
    });
  }

  createScene(name, items) {
    const uid = newUid();
    const n = name.trim() || this.defaultSceneName(items);
    this.change(() => this.records.set(`S:${uid}`, this.sceneValue(n, [...new Set(items.map((i) => i.key))], {})));
    return uid;
  }

  updateScene(uid, fn) {
    const s = this.sceneById.get(uid);
    if (!s) return;
    const next = fn({ name: s.name, keys: [...s.keys], people: { ...s.people }, thumb: s.thumb });
    this.change(() => this.records.set(`S:${uid}`, this.sceneValue(next.name, next.keys, next.people, next.thumb)));
  }

  /** Adds files at the end of the scene. Returns how many were new to it. */
  addToScene(uid, items) {
    const s = this.sceneById.get(uid);
    const fresh = items.filter((i) => !s.keys.includes(i.key));
    if (fresh.length) this.updateScene(uid, (x) => ({ ...x, keys: [...x.keys, ...fresh.map((i) => i.key)] }));
    return fresh.length;
  }

  removeFromScene(uid, items) {
    const drop = new Set(items.map((i) => i.key));
    this.updateScene(uid, (x) => ({ ...x, keys: x.keys.filter((k) => !drop.has(k)) }));
  }

  renameScene(uid, name) {
    if (name.trim()) this.updateScene(uid, (x) => ({ ...x, name: name.trim() }));
  }

  deleteScene(uid) {
    this.change(() => this.records.delete(`S:${uid}`));
  }

  /** A file uploaded from this browser (same record as the phone writes after an upload). */
  addUploaded(f) {
    const o = { f: f.fileId, n: f.name, m: f.mime, s: f.size, d: f.modified, e: f.encrypted };
    if (f.thumbId) o.t = f.thumbId;
    this.change(() => {
      this.records.set(`D:${f.key}`, JSON.stringify(o));
      if (f.animated != null) this.records.set(`X:${f.key}`, JSON.stringify([f.modified, f.animated ? 1 : 0]));
    });
  }
}

function sameMap(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}
