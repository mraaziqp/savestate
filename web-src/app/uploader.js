// Uploading files from the browser to a Drive (Cloud Drives and My Drives).
//
// Each file goes in 8 MB parts (under Cloudflare's request size), several at
// once, each written by the server at its own offset, so any part can be
// retried without harm. Parts are retried with growing waits when the
// connection drops or the server is busy; only a real refusal (no space, not
// allowed) stops a file. Progress is reported for the whole batch: bytes,
// speed over the last 20 s, time left, which files are done or failed.
import { token } from "./lib.jsx";

const PART = 8 * 1024 * 1024;
const FILES_AT_ONCE = 3;
const PARTS_IN_FLIGHT = 6;
const TRIES = 7;

const pause = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("Cancelled", "AbortError")); }, { once: true });
});

/** One request, as XHR so its upload progress can be counted byte by byte. */
function xhr(method, url, body, signal, onBytes) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open(method, url);
    const t = token();
    if (t) x.setRequestHeader("Authorization", `Bearer ${t}`);
    if (body instanceof Blob) x.setRequestHeader("Content-Type", "application/octet-stream");
    else if (body != null) x.setRequestHeader("Content-Type", "application/json");
    let last = 0;
    x.upload.onprogress = (e) => { onBytes?.(e.loaded - last); last = e.loaded; };
    x.onload = () => {
      let data = null; try { data = JSON.parse(x.responseText); } catch { /* not json */ }
      resolve({ status: x.status, data, sent: last });
    };
    x.onerror = () => resolve({ status: 0, data: null, sent: last });
    x.ontimeout = () => resolve({ status: 0, data: null, sent: last });
    signal?.addEventListener("abort", () => x.abort(), { once: true });
    x.onabort = () => reject(new DOMException("Cancelled", "AbortError"));
    x.send(body instanceof Blob ? body : body != null ? JSON.stringify(body) : null);
  });
}

/** Retry a request until it works, the server refuses for real, or tries run out. */
async function withRetry(run, signal) {
  let wait = 1000;
  for (let i = 1; ; i++) {
    const r = await run();
    if (r.status >= 200 && r.status < 300) return r;
    const temporary = r.status === 0 || r.status === 408 || r.status === 429 || r.status >= 500;
    if (!temporary || i >= TRIES) {
      throw new Error(r.data?.error || r.data?.message || (r.status === 0 ? "The connection kept dropping. Try again when it's steadier." : (window.__nxHttpText?.(r.status) ?? `Upload failed (${r.status})`)));
    }
    await pause(wait, signal);
    wait = Math.min(30_000, wait * 2);
  }
}

/** A small semaphore: at most n parts travel at once across all files. */
function limiter(n) {
  let active = 0; const queue = [];
  const next = () => { if (active < n && queue.length) { active++; queue.shift()(); } };
  return async (fn) => {
    await new Promise((r) => { queue.push(r); next(); });
    try { return await fn(); } finally { active--; next(); }
  };
}

/**
 * Upload files into a folder of a drive.
 * items: [{ file: File, dir: "sub/folder" }] (dir is relative to `path`, "" for none).
 * onProgress({ sent, total, speed, eta, filesDone, filesTotal, current, failed }) is called often.
 */
export function uploadToDrive({ base, fs, path, items, signal, onProgress }) {
  return uploadInParts({
    items, signal, onProgress,
    init: ({ file, dir }) => [`${base}/upload/init`, { fs, path: [path, dir].filter(Boolean).join("/"), name: file.name, size: file.size }],
    part: (id, off) => `${base}/upload/${id}?offset=${off}`,
    complete: (id) => `${base}/upload/${id}/complete`,
    cancel: (id) => `${base}/upload/${id}`,
  });
}

/**
 * The engine: init (may answer { skip: true } when the file is already
 * there), parts at offsets, complete. `results` holds each file's
 * completion answer (e.g. the game it became), in the order finished.
 */
export async function uploadInParts({ items, init, part, complete, cancel, signal, onProgress }) {
  const total = items.reduce((n, it) => n + it.file.size, 0);
  let sent = 0, filesDone = 0, smooth = 0, skipped = 0;
  const failed = [];
  const results = [];
  const current = new Set();
  const samples = [{ t: Date.now(), sent: 0 }];
  let shownAt = 0;
  const report = (force = false) => {
    const now = Date.now();
    samples.push({ t: now, sent });
    while (samples.length > 2 && now - samples[1].t > 20_000) samples.shift();
    const span = (now - samples[0].t) / 1000;
    if (span >= 2) { const recent = (sent - samples[0].sent) / span; smooth = smooth ? smooth * 0.7 + recent * 0.3 : recent; }
    if (!force && now - shownAt < 200) return;
    shownAt = now;
    onProgress?.({ sent, total, speed: smooth, eta: smooth > 0 ? (total - sent) / smooth : null, filesDone, filesTotal: items.length, current: [...current], failed: [...failed] });
  };
  const bytes = (n) => { sent = Math.max(0, sent + n); report(); };
  const slot = limiter(PARTS_IN_FLIGHT);

  const one = (item) => oneFile(item);
  const oneFile = async (item) => {
    const { file } = item;
    const name = file.name;
    current.add(name); report(true);
    let id = null, counted = 0;
    const count = (n) => { counted += n; bytes(n); };
    try {
      const [initUrl, initBody] = init(item);
      const started = await withRetry(() => xhr("POST", initUrl, initBody, signal), signal);
      if (started.data?.skip) { skipped++; filesDone++; bytes(file.size); results.push({ item, skipped: true, ...started.data }); return; }
      id = started.data.id;
      const offsets = [];
      for (let off = 0; off < file.size; off += PART) offsets.push(off);
      if (!offsets.length) offsets.push(0); // an empty file still gets created
      await Promise.all(offsets.map((off) => slot(() => withRetry(async () => {
        const r = await xhr("PUT", part(id, off), file.slice(off, Math.min(file.size, off + PART)), signal, count);
        if (r.status < 200 || r.status >= 300) count(-r.sent); // that part is sent again
        return r;
      }, signal))));
      const done = await withRetry(() => xhr("POST", complete(id), {}, signal), signal);
      results.push({ item, ...(done.data ?? {}) });
      filesDone++;
    } catch (e) {
      if (e?.name === "AbortError") {
        if (id) fetch(cancel(id), { method: "DELETE", headers: { Authorization: `Bearer ${token()}` } }).catch(() => {});
        throw e;
      }
      bytes(-counted + file.size); // counted as handled, so the bar and time left stay true
      failed.push({ name, error: e?.message || "Upload failed" });
    } finally {
      current.delete(name); report(true);
    }
  };

  // Biggest first keeps the pipe full at the end instead of waiting on one large file.
  const queue = [...items].sort((a, b) => b.file.size - a.file.size);
  const workers = Array.from({ length: Math.min(FILES_AT_ONCE, queue.length) }, async () => {
    while (queue.length) await one(queue.shift());
  });
  await Promise.all(workers);
  report(true);
  return { filesDone, failed, skipped, results };
}
