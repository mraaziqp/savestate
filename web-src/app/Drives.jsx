// Cloud Drives (admins): both Google accounts and this PC's disks side by
// side, plus "upload this folder to Drive" jobs that verify every file and
// then ask before anything is deleted from the PC. See server/drives.ts.
import React, { useState, useEffect, useCallback, useMemo, useRef, Suspense, lazy } from "react";
import { useStyles, api, Icon, Note, when } from "./lib.jsx";
import { loadOldCloudHub } from "old-cloud";
import { uploadToDrive } from "./uploader.js";

const OldCloudHub = lazy(loadOldCloudHub);
const gb = (n) => (n == null ? "?" : n >= 1024 ** 4 ? `${(n / 1024 ** 4).toFixed(2)} TB` : n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.max(0, Math.round((n || 0) / 1024))} KB`);
// rclone limits read "650k" or "17528k" (KiB/s); people read MB/s.
const fmtLeft = (s) => (s > 86400 ? `${Math.round(s / 86400)} d` : s > 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : s > 60 ? `${Math.round(s / 60)} min` : `${Math.max(1, Math.round(s))} s`);
const rateText = (r) => { const m = /^(\d+(?:\.\d+)?)([kKmM])$/.exec(String(r)); if (!m) return `${r}/s`; const kib = Number(m[1]) * (/m/i.test(m[2]) ? 1024 : 1); return kib >= 1024 ? `${(kib / 1024).toFixed(1)} MB/s` : `${Math.round(kib)} KB/s`; };
const isLocal = (fs) => /^[A-Za-z]:$/.test(fs);
const joinPath = (a, b) => [a, b].filter(Boolean).join("/");
const parentOf = (p) => p.split("/").slice(0, -1).join("/");
const winPath = (fs, p) => `${fs}\\${String(p).replace(/\//g, "\\")}`;
const KINDS = [["movies", "Movies", "NexusArchive/movies"], ["tv", "TV shows", "NexusArchive/TV Shows"], ["music", "Music", "NexusArchive/music"],
  ["roms", "ROMs", "NexusArchive/roms"], ["files", "Other files", "Files"]];
const STATUS = {
  queued: ["", "Waiting"], copying: ["acc", "Uploading"], verifying: ["acc", "Checking every file"], verified: ["ok", "All files confirmed on Drive"],
  incomplete: ["warn", "Some files need another try"], paused: ["", "Paused"], failed: ["bad", "Failed"], deleting: ["acc", "Deleting from this PC"],
  done: ["ok", "Moved: on Drive, removed from this PC"], kept: ["ok", "On Drive (kept on this PC too)"],
};

function SpaceBar({ used, total }) {
  const pct = total ? Math.min(100, (used / total) * 100) : 0;
  return <div style={{ height: 6, borderRadius: 6, background: "rgba(255,255,255,.1)", overflow: "hidden", marginTop: 8 }}>
    <i style={{ display: "block", height: "100%", width: `${pct}%`, background: pct > 90 ? "#fb7185" : pct > 75 ? "#fbbf24" : "linear-gradient(90deg,#22d3ee,#4d7cff)" }} /></div>;
}

export function Pane({ side, sources, state, setState, other, onChanged, onOffload, notice, base = "/api/admin/drives" }) {
  const { fs, path } = state;
  const [items, setItems] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [sel, setSel] = useState(new Set());
  const local = isLocal(fs);
  const load = useCallback(async () => {
    if (!fs) return;
    setError(""); setItems(null); setSel(new Set());
    try { setItems((await api(`${base}/list?fs=${encodeURIComponent(fs)}&path=${encodeURIComponent(path)}`)).items); }
    catch (e) { setError(e.message); setItems([]); }
  }, [fs, path]);
  useEffect(() => { load(); }, [load, state.version]);
  const go = (p) => setState((s) => ({ ...s, path: p }));
  const crumbs = path ? path.split("/") : [];
  const picked = (items ?? []).filter((x) => sel.has(x.path));
  const toggle = (p) => setSel((s) => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n; });
  const act = async (label, fn) => { setBusy(label); setError(""); try { await fn(); await load(); onChanged?.(); } catch (e) { setError(e.message); } finally { setBusy(""); } };

  const mkdir = () => { const n = window.prompt("New folder name"); if (n?.trim()) act("mkdir", () => api(`${base}/mkdir`, { method: "POST", body: { fs, path: joinPath(path, n.trim()) } })); };
  const rename = (x) => { const n = window.prompt("New name", x.name); if (n?.trim() && n.trim() !== x.name) act("rename", () => api(`${base}/rename`, { method: "POST", body: { fs, from: x.path, to: joinPath(parentOf(x.path), n.trim()), isDir: x.isDir } })); };
  const del = () => {
    if (!picked.length || !window.confirm(`Move ${picked.length} item(s) to the Google Drive trash? You can restore them from drive.google.com for 30 days.`)) return;
    act("delete", async () => { for (const x of picked) await api(`${base}/delete`, { method: "POST", body: { fs, path: x.path, isDir: x.isDir } }); });
  };
  const send = (move) => {
    if (!picked.length || !other.fs) return;
    if (local) {
      if (isLocal(other.fs)) return setError("Pick a Google Drive on the other side.");
      const dirs = picked.filter((x) => x.isDir);
      if (dirs.length !== picked.length) return setError("Upload whole folders from this PC: select folders, not single files.");
      dirs.forEach((x) => onOffload({ source: winPath(fs, x.path), remote: other.fs, dest: joinPath(other.path, x.name), label: x.name }));
      return;
    }
    act("transfer", async () => {
      for (const x of picked) await api(`${base}/transfer`, { method: "POST", body: { fromFs: fs, fromPath: x.path, toFs: other.fs, toPath: joinPath(other.path, x.name), isDir: x.isDir, move } });
      notice(`${move ? "Moving" : "Copying"} ${picked.length} item(s). Progress is under Transfers below.`);
    });
  };
  // Uploads: files, whole folders (keeping their sub-folders) or a drop onto
  // the pane; see uploader.js for how parts travel and are retried.
  const [up, setUp] = useState(null);
  const [drop, setDrop] = useState(false);
  const stopUp = useRef(null);
  const startUpload = async (items) => {
    if (!items.length || local || up) return;
    const ctl = new AbortController();
    stopUp.current = ctl;
    setError("");
    setUp({ sent: 0, total: items.reduce((n, it) => n + it.file.size, 0), speed: 0, eta: null, filesDone: 0, filesTotal: items.length, current: [], failed: [] });
    try {
      const r = await uploadToDrive({ base, fs, path, items, signal: ctl.signal, onProgress: setUp });
      const later = r.results.filter((x) => x.background).length;
      notice?.(r.failed.length ? `${r.filesDone} uploaded, ${r.failed.length} couldn't be: ${r.failed.slice(0, 3).map((f) => `${f.name} (${f.error})`).join("; ")}`
        : later ? `${r.filesDone} file${r.filesDone === 1 ? "" : "s"} uploaded. ${later} big one${later === 1 ? " is" : "s are"} being saved to Drive in the background (Activity log shows it); ${later === 1 ? "it appears" : "they appear"} here when done.`
        : `${r.filesDone} file${r.filesDone === 1 ? "" : "s"} uploaded to Drive and checked.`);
      if (r.failed.length) setError(`${r.failed.length} file(s) didn't upload: ${r.failed.slice(0, 3).map((f) => `${f.name}: ${f.error}`).join("; ")}`);
    } catch (e) {
      if (e?.name !== "AbortError") setError(e.message); else notice?.("Upload cancelled.");
    } finally {
      setUp(null); stopUp.current = null; load(); onChanged?.();
    }
  };
  const upload = (e) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = "";
    // A folder pick gives each file its path inside the folder: keep it.
    startUpload(files.map((file) => ({ file, dir: (file.webkitRelativePath || "").split("/").slice(0, -1).join("/") })));
  };
  // Dropped folders are walked, keeping their structure.
  const onDrop = async (e) => {
    e.preventDefault(); setDrop(false);
    if (local) return;
    const walk = (entry, dir) => new Promise((resolve) => {
      if (entry.isFile) entry.file((file) => resolve([{ file, dir }]), () => resolve([]));
      else if (entry.isDirectory) {
        const reader = entry.createReader(); const all = [];
        const more = () => reader.readEntries(async (batch) => {
          if (!batch.length) { const nested = await Promise.all(all.map((c) => walk(c, [dir, entry.name].filter(Boolean).join("/")))); resolve(nested.flat()); return; }
          all.push(...batch); more();
        }, () => resolve([]));
        more();
      } else resolve([]);
    });
    const entries = [...(e.dataTransfer.items ?? [])].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
    const items = entries.length ? (await Promise.all(entries.map((en) => walk(en, "")))).flat() : [...(e.dataTransfer.files ?? [])].map((file) => ({ file, dir: "" }));
    startUpload(items);
  };
  const src = sources.find((s) => s.id === fs);
  return (
    <div className="nxa-card nxa-grow" style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="nxa-row nxa-wrap" style={{ justifyContent: "space-between" }}>
        <select className="nxa-input sm" style={{ maxWidth: 260 }} value={fs} onChange={(e) => setState((s) => ({ ...s, fs: e.target.value, path: "" }))} aria-label={`${side} pane location`}>
          {sources.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
        <div className="nxa-row">
          <button className="nxa-btn sm" onClick={load} title="Refresh"><Icon name="refresh" size={13} /></button>
          {!local && <button className="nxa-btn sm" onClick={mkdir}><Icon name="folder" size={13} /> New folder</button>}
          {!local && <label className="nxa-btn sm" style={{ cursor: up ? "default" : "pointer", opacity: up ? 0.5 : 1 }}><Icon name="cloud" size={13} /> Upload files<input type="file" multiple hidden disabled={!!up} onChange={upload} /></label>}
          {!local && <label className="nxa-btn sm" style={{ cursor: up ? "default" : "pointer", opacity: up ? 0.5 : 1 }}><Icon name="folder" size={13} /> Upload a folder<input type="file" multiple hidden disabled={!!up} webkitdirectory="" directory="" onChange={upload} /></label>}
        </div>
      </div>
      {src?.space && <div className="nxa-faint" style={{ fontSize: 12 }}>{gb(src.space.free)} free of {gb(src.space.total)}<SpaceBar used={src.space.used} total={src.space.total} /></div>}
      <div className="nxa-row nxa-wrap" style={{ fontSize: 13 }}>
        <button className="nxa-link" onClick={() => go("")}>{src?.short ?? fs}</button>
        {crumbs.map((c, i) => <React.Fragment key={i}><span className="nxa-faint">/</span><button className="nxa-link" onClick={() => go(crumbs.slice(0, i + 1).join("/"))}>{c}</button></React.Fragment>)}
      </div>
      {picked.length > 0 && (
        <div className="nxa-row nxa-wrap" style={{ padding: "8px 10px", borderRadius: 10, background: "rgba(34,211,238,.08)" }}>
          <b style={{ fontSize: 13 }}>{picked.length} selected</b>
          {local
            ? <button className="nxa-btn sm primary" onClick={() => send(true)}><Icon name="cloud" size={13} /> Upload & verify to the other side</button>
            : <>
              {other?.fs && <button className="nxa-btn sm" onClick={() => send(false)}><Icon name="copy" size={13} /> Copy to other side</button>}
              {other?.fs && <button className="nxa-btn sm" onClick={() => send(true)}><Icon name="arrow" size={13} /> Move to other side</button>}
              <button className="nxa-btn sm danger" onClick={del}><Icon name="trash" size={13} /> Delete</button>
            </>}
          <button className="nxa-link" onClick={() => setSel(new Set())}>Clear</button>
        </div>
      )}
      {busy && <p className="nxa-dim" style={{ fontSize: 13 }}><Icon name="spinner" size={13} /> {busy}…</p>}
      {up && (
        <div className="nxa-file" style={{ display: "block" }}>
          <div className="nxa-row" style={{ justifyContent: "space-between", gap: 8 }}>
            <b style={{ fontSize: 13 }}>Uploading {up.filesDone} of {up.filesTotal} file{up.filesTotal === 1 ? "" : "s"}</b>
            <button className="nxa-btn sm" onClick={() => stopUp.current?.abort()}>Cancel</button>
          </div>
          <div className="nxa-progress" style={{ marginTop: 6 }} role="progressbar" aria-valuenow={up.total ? Math.round((up.sent / up.total) * 100) : 0} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${up.total ? Math.min(100, (up.sent / up.total) * 100) : 0}%` }} /></div>
          <small>{gb(up.sent)} of {gb(up.total)}{up.speed > 0 ? ` · ${gb(up.speed)}/s` : ""}{up.eta != null && up.speed > 0 ? ` · ${fmtLeft(up.eta)} left` : " · working out the speed…"}</small>
          {up.current.length > 0 && <small style={{ display: "block", overflowWrap: "anywhere" }}>Now: {up.current.slice(0, 3).join(", ")}</small>}
          {up.failed.length > 0 && <small style={{ display: "block", color: "var(--bad)" }}>{up.failed.length} couldn't be uploaded (listed when the rest finish)</small>}
        </div>
      )}
      {error && <Note kind="bad">{error}</Note>}
      <div style={{ overflow: "auto", maxHeight: 460, border: `1px ${drop ? "dashed rgba(34,211,238,.6)" : "solid rgba(255,255,255,.07)"}`, borderRadius: 12, background: drop ? "rgba(34,211,238,.05)" : undefined }}
        onDragOver={(e) => { if (!local && !up) { e.preventDefault(); setDrop(true); } }} onDragLeave={() => setDrop(false)} onDrop={onDrop}>
        <table className="nxa-table">
          <tbody>
            {path && <tr><td colSpan={4}><button className="nxa-link" onClick={() => go(parentOf(path))}>.. (up)</button></td></tr>}
            {items === null && <tr><td colSpan={4} className="nxa-dim"><Icon name="spinner" size={13} /> Loading…</td></tr>}
            {items?.length === 0 && <tr><td colSpan={4} className="nxa-dim">Empty folder</td></tr>}
            {items?.map((x) => (
              <tr key={x.path}>
                <td style={{ width: 28 }}><input type="checkbox" className="nxa-check" checked={sel.has(x.path)} onChange={() => toggle(x.path)} aria-label={`Select ${x.name}`} /></td>
                <td style={{ wordBreak: "break-word" }}>
                  {x.isDir
                    ? <button className="nxa-link" style={{ color: "#f4f5fb", fontWeight: 600 }} onClick={() => go(x.path)}><Icon name="folder" size={14} /> {x.name}</button>
                    : <span>{x.name}</span>}
                </td>
                <td className="nxa-faint" style={{ whiteSpace: "nowrap", fontSize: 12 }}>{x.isDir ? "" : gb(x.size)}</td>
                <td style={{ whiteSpace: "nowrap", textAlign: "right" }}>
                  {!x.isDir && !local && <a className="nxa-btn sm" href={`${base}/download?fs=${encodeURIComponent(fs)}&path=${encodeURIComponent(x.path)}`} title="Download"><Icon name="down" size={12} /></a>}
                  {!local && <button className="nxa-btn sm" style={{ marginLeft: 4 }} onClick={() => rename(x)} title="Rename"><Icon name="edit" size={12} /></button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Clearing the PC, in one place: what is safe to delete now, and the video
// folders that are not on Drive yet (found on the host's disks).
function FreeSpace({ local, jobs, suggestions, remote, onAction, startOffload }) {
  const [busy, setBusy] = useState(false);
  const ready = jobs.filter((j) => j.status === "verified" && (j.verify?.matched ?? 0) > 0);
  const readyBytes = ready.reduce((n, j) => n + (j.verify?.matchedBytes ?? 0), 0);
  const videos = suggestions.filter((x) => /^(Films & shows|Personal videos): /.test(x.label) && !x.status);
  const roms = suggestions.filter((x) => x.kind === "roms" && !x.status);
  const pending = jobs.filter((j) => ["queued", "copying", "verifying", "paused", "failed", "incomplete"].includes(j.status));
  const pendingBytes = pending.reduce((n, j) => n + Math.max(0, (j.stats.totalBytes || 0) - (j.stats.bytes || 0)), 0);
  async function freeAll() {
    if (!window.confirm(`Every file in these ${ready.length} folder(s) is confirmed on Google Drive with matching checksums:\n\n${ready.map((j) => `• ${j.source} (${gb(j.verify.matchedBytes)})`).join("\n")}\n\nDelete them from this PC to free ${gb(readyBytes)}? The copies on Drive stay.`)) return;
    setBusy(true);
    for (const j of ready) await onAction(j, "delete-local", { confirm: j.id });
    setBusy(false);
  }
  const upload = (x, autoFree) => {
    if (autoFree && !window.confirm(`Upload ${x.source} to Google Drive, check every file, then delete each confirmed file from this PC?\n\nNothing is deleted until its copy on Drive matches exactly.`)) return;
    startOffload({ source: x.source, remote, dest: x.dest, kind: x.kind, label: x.label.replace(/ \([^)]*\)$/, ""), autoFree });
  };
  return (
    <div className="nxa-card">
      <div className="nxa-card-head"><div><h3 style={{ display: "flex", alignItems: "center", gap: 8 }}><Icon name="shield" /> Free up space on this PC</h3>
        <p className="nxa-sub">Folders go to Google Drive, every file is checked against Drive, and only then is it removed from this PC. Everything keeps playing in SaveState from Drive.</p></div></div>
      <div className="nxa-row nxa-wrap" style={{ gap: 8, marginBottom: 10 }}>
        {local.map((l) => <span key={l.name} className={`nxa-pill ${l.free < 50 * 1024 ** 3 ? "warn" : ""}`}>{l.name} {gb(l.free)} free</span>)}
      </div>
      {ready.length > 0 ? (
        <div className="nxa-row nxa-wrap" style={{ marginBottom: 12 }}>
          <button className="nxa-btn primary" disabled={busy} onClick={freeAll}>{busy ? <Icon name="spinner" /> : <Icon name="trash" />} Free {gb(readyBytes)} now</button>
          <span className="nxa-faint" style={{ fontSize: 12 }}>{ready.length} folder(s) already confirmed on Drive: {ready.map((j) => j.source).join(" · ")}</span>
        </div>
      ) : <p className="nxa-faint" style={{ fontSize: 12 }}>Nothing is waiting to be freed{pending.length ? `; ${pending.length} upload(s) still going (${gb(pendingBytes)} to go)` : ""}.</p>}
      {videos.length > 0 && <>
        <p className="nxa-label" style={{ marginTop: 8 }}>VIDEO FOLDERS NOT ON DRIVE YET (BIGGEST FIRST)</p>
        <div style={{ display: "grid", gap: 6 }}>
          {videos.map((x) => (
            <div key={x.source} className="nxa-file" style={{ alignItems: "center" }}>
              <Icon name="film" />
              <div className="nxa-grow"><b>{x.label}</b><small>{x.dest.startsWith("NexusArchive/") ? `to ${x.dest}; appears in Movies & TV once uploaded` : `to ${x.dest} on your Drive; private, not shown to anyone in SaveState`}</small></div>
              <button className="nxa-btn sm primary" onClick={() => upload(x, true)}>Upload & free</button>
              <button className="nxa-btn sm" onClick={() => upload(x, false)}>Upload only</button>
            </div>
          ))}
        </div>
      </>}
      {roms.length > 0 && <p className="nxa-faint" style={{ fontSize: 12, marginTop: 10 }}>{roms.length} ROM folder(s) aren't backed up yet; see "Keep a copy of everything on Drive" below.</p>}
    </div>
  );
}

function JobCard({ job, onAction }) {
  const [cls, label] = STATUS[job.status] ?? ["", job.status];
  const s = job.stats;
  const pct = s.totalBytes ? Math.min(100, (s.bytes / s.totalBytes) * 100) : 0;
  const active = job.status === "copying" || job.status === "verifying" || job.status === "deleting";
  const askDelete = () => {
    const v = job.verify;
    if (!window.confirm(`All ${v.matched} file(s) in ${job.source} (${gb(v.matchedBytes)}) are confirmed on Google Drive with matching checksums.\n\nDelete them from this PC to free the space? They skip the Recycle Bin, so this can't be undone here. The copies on Google Drive stay.`)) return;
    onAction(job, "delete-local", { confirm: job.id });
  };
  return (
    <div className="nxa-card" style={{ padding: 16 }}>
      <div className="nxa-row nxa-wrap" style={{ justifyContent: "space-between" }}>
        <div style={{ minWidth: 0 }}>
          <b>{job.label}</b> <span className={`nxa-pill ${cls}`}>{active && <Icon name="spinner" size={11} />} {label}</span>
          <div className="nxa-faint" style={{ fontSize: 12, wordBreak: "break-all" }}>{job.source} → {job.remote}:{job.dest}</div>
        </div>
        <div className="nxa-row nxa-wrap">
          {(job.status === "queued" || job.status === "copying" || job.status === "verifying") && <button className="nxa-btn sm" onClick={() => onAction(job, "pause")}>Pause</button>}
          {job.status === "paused" && <button className="nxa-btn sm primary" onClick={() => onAction(job, "resume")}>Resume</button>}
          {(job.status === "failed" || job.status === "incomplete") && <button className="nxa-btn sm primary" onClick={() => onAction(job, "retry")}>Try again</button>}
          {job.status === "verified" && <>
            <button className="nxa-btn sm danger" onClick={askDelete}><Icon name="trash" size={13} /> Delete from this PC ({gb(job.verify?.matchedBytes)})</button>
            <button className="nxa-btn sm" onClick={() => onAction(job, "keep")}>Keep both</button>
          </>}
          {["done", "kept", "failed", "paused", "incomplete"].includes(job.status) && <button className="nxa-btn sm" onClick={() => onAction(job, "remove")} title="Remove from this list">Clear</button>}
        </div>
      </div>
      {job.status === "copying" && (
        <div style={{ marginTop: 10 }}>
          <SpaceBar used={s.bytes} total={s.totalBytes || 1} />
          <div className="nxa-faint" style={{ fontSize: 12, marginTop: 6 }}>
            {gb(s.bytes)} of {gb(s.totalBytes)} · {s.transfers}/{s.totalTransfers} files · {gb(s.speed)}/s{s.eta != null && s.eta < 30 * 86400 ? ` · about ${s.eta > 5400 ? `${Math.round(s.eta / 3600)} h` : `${Math.ceil(s.eta / 60)} min`} left` : ""}{s.errors ? ` · ${s.errors} retrying` : ""}
            {s.current?.length > 0 && <div style={{ marginTop: 3 }}>{s.current.join(" · ")}</div>}
          </div>
        </div>
      )}
      {job.status === "verifying" && <p className="nxa-faint" style={{ fontSize: 12, marginTop: 8 }}>Comparing every file's size and checksum with Google Drive before anything can be deleted. Large folders take a while.</p>}
      {job.verify && job.status !== "verifying" && (
        <p className="nxa-faint" style={{ fontSize: 12, marginTop: 8 }}>
          {job.verify.matched} file(s) confirmed{job.verify.missing + job.verify.differ + job.verify.errors ? `, ${job.verify.missing + job.verify.differ + job.verify.errors} not yet` : ""} · checked {when(job.verify.at)}
        </p>
      )}
      {job.verify?.problems?.length > 0 && job.status === "incomplete" && <Note kind="warn">{job.verify.problems.slice(0, 5).join(" · ")}{job.verify.problems.length > 5 ? " …" : ""}</Note>}
      {job.deleted && <p className="nxa-faint" style={{ fontSize: 12, marginTop: 6 }}>Freed {gb(job.deleted.bytes)} ({job.deleted.files} files){job.deleted.skipped ? `; ${job.deleted.skipped} file(s) left because they changed or were in use` : ""}.</p>}
      {job.lastError && job.status !== "verified" && <p style={{ fontSize: 12, marginTop: 6, color: "#fca5a5" }}>{job.lastError}{job.status === "failed" && job.retryAt ? ` · trying again by itself at ${new Date(job.retryAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}</p>}
      <div className="nxa-row nxa-wrap" style={{ marginTop: 8, fontSize: 12 }}>
        <button className={`nxa-switch ${job.keepSynced ? "on" : ""}`} role="switch" aria-checked={!!job.keepSynced} aria-label="Keep this folder backed up"
          onClick={() => onAction(job, job.keepSynced ? "sync-off" : "sync-on")} />
        <span className="nxa-dim">{job.keepSynced
          ? <>Kept backed up: new files in this folder go to Drive every day{job.nextSyncAt ? ` (next ${new Date(job.nextSyncAt).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })})` : ""}</>
          : "Back up once"}</span>
        {["verified", "kept", "done"].includes(job.status) && <button className="nxa-link" onClick={() => onAction(job, "sync-now")}>Check for new files now</button>}
      </div>
      <div className="nxa-row nxa-wrap" style={{ marginTop: 6, fontSize: 12 }}>
        <button className={`nxa-switch ${job.autoFree ? "on" : ""}`} role="switch" aria-checked={!!job.autoFree} aria-label="Free this PC automatically"
          onClick={() => {
            if (job.autoFree) return onAction(job, "autofree-off");
            if (!window.confirm(`Delete files in ${job.source} from this PC automatically, each time they are confirmed on Google Drive with matching checksums?${job.status === "verified" ? `\n\n${gb(job.verify?.matchedBytes)} already confirmed will be freed now.` : ""}\n\nThe copies on Drive stay; files that change before the check are left alone.`)) return;
            onAction(job, "autofree-on", { confirm: job.id });
          }} />
        <span className="nxa-dim">{job.autoFree ? "Frees this PC automatically once files are confirmed on Drive" : "Asks before deleting anything from this PC"}</span>
      </div>
    </div>
  );
}

// ── Connecting accounts ──────────────────────────────────────────────────
function returnedFromGoogle() {
  try {
    const q = new URLSearchParams(window.location.search);
    const out = { ok: q.get("drive_connected"), error: q.get("drive_error") };
    if (out.ok || out.error) {
      const u = new URL(window.location.href);
      u.searchParams.delete("drive_connected"); u.searchParams.delete("drive_error");
      window.history.replaceState(null, "", u.toString());
    }
    return out;
  } catch { return {}; }
}

export function WebdavForm({ purpose, onDone }) {
  const [f, setF] = useState({ url: "", user: "", pass: "", vendor: "nextcloud", label: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async (e) => {
    e.preventDefault(); setBusy(true); setError("");
    try { await api("/api/drives/connect/webdav", { method: "POST", body: { ...f, purpose } }); onDone(); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return (
    <form onSubmit={save} className="nxa-form" style={{ marginTop: 12 }}>
      <div className="nxa-field"><label>Service</label>
        <select className="nxa-input sm" value={f.vendor} onChange={set("vendor")}><option value="nextcloud">Nextcloud</option><option value="owncloud">ownCloud</option><option value="other">Other WebDAV (pCloud, Koofr, a NAS)</option></select></div>
      <div className="nxa-field wide"><label>WebDAV address <i>(Nextcloud: Files &gt; Settings &gt; WebDAV)</i></label><input className="nxa-input sm" value={f.url} onChange={set("url")} placeholder="https://cloud.example.com/remote.php/dav/files/you/" /></div>
      <div className="nxa-field"><label>User name</label><input className="nxa-input sm" value={f.user} onChange={set("user")} autoComplete="off" /></div>
      <div className="nxa-field"><label>Password <i>(an app password if the service offers one)</i></label><input className="nxa-input sm" type="password" value={f.pass} onChange={set("pass")} autoComplete="new-password" /></div>
      <div className="nxa-field"><label>Name it</label><input className="nxa-input sm" value={f.label} onChange={set("label")} placeholder="My Nextcloud" /></div>
      <div className="nxa-row wide"><button className="nxa-btn primary" disabled={busy || !f.url}>{busy ? <Icon name="spinner" /> : <Icon name="link" />} Connect</button>{error && <span style={{ color: "#fca5a5", fontSize: 13 }}>{error}</span>}</div>
    </form>
  );
}

function ConnectCard({ onChanged }) {
  const [info, setInfo] = useState(null);
  const [app, setApp] = useState({ clientId: "", clientSecret: "" });
  const [msg, setMsg] = useState(() => returnedFromGoogle());
  const [busy, setBusy] = useState("");
  const [webdav, setWebdav] = useState(false);
  const [setup, setSetup] = useState(false);
  const load = useCallback(() => api("/api/admin/drives/connections").then(setInfo).catch((e) => setMsg({ error: e.message })), []);
  useEffect(() => { load(); }, [load]);
  const google = async (replace) => {
    setBusy(replace ?? "new");
    try { const r = await api("/api/drives/connect/google", { method: "POST", body: { purpose: "host", replace } }); window.location.href = r.url; }
    catch (e) { setMsg({ error: e.message }); setBusy(""); }
  };
  const saveApp = async (e) => {
    e.preventDefault(); setBusy("app");
    try { await api("/api/admin/drives/google-app", { method: "PUT", body: app }); setSetup(false); setMsg({ ok: "Google app saved. You can connect accounts now." }); load(); }
    catch (err) { setMsg({ error: err.message }); } finally { setBusy(""); }
  };
  const disconnect = async (a) => {
    if (!window.confirm(`Disconnect ${a.label}? Nothing on the drive is deleted; you can connect it again later.`)) return;
    try { await api(`/api/admin/drives/connections/${encodeURIComponent(a.name)}`, { method: "DELETE" }); load(); onChanged(); } catch (e) { setMsg({ error: e.message }); }
  };
  if (!info) return null;
  const shared = info.accounts.filter((a) => a.sharedClient);
  // Drives connected earlier (with rclone) work without the Google app; the
  // app is only needed to add accounts from here and for members' own drives.
  const drivesWorking = info.accounts.filter((a) => a.ok !== false);
  const showSetup = setup || (!info.google && !drivesWorking.length);
  return (
    <div className="nxa-card">
      <div className="nxa-card-head"><div><h3>Connected accounts</h3>
        <p className="nxa-sub">Add Google Drive accounts with a normal Google sign-in, or any WebDAV drive. Members can connect their own drives under My Drives once the Google app below is set up{info.personalCount ? ` (${info.personalCount} connected so far)` : ""}.</p></div>
        <div className="nxa-row nxa-wrap">
          <button className="nxa-btn primary" disabled={!info.google || !!busy} onClick={() => google(null)}>{busy === "new" ? <Icon name="spinner" /> : <Icon name="plus" />} Connect a Google account</button>
          <button className="nxa-btn" onClick={() => setWebdav((v) => !v)}><Icon name="link" /> WebDAV / Nextcloud</button>
        </div>
      </div>
      {msg?.ok && <Note kind="ok">Connected: {msg.ok}</Note>}
      {msg?.error && <Note kind="bad">{msg.error}</Note>}
      {webdav && <WebdavForm purpose="host" onDone={() => { setWebdav(false); load(); onChanged(); setMsg({ ok: "WebDAV drive" }); }} />}
      {drivesWorking.length > 0 && (
        <Note kind="ok">Connected and working: {drivesWorking.map((a) => a.label).join(", ")}. Browse, upload and free up space with them below.</Note>
      )}
      {!info.google && !showSetup && (
        <div className="nxa-row nxa-wrap" style={{ marginTop: 8, fontSize: 13 }}>
          <span className="nxa-dim">Optional: set up your own Google app (about 5 minutes, free) so you can add more Google accounts with one button and members can connect their own Drives under My Drives. It also moves your drives off rclone's shared Google app, which Google is retiring during 2026.</span>
          <button className="nxa-btn sm" onClick={() => setSetup(true)}><Icon name="key" /> Set up the Google app</button>
        </div>
      )}
      {showSetup ? (
        <div style={{ marginTop: 12 }}>
          <Note kind={info.google ? "warn" : "info"}>{info.google ? "Replacing the Google app." : "Follow these steps once. Each link opens the right Google page."}</Note>
          <ol className="nxa-steps" style={{ marginTop: 12, paddingLeft: 0, listStyle: "none" }}>
            <li className="nxa-step"><div><b>Create a project</b><p>Open <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener noreferrer">Google Cloud: new project <Icon name="ext" size={11} /></a>, name it "SaveState" and create it.</p></div></li>
            <li className="nxa-step"><div><b>Turn on the Drive API</b><p><a href="https://console.cloud.google.com/apis/library/drive.googleapis.com" target="_blank" rel="noopener noreferrer">Google Drive API <Icon name="ext" size={11} /></a> &gt; Enable.</p></div></li>
            <li className="nxa-step"><div><b>Name the app</b><p><a href="https://console.cloud.google.com/auth/branding" target="_blank" rel="noopener noreferrer">Branding <Icon name="ext" size={11} /></a> (pick the SaveState project at the top if Google asks): App name <b>SaveState</b>, your email as support and developer contact, Save. If it shows "Get started" instead, follow it with the same answers and choose <b>External</b>.</p></div></li>
            <li className="nxa-step"><div><b>Allow Drive access</b><p><a href="https://console.cloud.google.com/auth/scopes" target="_blank" rel="noopener noreferrer">Data access <Icon name="ext" size={11} /></a> &gt; Add or remove scopes &gt; tick <span className="nxa-code">.../auth/drive</span> (search "drive") &gt; Update &gt; Save.</p></div></li>
            <li className="nxa-step"><div><b>Publish it</b><p><a href="https://console.cloud.google.com/auth/audience" target="_blank" rel="noopener noreferrer">Audience <Icon name="ext" size={11} /></a> &gt; <b>Publish app</b> &gt; Confirm. (Left in "Testing", Google signs every account out after 7 days.)</p></div></li>
            <li className="nxa-step"><div><b>Create the client</b><p><a href="https://console.cloud.google.com/auth/clients/create" target="_blank" rel="noopener noreferrer">Create client <Icon name="ext" size={11} /></a> &gt; Application type <b>Web application</b>, name SaveState. Under <b>Authorised redirect URIs</b> &gt; Add URI, paste exactly:
              <span className="nxa-row nxa-wrap" style={{ marginTop: 6 }}><span className="nxa-code" style={{ wordBreak: "break-all" }}>{info.redirectUri}</span><button type="button" className="nxa-btn sm" onClick={() => navigator.clipboard?.writeText(info.redirectUri)}><Icon name="copy" size={12} /> Copy</button></span>
              Then Create. Google shows the Client ID and secret (and offers "Download JSON").</p></div></li>
            <li className="nxa-step"><div><b>Paste the ID and secret here</b><p className="nxa-faint" style={{ fontSize: 12, margin: "2px 0 0" }}>Or paste the whole downloaded JSON into the first box; both are read from it.</p>
              <form onSubmit={saveApp} className="nxa-form" style={{ marginTop: 8 }}>
                <div className="nxa-field"><label>Client ID</label><input className="nxa-input sm" value={app.clientId} placeholder="1234-abc.apps.googleusercontent.com"
                  onChange={(e) => {
                    const v = e.target.value;
                    // The "Download JSON" file: {"web":{"client_id":...,"client_secret":...}}
                    try { const j = JSON.parse(v); const w = j.web ?? j.installed ?? j; if (w.client_id) return setApp({ clientId: w.client_id, clientSecret: w.client_secret ?? app.clientSecret }); } catch { /* not JSON */ }
                    setApp({ ...app, clientId: v.trim() });
                  }} /></div>
                <div className="nxa-field"><label>Client secret</label><input className="nxa-input sm" type="password" value={app.clientSecret} onChange={(e) => setApp({ ...app, clientSecret: e.target.value })} autoComplete="off" /></div>
                <div className="nxa-row wide"><button className="nxa-btn primary" disabled={busy === "app"}>{busy === "app" ? <Icon name="spinner" /> : <Icon name="check" />} Save Google app</button></div>
              </form></div></li>
            <li className="nxa-step"><div><b>Connect your Drive</b><p>Press <b>Connect a Google account</b> above and sign in with the Google account whose Drive you want. Google then says "Google hasn't verified this app" (it's your own app, so that's expected): choose <b>Advanced</b> &gt; <b>Go to SaveState (unsafe)</b>, tick the Drive permission and <b>Continue</b>. You come straight back here with the drive connected. Repeat for each account.</p></div></li>
          </ol>
          <p className="nxa-faint" style={{ fontSize: 12 }}>Members connect their own drives the same way under My Drives, with one button and no setup. Up to 100 accounts can connect before Google asks to review the app.</p>
        </div>
      ) : info.google ? <button className="nxa-link" style={{ marginTop: 6 }} onClick={() => setSetup(true)}>Change the Google app</button> : null}
      {shared.length > 0 && info.google && (
        <Note kind="warn">{shared.map((a) => a.label).join(" and ")} still sign{shared.length === 1 ? "s" : ""} in through rclone's shared Google app, which is being retired.{" "}
          {shared.map((a) => <button key={a.name} className="nxa-link" disabled={!!busy} onClick={() => google(a.name)}>Reconnect {a.label}</button>)} (sign in with the same account; nothing changes on the drive).</Note>
      )}
      <table className="nxa-table" style={{ marginTop: 10 }}><tbody>
        {info.accounts.map((a) => (
          <tr key={a.name}>
            <td><b>{a.label}</b> <span className="nxa-faint" style={{ fontSize: 12 }}>{a.type === "webdav" ? "WebDAV" : "Google Drive"}</span>{!a.ok && <span className="nxa-pill bad" style={{ marginLeft: 6 }}>Can't reach it</span>}</td>
            <td className="nxa-faint" style={{ fontSize: 12 }}>{a.free != null ? `${gb(a.free)} free of ${gb(a.total)}` : ""}</td>
            <td style={{ textAlign: "right" }}>{a.type === "drive" && info.google && <button className="nxa-btn sm" onClick={() => google(a.name)}>Reconnect</button>} <button className="nxa-btn sm" onClick={() => disconnect(a)}>Disconnect</button></td>
          </tr>
        ))}
      </tbody></table>
    </div>
  );
}

export function DrivesPage() {
  useStyles();
  const [info, setInfo] = useState(null);
  const [error, setError] = useState("");
  const [left, setLeft] = useState({ fs: "", path: "", version: 0 });
  const [right, setRight] = useState({ fs: "", path: "", version: 0 });
  const [jobs, setJobs] = useState([]);
  const [gameMode, setGameMode] = useState(false);
  const [speedLimit, setSpeedLimit] = useState(null);
  const [protectedSum, setProtectedSum] = useState(null);
  const [transfers, setTransfers] = useState([]);
  const [suggestions, setSuggestions] = useState([]);
  const [msg, setMsg] = useState("");
  const [form, setForm] = useState({ source: "", kind: "movies", remote: "", dest: "NexusArchive/movies" });
  const [showOld, setShowOld] = useState(false);

  const loadInfo = useCallback(async () => {
    try {
      const d = await api(`/api/admin/drives${info ? "?fresh=1" : ""}`);
      if (!d.ok) throw new Error(d.error);
      setInfo(d);
      const first = d.accounts.find((a) => a.total > 100 * 1024 ** 3) ?? d.accounts[0];
      setLeft((s) => (s.fs ? s : { ...s, fs: d.local.find((l) => l.name === "E:")?.name ?? d.local[0]?.name ?? "" }));
      setRight((s) => (s.fs ? s : { ...s, fs: first?.name ?? "", path: "NexusArchive" }));
      setForm((f) => (f.remote ? f : { ...f, remote: first?.name ?? "" }));
    } catch (e) { setError(e.message); }
  }, []);
  const loadJobs = useCallback(async () => {
    const [j, t, sg] = await Promise.all([api("/api/admin/offload").catch(() => null), api("/api/admin/drives/transfers").catch(() => null), api("/api/admin/offload/suggestions").catch(() => null)]);
    if (j) { setJobs(j.jobs); setGameMode(j.gameMode); setSpeedLimit(j.speedLimit); setProtectedSum({ files: j.protectedFiles, bytes: j.protectedBytes }); }
    if (t) setTransfers(t.transfers);
    if (sg) setSuggestions(sg.suggestions);
  }, []);
  useEffect(() => { loadInfo(); loadJobs(); }, [loadInfo, loadJobs]);
  useEffect(() => { const t = setInterval(() => { if (!document.hidden) loadJobs(); }, 4000); return () => clearInterval(t); }, [loadJobs]);

  const sources = useMemo(() => !info ? [] : [
    ...info.accounts.map((a) => ({ id: a.name, label: `Google Drive · ${a.email ?? a.name}`, short: a.email ?? a.name, space: a })),
    ...info.local.map((l) => ({ id: l.name, label: `This PC · ${l.name} (${gb(l.free)} free)`, short: `${l.name}\\`, space: l })),
  ], [info]);

  const startOffload = async (body) => {
    setMsg(""); setError("");
    try {
      await api("/api/admin/offload", { method: "POST", body: { kind: "files", ...body } });
      setMsg(`Upload of "${body.label ?? body.source}" queued. It carries on after pauses and restarts${body.autoFree ? ", and frees this PC as each file is confirmed on Drive" : ", and asks before deleting anything from this PC"}.`);
      loadJobs();
    } catch (e) { setError(e.message); }
  };
  const onAction = async (job, action, body = {}) => {
    try { await api(`/api/admin/offload/${job.id}/${action}`, { method: "POST", body }); loadJobs(); if (action === "delete-local" || action === "autofree-on") setTimeout(loadInfo, 4000); }
    catch (e) { setError(e.message); }
  };
  const backupRoms = async () => {
    for (const s of suggestions.filter((x) => x.kind === "roms" && !x.status)) await startOffload({ source: s.source, remote: form.remote, dest: s.dest, kind: "roms", label: s.label });
  };
  const pendingRoms = suggestions.filter((x) => x.kind === "roms" && !x.status);
  const musicFolders = suggestions.filter((x) => x.kind === "music" && !x.status);

  if (error && !info) return <div className="nxa nxa-page"><Note kind="bad">{error}</Note></div>;
  if (!info) return <div className="nxa nxa-page"><p className="nxa-dim"><Icon name="spinner" /> Connecting to your drives…</p></div>;
  const small = info.accounts.filter((a) => a.total && a.total < 100 * 1024 ** 3);

  return (
    <div className="nxa nxa-page">
      <div className="nxa-row nxa-wrap" style={{ gap: 14 }}>
        {info.accounts.map((a) => (
          <div key={a.name} className="nxa-card nxa-grow" style={{ minWidth: 240 }}>
            <p className="nxa-label">GOOGLE DRIVE</p>
            <h3 style={{ wordBreak: "break-all" }}>{a.email ?? a.name}</h3>
            <p className="nxa-sub">{a.total ? `${gb(a.free)} free of ${gb(a.total)}` : "Checking space…"}</p>
            <SpaceBar used={a.used} total={a.total} />
          </div>
        ))}
      </div>
      <ConnectCard onChanged={loadInfo} />
      {small.length > 0 && <Note kind="warn">{small.map((a) => a.email ?? a.name).join(", ")} has Google's free 15 GB, not a 5 TB plan, so big uploads go to the larger account. If it should have more space, check its plan at one.google.com.</Note>}
      {gameMode && <Note>A game is running on this PC, so new uploads wait until it closes.</Note>}
      {msg && <Note kind="ok">{msg}</Note>}
      {error && <Note kind="bad">{error}</Note>}

      <FreeSpace local={info.local} jobs={jobs} suggestions={suggestions} remote={form.remote} onAction={onAction} startOffload={startOffload} />

      <div className="nxa-card">
        <div className="nxa-card-head"><div><h3>Move a folder from this PC to Google Drive</h3>
          <p className="nxa-sub">Uploads everything inside it, carries on after pauses, restarts or a reboot, then checks every file's checksum against Drive. Only after that are you asked whether to delete it from this PC.</p></div></div>
        <div className="nxa-form">
          <div className="nxa-field wide"><label>Folder on this PC</label>
            <input className="nxa-input sm" value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} placeholder="E:\Downloads\Movies  (or select folders in the left pane)" /></div>
          <div className="nxa-field"><label>What it is</label>
            <select className="nxa-input sm" value={form.kind} onChange={(e) => { const k = KINDS.find((x) => x[0] === e.target.value); setForm({ ...form, kind: k[0], dest: k[2] }); }}>
              {KINDS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select></div>
          <div className="nxa-field"><label>Google account</label>
            <select className="nxa-input sm" value={form.remote} onChange={(e) => setForm({ ...form, remote: e.target.value })}>
              {info.accounts.map((a) => <option key={a.name} value={a.name}>{a.email ?? a.name} ({gb(a.free)} free)</option>)}
            </select></div>
          <div className="nxa-field"><label>Folder on Drive <i>(movies, TV, music and ROMs under NexusArchive appear in SaveState)</i></label>
            <input className="nxa-input sm" value={form.dest} onChange={(e) => setForm({ ...form, dest: e.target.value })} /></div>
        </div>
        <div className="nxa-row" style={{ marginTop: 12 }}>
          <button className="nxa-btn primary" disabled={!form.source.trim() || !form.dest.trim()} onClick={() => {
            const name = form.source.trim().replace(/[\\/]+$/, "").split(/[\\/]/).pop();
            startOffload({ source: form.source.trim(), remote: form.remote, kind: form.kind, label: name,
              dest: form.kind === "files" || form.kind === "roms" ? `${form.dest.replace(/\/+$/, "")}/${name}` : form.dest });
          }}><Icon name="cloud" /> Upload & verify</button>
          <span className="nxa-faint" style={{ fontSize: 12 }}>Movies and TV keep their folders inside the destination; ROMs and other files go into a folder named after the source.</span>
        </div>
      </div>

      {(pendingRoms.length > 0 || musicFolders.length > 0) && (
        <div className="nxa-card">
          <div className="nxa-card-head"><div><h3>Keep a copy of everything on Drive</h3>
            <p className="nxa-sub">These folders on this PC exist nowhere else. A copy on Drive means a dead disk never costs you them again.</p></div></div>
          {pendingRoms.length > 0 && (
            <div className="nxa-row nxa-wrap" style={{ marginBottom: 10 }}>
              <button className="nxa-btn primary" onClick={backupRoms}><Icon name="shield" /> Back up all ROM folders ({pendingRoms.length})</button>
              <span className="nxa-faint" style={{ fontSize: 12 }}>{pendingRoms.map((s) => s.source).join(" · ")}</span>
            </div>
          )}
          {musicFolders.map((s) => (
            <div key={s.source} className="nxa-row nxa-wrap" style={{ marginTop: 6 }}>
              <button className="nxa-btn sm" onClick={() => startOffload({ source: s.source, remote: form.remote, dest: s.dest, kind: "music", label: s.label })}><Icon name="music" size={13} /> Upload {s.source}</button>
              <span className="nxa-faint" style={{ fontSize: 12 }}>to {s.dest}; it keeps playing in Music from Drive</span>
            </div>
          ))}
        </div>
      )}

      {jobs.length > 0 && (
        // minmax(0,1fr): a long folder path must wrap, not widen the page on a phone.
        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "minmax(0,1fr)" }}>
          <div className="nxa-row nxa-wrap" style={{ justifyContent: "space-between" }}>
            <h3 style={{ fontSize: 16, fontWeight: 800 }}>Uploads</h3>
            {protectedSum?.files > 0 && <span className="nxa-pill ok"><Icon name="shield" size={12} /> {protectedSum.files.toLocaleString()} files ({gb(protectedSum.bytes)}) confirmed safe on Drive</span>}
          </div>
          <p className="nxa-faint" style={{ fontSize: 12, marginTop: -6 }}>Uploads remember where they are: pausing, closing the app, a restart or a power cut only means they carry on from the last finished file. A stuck upload is restarted, and a failed one tries again by itself.</p>
          {speedLimit && <p className="nxa-faint" style={{ fontSize: 12, marginTop: -6 }}>
            {speedLimit === "off" ? "Uploading at full speed: nobody is watching or browsing right now (and from 01:00 to 07:00). The moment someone starts, it slows down so the site stays quick." : `Upload speed is held at ${rateText(speedLimit)} while ${gameMode ? "you game" : "someone is using SaveState"}, leaving the rest of the line for them. It goes back to full speed a few minutes after they stop.`}
          </p>}
          {jobs.map((j) => <JobCard key={j.id} job={j} onAction={onAction} />)}
        </div>
      )}

      <div className="nxa-row" style={{ alignItems: "stretch", gap: 14, flexWrap: "wrap" }}>
        <Pane side="Left" sources={sources} state={left} setState={setLeft} other={right} onOffload={startOffload} notice={setMsg}
          onChanged={() => { setRight((s) => ({ ...s, version: s.version + 1 })); loadJobs(); }} />
        <Pane side="Right" sources={sources} state={right} setState={setRight} other={left} onOffload={startOffload} notice={setMsg}
          onChanged={() => { setLeft((s) => ({ ...s, version: s.version + 1 })); loadJobs(); }} />
      </div>

      {transfers.length > 0 && (
        <div className="nxa-card">
          <h3>Transfers</h3>
          <table className="nxa-table" style={{ marginTop: 8 }}><tbody>
            {transfers.map((t) => (
              <tr key={t.id}><td>{t.label}</td>
                <td className="nxa-faint">{t.finished ? (t.success ? "Done" : `Failed: ${t.error}`) : `${gb(t.bytes)} of ${gb(t.totalBytes)} · ${gb(t.speed)}/s`}</td></tr>
            ))}
          </tbody></table>
        </div>
      )}

      <div className="nxa-card">
        <button className="nxa-link" onClick={() => setShowOld((v) => !v)}>{showOld ? "Hide" : "Show"} advanced cloud tools (storage autopilot, reclaim, categories)</button>
        {showOld && <div style={{ marginTop: 14 }}><Suspense fallback={<p className="nxa-dim"><Icon name="spinner" /> Loading…</p>}><OldCloudHub /></Suspense></div>}
      </div>
    </div>
  );
}
