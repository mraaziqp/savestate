// Movies & TV > upload: send a folder (or files) to the host's media library.
//
// The folder is described to the server first, which plans where every file
// goes as a whole (server/upload-batches.ts) and shows it here grouped by show
// and season before anything is sent. Uploading is resumable at every level:
//   - the plan and each file's state live on the server, so a reload, a
//     restart or another device picks up where it stopped;
//   - each file goes up in chunks the server keeps, so a broken connection
//     only re-sends the chunk in flight;
//   - on Chrome / Edge the folder itself is remembered (IndexedDB), so
//     "Continue" needs no re-picking; elsewhere, picking the same folder again
//     skips everything already sent.
// Requests are retried through dropped connections (waiting for the network
// to come back), and the screen is kept awake while uploading.
import React, { useState, useEffect, useRef, useCallback } from "react";
import { useStyles, api, token, Icon, Note } from "./lib.jsx";

const CHUNK = 16 * 1024 * 1024;
const PARALLEL = 3;
const MEDIA = /\.(mkv|mp4|m4v|avi|mov|wmv|webm|ts|m2ts|mpg|mpeg|flv|srt|vtt|ass|ssa|sub|jpg|jpeg|png|webp)$/i;
const size = (n) => (n >= 1024 ** 4 ? `${(n / 1024 ** 4).toFixed(2)} TB` : n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${Math.round(n / 1024 ** 2)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const eta = (s) => (!Number.isFinite(s) || s <= 0 ? "" : s > 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : s > 60 ? `${Math.round(s / 60)} min` : `${Math.round(s)} s`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Remembered folders (Chrome / Edge) ────────────────────────────────────
const idb = () => new Promise((res, rej) => { const r = indexedDB.open("nexus-uploads", 1); r.onupgradeneeded = () => r.result.createObjectStore("dirs"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function rememberDir(id, handle) { try { const db = await idb(); db.transaction("dirs", "readwrite").objectStore("dirs").put(handle, id); } catch { /* not supported */ } }
async function recallDir(id) { try { const db = await idb(); return await new Promise((res) => { const q = db.transaction("dirs").objectStore("dirs").get(id); q.onsuccess = () => res(q.result ?? null); q.onerror = () => res(null); }); } catch { return null; } }
async function forgetDir(id) { try { const db = await idb(); db.transaction("dirs", "readwrite").objectStore("dirs").delete(id); } catch { /* ignore */ } }

async function walk(dir, prefix, out) {
  for await (const [name, h] of dir.entries()) {
    if (name.startsWith(".")) continue;
    if (h.kind === "directory") await walk(h, `${prefix}${name}/`, out);
    else if (MEDIA.test(name)) out.push({ rel: `${prefix}${name}`, get: () => h.getFile() });
  }
}
async function fromHandle(dir) { const out = []; await walk(dir, `${dir.name}/`, out); return out; }
function fromInput(list) {
  return [...list].filter((f) => MEDIA.test(f.name)).map((f) => ({ rel: f.webkitRelativePath || f.name, get: async () => f }));
}
// Drag and drop: folders arrive as entries.
async function fromDrop(items) {
  const out = [];
  const read = (entry, prefix) => new Promise((resolve) => {
    if (entry.isFile) entry.file((f) => { if (MEDIA.test(f.name)) out.push({ rel: prefix + f.name, get: async () => f }); resolve(); }, () => resolve());
    else if (entry.isDirectory) {
      const r = entry.createReader(); const all = [];
      const more = () => r.readEntries(async (batch) => { if (batch.length) { all.push(...batch); more(); } else { for (const e of all) await read(e, `${prefix}${entry.name}/`); resolve(); } }, () => resolve());
      more();
    } else resolve();
  });
  for (const it of [...items]) { const e = it.webkitGetAsEntry?.(); if (e) await read(e, ""); }
  return out;
}

/** fetch that waits out dropped connections and retries server hiccups. */
async function robust(url, init, ctl) {
  for (let attempt = 0; ; attempt++) {
    if (ctl.stop) throw Object.assign(new Error("paused"), { paused: true });
    if (!navigator.onLine) { ctl.setStatus("Waiting for the internet connection…"); await new Promise((r) => window.addEventListener("online", r, { once: true })); }
    try {
      const r = await fetch(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token()}` } });
      if (r.ok || (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429)) return r;
      throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      if (e.paused) throw e;
      const wait = Math.min(60, 2 ** Math.min(attempt, 6));
      ctl.setStatus(`Connection trouble (${e.message}); retrying in ${wait} s…`);
      await sleep(wait * 1000);
    }
  }
}

function Plan({ batch, onRename }) {
  const s = batch.summary;
  const [edit, setEdit] = useState(null);
  return (
    <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
      {s.shows.map((sh) => (
        <div key={sh.key} className="nxa-file">
          <Icon name="film" />
          <div className="nxa-grow">
            {edit?.key === sh.key ? (
              <form className="nxa-row" onSubmit={(e) => { e.preventDefault(); onRename(sh.key, edit.title); setEdit(null); }}>
                <input className="nxa-input sm nxa-grow" value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} autoFocus aria-label="Show name" />
                <button className="nxa-btn sm primary" type="submit">Save</button>
                <button className="nxa-btn sm" type="button" onClick={() => setEdit(null)}>Cancel</button>
              </form>
            ) : (
              <b>{sh.title} <button className="nxa-link" style={{ fontSize: 12 }} onClick={() => setEdit({ key: sh.key, title: sh.title })}>rename</button></b>
            )}
            <small>TV show · {Object.entries(sh.seasons).sort((a, b) => a[0] - b[0]).map(([n, c]) => `${Number(n) === 0 ? "Specials" : `Season ${n}`}: ${c} episode${c === 1 ? "" : "s"}`).join(" · ")} · {size(sh.bytes)}</small>
          </div>
        </div>
      ))}
      {s.movies.map((m) => (
        <div key={m.title} className="nxa-file"><Icon name="film" /><div><b>{m.title}</b><small>Film · {size(m.bytes)}</small></div></div>
      ))}
      {s.skipped > 0 && <p className="nxa-faint" style={{ fontSize: 12, margin: 0 }}>{s.skipped} file{s.skipped === 1 ? "" : "s"} left out (samples, screenshots and other extras).</p>}
    </div>
  );
}

export function MediaUploader() {
  useStyles();
  const [open, setOpen] = useState([]);           // unfinished batches from the server
  const [batch, setBatch] = useState(null);       // the one in hand
  const [phase, setPhase] = useState("idle");     // idle | scanning | planned | uploading | paused | done
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState({ bytes: 0, total: 0, speed: 0, current: "" });
  const [drag, setDrag] = useState(false);
  const [repick, setRepick] = useState(null);   // an unfinished upload whose files must be picked again
  const files = useRef(new Map());                // rel -> () => Promise<File>
  const ctl = useRef({ stop: false, setStatus });
  const inputDir = useRef(null), inputFiles = useRef(null);

  const loadOpen = useCallback(async () => {
    try { const r = await api("/api/media/upload/batches"); setOpen(r.batches.filter((b) => b.summary.done + b.summary.skipped < b.summary.total + b.summary.skipped || b.summary.failed)); }
    catch { setOpen([]); }
  }, []);
  useEffect(() => { loadOpen(); }, [loadOpen]);

  // Keep the screen on and warn before closing while uploading.
  useEffect(() => {
    if (phase !== "uploading") return;
    let lock = null;
    const take = async () => { try { lock = await navigator.wakeLock?.request("screen"); } catch { /* not allowed */ } };
    take();
    const vis = () => { if (!document.hidden) take(); };
    const leave = (e) => { e.preventDefault(); e.returnValue = ""; };
    document.addEventListener("visibilitychange", vis);
    window.addEventListener("beforeunload", leave);
    return () => { document.removeEventListener("visibilitychange", vis); window.removeEventListener("beforeunload", leave); try { lock?.release(); } catch { /* ignore */ } };
  }, [phase]);

  async function plan(list, name, handle) {
    if (!list.length) { setError("No videos, subtitles or posters in what you picked."); setPhase("idle"); return; }
    setPhase("scanning"); setError(""); setStatus(`Reading ${list.length} file${list.length === 1 ? "" : "s"}…`);
    files.current = new Map(list.map((f) => [f.rel, f.get]));
    const described = [];
    for (const f of list) { const file = await f.get(); described.push({ rel: f.rel, size: file.size, lastModified: file.lastModified }); }
    try {
      const b = await api("/api/media/upload/batches", { method: "POST", body: { name: name || list[0].rel.split("/")[0], files: described } });
      if (handle) await rememberDir(b.id, handle);
      setBatch(b);
      setPhase(b.resumed ? "paused" : "planned");
      setStatus(b.resumed ? `This folder was being uploaded before: ${b.summary.done} of ${b.summary.total} files are already done.` : "");
    } catch (e) { setError(e.message); setPhase("idle"); }
  }

  async function pickFolder() {
    if (window.showDirectoryPicker) {
      try { const dir = await window.showDirectoryPicker({ id: "nexus-media", mode: "read" }); setPhase("scanning"); setStatus("Looking through the folder…"); await plan(await fromHandle(dir), dir.name, dir); }
      catch (e) { if (e?.name !== "AbortError") setError(e.message); setPhase((p) => (p === "scanning" ? "idle" : p)); }
    } else inputDir.current?.click();
  }

  async function resume(b) {
    setError("");
    const handle = await recallDir(b.id);
    if (handle) {
      try {
        const perm = (await handle.queryPermission?.({ mode: "read" })) === "granted" || (await handle.requestPermission?.({ mode: "read" })) === "granted";
        if (perm) { const full = await api(`/api/media/upload/batches/${b.id}`); setBatch(full); setPhase("scanning"); setStatus("Finding the files again…"); const list = await fromHandle(handle); files.current = new Map(list.map((f) => [f.rel, f.get])); setPhase("paused"); return start(full); }
      } catch { /* fall through to re-picking */ }
    }
    setRepick(b);
  }

  async function rename(key, title) {
    try { setBatch(await api(`/api/media/upload/batches/${batch.id}`, { method: "PATCH", body: { key, title } })); } catch (e) { setError(e.message); }
  }

  async function sendFile(b, f, onBytes) {
    const get = files.current.get(f.rel);
    if (!get) return "missing";
    const file = await get();
    if (file.size !== f.size) return "changed";
    const total = Math.max(1, Math.ceil(file.size / CHUNK));
    const q = (o) => new URLSearchParams(o).toString();
    const name = f.rel.split("/").pop();
    const init = await (await robust(`/api/media/upload/init?${q({ filename: name, rel: f.rel, totalChunks: total, totalSize: file.size, batch: b.id, index: f.i })}`, { method: "POST" }, ctl.current)).json();
    if (init.skipUpload) return "skipped";
    if (!init.uploadId) throw new Error(init.message || init.error || "The server didn't start the upload.");
    const have = new Set(init.receivedChunks ?? []);
    // Already on the server from an earlier try: counts as done, not as speed.
    onBytes([...have].reduce((n, i) => n + Math.min(CHUNK, file.size - i * CHUNK), 0), true);
    const todo = [...Array(total).keys()].filter((i) => !have.has(i));
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const i = todo[next++];
        const body = file.slice(i * CHUNK, Math.min(file.size, (i + 1) * CHUNK));
        const r = await robust(`/api/media/upload/chunk?${q({ uploadId: init.uploadId, chunkIndex: i })}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body }, ctl.current);
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Chunk ${i} was refused.`);
        onBytes(body.size);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, todo.length || 1) }, worker));
    const done = await robust(`/api/media/upload/complete?${q({ uploadId: init.uploadId })}`, { method: "POST" }, ctl.current);
    if (done.ok) return "done";
    // The answer to an earlier attempt may have been lost: ask the plan.
    const fresh = await api(`/api/media/upload/batches/${b.id}`).catch(() => null);
    if (fresh?.files[f.i]?.state === "done") return "done";
    throw new Error((await done.json().catch(() => ({}))).error || "The server couldn't finish this file.");
  }

  async function start(b = batch) {
    ctl.current.stop = false;
    setPhase("uploading"); setError("");
    const fresh = await api(`/api/media/upload/batches/${b.id}`).catch(() => b);
    setBatch(fresh);
    const todo = fresh.files.filter((f) => f.state === "pending" || f.state === "failed");
    const total = fresh.summary.bytes;
    let sent = fresh.summary.doneBytes;
    // Speed is what actually crossed the line in the last 30 s, smoothed, so
    // "time left" follows the connection as it is now. Averaging the whole run
    // (and counting chunks already on the server from an earlier try as if
    // just sent) made the estimate far too hopeful and then jump.
    let moved = 0, smooth = 0, shownAt = 0;
    const samples = [{ t: Date.now(), moved: 0 }];
    const tick = (n, current, resumed = false) => {
      sent += n;
      if (!resumed && n > 0) moved += n;
      const now = Date.now();
      samples.push({ t: now, moved });
      while (samples.length > 2 && now - samples[1].t > 30_000) samples.shift();
      const span = (now - samples[0].t) / 1000;
      if (span >= 3) {
        const recent = (moved - samples[0].moved) / span;
        smooth = smooth ? smooth * 0.8 + recent * 0.2 : recent;
      }
      // At most four updates a second: every chunk used to re-render the page.
      if (now - shownAt < 250 && n !== 0) return;
      shownAt = now;
      setProgress({ bytes: sent, total, speed: smooth, current });
    };
    tick(0, "");
    let missing = 0, failed = 0;
    for (const f of todo) {
      if (ctl.current.stop) break;
      setStatus(`Uploading ${f.rel.split("/").pop()}`);
      let counted = 0;
      try {
        const r = await sendFile(fresh, f, (n, resumed) => { counted += n; tick(n, f.rel, resumed); });
        if (r === "missing" || r === "changed") {
          missing++; tick(-counted, f.rel);
          await api(`/api/media/upload/batches/${fresh.id}/files/${f.i}`, { method: "POST", body: { state: "failed", note: r === "missing" ? "Not in the folder picked" : "The file changed since the upload began" } }).catch(() => {});
        } else if (r === "skipped") tick(-counted + 0, f.rel);
      } catch (e) {
        tick(-counted, f.rel);
        if (e.paused) break;
        failed++;
        await api(`/api/media/upload/batches/${fresh.id}/files/${f.i}`, { method: "POST", body: { state: "failed", note: e.message } }).catch(() => {});
      }
    }
    const end = await api(`/api/media/upload/batches/${fresh.id}`).catch(() => fresh);
    setBatch(end);
    if (ctl.current.stop) { setPhase("paused"); setStatus("Paused. Everything sent so far is kept."); }
    else {
      setPhase("done");
      setStatus(failed || missing
        ? `${end.summary.done} of ${end.summary.total} files are in the library. ${failed + missing} couldn't be sent${missing ? " (not found in the folder)" : ""}; press Continue to try them again.`
        : end.summary.done < end.summary.total
          ? `${end.summary.done} of ${end.summary.total} files are in the library; press Continue for the rest.`
          : `All ${end.summary.done} file${end.summary.done === 1 ? " is" : "s are"} in the library. They appear in Movies & TV within a minute.`);
      if (!failed && !missing && end.summary.done >= end.summary.total) forgetDir(fresh.id);
      window.dispatchEvent(new CustomEvent("nexus:media-updated"));
    }
    loadOpen();
  }

  function pause() { ctl.current.stop = true; setStatus("Pausing after the current piece…"); }
  async function discard(b) {
    if (!window.confirm(`Forget the upload of "${b.name}"? Files already uploaded stay in the library.`)) return;
    await api(`/api/media/upload/batches/${b.id}`, { method: "DELETE" }).catch(() => {});
    forgetDir(b.id);
    if (batch?.id === b.id) { setBatch(null); setPhase("idle"); setStatus(""); }
    loadOpen();
  }

  const busy = phase === "scanning" || phase === "uploading";
  const pct = progress.total ? Math.min(100, (progress.bytes / progress.total) * 100) : 0;
  return (
    <div className="nxa" style={{ marginBottom: 16 }}>
      <input ref={inputDir} type="file" multiple webkitdirectory="" directory="" hidden onChange={(e) => { const l = fromInput(e.target.files); e.target.value = ""; plan(l); }} />
      <input ref={inputFiles} type="file" multiple hidden accept="video/*,.mkv,.srt,.vtt,.ass,.ssa,.sub,image/*" onChange={(e) => { const l = fromInput(e.target.files); e.target.value = ""; plan(l, l.length === 1 ? l[0].rel : "Files"); }} />

      {open.filter((b) => b.id !== batch?.id).map((b) => (
        <div key={b.id} className="nxa-card" style={{ padding: 14, marginBottom: 10 }}>
          <div className="nxa-row nxa-wrap" style={{ justifyContent: "space-between" }}>
            <div><b>Unfinished upload: {b.name}</b>
              <div className="nxa-faint" style={{ fontSize: 12 }}>{b.summary.done} of {b.summary.total} files sent · {size(Math.max(0, b.summary.bytes - b.summary.doneBytes))} to go{b.summary.failed ? ` · ${b.summary.failed} failed` : ""}</div></div>
            <div className="nxa-row">
              <button className="nxa-btn sm primary" disabled={busy} onClick={() => resume(b)}><Icon name="refresh" /> Continue</button>
              <button className="nxa-btn sm" disabled={busy} onClick={() => discard(b)}>Forget</button>
            </div>
          </div>
        </div>
      ))}

      <div className="nxa-card" onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
        onDrop={async (e) => { e.preventDefault(); setDrag(false); if (busy) return; const l = await fromDrop(e.dataTransfer.items); plan(l); }}
        style={drag ? { borderColor: "var(--acc)", background: "rgba(34,211,238,.06)" } : undefined}>
        <div className="nxa-card-head" style={{ marginBottom: 8 }}>
          <div>
            <h3 style={{ display: "flex", alignItems: "center", gap: 8 }}><Icon name="down" /> Add to the library</h3>
            <p className="nxa-sub" style={{ margin: 0 }}>Pick a show's folder, a whole collection, or single films, or drop them here. Episodes are grouped by show and season however they are arranged, and the upload carries on after a lost connection or a restart.</p>
          </div>
          <div className="nxa-row nxa-wrap">
            <button className="nxa-btn primary" disabled={busy} onClick={pickFolder}><Icon name="folder" /> Upload a folder</button>
            <button className="nxa-btn" disabled={busy} onClick={() => inputFiles.current?.click()}><Icon name="plus" /> Files</button>
          </div>
        </div>

        {repick && !busy && (
          <Note>To carry on with "{repick.name}", pick it again: files already sent are skipped.{" "}
            <button className="nxa-link" onClick={() => { setRepick(null); pickFolder(); }}>Pick the folder</button>{" or "}
            <button className="nxa-link" onClick={() => { setRepick(null); inputFiles.current?.click(); }}>pick the files</button>
          </Note>
        )}
        {phase === "scanning" && <p className="nxa-dim"><Icon name="spinner" /> {status}</p>}
        {batch && phase !== "scanning" && (
          <>
            {phase === "planned" && <Note>Check where things will go, rename a show if it's wrong, then start.</Note>}
            <Plan batch={batch} onRename={rename} />
            {(phase === "uploading" || phase === "paused" || phase === "done") && (
              <div style={{ marginTop: 12 }}>
                <div className="nxa-progress" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label="Upload progress"><i style={{ width: `${pct}%` }} /></div>
                <p className="nxa-faint" style={{ fontSize: 12, margin: "6px 0 0" }}>
                  {size(progress.bytes)} of {size(progress.total)}{progress.speed > 0 && phase === "uploading" ? ` · ${size(progress.speed)}/s · ${eta((progress.total - progress.bytes) / progress.speed)} left` : ""}
                </p>
              </div>
            )}
            {status && phase !== "scanning" && <p className="nxa-dim" style={{ fontSize: 13, margin: "8px 0 0" }}>{status}</p>}
            <div className="nxa-row nxa-wrap" style={{ marginTop: 12 }}>
              {phase === "planned" && <button className="nxa-btn primary" onClick={() => start()}><Icon name="check" /> Start upload ({batch.summary.total} files, {size(batch.summary.bytes)})</button>}
              {phase === "uploading" && <button className="nxa-btn" onClick={pause}>Pause</button>}
              {(phase === "paused" || (phase === "done" && (batch.summary.failed || batch.summary.done < batch.summary.total))) && <button className="nxa-btn primary" onClick={() => start()}><Icon name="refresh" /> Continue</button>}
              {phase !== "uploading" && <button className="nxa-btn" onClick={() => { setBatch(null); setPhase("idle"); setStatus(""); loadOpen(); }}>{phase === "done" ? "Close" : "Not now"}</button>}
            </div>
          </>
        )}
        {error && <Note kind="bad">{error}</Note>}
      </div>
    </div>
  );
}
