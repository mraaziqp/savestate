// Game saves that follow you (browser player side of server/savefiles.ts).
// When a game starts in the browser (EmulatorJS), the host's save for it is
// loaded if it changed elsewhere (a PS Vita, another browser) and this
// device's didn't; while playing, a changed save goes up every 45 s and once
// more when the game closes. The PS Vita app does the same with RetroArch's
// .srm files, so the two carry on from each other.
//
// window.nxSaveSync.start(gameId) / .stop(): called by the player (build.mjs 3q).
const KEY = "nx_save_crc";
const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const synced = () => { try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { return {}; } };
const remember = (id, crc) => { try { const m = synced(); m[id] = crc; localStorage.setItem(KEY, JSON.stringify(m)); } catch { /* private mode */ } };
const auth = () => { try { const t = localStorage.getItem("nexus_token"); return t ? { Authorization: `Bearer ${t}` } : {}; } catch { return {}; } };
const gm = () => window.EJS_emulator?.gameManager ?? null;

let current = null; // { id, timer }

function writeSave(g, bytes) {
  const file = g.getSaveFilePath();
  const parts = file.split("/");
  let dir = "";
  for (let i = 0; i < parts.length - 1; i++) { if (!parts[i]) continue; dir += `/${parts[i]}`; if (!g.FS.analyzePath(dir).exists) g.FS.mkdir(dir); }
  if (g.FS.analyzePath(file).exists) g.FS.unlink(file);
  g.FS.writeFile(file, bytes);
  g.loadSaveFiles();
}

async function push(final) {
  const c = current, g = gm();
  if (!c || !g) return;
  let data = null;
  try { data = g.getSaveFile(true); } catch { return; }
  if (!data || !data.length) return;
  const crc = crc32(data);
  if (synced()[c.id] === crc) return;
  try {
    const r = await fetch(`/api/savefile/${encodeURIComponent(c.id)}`, {
      method: "PUT", body: data, keepalive: !!final && data.length < 60000,
      headers: { ...auth(), "Content-Type": "application/octet-stream", "X-Device": "Browser" },
    });
    if (r.ok) remember(c.id, crc);
  } catch { /* offline: next time */ }
}

async function start(id) {
  stop(true);
  if (!id) return;
  current = { id, timer: setInterval(() => void push(false), 45_000) };
  const g = gm();
  if (!g) return;
  try {
    const r = await fetch(`/api/savefile/${encodeURIComponent(id)}`, { headers: auth() });
    if (!r.ok || current?.id !== id) return;
    const remote = new Uint8Array(await r.arrayBuffer());
    if (!remote.length) return;
    const rc = crc32(remote);
    let local = null;
    try { local = g.getSaveFile(false); } catch { /* no save yet */ }
    const lc = local && local.length ? crc32(local) : null;
    if (rc === lc) { remember(id, rc); return; }
    // Changed on another device, and not here since the last sync: take it.
    if (lc === null || lc === synced()[id]) { writeSave(g, remote); remember(id, rc); }
  } catch { /* offline: play with what's here */ }
}

function stop(silent) {
  if (!current) return;
  clearInterval(current.timer);
  if (!silent) void push(true);
  current = null;
}

if (typeof window !== "undefined") {
  window.nxSaveSync = { start, stop: () => stop(false) };
  addEventListener("pagehide", () => { if (current) void push(true); });
}
