// Games > Add games (admins): put ROMs into the library from any PC or phone.
//
// Drop files or whole folders. The server names each file's system with the
// same detection the library uses (extension first, then folder names such
// as "SNES" or "PS2 games"); anything it can't be sure of is marked so it
// can be chosen. Files already in the library are skipped. Uploads go in
// parallel parts that survive dropped connections (uploader.js), and each
// game is playable the moment its upload finishes.
import React, { useState, useRef, useMemo } from "react";
import { useStyles, api, Icon, Note, goTab } from "./lib.jsx";
import { SYSTEMS } from "./systems.js";
import { uploadInParts } from "./uploader.js";

// The setup guide groups a few systems; the library keeps them apart.
const CHOICES = [
  ...SYSTEMS.filter((s) => !["gb", "mastersystem", "atari"].includes(s.id)).map((s) => [s.id, s.name]),
  ["gb", "Game Boy"], ["gbc", "Game Boy Color"], ["mastersystem", "Master System"], ["gamegear", "Game Gear"], ["atari2600", "Atari 2600"],
].sort((a, b) => a[1].localeCompare(b[1]));
const NAME = Object.fromEntries(CHOICES);
// Files that come with game sets but aren't games.
const JUNK = /\.(txt|nfo|diz|jpe?g|png|gif|bmp|webp|ini|cfg|db|sfv|md5|sha1|url|lnk|exe|dll|pdf|html?|xml|json|log|ds_store)$/i;
const size = (n) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const left = (s) => (s > 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : s > 60 ? `${Math.round(s / 60)} min` : `${Math.max(1, Math.round(s))} s`);

async function walkDrop(dataTransfer) {
  const walk = (entry, dir) => new Promise((resolve) => {
    if (entry.isFile) entry.file((file) => resolve([{ file, rel: [dir, file.name].filter(Boolean).join("/") }]), () => resolve([]));
    else if (entry.isDirectory) {
      const reader = entry.createReader(); const all = [];
      const more = () => reader.readEntries(async (batch) => {
        if (!batch.length) { resolve((await Promise.all(all.map((c) => walk(c, [dir, entry.name].filter(Boolean).join("/"))))).flat()); return; }
        all.push(...batch); more();
      }, () => resolve([]));
      more();
    } else resolve([]);
  });
  const entries = [...(dataTransfer.items ?? [])].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (entries.length) return (await Promise.all(entries.map((e) => walk(e, "")))).flat();
  return [...(dataTransfer.files ?? [])].map((file) => ({ file, rel: file.name }));
}

export function AddGames() {
  useStyles();
  const [rows, setRows] = useState(null);      // [{ file, rel, platform, sure, existing, include, junk }]
  const [checking, setChecking] = useState(false);
  const [over, setOver] = useState(false);
  const [up, setUp] = useState(null);
  const [done, setDone] = useState(null);
  const [error, setError] = useState("");
  const ctl = useRef(null);
  const pickFiles = useRef(null);
  const pickFolder = useRef(null);

  const take = async (picked) => {
    setError(""); setDone(null);
    if (!picked.length) return;
    setChecking(true);
    try {
      const games = picked.filter((p) => !JUNK.test(p.file.name) && p.file.size > 0);
      const junk = picked.length - games.length;
      const out = [];
      for (let i = 0; i < games.length; i += 800) {
        const batch = games.slice(i, i + 800);
        const r = await api("/api/games/intake/classify", { method: "POST", body: { files: batch.map((g) => ({ name: g.file.name, rel: g.rel, size: g.file.size })) } });
        r.files.forEach((c, n) => out.push({ ...batch[n], platform: c.platform, sure: c.sure, existing: c.existing, include: !c.existing }));
      }
      setRows(out);
      if (junk) setError(`${junk} file(s) that aren't games (pictures, text, shortcuts) were left out.`);
    } catch (e) { setError(e.message); } finally { setChecking(false); }
  };

  const chosen = (rows ?? []).filter((r) => r.include);
  const needsSystem = chosen.filter((r) => !r.platform || r.platform === "unknown");
  const bySystem = useMemo(() => {
    const m = new Map();
    for (const r of chosen) m.set(r.platform, (m.get(r.platform) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);
  const setRow = (i, patch) => setRows((rs) => rs.map((r, n) => (n === i ? { ...r, ...patch } : r)));
  const setAllUnknown = (platform) => setRows((rs) => rs.map((r) => (r.include && (!r.platform || r.platform === "unknown") ? { ...r, platform, sure: true } : r)));

  const start = async () => {
    if (!chosen.length || needsSystem.length) return;
    const c = new AbortController(); ctl.current = c;
    setError(""); setUp({ sent: 0, total: chosen.reduce((n, r) => n + r.file.size, 0), filesDone: 0, filesTotal: chosen.length, current: [], failed: [], speed: 0, eta: null });
    try {
      const r = await uploadInParts({
        items: chosen, signal: c.signal, onProgress: setUp,
        init: (row) => ["/api/games/intake/init", { filename: row.file.name, size: row.file.size, platform: row.platform }],
        part: (id, off) => `/api/games/intake/${id}?offset=${off}`,
        complete: (id) => `/api/games/intake/${id}/complete`,
        cancel: (id) => `/api/games/intake/${id}`,
      });
      const added = r.results.filter((x) => !x.skipped && x.game);
      const systems = [...new Set(added.map((x) => NAME[x.game.platform] ?? x.game.platform))];
      setDone({ added, skipped: r.skipped, failed: r.failed });
      api("/api/games/intake/done", { method: "POST", body: { added: added.length, skipped: r.skipped, failed: r.failed.length, systems, bytes: added.reduce((n, x) => n + x.item.file.size, 0) } }).catch(() => {});
      setRows(null);
    } catch (e) {
      if (e?.name !== "AbortError") setError(e.message); else setError("Stopped. Games that finished are in the library; start again to add the rest.");
    } finally { setUp(null); ctl.current = null; }
  };

  return (
    <div className="nxa nxa-page">
      <div className="nxa-card">
        <div className="nxa-card-head"><div><h3 style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 20 }}><Icon name="plus" /> Add games</h3>
          <p className="nxa-sub" style={{ margin: 0 }}>Drop ROM files or whole folders. Each game's system is recognised, it goes into the right library folder, and it's playable the moment it finishes uploading. Games already in the library are skipped.</p></div></div>

        {!rows && !up && (
          <div onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
            onDrop={async (e) => { e.preventDefault(); setOver(false); take(await walkDrop(e.dataTransfer)); }}
            style={{ border: `2px dashed ${over ? "var(--acc)" : "var(--line)"}`, background: over ? "rgba(34,211,238,.06)" : undefined, borderRadius: 16, padding: "28px 18px", textAlign: "center" }}>
            <Icon name="game" size={26} />
            <p style={{ margin: "8px 0 14px", fontSize: 15 }}><b>Drop games or folders here</b><br /><span className="nxa-faint" style={{ fontSize: 13 }}>Any mix of systems: .sfc .gba .iso .chd .rvz .zip and more</span></p>
            <div className="nxa-row nxa-wrap" style={{ justifyContent: "center" }}>
              <button className="nxa-btn primary" onClick={() => pickFiles.current?.click()}><Icon name="plus" size={14} /> Choose files</button>
              <button className="nxa-btn" onClick={() => pickFolder.current?.click()}><Icon name="folder" size={14} /> Choose a folder</button>
            </div>
            <input ref={pickFiles} type="file" multiple hidden onChange={(e) => { const f = [...e.target.files]; e.target.value = ""; take(f.map((file) => ({ file, rel: file.name }))); }} />
            <input ref={pickFolder} type="file" multiple hidden webkitdirectory="" directory="" onChange={(e) => { const f = [...e.target.files]; e.target.value = ""; take(f.map((file) => ({ file, rel: file.webkitRelativePath || file.name }))); }} />
            {checking && <p className="nxa-dim" style={{ marginTop: 12 }}><Icon name="spinner" /> Recognising the systems…</p>}
          </div>
        )}

        {rows && !up && (
          <div style={{ display: "grid", gap: 12 }}>
            <div className="nxa-row nxa-wrap" style={{ justifyContent: "space-between" }}>
              <b>{chosen.length} game{chosen.length === 1 ? "" : "s"} to add · {size(chosen.reduce((n, r) => n + r.file.size, 0))}</b>
              <span className="nxa-faint" style={{ fontSize: 13 }}>{bySystem.map(([p, n]) => `${n} ${NAME[p] ?? "need a system"}`).join(" · ")}</span>
            </div>
            {rows.some((r) => r.existing) && <Note>{rows.filter((r) => r.existing).length} already in the library, left out (tick one to send it again).</Note>}
            {needsSystem.length > 0 && (
              <Note kind="warn">
                {needsSystem.length} file{needsSystem.length === 1 ? "" : "s"} need a system. Choose it on each row, or for all of them:{" "}
                <select className="nxa-input sm" style={{ display: "inline-block", width: "auto", marginLeft: 6 }} value="" onChange={(e) => e.target.value && setAllUnknown(e.target.value)}>
                  <option value="">Choose…</option>{CHOICES.map(([id, n]) => <option key={id} value={id}>{n}</option>)}
                </select>
              </Note>
            )}
            <div style={{ maxHeight: 420, overflow: "auto", border: "1px solid var(--line)", borderRadius: 12 }}>
              <table className="nxa-table"><tbody>
                {rows.map((r, i) => (
                  <tr key={i} style={{ opacity: r.include ? 1 : 0.5 }}>
                    <td style={{ width: 28 }}><input type="checkbox" className="nxa-check" checked={r.include} onChange={() => setRow(i, { include: !r.include })} aria-label={`Add ${r.file.name}`} /></td>
                    <td style={{ overflowWrap: "anywhere" }}>{r.file.name}{r.existing && <span className="nxa-faint"> · already in the library</span>}<div className="nxa-faint" style={{ fontSize: 11 }}>{size(r.file.size)}</div></td>
                    <td style={{ width: 190 }}>
                      <select className={`nxa-input sm${r.include && (!r.platform || r.platform === "unknown") ? " bad" : ""}`} value={r.platform && r.platform !== "unknown" ? r.platform : ""} onChange={(e) => setRow(i, { platform: e.target.value, sure: true })} aria-label={`System for ${r.file.name}`}>
                        <option value="">Choose a system…</option>
                        {CHOICES.map(([id, n]) => <option key={id} value={id}>{n}</option>)}
                        {r.platform && r.platform !== "unknown" && !NAME[r.platform] && <option value={r.platform}>{r.platform}</option>}
                      </select>
                      {!r.sure && r.platform && r.platform !== "unknown" && <div className="nxa-faint" style={{ fontSize: 11 }}>best guess, check it</div>}
                    </td>
                  </tr>
                ))}
              </tbody></table>
            </div>
            <div className="nxa-row nxa-wrap">
              <button className="nxa-btn primary" disabled={!chosen.length || needsSystem.length > 0} onClick={start}><Icon name="cloud" size={14} /> Add {chosen.length} game{chosen.length === 1 ? "" : "s"}</button>
              <button className="nxa-btn" onClick={() => { setRows(null); setError(""); }}>Start over</button>
            </div>
          </div>
        )}

        {up && (
          <div className="nxa-file" style={{ display: "block" }}>
            <div className="nxa-row" style={{ justifyContent: "space-between" }}>
              <b>Adding {up.filesDone} of {up.filesTotal}</b>
              <button className="nxa-btn sm" onClick={() => ctl.current?.abort()}>Stop</button>
            </div>
            <div className="nxa-progress" style={{ marginTop: 6 }}><i style={{ width: `${up.total ? Math.min(100, (up.sent / up.total) * 100) : 0}%` }} /></div>
            <small>{size(up.sent)} of {size(up.total)}{up.speed > 0 ? ` · ${size(up.speed)}/s · ${left(up.eta)} left` : " · working out the speed…"}</small>
            {up.current.length > 0 && <small style={{ display: "block", overflowWrap: "anywhere" }}>Now: {up.current.slice(0, 3).join(", ")}</small>}
            <p className="nxa-faint" style={{ fontSize: 12, margin: "6px 0 0" }}>You can keep using SaveState; leave this page open until it finishes. Each game is playable as soon as it's done.</p>
          </div>
        )}

        {done && (
          <div style={{ display: "grid", gap: 8, gridTemplateColumns: "minmax(0,1fr)" }}>
            <Note kind={done.failed.length ? "warn" : "ok"}>
              {done.added.length} game{done.added.length === 1 ? "" : "s"} added{done.skipped ? `, ${done.skipped} already there` : ""}{done.failed.length ? `, ${done.failed.length} couldn't be added` : ""}. They're in Games now, with cover art arriving over the next minutes.
            </Note>
            {done.failed.length > 0 && <div className="nxa-faint" style={{ fontSize: 12 }}>{done.failed.map((f) => <div key={f.name}>{f.name}: {f.error}</div>)}</div>}
            <div className="nxa-row nxa-wrap">
              <button className="nxa-btn primary" onClick={() => goTab("library")}><Icon name="game" size={14} /> Open Games</button>
              <button className="nxa-btn" onClick={() => setDone(null)}>Add more</button>
            </div>
          </div>
        )}
        {error && <div style={{ marginTop: 10 }}><Note kind={/left out|Stopped/.test(error) ? "info" : "bad"}>{error}</Note></div>}
      </div>
      <div className="nxa-card">
        <h3 style={{ fontSize: 15 }}>Good to know</h3>
        <ul style={{ margin: "6px 0 0", paddingLeft: 20, display: "grid", gap: 6, fontSize: 13.5 }}>
          <li>Games go into the library folder on Google Drive, so they're backed up as they arrive.</li>
          <li>Disc games in several files (a <b>.cue</b> with its <b>.bin</b> files, or <b>.m3u</b> sets): add the whole folder together.</li>
          <li>Arcade and Neo Geo games stay zipped, named as MAME/FBNeo expect (e.g. <b>mslug.zip</b>).</li>
          <li>Some systems need BIOS files: Emulation Setup lists them.</li>
          <li>Only add games you own.</li>
        </ul>
      </div>
    </div>
  );
}
