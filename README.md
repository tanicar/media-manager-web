# Media Manager (browser)

The browser version of the Media Manager Android app. It shows the same library (files, tags,
participants, scenes, live scenes) from the same Google Drive folder, and edits made here sync
with the phone. Pictures and videos can also be uploaded from here (⬆ Upload, or drag and drop):
they're encrypted in the browser exactly like the phone does it. A whole folder can be uploaded
too: each folder inside it becomes a participant for everything it contains
(`Folder1/Anna/…/photo.jpg` gets the participant "Anna", reusing an existing one with that name;
a folder named "Anna, Ben" gives both).

Everything runs in the browser: there is no server. The page signs in with Google, reads the
"Media Manager" folder in Drive, and decrypts files locally when the folder is password-protected.
Nothing in this repository is secret.

## One-time setup

1. **GitHub Pages:** in this repo go to Settings → Pages → *Deploy from a branch* → `main`, folder `/ (root)`.
   The site appears at `https://<user>.github.io/media-manager-web/`.
2. **Google sign-in for the web:** in the Google Cloud project used by the phone app
   (APIs & Services → Credentials):
   - *Create credentials → OAuth client ID → Web application*.
   - Under *Authorized JavaScript origins* add `https://<user>.github.io`.
   - Copy the client ID. Paste it on the page the first time it opens (or put it in `config.js`).
3. Open the page, sign in with the Google account that holds the Media Manager folder, and enter
   the cloud password once (it is remembered in that browser; ⋮ → Lock forgets it).

## How it works

- `js/crypto.js`: the phone's encryption format (AES-256-GCM in 1 MiB chunks, PBKDF2 password).
- `js/library.js`: the shared library file and the merge rules (same as the phone's Sync.kt).
- `js/upload.js`: uploads from this computer (encrypted 1 MiB chunks, sent in 8 MiB parts, plus a thumbnail).
- `sw.js`: a service worker that streams videos, downloading and decrypting only the parts being played.
- `js/app.js`: the interface.
