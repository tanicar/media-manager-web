// Tiny key-value store in IndexedDB, shared by the page and the service worker
// (the worker can't read localStorage).

let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('media-manager', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

export async function kvGet(key) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = d.transaction('kv').objectStore('kv').get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function kvSet(key, value) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('kv', 'readwrite');
    if (value === undefined) tx.objectStore('kv').delete(key);
    else tx.objectStore('kv').put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
