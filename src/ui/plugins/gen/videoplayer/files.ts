// The video files the Video Player plays. A browser cannot keep a path to a
// file on disk like FL, so the file's bytes (a Blob) live in IndexedDB under a
// key the plugin's state holds ("videoKey"), the way user samples keep their
// files (src/audio/samples.ts): the project data only has the key, never the
// video. The same file loaded twice gets the same key. If IndexedDB is not
// available the files live for the session only.

const DB_NAME = 'orchard-video';
const STORE = 'files';

/** Files of this session (also the fallback when IndexedDB is unavailable). */
const session = new Map<string, Blob>();

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Store a video file under `key` (also remembered for this session). */
export async function putVideo(key: string, blob: Blob): Promise<void> {
  session.set(key, blob);
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(blob, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    db.close();
  } catch {
    /* storage unavailable or full: the file lives for this session only */
  }
}

/** The file stored under `key` (undefined when it is not there). */
export async function getVideo(key: string): Promise<Blob | undefined> {
  const s = session.get(key);
  if (s) return s;
  try {
    const db = await openDb();
    const blob = await new Promise<Blob | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result as Blob | undefined);
      req.onerror = () => reject(req.error);
    });
    db.close();
    if (blob instanceof Blob) { session.set(key, blob); return blob; }
  } catch {
    /* storage unavailable */
  }
  return undefined;
}

/** FNV-1a over a string, continuing `h`. */
function fnv(h: number, s: string): number {
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h;
}

/** FNV-1a over bytes, continuing `h`. */
function fnvBytes(h: number, b: Uint8Array): number {
  for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 16777619) >>> 0; }
  return h;
}

/** A key for a file: its name, size, date and a sample of its bytes (the start and the end). */
export async function videoKeyOf(file: File): Promise<string> {
  let h = fnv(2166136261, `${file.name}|${file.size}|${file.lastModified}`);
  try {
    const n = 65536;
    h = fnvBytes(h, new Uint8Array(await file.slice(0, n).arrayBuffer()));
    if (file.size > 2 * n) h = fnvBytes(h, new Uint8Array(await file.slice(file.size - n).arrayBuffer()));
  } catch {
    /* unreadable: the name, size and date have to do */
  }
  return `v${h.toString(36)}${file.size.toString(36)}`;
}
