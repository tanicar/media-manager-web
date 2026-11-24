// Media Manager for the browser: the same library as the phone app, read from and saved to the
// same Google Drive folder.

import * as drive from './drive.js';
import { Library, HLS, DASH } from './library.js';
import * as media from './media.js';
import { durationMs } from './anim.js';
import { uploadFile, isMedia } from './upload.js';
import { addFromLink, extractUrl } from './links.js';

const lib = new Library();
const CLIENT_KEY = 'mm.clientId';
const $app = document.getElementById('app');
const $modal = document.getElementById('modal');

const ui = {
  stage: 'boot', // boot | setup | signin | busy | password | main | error
  message: '',
  error: '',
  authLost: false,
  nav: [{ view: 'home', tab: 'files' }],
  modal: null,
};

// ---------------------------------------------------------------------------------------------
// DOM helper

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  add(el, children);
  return el;
}

function add(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

const plural = (n, noun) => (n === 1 ? `1 ${noun}` : `${n} ${noun}s`);
const countText = (n) => plural(n, 'file');
const display = (l) => (l.kind === 'TAG' ? `#${l.name}` : l.name);
const store = {
  get: (k, d) => {
    try {
      const v = localStorage.getItem(`mm.${k}`);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set: (k, v) => localStorage.setItem(`mm.${k}`, JSON.stringify(v)),
};

// ---------------------------------------------------------------------------------------------
// Errors and sign-in

function failed(e) {
  if (e instanceof drive.AuthError) {
    ui.authLost = true;
    render();
    return;
  }
  console.error(e);
  toast(e.message || String(e));
}

function guard(fn) {
  return (...args) => {
    try {
      const r = fn(...args);
      if (r && typeof r.catch === 'function') r.catch(failed);
    } catch (e) {
      failed(e);
    }
  };
}

function toast(text) {
  const t = h('div', { class: 'toast' }, text);
  document.body.append(t);
  setTimeout(() => t.classList.add('show'));
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 400);
  }, 3500);
}

async function signInAgain() {
  await drive.signIn('');
  ui.authLost = false;
  render();
  lib.refresh().catch(failed);
  if (up.queue.length && !up.running) runUploads();
}

// ---------------------------------------------------------------------------------------------
// Start-up

async function boot() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('No video streaming worker', e));
  }
  const clientId = localStorage.getItem(CLIENT_KEY) || window.MM_CLIENT_ID || '';
  if (!clientId) {
    ui.stage = 'setup';
    render();
    return;
  }
  await gisReady();
  drive.initAuth(clientId);
  ui.stage = 'signin';
  render();
}

function gisReady() {
  return new Promise((resolve) => {
    const check = () => (window.google?.accounts?.oauth2 ? resolve() : setTimeout(check, 50));
    check();
  });
}

async function connect() {
  ui.stage = 'busy';
  ui.message = 'Opening your Drive folder…';
  render();
  try {
    await lib.openFolder();
    if (lib.encrypted && !(await lib.useSavedKey())) {
      ui.stage = 'password';
      render();
      return;
    }
    await loadLibrary();
  } catch (e) {
    showError(e);
  }
}

async function loadLibrary() {
  ui.stage = 'busy';
  ui.message = 'Loading your library…';
  render();
  try {
    await lib.load();
    localStorage.setItem('mm.signedInBefore', '1');
    ui.stage = 'main';
    render();
  } catch (e) {
    showError(e);
  }
}

function showError(e) {
  if (e instanceof drive.AuthError) {
    ui.stage = 'signin';
  } else {
    ui.stage = 'error';
    ui.error = e.message || String(e);
  }
  render();
}

// Changes from the phone show up within a minute, and as soon as the page is visible again.
setInterval(() => ui.stage === 'main' && !document.hidden && lib.refresh().catch(failed), 60_000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && ui.stage === 'main') lib.refresh().catch(failed);
});
window.addEventListener('beforeunload', (e) => {
  if (up.running) e.preventDefault();
  if (lib.dirty || lib.saving) {
    lib.save().catch(() => {});
    e.preventDefault();
  }
});
lib.onChange(() => ui.stage === 'main' && render());

// ---------------------------------------------------------------------------------------------
// Navigation (the browser's back button and Esc go back too)

function push(entry) {
  ui.nav.push(entry);
  history.pushState({ depth: ui.nav.length }, '');
  render();
}

function back() {
  if (ui.nav.length > 1) history.back();
}

window.addEventListener('popstate', () => {
  if (ui.modal) {
    ui.modal = null;
    renderModal();
    history.pushState({ depth: ui.nav.length }, '');
    return;
  }
  if (ui.nav.length > 1) {
    const gone = ui.nav.pop();
    gone.ctl?.close?.();
    render();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (ui.modal) closeModal();
  else back();
});

function openModal(m) {
  ui.modal = m;
  renderModal();
}

function closeModal() {
  ui.modal = null;
  renderModal();
}

// ---------------------------------------------------------------------------------------------
// Rendering

function render() {
  const top = ui.nav[ui.nav.length - 1];
  if (ui.stage !== 'main') {
    $app.replaceChildren(stageScreen());
    renderModal();
    return;
  }
  if (top.ctl) {
    // Viewer and live scene keep their own content (a video keeps playing); just refresh details.
    if ($app.firstChild !== top.ctl.el) $app.replaceChildren(top.ctl.el);
    top.ctl.update?.();
    renderModal();
    return;
  }
  const old = $app.querySelector('.scroll');
  if (old) ui.nav[ui.nav.length - 1].scroll = old.scrollTop;
  let screen;
  if (top.view === 'home') screen = homeScreen(top);
  else if (top.view === 'list') screen = listScreen(top);
  else if (top.view === 'scene') screen = sceneScreen(top);
  else if (top.view === 'viewer') screen = (top.ctl = viewer(top)).el;
  else if (top.view === 'live') screen = (top.ctl = livePlayer(top)).el;
  $app.replaceChildren(screen, ui.authLost ? authBanner() : '', lib.status ? h('div', { class: 'status-pill' }, lib.status) : '');
  const sc = $app.querySelector('.scroll');
  if (sc && top.scroll) sc.scrollTop = top.scroll;
  renderModal();
}

function authBanner() {
  return h('div', { class: 'banner' },
    'Your Google session has expired.',
    h('button', { class: 'btn', onclick: guard(signInAgain) }, 'Sign in again'));
}

function stageScreen() {
  const box = (...c) => h('div', { class: 'center' }, h('div', { class: 'card setup' }, h('div', { class: 'logo' }, '▶'), h('h1', { class: 'gradient' }, 'Media Manager'), ...c));
  switch (ui.stage) {
    case 'boot':
      return box(h('p', { class: 'muted' }, 'Starting…'));
    case 'busy':
      return box(h('div', { class: 'spinner' }), h('p', { class: 'muted' }, ui.message));
    case 'setup': {
      const input = h('input', { class: 'field', placeholder: '1234567890-abc….apps.googleusercontent.com' });
      return box(
        h('p', {}, 'One-time setup: paste the Web client ID from your Google Cloud project (the same project as the phone app).'),
        h('p', { class: 'muted small' }, 'Google Cloud console → APIs & Services → Credentials → Create credentials → OAuth client ID → Web application, with this page\'s address (', location.origin, ') as an authorized JavaScript origin.'),
        input,
        h('button', {
          class: 'btn primary',
          onclick: () => {
            const v = input.value.trim();
            if (!v) return;
            localStorage.setItem(CLIENT_KEY, v);
            boot().catch(showError);
          },
        }, 'Save'),
      );
    }
    case 'signin':
      return box(
        h('p', { class: 'muted' }, 'Your files, tags, participants and scenes, from the same Google Drive as the phone app.'),
        h('button', {
          class: 'btn primary big',
          onclick: async () => {
            try {
              await drive.signIn(localStorage.getItem('mm.signedInBefore') ? '' : 'consent');
              await connect();
            } catch (e) {
              showError(e);
            }
          },
        }, localStorage.getItem('mm.signedInBefore') ? 'Continue with Google' : 'Sign in with Google'),
      );
    case 'password': {
      const input = h('input', { class: 'field', type: 'password', placeholder: 'Cloud password', autofocus: true });
      const msg = h('p', { class: 'error' });
      const go = async () => {
        msg.textContent = 'Checking…';
        if (await lib.unlock(input.value)) await loadLibrary();
        else msg.textContent = 'Wrong password.';
      };
      input.addEventListener('keydown', (e) => e.key === 'Enter' && go());
      setTimeout(() => input.focus());
      return box(
        h('p', {}, 'Your Media Manager folder is password-protected. Enter the password once on this browser.'),
        input,
        h('button', { class: 'btn primary', onclick: go }, 'Unlock'),
        msg,
      );
    }
    case 'error':
      return box(
        h('p', { class: 'error' }, ui.error),
        h('button', { class: 'btn primary', onclick: () => connect() }, 'Try again'),
      );
    default:
      return box();
  }
}

// ---------------------------------------------------------------------------------------------
// Pictures

const observer = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    observer.unobserve(e.target);
    const img = e.target;
    const id = img.dataset.thumb;
    if (id) {
      media.thumbUrl(lib, id).then((url) => {
        if (url) img.src = url;
        else img.classList.add('none');
      }).catch(failed);
    }
  }
}, { rootMargin: '400px' });

/** <img> for a file's thumbnail (or a label's), loaded when it scrolls into view. */
function thumbImg(thumbId, fallbackUrl, cls = '') {
  const img = h('img', { class: `thumb ${cls}`, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
  img.addEventListener('error', () => img.classList.add('none'));
  if (thumbId) {
    img.dataset.thumb = thumbId;
    observer.observe(img);
  } else if (fallbackUrl) {
    img.src = fallbackUrl;
  } else {
    img.classList.add('none');
  }
  return img;
}

const itemThumb = (item, cls) => thumbImg(item.thumb, item.web && item.type !== 'video' ? item.key : null, cls);

function labelThumb(label, cls) {
  if (label.thumb) return thumbImg(label.thumb, null, cls);
  const first = lib.itemsFor(label.uid)[0];
  return first ? itemThumb(first, cls) : thumbImg(null, null, cls);
}

function sceneThumb(scene, cls) {
  if (scene.thumb) return thumbImg(scene.thumb, null, cls);
  const first = lib.sceneItems(scene)[0];
  return first ? itemThumb(first, cls) : thumbImg(null, null, cls);
}

// ---------------------------------------------------------------------------------------------
// Home

const TABS = [
  ['files', 'Files'],
  ['tags', 'Tags'],
  ['people', 'Participants'],
  ['scenes', 'Scenes'],
];

function homeScreen(top) {
  const tab = top.tab;
  const subtitle = {
    files: countText(lib.items.length),
    tags: plural(lib.labelsOf('TAG').length, 'tag'),
    people: plural(lib.labelsOf('PERSON').length, 'participant'),
    scenes: plural(lib.scenes.length, 'scene'),
  }[tab];
  const search = tab !== 'files'
    ? h('input', {
      class: 'search',
      placeholder: `Search ${tab === 'people' ? 'participants' : tab}`,
      value: top.query || '',
      oninput: (e) => {
        top.query = e.target.value;
        const pos = e.target.selectionStart;
        render();
        const s = $app.querySelector('.search');
        s.focus();
        s.setSelectionRange(pos, pos);
      },
    })
    : null;
  let content;
  if (tab === 'files') content = filesTab();
  else if (tab === 'tags') content = labelsTab('TAG', top.query || '');
  else if (tab === 'people') content = labelsTab('PERSON', top.query || '');
  else content = scenesTab(top.query || '');

  return h('div', { class: 'screen' },
    h('header', { class: 'top' },
      h('div', { class: 'grow' }, h('div', { class: 'title gradient' }, 'Media Manager'), h('div', { class: 'muted small' }, subtitle)),
      search,
      tab === 'scenes' ? h('button', { class: 'btn primary', onclick: () => openLiveDialog() }, '▶ Live scene') : null,
      tab === 'files' ? h('button', { class: 'btn', onclick: () => openLinkDialog('') }, '🔗 Add link') : null,
      tab === 'files' ? h('button', { class: 'btn primary', onclick: chooseUpload }, '⬆ Upload') : null,
      tab === 'tags' || tab === 'people'
        ? h('button', { class: 'btn', onclick: () => newLabel(tab === 'people' ? 'PERSON' : 'TAG') }, '+ New')
        : null,
      menuButton()),
    h('nav', { class: 'tabs' },
      TABS.map(([id, title]) => h('button', {
        class: `tab ${id === tab ? 'on' : ''}`,
        onclick: () => {
          top.tab = id;
          top.query = '';
          top.scroll = 0;
          render();
        },
      }, title))),
    h('main', { class: 'scroll' }, content));
}

function menuButton() {
  return h('button', {
    class: 'btn icon',
    title: 'Menu',
    onclick: () => openModal({
      title: 'Menu',
      body: () => h('div', { class: 'menu' },
        h('button', { class: 'btn wide', onclick: () => { closeModal(); lib.refresh().then(() => toast('Library up to date'), failed); } }, 'Reload library'),
        lib.encrypted ? h('button', {
          class: 'btn wide',
          onclick: async () => {
            closeModal();
            await lib.forgetKey();
            await media.clearCaches();
            location.reload();
          },
        }, 'Lock (forget the password on this browser)') : null,
        h('button', {
          class: 'btn wide',
          onclick: async () => {
            closeModal();
            await drive.signOut();
            location.reload();
          },
        }, 'Sign out'),
        h('button', {
          class: 'btn wide subtle',
          onclick: () => {
            if (!confirm('Change the Google client ID used by this page?')) return;
            localStorage.removeItem(CLIENT_KEY);
            location.reload();
          },
        }, 'Change Google client ID')),
    }),
  }, '⋮');
}

function filesTab() {
  const types = [['video', 'Videos', 'g-videos'], ['gif', 'GIFs', 'g-gifs'], ['picture', 'Pictures', 'g-pictures']];
  return h('div', {}, h('div', { class: 'types' },
    types.map(([type, title, cls]) => h('button', {
      class: `type-card ${cls}`,
      onclick: () => push({ view: 'list', source: { type, title } }),
    }, h('div', { class: 'type-icon' }, type === 'video' ? '▶' : type === 'gif' ? 'GIF' : '▣'),
    h('div', {}, h('div', { class: 'type-title' }, title), h('div', { class: 'small' }, countText(lib.items.filter((i) => i.type === type).length)))))),
  h('p', { class: 'muted small drop-hint' }, 'Drop pictures, videos or whole folders anywhere on this page (or use ⬆ Upload) to add them to your Drive. To add something that stays on its website, use 🔗 Add link or just paste the link here (Ctrl+V).'));
}

// ---------------------------------------------------------------------------------------------
// Uploading from this computer

const up = { people: new Map(), queue: [], total: 0, done: 0, current: null, fraction: 0, keys: [], failed: [], running: false, open: false };
const $uploads = h('div', { id: 'uploads' });
document.body.append($uploads);

function chooseUpload() {
  openModal({
    title: 'Upload',
    body: () => h('div', { class: 'menu' },
      h('button', { class: 'btn wide', onclick: () => { closeModal(); pickFiles(false); } }, '🖼  Pictures and videos'),
      h('button', { class: 'btn wide', onclick: () => { closeModal(); pickFiles(true); } }, '📁  A folder'),
      h('p', { class: 'muted small' },
        'With a folder, each folder inside it becomes a participant: everything in Folder → Anna → … gets the participant “Anna” (a new one is added if needed). A folder named “Anna, Ben” gives both. Files directly in the chosen folder get no participant. You can also drop folders onto the page.')),
    actions: () => [h('button', { class: 'btn', onclick: closeModal }, 'Cancel')],
  });
}

function pickFiles(folder) {
  const input = h('input', { type: 'file', multiple: true, accept: folder ? null : 'image/*,video/*' });
  if (folder) input.webkitdirectory = true;
  input.addEventListener('change', () => startUploads([...input.files].map((file) => ({ file, path: file.webkitRelativePath || file.name }))));
  input.click();
}

/**
 * The participants for a file picked or dropped with its folder: the name of the folder just inside
 * the chosen one ("Folder1/Person1/…/media1" → Person1), split at commas ("Person1, Person2" → both).
 * None for files directly in the chosen folder.
 */
function peopleFromPath(path) {
  const parts = path.split('/').filter(Boolean);
  if (parts.length < 3) return [];
  return [...new Set(parts[1].split(',').map((n) => n.trim()).filter(Boolean))];
}

/** Everything in a dropped item: a file, or a whole folder read recursively, with their paths. */
async function droppedFiles(dataTransfer) {
  const entries = [...(dataTransfer.items || [])].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...dataTransfer.files].map((file) => ({ file, path: file.name }));
  const out = [];
  const walk = async (entry) => {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      out.push({ file, path: entry.fullPath.replace(/^\//, '') });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        // readEntries returns at most ~100 entries per call.
        const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const e of batch) await walk(e);
      }
    }
  };
  for (const e of entries) await walk(e);
  return out;
}

function startUploads(picked) {
  const files = picked.filter((p) => isMedia(p.file) && !p.file.name.startsWith('.'))
    .map((p) => ({ file: p.file, people: peopleFromPath(p.path) }));
  const skipped = picked.filter((p) => !p.file.name.startsWith('.')).length - files.length;
  if (!files.length) {
    toast('Only pictures and videos can be added');
    return;
  }
  if (skipped > 0) toast(`${plural(skipped, 'file')} skipped (not pictures or videos)`);
  if (!up.running && !up.queue.length) Object.assign(up, { total: 0, done: 0, keys: [], failed: [], people: new Map() });
  up.queue.push(...files);
  up.total += files.length;
  up.open = true;
  renderUploads();
  if (!up.running) runUploads();
}

async function runUploads() {
  up.running = true;
  while (up.queue.length) {
    const { file, people } = up.queue[0];
    up.current = file.name;
    up.fraction = 0;
    renderUploads();
    try {
      const key = await uploadFile(lib, file, (x) => {
        up.fraction = x;
        renderUploads();
      });
      up.keys.push(key);
      for (const person of people) {
        const uid = lib.createLabel('PERSON', person);
        lib.setAssigned([{ key }], uid, true);
        const name = lib.labelById.get(uid)?.name || person;
        up.people.set(name, (up.people.get(name) || 0) + 1);
      }
    } catch (e) {
      if (e instanceof drive.AuthError) {
        // Continues after signing in again.
        up.running = false;
        failed(e);
        renderUploads();
        return;
      }
      up.failed.push(`${file.name}: ${e.message || e}`);
    }
    up.queue.shift();
    up.done++;
  }
  up.running = false;
  up.current = null;
  renderUploads();
}

function renderUploads() {
  if (!up.open || ui.stage !== 'main') {
    $uploads.replaceChildren();
    return;
  }
  const items = up.keys.map((k) => lib.itemByKey.get(k)).filter(Boolean);
  const pct = Math.round(up.fraction * 100);
  $uploads.replaceChildren(h('div', { class: 'upload-panel' },
    up.running || up.queue.length
      ? [
        h('div', {}, up.running ? `Uploading ${up.done + 1} of ${up.total} · ${pct}%` : `Paused · ${up.queue.length} left: sign in again to continue`),
        h('div', { class: 'muted small ellipsis' }, up.current || ''),
        h('div', { class: 'bar' }, h('div', { style: { width: `${pct}%` } })),
      ]
      : [
        h('div', {}, `${plural(up.keys.length, 'file')} uploaded`),
        up.people?.size ? h('div', { class: 'muted small' }, 'Participants: ', [...up.people].map(([n, c]) => `${n} (${c})`).join(', ')) : null,
        up.failed.map((f) => h('div', { class: 'error small' }, f)),
        h('div', { class: 'row' },
          items.length ? h('button', { class: 'btn primary', onclick: () => openEditData(items) }, 'Edit data') : null,
          h('button', { class: 'btn', onclick: () => { up.open = false; renderUploads(); } }, 'Close')),
      ]));
}

// Drag and drop anywhere.
document.addEventListener('dragover', (e) => {
  if (ui.stage === 'main' && e.dataTransfer?.types?.includes('Files')) e.preventDefault();
});
document.addEventListener('drop', (e) => {
  if (ui.stage !== 'main' || !(e.dataTransfer?.files?.length || e.dataTransfer?.items?.length)) return;
  e.preventDefault();
  droppedFiles(e.dataTransfer).then(startUploads, failed);
});

// ---------------------------------------------------------------------------------------------
// Adding from a link (the file stays on its website, like the phone's "Add from a link")

function openLinkDialog(initial) {
  const state = { text: initial, busy: false, step: '', error: '' };
  const add = async () => {
    if (state.busy || !state.text.trim()) return;
    Object.assign(state, { busy: true, error: '', step: 'Looking at the link…' });
    renderModal();
    try {
      const { key, existed } = await addFromLink(lib, state.text, (step) => { state.step = step; renderModal(); });
      closeModal();
      const item = lib.itemByKey.get(key);
      if (existed) toast('That link is already in your library');
      if (item) push({ view: 'viewer', list: [item], index: 0 });
    } catch (e) {
      if (e instanceof drive.AuthError) {
        state.busy = false;
        closeModal();
        failed(e);
        return;
      }
      Object.assign(state, { busy: false, error: e.message || String(e) });
      renderModal();
    }
  };
  openModal({
    title: 'Add from a link',
    body: () => h('div', {},
      h('p', { class: 'muted small' }, 'Paste a link to a video, GIF or picture, or to a page that shows one (Reddit, Imgur…). It plays from the website and isn\'t uploaded to Drive.'),
      h('input', {
        class: 'field', placeholder: 'https://…', value: state.text, 'data-focus': 'link', disabled: state.busy,
        oninput: (e) => { state.text = e.target.value; state.error = ''; },
        onkeydown: (e) => e.key === 'Enter' && add(),
      }),
      state.busy ? h('div', { class: 'row', style: { marginTop: '12px' } }, h('div', { class: 'spinner', style: { width: '18px', height: '18px', borderWidth: '2px' } }), h('span', { class: 'muted' }, state.step)) : null,
      state.error ? h('p', { class: 'error small' }, state.error) : null),
    actions: () => [
      h('button', { class: 'btn', disabled: state.busy, onclick: closeModal }, 'Cancel'),
      h('button', { class: 'btn primary', disabled: state.busy, onclick: add }, 'Add'),
    ],
  });
  setTimeout(() => $modal.querySelector('[data-focus="link"]')?.focus());
  if (initial) add();
}

// Pasting a link anywhere on the main screens adds it.
document.addEventListener('paste', (e) => {
  if (ui.stage !== 'main' || ui.modal || /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
  const url = extractUrl(e.clipboardData?.getData('text') || '');
  if (!url) return;
  e.preventDefault();
  openLinkDialog(url);
});

function labelsTab(kind, query) {
  const all = lib.labelsOf(kind);
  const q = query.trim().toLowerCase();
  const labels = q ? all.filter((l) => l.name.toLowerCase().includes(q)) : all;
  if (!labels.length) {
    return h('p', { class: 'empty' }, all.length ? `Nothing matches “${query}”.` : `No ${kind === 'PERSON' ? 'participants' : 'tags'} yet.`);
  }
  return h('div', { class: kind === 'PERSON' ? 'people-grid' : 'card-grid' },
    labels.map((l) => {
      const n = lib.itemsFor(l.uid).length;
      const open = () => push({ view: 'list', source: { label: l.uid } });
      if (kind === 'PERSON') {
        return h('button', { class: 'person', onclick: open },
          h('div', { class: 'avatar' }, labelThumb(l), h('span', { class: 'initial' }, l.name.slice(0, 1).toUpperCase())),
          h('div', { class: 'name' }, l.name), h('div', { class: 'muted small' }, countText(n)));
      }
      return h('button', { class: 'pic-card', onclick: open }, labelThumb(l),
        h('div', { class: 'caption' }, h('div', { class: 'name' }, display(l)), h('div', { class: 'small' }, countText(n))));
    }));
}

function sceneCard(scene) {
  const people = lib.sceneParticipants(scene).map((p) => p.name).join(', ');
  return h('button', { class: 'pic-card', onclick: () => push({ view: 'scene', scene: scene.uid }) },
    sceneThumb(scene),
    h('div', { class: 'caption' }, h('div', { class: 'name' }, scene.name),
      h('div', { class: 'small' }, countText(lib.sceneItems(scene).length) + (people ? ` · ${people}` : ''))));
}

function scenesTab(query) {
  const q = query.trim().toLowerCase();
  const parts = new Map(lib.scenes.map((s) => [s.uid, lib.sceneParticipants(s)]));
  const scenes = lib.scenes.filter((s) => !q || s.name.toLowerCase().includes(q) || parts.get(s.uid).some((p) => p.name.toLowerCase().includes(q)));
  const grouped = store.get('groupScenes', false);
  const options = h('div', { class: 'row options' },
    h('label', { class: 'check' }, h('input', {
      type: 'checkbox', checked: grouped,
      onchange: (e) => { store.set('groupScenes', e.target.checked); render(); },
    }), 'Group by participant'));
  if (!scenes.length) {
    return h('div', {}, options, h('p', { class: 'empty' },
      lib.scenes.length ? `Nothing matches “${query}”.` : 'No scenes yet. In any list, select files and choose “Add to scene”.'));
  }
  if (!grouped) return h('div', {}, options, h('div', { class: 'card-grid' }, scenes.map(sceneCard)));
  const collapsed = new Set(store.get('collapsedLanes', []));
  const lanes = lib.labelsOf('PERSON')
    .map((p) => [p, scenes.filter((s) => parts.get(s.uid).some((x) => x.uid === p.uid))])
    .filter(([, list]) => list.length);
  const none = scenes.filter((s) => !parts.get(s.uid).length);
  if (none.length) lanes.push([null, none]);
  return h('div', {}, options, lanes.map(([p, list]) => {
    const id = p?.uid || '-';
    const open = !collapsed.has(id);
    return h('section', { class: 'lane' },
      h('button', {
        class: 'lane-head',
        onclick: () => {
          if (open) collapsed.add(id);
          else collapsed.delete(id);
          store.set('collapsedLanes', [...collapsed]);
          render();
        },
      }, h('span', { class: 'arrow' }, open ? '▾' : '▸'),
      p ? h('div', { class: 'avatar small' }, labelThumb(p), h('span', { class: 'initial' }, p.name.slice(0, 1).toUpperCase())) : null,
      h('span', { class: 'grow' }, p ? p.name : 'No participants'), h('span', { class: 'muted small' }, plural(list.length, 'scene'))),
      open ? h('div', { class: 'card-grid' }, list.map(sceneCard)) : null);
  }));
}

// ---------------------------------------------------------------------------------------------
// File lists (by type, by tag/participant, a scene)

function mediaGrid(items, top, onOpen) {
  top.selected ||= new Set();
  const selecting = top.selecting;
  return h('div', { class: 'media-grid' }, items.map((item, index) => {
    const on = top.selected.has(item.key);
    const people = lib.labelsFor(item, 'PERSON').length;
    const tile = h('button', {
      class: `tile ${on ? 'selected' : ''}`,
      title: item.name,
      onclick: () => {
        if (top.selecting) toggleSelect(top, item);
        else onOpen(index);
      },
      oncontextmenu: (e) => {
        e.preventDefault();
        top.selecting = true;
        toggleSelect(top, item);
      },
    }, itemThumb(item),
    h('div', { class: 'badges' },
      item.type === 'video' ? h('span', { class: 'badge' }, '▶') : null,
      item.type === 'gif' ? h('span', { class: 'badge' }, 'GIF') : null,
      item.web ? h('span', { class: 'badge' }, '🌐') : null,
      h('span', { class: 'grow' }),
      people ? h('span', { class: 'badge' }, `👤 ${people}`) : null),
    selecting ? h('span', { class: `tick ${on ? 'on' : ''}` }, on ? '✓' : '') : null);
    return tile;
  }));
}

function toggleSelect(top, item) {
  if (top.selected.has(item.key)) top.selected.delete(item.key);
  else top.selected.add(item.key);
  render();
}

function selectionBar(top, items, extra = []) {
  const chosen = items.filter((i) => top.selected.has(i.key));
  const all = chosen.length === items.length;
  return h('div', { class: 'selection-bar' },
    h('span', { class: 'grow' }, `${chosen.length} selected`),
    h('button', { class: 'btn', onclick: () => { top.selected = all ? new Set() : new Set(items.map((i) => i.key)); render(); } }, all ? 'None' : 'All'),
    h('button', { class: 'btn', disabled: !chosen.length, onclick: () => openEditData(chosen) }, 'Edit data'),
    h('button', { class: 'btn', disabled: !chosen.length, onclick: () => openAddToScene(chosen, () => { top.selecting = false; top.selected.clear(); render(); }) }, 'Add to scene'),
    extra.map((x) => x(chosen)),
    h('button', { class: 'btn', onclick: () => { top.selecting = false; top.selected.clear(); render(); } }, 'Done'));
}

function listScreen(top) {
  const src = top.source;
  const label = src.label ? lib.labelById.get(src.label) : null;
  if (src.label && !label) {
    setTimeout(back);
    return h('div');
  }
  const base = label ? lib.itemsFor(label.uid) : lib.items.filter((i) => i.type === src.type);
  top.selected ||= new Set();
  top.refine ||= new Set();
  top.without ||= new Set();
  const has = (item, kind) => lib.labelsFor(item, kind).length > 0;
  const items = base.filter((i) => {
    const ids = lib.assign.get(i.key) || new Set();
    return (!top.typeFilter || i.type === top.typeFilter) &&
      [...top.refine].every((uid) => ids.has(uid)) &&
      [...top.without].every((kind) => !has(i, kind));
  });

  // Filters: only what appears in this list, with how many files each has.
  const counts = new Map();
  for (const i of base) for (const uid of lib.assign.get(i.key) || []) counts.set(uid, (counts.get(uid) || 0) + 1);
  const rows = (label?.kind === 'PERSON' ? ['TAG', 'PERSON'] : ['PERSON', 'TAG']).map((kind) => {
    const options = lib.labelsOf(kind).filter((l) => l.uid !== label?.uid && (counts.get(l.uid) || top.refine.has(l.uid)));
    const noneCount = base.filter((i) => !has(i, kind)).length;
    if (!options.length && !noneCount) return null;
    return h('div', { class: 'filter-row' }, h('span', { class: 'filter-label' }, kind === 'PERSON' ? 'People' : 'Tags'),
      h('div', { class: 'chips' },
        noneCount || top.without.has(kind) ? chip(`${kind === 'PERSON' ? 'None' : 'Untagged'} · ${noneCount}`, top.without.has(kind), () => {
          if (top.without.has(kind)) top.without.delete(kind);
          else {
            top.without.add(kind);
            for (const uid of [...top.refine]) if (lib.labelById.get(uid)?.kind === kind) top.refine.delete(uid);
          }
          render();
        }) : null,
        options.map((l) => chip(`${display(l)} · ${counts.get(l.uid) || 0}`, top.refine.has(l.uid), () => {
          if (top.refine.has(l.uid)) top.refine.delete(l.uid);
          else top.refine.add(l.uid);
          top.without.delete(kind);
          render();
        }))));
  });
  const types = ['video', 'gif', 'picture'].filter((t) => base.some((i) => i.type === t));
  const typeRow = label && types.length > 1
    ? h('div', { class: 'filter-row' }, h('span', { class: 'filter-label' }, 'Type'), h('div', { class: 'chips' },
      types.map((t) => chip({ video: 'Videos', gif: 'GIFs', picture: 'Pictures' }[t], top.typeFilter === t, () => { top.typeFilter = top.typeFilter === t ? null : t; render(); }))))
    : null;
  const scenesRow = label?.kind === 'PERSON'
    ? (() => {
      const ss = lib.scenes.filter((s) => lib.sceneParticipants(s).some((p) => p.uid === label.uid));
      return ss.length ? h('div', { class: 'filter-row' }, h('span', { class: 'filter-label' }, 'Scenes'),
        h('div', { class: 'chips' }, ss.map((s) => chip(`◫ ${s.name}`, false, () => push({ view: 'scene', scene: s.uid }))))) : null;
    })()
    : null;
  const filtering = top.refine.size || top.without.size || top.typeFilter;

  return h('div', { class: 'screen' },
    h('header', { class: 'top' },
      h('button', { class: 'btn icon', onclick: back, title: 'Back' }, '←'),
      h('div', { class: 'grow' }, h('div', { class: 'title' }, label ? display(label) : src.title), h('div', { class: 'muted small' }, countText(items.length))),
      filtering ? h('button', { class: 'btn', onclick: () => { top.refine.clear(); top.without.clear(); top.typeFilter = null; render(); } }, 'Clear') : null,
      top.selecting ? null : h('button', { class: 'btn', onclick: () => { top.selecting = true; render(); } }, 'Select'),
      label ? h('button', { class: 'btn', onclick: () => renameLabel(label) }, 'Rename') : null,
      label ? h('button', { class: 'btn danger', onclick: () => deleteLabel(label) }, 'Delete') : null),
    top.selecting ? selectionBar(top, items) : null,
    h('main', { class: 'scroll' },
      scenesRow, rows, typeRow,
      items.length ? mediaGrid(items, top, (index) => push({ view: 'viewer', list: items, index }))
        : h('p', { class: 'empty' }, base.length ? 'Nothing matches these filters.' : 'No files here yet.')));
}

function chip(text, on, onclick) {
  return h('button', { class: `chip ${on ? 'on' : ''}`, onclick }, text);
}

function sceneScreen(top) {
  const scene = lib.sceneById.get(top.scene);
  if (!scene) {
    setTimeout(back);
    return h('div');
  }
  const items = lib.sceneItems(scene);
  const people = lib.sceneParticipants(scene);
  top.selected ||= new Set();
  return h('div', { class: 'screen' },
    h('header', { class: 'top' },
      h('button', { class: 'btn icon', onclick: back, title: 'Back' }, '←'),
      h('div', { class: 'grow' }, h('div', { class: 'title' }, scene.name), h('div', { class: 'muted small' }, `Scene · ${countText(items.length)}`)),
      top.selecting ? null : h('button', { class: 'btn', onclick: () => { top.selecting = true; render(); } }, 'Select'),
      h('button', {
        class: 'btn',
        onclick: () => askName('Rename scene', scene.name, 'Save', (name) => lib.renameScene(scene.uid, name)),
      }, 'Rename'),
      h('button', {
        class: 'btn danger',
        onclick: () => confirmBox(`Delete “${scene.name}”?`, 'Only the scene is deleted. Its files, tags and participants stay as they are.', 'Delete', () => {
          lib.deleteScene(scene.uid);
          back();
        }),
      }, 'Delete')),
    top.selecting ? selectionBar(top, items, [(chosen) => h('button', {
      class: 'btn', disabled: !chosen.length,
      onclick: () => { lib.removeFromScene(scene.uid, chosen); top.selected.clear(); toast(`Removed ${chosen.length} from the scene`); },
    }, 'Remove')]) : null,
    h('main', { class: 'scroll' },
      people.length ? h('div', { class: 'filter-row' }, h('span', { class: 'filter-label' }, 'People'),
        h('div', { class: 'chips' }, people.map((p) => chip(p.name, false, () => push({ view: 'list', source: { label: p.uid } }))))) : null,
      items.length ? mediaGrid(items, top, (index) => push({ view: 'viewer', list: items, index }))
        : h('p', { class: 'empty' }, 'No files in this scene yet.')));
}

// ---------------------------------------------------------------------------------------------
// Dialogs

function renderModal() {
  const m = ui.modal;
  if (!m) {
    $modal.replaceChildren();
    $modal.classList.remove('open');
    return;
  }
  const keep = $modal.querySelector('.modal-body')?.scrollTop;
  const focused = document.activeElement?.dataset?.focus;
  const pos = document.activeElement?.selectionStart;
  $modal.classList.add('open');
  $modal.replaceChildren(h('div', { class: 'backdrop', onclick: closeModal }),
    h('div', { class: `dialog ${m.wide ? 'wide' : ''}` },
      h('div', { class: 'dialog-title' }, m.title),
      h('div', { class: 'modal-body' }, m.body()),
      m.actions ? h('div', { class: 'dialog-actions' }, m.actions()) : null));
  if (keep) $modal.querySelector('.modal-body').scrollTop = keep;
  if (focused) {
    const el = $modal.querySelector(`[data-focus="${focused}"]`);
    el?.focus();
    if (pos != null) el?.setSelectionRange?.(pos, pos);
  }
}

function askName(title, initial, confirmText, onConfirm) {
  const input = h('input', { class: 'field', value: initial });
  const ok = () => {
    const v = input.value.trim();
    if (!v) return;
    try {
      onConfirm(v);
      closeModal();
    } catch (e) {
      failed(e);
    }
  };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && ok());
  openModal({
    title,
    body: () => input,
    actions: () => [h('button', { class: 'btn', onclick: closeModal }, 'Cancel'), h('button', { class: 'btn primary', onclick: ok }, confirmText)],
  });
  setTimeout(() => input.focus());
}

function confirmBox(title, text, confirmText, onConfirm) {
  openModal({
    title,
    body: () => h('p', {}, text),
    actions: () => [h('button', { class: 'btn', onclick: closeModal }, 'Cancel'),
      h('button', { class: 'btn danger', onclick: () => { closeModal(); onConfirm(); } }, confirmText)],
  });
}

function newLabel(kind) {
  askName(kind === 'PERSON' ? 'New participant' : 'New tag', '', 'Add', (name) => lib.createLabel(kind, name));
}

function renameLabel(label) {
  askName(`Rename ${label.kind === 'PERSON' ? 'participant' : 'tag'}`, label.name, 'Save', (name) => lib.renameLabel(label.uid, name));
}

function deleteLabel(label) {
  confirmBox(`Delete “${display(label)}”?`, 'It will be removed from every file. The files themselves aren\'t touched.', 'Delete', () => {
    lib.deleteLabel(label.uid);
    back();
  });
}

/** Participants and tags of one or more files: what's set first, then the rest. */
function openEditData(items) {
  const state = { query: '' };
  const count = (uid) => items.filter((i) => lib.assign.get(i.key)?.has(uid)).length;
  const initiallySet = new Set(lib.labels.filter((l) => count(l.uid) > 0).map((l) => l.uid));
  openModal({
    title: items.length === 1 ? 'Edit data' : `Edit data · ${items.length} files`,
    body: () => {
      const q = state.query.trim();
      const input = h('input', {
        class: 'field', placeholder: 'Search or add', value: state.query, 'data-focus': 'q',
        oninput: (e) => { state.query = e.target.value; renderModal(); },
      });
      const adders = q ? ['PERSON', 'TAG'].filter((kind) => !lib.labelsOf(kind).some((l) => l.name.toLowerCase() === q.toLowerCase()))
        .map((kind) => h('button', {
          class: 'btn link',
          onclick: () => {
            const uid = lib.createLabel(kind, q);
            lib.setAssigned(items, uid, true);
            state.query = '';
            renderModal();
          },
        }, kind === 'PERSON' ? `Add participant “${q}”` : `Add tag “${q}”`)) : [];
      const sections = [
        [items.length === 1 ? 'On this file' : 'On these files', [...lib.labelsOf('PERSON'), ...lib.labelsOf('TAG')].filter((l) => initiallySet.has(l.uid)), null],
        ['Participants', lib.labelsOf('PERSON').filter((l) => !initiallySet.has(l.uid)), 'PERSON'],
        ['Tags', lib.labelsOf('TAG').filter((l) => !initiallySet.has(l.uid)), 'TAG'],
      ];
      return h('div', {}, input, adders, sections.map(([title, labels, kind]) => {
        const matches = labels.filter((l) => l.name.toLowerCase().includes(q.toLowerCase()));
        if (!kind && !matches.length) return null;
        return h('div', {},
          h('div', { class: 'section' }, kind && initiallySet.size ? `Add more ${title.toLowerCase()}` : title),
          matches.length ? null : h('p', { class: 'muted small' }, q ? 'No matches' : (lib.labelsOf(kind).length ? 'All of them are set' : 'None yet — type a name above to add one.')),
          matches.map((l) => {
            const n = count(l.uid);
            const state3 = n === 0 ? '' : n === items.length ? '✓' : '–';
            return h('button', { class: 'check-row', onclick: () => { lib.setAssigned(items, l.uid, n < items.length); renderModal(); } },
              h('span', { class: `box ${state3 ? 'on' : ''}` }, state3), display(l),
              items.length > 1 && state3 === '–' ? h('span', { class: 'muted small' }, ` ${n} of ${items.length}`) : null);
          }));
      }));
    },
    actions: () => [h('button', { class: 'btn primary', onclick: closeModal }, 'Done')],
  });
  setTimeout(() => $modal.querySelector('[data-focus="q"]')?.focus());
}

/** New scene, or an existing one: scenes with the files' participants first, with thumbnails. */
function openAddToScene(items, onDone) {
  const state = { name: lib.defaultSceneName(items), query: '' };
  const ids = new Set(items.flatMap((i) => [...(lib.assign.get(i.key) || [])]));
  const people = lib.labelsOf('PERSON').filter((l) => ids.has(l.uid));
  const shared = (s) => lib.sceneParticipants(s).filter((p) => ids.has(p.uid)).length;
  openModal({
    title: items.length === 1 ? 'Add to a scene' : `Add ${items.length} files to a scene`,
    body: () => {
      const q = state.query.trim().toLowerCase();
      const matches = lib.scenes.filter((s) => !q || s.name.toLowerCase().includes(q)).sort((a, b) => shared(b) - shared(a));
      const withPeople = matches.filter((s) => shared(s) > 0).length;
      return h('div', {},
        h('div', { class: 'section' }, 'New scene'),
        h('div', { class: 'row' },
          h('input', { class: 'field grow', value: state.name, 'data-focus': 'name', oninput: (e) => { state.name = e.target.value; } }),
          h('button', {
            class: 'btn primary',
            onclick: () => {
              lib.createScene(state.name, items);
              toast(`Created “${state.name}”`);
              closeModal();
              onDone?.();
            },
          }, 'Create')),
        lib.scenes.length ? h('div', { class: 'section' }, withPeople ? `Or add to a scene with ${people.map((p) => p.name).join(', ')}` : 'Or add to an existing one') : null,
        lib.scenes.length > 6 ? h('input', { class: 'field', placeholder: 'Search scenes', value: state.query, 'data-focus': 'sq', oninput: (e) => { state.query = e.target.value; renderModal(); } }) : null,
        matches.map((s, i) => [
          i === withPeople && withPeople > 0 ? h('div', { class: 'section' }, 'Other scenes') : null,
          h('button', {
            class: 'scene-row',
            onclick: () => {
              const added = lib.addToScene(s.uid, items);
              toast(added ? `Added ${added} to “${s.name}”` : `Already in “${s.name}”`);
              closeModal();
              onDone?.();
            },
          }, h('div', { class: 'mini' }, sceneThumb(s)),
          h('div', { class: 'grow' }, h('div', {}, s.name),
            h('div', { class: 'muted small' }, [countText(lib.sceneItems(s).length), lib.sceneParticipants(s).map((p) => p.name).join(', '),
              items.filter((it) => s.keys.includes(it.key)).length ? `${items.filter((it) => s.keys.includes(it.key)).length} already in it` : ''].filter(Boolean).join(' · ')))),
        ]));
    },
    actions: () => [h('button', { class: 'btn', onclick: closeModal }, 'Cancel')],
  });
}

// ---------------------------------------------------------------------------------------------
// Viewer

let hlsScript = null;
function loadHls() {
  hlsScript ||= new Promise((resolve, reject) => {
    const s = h('script', { src: 'https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js' });
    s.onload = () => resolve(window.Hls);
    s.onerror = reject;
    document.head.append(s);
  });
  return hlsScript;
}

function viewer(entry) {
  const list = entry.list;
  let index = entry.index;
  let hls = null;
  const stage = h('div', { class: 'stage' });
  const title = h('div', { class: 'grow ellipsis' });
  const info = h('aside', { class: 'info' });
  const el = h('div', { class: 'viewer' },
    h('div', { class: 'viewer-top' },
      h('button', { class: 'btn icon', onclick: back, title: 'Close' }, '✕'), title),
    stage,
    h('button', { class: 'nav-btn left', onclick: () => go(-1), title: 'Previous' }, '‹'),
    h('button', { class: 'nav-btn right', onclick: () => go(1), title: 'Next' }, '›'),
    info);

  const item = () => list[index];

  function go(d) {
    const next = index + d;
    if (next < 0 || next >= list.length) return;
    index = next;
    entry.index = index;
    show();
  }

  function show() {
    hls?.destroy();
    hls = null;
    const it = item();
    title.replaceChildren(h('div', { class: 'ellipsis' }, it.name),
      h('div', { class: 'muted small' }, `${index + 1} of ${list.length}${it.web ? ' · from the web' : ''}`));
    stage.replaceChildren(itemThumb(it, 'placeholder'), h('div', { class: 'spinner' }));
    const shownKey = it.key;
    (async () => {
      if (it.type === 'video') {
        const video = h('video', { controls: true, autoplay: true, playsinline: true });
        if (it.web) {
          if (it.mime === HLS && !video.canPlayType('application/vnd.apple.mpegurl')) {
            const Hls = await loadHls();
            if (Hls?.isSupported()) {
              hls = new Hls();
              hls.loadSource(it.key);
              hls.attachMedia(video);
            }
          } else if (it.mime === DASH) {
            throw new Error('This video can only be played on its website');
          } else {
            video.src = it.key;
          }
        } else {
          video.src = media.streamUrl(it);
        }
        video.addEventListener('error', () => {
          if (it.web) stage.append(h('div', { class: 'stage-msg' }, 'This video can\'t be played here. ', h('a', { href: it.web.page || it.key, target: '_blank', rel: 'noreferrer' }, 'Open the original page')));
        });
        if (item().key === shownKey) stage.replaceChildren(video);
      } else {
        const url = await media.fileUrl(lib, it);
        if (item().key !== shownKey) return;
        const img = h('img', { class: 'full', src: url, alt: it.name, referrerpolicy: 'no-referrer' });
        img.addEventListener('error', () => {
          if (it.web) stage.append(h('div', { class: 'stage-msg' }, 'This picture can\'t be loaded here. ', h('a', { href: it.web.page || it.key, target: '_blank', rel: 'noreferrer' }, 'Open the original page')));
        });
        stage.replaceChildren(img);
        // Get the neighbours ready.
        for (const n of [list[index + 1], list[index - 1]]) {
          if (n && n.type !== 'video' && !n.web) media.fileUrl(lib, n).catch(() => {});
        }
      }
    })().catch((e) => {
      if (item().key === shownKey) stage.replaceChildren(h('div', { class: 'stage-msg' }, e.message || String(e)));
      failed(e);
    });
    update();
  }

  function update() {
    const it = lib.itemByKey.get(item().key) || item();
    const chips = (kind) => {
      const ls = lib.labelsFor(it, kind);
      return ls.length ? h('div', { class: 'chips' }, ls.map((l) => chip(display(l), kind === 'PERSON', () => push({ view: 'list', source: { label: l.uid } }))))
        : h('div', { class: 'muted small' }, 'None yet');
    };
    const scenes = lib.scenes.filter((s) => s.keys.includes(it.key));
    info.replaceChildren();
    add(info, [
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: () => openEditData([it]) }, '✎ Edit data'),
        h('button', { class: 'btn', onclick: () => openAddToScene([it]) }, scenes.length ? 'Add to another scene' : 'Add to a scene')),
      it.web ? h('a', { class: 'btn link', href: it.web.page || it.key, target: '_blank', rel: 'noreferrer' }, 'Open the original page') : null,
      h('div', { class: 'section' }, 'Participants'), chips('PERSON'),
      h('div', { class: 'section' }, 'Tags'), chips('TAG'),
      h('div', { class: 'section' }, 'Scenes'),
      scenes.length ? h('div', { class: 'chips' }, scenes.map((s) => chip(`◫ ${s.name}`, false, () => push({ view: 'scene', scene: s.uid }))))
        : h('div', { class: 'muted small' }, 'Not in a scene')]);
  }

  const onKey = (e) => {
    if (ui.modal || ui.nav[ui.nav.length - 1] !== entry || e.target.tagName === 'INPUT') return;
    if (e.key === 'ArrowLeft') go(-1);
    else if (e.key === 'ArrowRight') go(1);
  };
  document.addEventListener('keydown', onKey);

  show();
  return {
    el,
    update,
    close() {
      hls?.destroy();
      document.removeEventListener('keydown', onKey);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Live scene: a slideshow of the pictures (and GIFs) of chosen participants and tags

const TRANSITIONS = [['fade', 'Fade'], ['slide', 'Slide'], ['zoom', 'Zoom'], ['kenburns', 'Pan & zoom'], ['none', 'None']];

function liveConfig() {
  return { labels: [], matchAll: false, gifs: true, seconds: 5, minutes: 0, transition: 'fade', shuffle: true, ...store.get('live', {}) };
}

function liveItems(c) {
  const ids = c.labels.filter((uid) => lib.labelById.has(uid));
  if (!ids.length) return [];
  return lib.items.filter((i) => {
    if (!(i.type === 'picture' || (c.gifs && i.type === 'gif'))) return false;
    const has = lib.assign.get(i.key) || new Set();
    return c.matchAll ? ids.every((u) => has.has(u)) : ids.some((u) => has.has(u));
  });
}

function openLiveDialog() {
  const c = liveConfig();
  const state = { query: '' };
  const toggle = (uid) => {
    c.labels = c.labels.includes(uid) ? c.labels.filter((x) => x !== uid) : [...c.labels, uid];
    renderModal();
  };
  const labelChip = (l, on) => chip(`${l.kind === 'PERSON' ? '👤 ' : ''}${display(l)}`, on, () => toggle(l.uid));
  openModal({
    title: 'Live scene',
    wide: true,
    body: () => {
      const q = state.query.trim().toLowerCase();
      const chosen = lib.labels.filter((l) => c.labels.includes(l.uid)).sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'PERSON' ? -1 : 1));
      const count = liveItems(c).length;
      const set = (k, v) => { c[k] = v; renderModal(); };
      return h('div', {},
        chosen.length ? h('div', {},
          h('div', { class: 'row' }, h('div', { class: 'section grow' }, `Selected · ${chosen.length}`), h('button', { class: 'btn link', onclick: () => set('labels', []) }, 'Clear')),
          h('div', { class: 'chips wrap' }, chosen.map((l) => labelChip(l, true)))) : null,
        lib.labels.length > 12 ? h('input', { class: 'field', placeholder: 'Search participants and tags', value: state.query, 'data-focus': 'lq', oninput: (e) => { state.query = e.target.value; renderModal(); } }) : null,
        ['PERSON', 'TAG'].map((kind) => {
          const shown = lib.labelsOf(kind).filter((l) => !c.labels.includes(l.uid) && (!q || l.name.toLowerCase().includes(q)));
          return h('div', {}, h('div', { class: 'section' }, kind === 'PERSON' ? 'Participants' : 'Tags'),
            shown.length ? h('div', { class: 'chips wrap' }, shown.map((l) => labelChip(l, false)))
              : h('p', { class: 'muted small' }, q ? 'No matches' : lib.labelsOf(kind).length ? 'All selected' : 'None yet'));
        }),
        c.labels.length > 1 ? h('div', {}, h('div', { class: 'section' }, 'Pictures with'),
          h('div', { class: 'chips' }, chip('Any of them', !c.matchAll, () => set('matchAll', false)), chip('All of them', c.matchAll, () => set('matchAll', true)))) : null,
        h('div', { class: 'section' }, `Each picture: ${c.seconds} s`),
        h('input', { type: 'range', min: 1, max: 30, value: c.seconds, class: 'slider', oninput: (e) => { c.seconds = Number(e.target.value); renderModal(); } }),
        h('div', { class: 'section' }, 'Stop after'),
        h('div', { class: 'chips wrap' }, [0, 1, 5, 10, 20, 30, 60].map((m) => chip(m ? `${m} min` : 'Never', c.minutes === m, () => set('minutes', m)))),
        h('div', { class: 'section' }, 'Transition'),
        h('div', { class: 'chips wrap' }, TRANSITIONS.map(([id, t]) => chip(t, c.transition === id, () => set('transition', id)))),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: c.gifs, onchange: (e) => set('gifs', e.target.checked) }), 'Include GIFs'),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: c.shuffle, onchange: (e) => set('shuffle', e.target.checked) }), 'Shuffle'),
        h('p', { class: count ? 'accent small' : 'muted small' },
          !c.labels.length ? 'Choose at least one participant or tag.' : count ? plural(count, 'picture') : 'No pictures match.'));
    },
    actions: () => [
      h('button', { class: 'btn', onclick: closeModal }, 'Cancel'),
      h('button', {
        class: 'btn primary',
        disabled: !liveItems(c).length,
        onclick: () => {
          store.set('live', c);
          closeModal();
          document.documentElement.requestFullscreen?.().catch(() => {});
          push({ view: 'live', config: { ...c } });
        },
      }, '▶ Start'),
    ],
  });
}

function livePlayer(entry) {
  const c = entry.config;
  const base = liveItems(c);
  const slideMs = c.seconds * 1000;
  const fadeMs = Math.min(900, slideMs / 2);
  const layers = h('div', { class: 'live-layers' });
  const status = h('div', { class: 'live-status' });
  const pauseBtn = h('button', { class: 'round big', onclick: () => togglePause() }, '❚❚');
  const controls = h('div', { class: 'live-controls' },
    h('button', { class: 'round close', onclick: back, title: 'Close' }, '✕'),
    h('div', { class: 'live-bottom' }, status,
      h('div', { class: 'row center-row' },
        h('button', { class: 'round', onclick: () => jump(-1), title: 'Previous' }, '‹'),
        pauseBtn,
        h('button', { class: 'round', onclick: () => jump(1), title: 'Next' }, '›'))));
  const el = h('div', { class: 'live' }, layers, controls);
  let paused = false;
  let jumpTo = 0;
  let stopped = false;
  let hideTimer = null;
  let wake = null;
  const prepared = new Map();

  const showControls = () => {
    el.classList.add('show-controls');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => !paused && el.classList.remove('show-controls'), 2500);
  };
  el.addEventListener('mousemove', showControls);
  el.addEventListener('click', (e) => { if (e.target === el || e.target.closest('.live-layers')) showControls(); });

  function togglePause() {
    paused = !paused;
    pauseBtn.textContent = paused ? '▶' : '❚❚';
    if (paused) showControls();
  }
  function jump(d) { jumpTo = d; }
  const onKey = (e) => {
    if (ui.nav[ui.nav.length - 1] !== entry) return;
    if (e.key === ' ') { e.preventDefault(); togglePause(); }
    else if (e.key === 'ArrowLeft') jump(-1);
    else if (e.key === 'ArrowRight') jump(1);
  };
  document.addEventListener('keydown', onKey);
  navigator.wakeLock?.request('screen').then((w) => { wake = w; }).catch(() => {});

  // Downloads (and decrypts) the picture and decodes it, so it appears instantly when its turn comes.
  function prepare(item) {
    if (!prepared.has(item.key)) {
      prepared.set(item.key, (async () => {
        try {
          const url = await media.fileUrl(lib, item);
          const img = new Image();
          img.referrerPolicy = 'no-referrer';
          img.src = url;
          await img.decode();
          let anim = null;
          if (item.type === 'gif') {
            // GIFs stay on screen until they've played through once.
            anim = await fetch(url).then((r) => r.arrayBuffer()).then((b) => durationMs(new Uint8Array(b))).catch(() => null);
          }
          return { url, anim };
        } catch {
          return null;
        }
      })());
    }
    return prepared.get(item.key);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const shuffle = (a) => {
    const b = [...a];
    for (let i = b.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [b[i], b[j]] = [b[j], b[i]];
    }
    return b;
  };

  function showSlide(url, durationMs, n) {
    const img = h('img', { src: url, class: 'live-img', referrerpolicy: 'no-referrer' });
    const layer = h('div', { class: 'live-layer' }, img);
    const old = [...layers.children];
    layers.append(layer);
    const t = c.transition;
    const ms = fadeMs;
    const anims = {
      fade: [[{ opacity: 0 }, { opacity: 1 }], [{ opacity: 1 }, { opacity: 0 }]],
      kenburns: [[{ opacity: 0 }, { opacity: 1 }], [{ opacity: 1 }, { opacity: 0 }]],
      slide: [[{ transform: 'translateX(100%)', opacity: 0 }, { transform: 'none', opacity: 1 }], [{ transform: 'none', opacity: 1 }, { transform: 'translateX(-100%)', opacity: 0 }]],
      zoom: [[{ transform: 'scale(.85)', opacity: 0 }, { transform: 'none', opacity: 1 }], [{ transform: 'none', opacity: 1 }, { transform: 'scale(1.15)', opacity: 0 }]],
    };
    if (t !== 'none') {
      layer.animate(anims[t][0], { duration: ms, easing: 'ease-out' });
      for (const o of old) o.animate(anims[t][1], { duration: ms, easing: 'ease-in', fill: 'forwards' }).finished.then(() => o.remove(), () => o.remove());
    } else {
      old.forEach((o) => o.remove());
    }
    if (t === 'kenburns') {
      const dir = n % 2 ? -1 : 1;
      img.animate([{ transform: `scale(1) translateX(${-2 * dir}%)` }, { transform: `scale(1.12) translateX(${2 * dir}%)` }], { duration: durationMs + ms, easing: 'linear', fill: 'forwards' });
    }
  }

  const bottom = controls.querySelector('.live-bottom');
  const playing = [...bottom.children];
  const run = async () => {
    bottom.replaceChildren(...playing);
    let order = c.shuffle ? shuffle(base) : base;
    let i = 0;
    let n = 0;
    let elapsed = 0;
    let failures = 0;
    while (!stopped) {
      if (i >= order.length) {
        order = c.shuffle ? shuffle(base) : base;
        i = 0;
      }
      const item = order[i];
      const ready = await prepare(item);
      if (stopped) return;
      if (!ready) {
        if (++failures >= order.length) break;
        i++;
        continue;
      }
      failures = 0;
      const showMs = Math.max(slideMs, ready.anim || 0);
      showSlide(ready.url, showMs, n++);
      status.replaceChildren(`${i + 1} of ${order.length} · ${c.seconds} s`, h('div', { class: 'muted small ellipsis' }, item.name));
      if (order[i + 1]) prepare(order[i + 1]);
      let waited = 0;
      while (waited < showMs && jumpTo === 0 && !stopped) {
        await sleep(100);
        if (!paused) {
          waited += 100;
          elapsed += 100;
        }
      }
      if (c.minutes && elapsed >= c.minutes * 60_000) break;
      i = jumpTo < 0 ? Math.max(0, i - 1) : i + 1;
      jumpTo = 0;
    }
    if (stopped) return;
    el.classList.add('show-controls');
    bottom.replaceChildren(h('div', { class: 'live-status' }, 'Live scene finished'),
      h('div', { class: 'row center-row' },
        h('button', { class: 'btn primary', onclick: () => run().catch(failed) }, 'Play again'),
        h('button', { class: 'btn', onclick: back }, 'Close')));
  };
  run().catch(failed);

  showControls();
  return {
    el,
    update() {},
    close() {
      stopped = true;
      document.removeEventListener('keydown', onKey);
      wake?.release().catch(() => {});
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    },
  };
}

// ---------------------------------------------------------------------------------------------

history.replaceState({ depth: 1 }, '');
boot().catch(showError);
