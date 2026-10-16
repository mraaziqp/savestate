/**
 * Mini Games: small browser games (usually made with the agent builder) that
 * the admins upload and every member can play.
 *
 * A game is one .html file, or a .zip of a web game with an index.html. It is
 * stored under <persist>/minigames/<id>/site and served from /mg/<id>/.
 *
 * Games are someone else's JavaScript running on our domain, so they are
 * never trusted with the site: every file is served with a CSP `sandbox`
 * (no allow-same-origin), which gives the page an origin of its own even
 * when opened directly. It cannot read the sign-in token in localStorage,
 * the session cookie or call the API as the player. The player page also
 * frames it with the same sandbox. Because a sandboxed page has no
 * localStorage (games keep high scores there and would crash), a small shim
 * is put at the top of each HTML page: storage lives in memory and is handed
 * to the parent page, which keeps it per game on that device.
 *
 * Game ids are random (96 bits) and the files need no token (a page in its
 * own origin can't send one), so a game is reachable by anyone who has its
 * address, the same as a shared link. The list of games needs a signed-in member.
 *
 * Publishing: admins upload on the Mini Games page, or the agent builder posts
 * the file with a publish key created on that page:
 *   curl -X POST "https://<site>/api/minigames/publish?title=Snake" \
 *        -H "X-SaveState-Publish-Key: ssk_..." -H "X-Filename: snake.html" \
 *        --data-binary @snake.html
 */
import type express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { createReadStream } from "node:fs";
import { readFile, writeFile, mkdir, rm, rename, readdir, stat } from "node:fs/promises";
import type { Caller } from "./access.ts";
import { receipt, humanBytes } from "./receipts.ts";

export type MiniGamesDeps = {
  persistDir: string;
  /** The Agent Builder's folder on this PC; its games appear here (null: not linked). */
  agentBuilderDir: string | null;
  callerOf: (req: express.Request) => Promise<Caller>;
  log: (level: string, msg: string) => void;
};

type Game = {
  id: string;
  title: string;
  description: string;
  author: string;
  entry: string;          // the HTML file that starts the game, relative to site/
  cover: string | null;   // file name under the game folder, or null
  bytes: number;
  files: number;
  plays: number;
  createdAt: string;
  updatedAt: string;
  addedBy: string | null;
  source: "upload" | "publish-key" | "agent-builder";
  /** Agent Builder games: which game it is (games/snake, builds/new_pgame) and the build's time. */
  sourceKey?: string;
  sourceStamp?: number;
};

/** A game the Agent Builder has made, found on disk (see scanAgentBuilder). */
type Candidate = {
  key: string;            // games/snake or builds/new_pgame_1791239989502
  group: string;          // one game across its build attempts: games/snake, builds/new_pgame
  dir: string;            // the folder holding index.html
  title: string;
  description: string;
  status: "finished" | "passed" | "unchecked";
  stamp: number;          // index.html's modified time
};

// A build counts as a game when its name or brief says so (the Agent
// Builder's own test, plus the names its game orders use).
const GAME_WORDS = /\b(games?|arcade|platformer|shooter|rpg|roguelike|puzzle|racing|runner|tower defen[cs]e|strategy|base builder|snake|invaders?|brick|breaker|clan|pgame|tetris|pong|asteroids)\b/i;
const GENERIC_TITLE = /^(vite|react|vite \+ react|app|web app|untitled|index|document)( app)?$/i;

const MAX_UPLOAD = 300 * 1024 * 1024;     // a zip or html as sent
const MAX_UNPACKED = 600 * 1024 * 1024;   // all files of one game
const MAX_FILES = 5000;
const MAX_COVER = 8 * 1024 * 1024;

// What a game page may do: run scripts, lock the pointer, show alerts and
// forms, open links in a new tab. Never allow-same-origin.
const SANDBOX = "sandbox allow-scripts allow-pointer-lock allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm", ".data": "application/octet-stream", ".pck": "application/octet-stream",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".bmp": "image/bmp",
  ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".flac": "audio/flac",
  ".mp4": "video/mp4", ".webm": "video/webm",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
  ".glb": "model/gltf-binary", ".gltf": "model/gltf+json", ".xml": "application/xml",
};

/**
 * Put at the top of every HTML page of a game. In the sandbox, touching
 * localStorage, sessionStorage or document.cookie throws; games then die on
 * their first high-score write. This gives them working stand-ins and sends
 * localStorage to the player page (which saves it for that game).
 */
const SHIM = `<script>(function(){try{window.localStorage.length;return}catch(e){}
var id=(location.pathname.split("/")[2]||"");
function store(seed,onChange){var d=Object.create(null);if(seed)for(var k in seed)d[k]=String(seed[k]);
var api={getItem:function(k){k=String(k);return k in d?d[k]:null},setItem:function(k,v){d[String(k)]=String(v);onChange&&onChange(d)},
removeItem:function(k){delete d[String(k)];onChange&&onChange(d)},clear:function(){for(var k in d)delete d[k];onChange&&onChange(d)},
key:function(i){return Object.keys(d)[i]||null}};
return new Proxy(api,{get:function(t,p){if(p==="length")return Object.keys(d).length;if(p in t)return t[p];return typeof p==="string"&&p in d?d[p]:undefined},
set:function(t,p,v){if(p in t)return true;d[String(p)]=String(v);onChange&&onChange(d);return true},
deleteProperty:function(t,p){delete d[String(p)];onChange&&onChange(d);return true},
has:function(t,p){return p in t||p in d},ownKeys:function(){return Object.keys(d)},
getOwnPropertyDescriptor:function(t,p){return p in d?{value:d[p],enumerable:true,configurable:true,writable:true}:undefined}})}
var seed=null;try{var m=location.hash.match(/nxs=([^&]+)/);if(m)seed=JSON.parse(decodeURIComponent(escape(atob(decodeURIComponent(m[1])))))}catch(e){}
var timer=0;function save(d){clearTimeout(timer);timer=setTimeout(function(){try{parent.postMessage({nxMiniGame:id,save:Object.assign({},d)},"*")}catch(e){}},250)}
try{Object.defineProperty(window,"localStorage",{value:store(seed,save),configurable:true})}catch(e){}
try{Object.defineProperty(window,"sessionStorage",{value:store(null,null),configurable:true})}catch(e){}
try{var jar="";Object.defineProperty(document,"cookie",{get:function(){return jar},set:function(v){var kv=String(v).split(";")[0];jar=jar?jar+"; "+kv:kv},configurable:true})}catch(e){}
})();</script>`;

const newId = () => crypto.randomBytes(12).toString("hex");
const isId = (s: string) => /^[a-f0-9]{24}$/.test(s);
const hash = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

function titleFromHtml(html: string): string {
  const m = /<title[^>]*>([^<]{1,120})<\/title>/i.exec(html);
  return m ? m[1].replace(/\s+/g, " ").trim() : "";
}
function titleFromName(name: string): string {
  return path.basename(name, path.extname(name)).replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim() || "Untitled game";
}
/** Insert the storage shim before anything else in the page runs. */
function withShim(html: string): string {
  const head = /<head[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + SHIM + html.slice(head.index + head[0].length);
  const doc = /<html[^>]*>/i.exec(html);
  if (doc) return html.slice(0, doc.index + doc[0].length) + SHIM + html.slice(doc.index + doc[0].length);
  return SHIM + html;
}

export function createMiniGames(deps: MiniGamesDeps) {
  const root = path.join(deps.persistDir, "minigames");
  const indexFile = path.join(root, "games.json");
  const keysFile = path.join(root, "publish-keys.json");
  let games: Game[] | null = null;

  async function load(): Promise<Game[]> {
    if (games) return games;
    try { games = JSON.parse(await readFile(indexFile, "utf8")); } catch { games = []; }
    return games!;
  }
  async function save() {
    await mkdir(root, { recursive: true });
    const tmp = `${indexFile}.tmp`;
    await writeFile(tmp, JSON.stringify(games ?? [], null, 2));
    await rename(tmp, indexFile);
  }
  type Key = { id: string; name: string; hash: string; createdAt: string; lastUsedAt: string | null };
  async function loadKeys(): Promise<Key[]> {
    try { return JSON.parse(await readFile(keysFile, "utf8")); } catch { return []; }
  }
  async function saveKeys(keys: Key[]) {
    await mkdir(root, { recursive: true });
    await writeFile(keysFile, JSON.stringify(keys, null, 2));
  }

  const view = (g: Game) => ({
    id: g.id, title: g.title, description: g.description, author: g.author, bytes: g.bytes, files: g.files,
    plays: g.plays, createdAt: g.createdAt, updatedAt: g.updatedAt,
    // The version segment changes when the files are replaced, so cached
    // copies (browser and Cloudflare) of the old scripts are never mixed in.
    playUrl: `/mg/${g.id}/~${Date.parse(g.updatedAt).toString(36)}/${g.entry.split("/").map(encodeURIComponent).join("/")}`,
    coverUrl: g.cover ? `/mg-cover/${g.id}?v=${encodeURIComponent(g.updatedAt)}` : null,
  });

  /**
   * Unpack an upload into a fresh folder. Returns the entry page and totals.
   * A zip may wrap everything in one folder; the shallowest index.html wins,
   * else the only .html file. Paths that climb out of the folder are refused.
   */
  async function unpack(buf: Buffer, filename: string, dest: string): Promise<{ entry: string; bytes: number; files: number; title: string }> {
    const ext = path.extname(filename).toLowerCase();
    await mkdir(dest, { recursive: true });
    const looksHtml = /^\s*(<!doctype html|<html|<head|<body|<script|<canvas|<meta|<!--)/i.test(buf.subarray(0, 512).toString("utf8"));
    if (ext === ".html" || ext === ".htm" || (!ext && looksHtml)) {
      await writeFile(path.join(dest, "index.html"), buf);
      return { entry: "index.html", bytes: buf.length, files: 1, title: titleFromHtml(buf.toString("utf8")) };
    }
    if (ext !== ".zip" && !(buf[0] === 0x50 && buf[1] === 0x4b)) throw Object.assign(new Error("Upload a .html file or a .zip of the game."), { status: 400 });

    const AdmZip = (await import("adm-zip")).default;
    let zip: any;
    try { zip = new AdmZip(buf); } catch { throw Object.assign(new Error("That zip file couldn't be opened."), { status: 400 }); }
    const entries = zip.getEntries().filter((e: any) => !e.isDirectory && !/(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db)(\/|$)/i.test(e.entryName));
    if (!entries.length) throw Object.assign(new Error("The zip is empty."), { status: 400 });
    if (entries.length > MAX_FILES) throw Object.assign(new Error(`The zip has more than ${MAX_FILES} files.`), { status: 400 });

    const names = entries.map((e: any) => String(e.entryName).replace(/\\/g, "/"));
    const htmls = names.filter((n: string) => /\.html?$/i.test(n));
    const index = htmls.filter((n: string) => /(^|\/)index\.html?$/i.test(n)).sort((a: string, b: string) => a.split("/").length - b.split("/").length)[0]
      ?? (htmls.length === 1 ? htmls[0] : "");
    if (!index) throw Object.assign(new Error("No index.html in the zip. Put the game's start page at index.html."), { status: 400 });
    const base = index.includes("/") ? index.slice(0, index.lastIndexOf("/") + 1) : "";

    let bytes = 0, files = 0;
    const destRoot = path.resolve(dest) + path.sep;
    for (let i = 0; i < entries.length; i++) {
      const name: string = names[i];
      if (base && !name.startsWith(base)) continue;
      const rel = name.slice(base.length);
      if (!rel || rel.startsWith("/") || rel.split("/").some((p) => p === ".." || p === "")) continue;
      const out = path.resolve(dest, rel);
      if (!out.startsWith(destRoot)) continue;
      const data: Buffer = entries[i].getData();
      bytes += data.length;
      if (bytes > MAX_UNPACKED) throw Object.assign(new Error("The game is larger than 600 MB unpacked."), { status: 400 });
      await mkdir(path.dirname(out), { recursive: true });
      await writeFile(out, data);
      files++;
    }
    const entry = index.slice(base.length);
    const html = await readFile(path.join(dest, entry), "utf8").catch(() => "");
    return { entry, bytes, files, title: titleFromHtml(html) };
  }

  async function addGame(buf: Buffer, filename: string, meta: { title?: string; description?: string; author?: string }, by: { userId: string | null; name: string; source: Game["source"] }) {
    const list = await load();
    const id = newId();
    const dir = path.join(root, id);
    try {
      const got = await unpack(buf, filename, path.join(dir, "site"));
      const now = new Date().toISOString();
      const game: Game = {
        id, entry: got.entry, bytes: got.bytes, files: got.files, plays: 0, cover: null,
        title: String(meta.title ?? "").trim().slice(0, 120) || got.title || titleFromName(filename),
        description: String(meta.description ?? "").trim().slice(0, 2000),
        author: String(meta.author ?? "").trim().slice(0, 80),
        createdAt: now, updatedAt: now, addedBy: by.userId, source: by.source,
      };
      list.unshift(game);
      await save();
      receipt({ kind: "library", title: `Mini game added: ${game.title}`, detail: `${game.files} file${game.files === 1 ? "" : "s"}, ${humanBytes(game.bytes)}${by.source === "publish-key" ? `, published by ${by.name}` : ""}`, userId: by.userId, actor: by.name, bytes: game.bytes, data: { id } });
      deps.log("INFO", `[minigames] added ${game.title} (${id}) by ${by.name}`);
      return game;
    } catch (err) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  }

  const fail = (res: express.Response, err: any) => res.status(err?.status ?? 500).json({ error: err?.message ?? "Something went wrong." });
  const raw = (limit: number): express.RequestHandler => (req, res, next) => {
    // Bodies arrive as raw bytes; express.raw() would buffer any size first.
    // A body some parser already read (a JSON content type) can't be a game.
    if ((req as any)._body || req.readableEnded) {
      if (Buffer.isBuffer(req.body) && req.body.length) { (req as any).rawBody = req.body; return next(); }
      return res.status(400).json({ error: "Send the file itself as the request body (Content-Type: application/octet-stream)." });
    }
    const chunks: Buffer[] = []; let size = 0; let done = false;
    const stop = (status: number, error: string) => { if (done) return; done = true; res.status(status).json({ error }); req.destroy(); };
    req.on("data", (c: Buffer) => { size += c.length; if (size > limit) return stop(413, `That file is larger than ${Math.round(limit / 1024 / 1024)} MB.`); chunks.push(c); });
    req.on("end", () => { if (done) return; done = true; (req as any).rawBody = Buffer.concat(chunks); next(); });
    req.on("error", () => stop(400, "The upload was interrupted."));
  };
  const filenameOf = (req: express.Request) => {
    let n = String(req.headers["x-filename"] ?? req.query.filename ?? "");
    try { n = decodeURIComponent(n); } catch { /* as sent */ }
    return path.basename(n.replace(/\\/g, "/")) || "game.html";
  };
  async function requireAdmin(req: express.Request, res: express.Response): Promise<Caller | null> {
    const c = await deps.callerOf(req);
    if (!c.authed) { res.status(401).json({ error: "Sign in to do this." }); return null; }
    if (!c.admin) { res.status(403).json({ error: "Only the host's admins can add or change mini games." }); return null; }
    return c;
  }

  // ── The Agent Builder link ──────────────────────────────────────────────
  // The Agent Builder (and Jarvis, which orders games from it) runs on this
  // PC. Its finished games sit in <builder>/games/<name>/index.html, and each
  // build attempt in <builder>/builds/<name>_<time>/dist/index.html, with
  // data/builds.json saying which attempts passed every check. Finished and
  // passing games are put on the shelf by themselves; a newer passing build
  // of the same game replaces the files in place (plays and cover kept).
  // Everything else is listed for an admin to add. A game an admin removes
  // is never added back by itself.
  const dismissedFile = path.join(root, "agent-builder-removed.json");
  async function dismissed(): Promise<Set<string>> {
    try { return new Set(JSON.parse(await readFile(dismissedFile, "utf8"))); } catch { return new Set(); }
  }
  async function dismiss(key: string) {
    const s = await dismissed(); s.add(key);
    await mkdir(root, { recursive: true });
    await writeFile(dismissedFile, JSON.stringify([...s], null, 2));
  }

  // A scan reads a few dozen folders on another drive; the page asks often.
  let lastScan: { at: number; list: Candidate[] } | null = null;
  async function scanAgentBuilder(maxAgeMs = 60_000): Promise<Candidate[]> {
    if (lastScan && Date.now() - lastScan.at < maxAgeMs) return lastScan.list;
    const list = await scanAgentBuilderNow();
    lastScan = { at: Date.now(), list };
    return list;
  }

  async function scanAgentBuilderNow(): Promise<Candidate[]> {
    const base = deps.agentBuilderDir;
    if (!base) return [];
    const out: Candidate[] = [];
    for (const name of await readdir(path.join(base, "games")).catch(() => [] as string[])) {
      const dir = path.join(base, "games", name);
      const st = await stat(path.join(dir, "index.html")).catch(() => null);
      if (!st?.isFile()) continue;
      const t = titleFromHtml(await readFile(path.join(dir, "index.html"), "utf8").catch(() => ""));
      out.push({ key: `games/${name}`, group: `games/${name}`, dir, title: t && !GENERIC_TITLE.test(t) ? t : titleFromName(name), description: "", status: "finished", stamp: st.mtimeMs });
    }
    let records: any[] = [];
    try {
      const j = JSON.parse(await readFile(path.join(base, "data", "builds.json"), "utf8"));
      records = Array.isArray(j) ? j : Array.isArray(j?.builds) ? j.builds : Object.values(j ?? {});
    } catch { /* no records */ }
    const same = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
    for (const name of await readdir(path.join(base, "builds")).catch(() => [] as string[])) {
      const dir = path.join(base, "builds", name);
      const st = await stat(path.join(dir, "dist", "index.html")).catch(() => null);
      if (!st?.isFile()) continue;
      const recs = records.filter((r) => r?.outputDir && same(String(r.outputDir), dir));
      const last = recs[recs.length - 1];
      let pkg: any = {};
      try { pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8")); } catch { /* none */ }
      // Folder names join words with _ and -, which a \b test reads as one word.
      if (!GAME_WORDS.test(`${name} ${last?.projectName ?? ""} ${last?.description ?? ""} ${pkg.description ?? ""}`.replace(/[_-]+/g, " "))) continue;
      const group = name.replace(/_\d{9,}$/, "");
      const t = titleFromHtml(await readFile(path.join(dir, "dist", "index.html"), "utf8").catch(() => ""));
      const title = String(last?.projectName ?? "").trim() || (t && !GENERIC_TITLE.test(t) ? t : titleFromName(group.replace(/^(new|order|project|academy)_/, "")));
      out.push({
        key: `builds/${name}`, group: `builds/${group}`, dir: path.join(dir, "dist"), title,
        description: String(last?.description ?? pkg.description ?? "").replace(/^Build (me )?(a |an )?/i, "").trim().slice(0, 500),
        status: recs.some((r) => r?.passed === true) ? "passed" : "unchecked", stamp: st.mtimeMs,
      });
    }
    return out.sort((a, b) => b.stamp - a.stamp);
  }

  /** Copy a game folder into a game's site, skipping tooling folders. */
  async function copyGame(src: string, dest: string): Promise<{ bytes: number; files: number }> {
    let bytes = 0, files = 0;
    const walk = async (from: string, to: string) => {
      await mkdir(to, { recursive: true });
      for (const e of await readdir(from, { withFileTypes: true })) {
        if (e.isDirectory() && /^(node_modules|\.git|\.cache)$/.test(e.name)) continue;
        const a = path.join(from, e.name), b = path.join(to, e.name);
        if (e.isDirectory()) { await walk(a, b); continue; }
        if (!e.isFile()) continue;
        const data = await readFile(a);
        bytes += data.length; files++;
        if (bytes > MAX_UNPACKED || files > MAX_FILES) throw Object.assign(new Error("That game is too large to add (over 600 MB or 5000 files)."), { status: 400 });
        await writeFile(b, data);
      }
    };
    await walk(src, dest);
    return { bytes, files };
  }

  /** Put an Agent Builder game on the shelf, or refresh the one already there. */
  async function importCandidate(c: Candidate, by: { userId: string | null; name: string }): Promise<{ game: Game; updated: boolean }> {
    const list = await load();
    const existing = list.find((g) => g.source === "agent-builder" && g.sourceKey === c.group);
    const id = existing?.id ?? newId();
    const dir = path.join(root, id);
    const fresh = path.join(dir, `site-${Date.now()}`);
    try {
      const got = await copyGame(c.dir, fresh);
      await rm(path.join(dir, "site"), { recursive: true, force: true });
      await rename(fresh, path.join(dir, "site"));
      const now = new Date().toISOString();
      let game: Game;
      if (existing) {
        Object.assign(existing, { entry: "index.html", bytes: got.bytes, files: got.files, updatedAt: now, sourceStamp: c.stamp });
        if (!existing.description && c.description) existing.description = c.description;
        game = existing;
      } else {
        game = {
          id, entry: "index.html", bytes: got.bytes, files: got.files, plays: 0, cover: null,
          title: c.title.slice(0, 120), description: c.description, author: "Agent Builder",
          createdAt: now, updatedAt: now, addedBy: by.userId, source: "agent-builder", sourceKey: c.group, sourceStamp: c.stamp,
        };
        list.unshift(game);
      }
      await save();
      receipt({ kind: "library", title: `Mini game ${existing ? "updated" : "added"} from the Agent Builder: ${game.title}`, detail: `${got.files} file${got.files === 1 ? "" : "s"}, ${humanBytes(got.bytes)} (${c.key})`, userId: by.userId, actor: by.name, bytes: got.bytes, data: { id: game.id, source: c.key } });
      deps.log("INFO", `[minigames] ${existing ? "updated" : "added"} ${game.title} from the Agent Builder (${c.key})`);
      return { game, updated: !!existing };
    } catch (err) {
      await rm(fresh, { recursive: true, force: true }).catch(() => {});
      if (!existing) await rm(dir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  }

  let syncing: Promise<{ added: number; updated: number }> | null = null;
  /** Add finished and passing Agent Builder games; refresh ones that were rebuilt. */
  function syncAgentBuilder(): Promise<{ added: number; updated: number }> {
    if (syncing) return syncing;
    syncing = (async () => {
      let added = 0, updated = 0;
      const [cands, gone, list] = [await scanAgentBuilder(0), await dismissed(), await load()];
      const newest = new Map<string, Candidate>();
      for (const c of cands) if (c.status !== "unchecked" && !newest.has(c.group)) newest.set(c.group, c);
      for (const c of newest.values()) {
        if (gone.has(c.group)) continue;
        const have = list.find((g) => g.source === "agent-builder" && g.sourceKey === c.group);
        if (have && (have.sourceStamp ?? 0) >= c.stamp) continue;
        try { (await importCandidate(c, { userId: null, name: "Agent Builder" })).updated ? updated++ : added++; }
        catch (err: any) { deps.log("WARN", `[minigames] couldn't add ${c.key} from the Agent Builder: ${err?.message ?? err}`); }
      }
      return { added, updated };
    })().finally(() => { syncing = null; });
    return syncing;
  }

  function register(app: express.Express) {
    // ── The Agent Builder link: admins ────────────────────────────────────
    app.get("/api/minigames/agent-builder", async (req, res) => {
      if (!(await requireAdmin(req, res))) return;
      const base = deps.agentBuilderDir;
      if (!base) return res.json({ linked: false, dir: null, candidates: [] });
      const [cands, list, gone] = [await scanAgentBuilder(), await load(), await dismissed()];
      const seen = new Set<string>();
      res.json({
        linked: true, dir: base,
        candidates: cands.map((c) => {
          const g = list.find((x) => x.source === "agent-builder" && x.sourceKey === c.group);
          const latest = !seen.has(c.group); seen.add(c.group);
          return { key: c.key, group: c.group, title: c.title, description: c.description, status: c.status, builtAt: new Date(c.stamp).toISOString(), latest,
            onShelf: g ? { id: g.id, current: (g.sourceStamp ?? 0) >= c.stamp } : null, removed: gone.has(c.group) };
        }),
      });
    });
    app.post("/api/minigames/agent-builder/add", async (req, res) => {
      const c = await requireAdmin(req, res); if (!c) return;
      const key = String(req.query.key ?? "");
      const cand = (await scanAgentBuilder()).find((x) => x.key === key);
      if (!cand) return res.status(404).json({ error: "That build isn't in the Agent Builder any more." });
      try {
        const gone = await dismissed();
        if (gone.delete(cand.group)) await writeFile(dismissedFile, JSON.stringify([...gone], null, 2));
        const r = await importCandidate(cand, { userId: c.userId, name: c.username ?? "admin" });
        res.json({ ok: true, updated: r.updated, game: view(r.game) });
      } catch (err) { fail(res, err); }
    });
    app.post("/api/minigames/agent-builder/sync", async (req, res) => {
      if (!(await requireAdmin(req, res))) return;
      try { res.json({ ok: true, ...(await syncAgentBuilder()) }); } catch (err) { fail(res, err); }
    });

    // ── The list, for every signed-in member ──────────────────────────────
    app.get("/api/minigames", async (req, res) => {
      const c = await deps.callerOf(req);
      if (!c.authed) return res.status(401).json({ error: "Sign in to see the mini games." });
      const list = await load();
      res.json({ games: list.map(view), canManage: c.admin });
    });

    app.post("/api/minigames/:id/played", async (req, res) => {
      const c = await deps.callerOf(req);
      if (!c.authed) return res.status(401).json({ error: "Sign in first." });
      const g = (await load()).find((x) => x.id === req.params.id);
      if (!g) return res.status(404).json({ error: "No such game." });
      g.plays++;
      await save().catch(() => {});
      res.json({ ok: true, plays: g.plays });
    });

    // ── Adding and changing games: admins ─────────────────────────────────
    app.post("/api/minigames", raw(MAX_UPLOAD), async (req, res) => {
      const c = await requireAdmin(req, res); if (!c) return;
      try {
        const g = await addGame((req as any).rawBody, filenameOf(req), { title: req.query.title as string, description: req.query.description as string, author: req.query.author as string },
          { userId: c.userId, name: c.username ?? "admin", source: "upload" });
        res.json({ ok: true, game: view(g) });
      } catch (err) { fail(res, err); }
    });

    // The agent builder publishes with a key instead of a sign-in.
    app.post("/api/minigames/publish", raw(MAX_UPLOAD), async (req, res) => {
      const sent = String(req.headers["x-savestate-publish-key"] ?? "").trim();
      const keys = await loadKeys();
      const key = sent ? keys.find((k) => crypto.timingSafeEqual(Buffer.from(k.hash), Buffer.from(hash(sent)))) : undefined;
      if (!key) return res.status(401).json({ error: "Send a valid X-SaveState-Publish-Key header. Create one on the Mini Games page." });
      try {
        const g = await addGame((req as any).rawBody, filenameOf(req), { title: req.query.title as string, description: req.query.description as string, author: req.query.author as string },
          { userId: null, name: key.name, source: "publish-key" });
        key.lastUsedAt = new Date().toISOString();
        await saveKeys(keys);
        const proto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() || req.protocol;
        res.json({ ok: true, game: view(g), url: `${proto}://${req.get("host")}/?tab=minigames&game=${g.id}` });
      } catch (err) { fail(res, err); }
    });

    app.patch("/api/minigames/:id", async (req, res) => {
      const c = await requireAdmin(req, res); if (!c) return;
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const g = (await load()).find((x) => x.id === req.params.id);
      if (!g) return res.status(404).json({ error: "No such game." });
      if (typeof body.title === "string" && body.title.trim()) g.title = body.title.trim().slice(0, 120);
      if (typeof body.description === "string") g.description = body.description.trim().slice(0, 2000);
      if (typeof body.author === "string") g.author = body.author.trim().slice(0, 80);
      g.updatedAt = new Date().toISOString();
      await save();
      res.json({ ok: true, game: view(g) });
    });

    // Replace the game's files and keep its title, cover and play count.
    app.put("/api/minigames/:id/files", raw(MAX_UPLOAD), async (req, res) => {
      const c = await requireAdmin(req, res); if (!c) return;
      const g = (await load()).find((x) => x.id === req.params.id);
      if (!g) return res.status(404).json({ error: "No such game." });
      const dir = path.join(root, g.id);
      const fresh = path.join(dir, `site-${Date.now()}`);
      try {
        const got = await unpack((req as any).rawBody, filenameOf(req), fresh);
        await rm(path.join(dir, "site"), { recursive: true, force: true });
        await rename(fresh, path.join(dir, "site"));
        Object.assign(g, { entry: got.entry, bytes: got.bytes, files: got.files, updatedAt: new Date().toISOString() });
        await save();
        receipt({ kind: "library", title: `Mini game updated: ${g.title}`, detail: `${got.files} files, ${humanBytes(got.bytes)}`, userId: c.userId, actor: c.username, bytes: got.bytes, data: { id: g.id } });
        res.json({ ok: true, game: view(g) });
      } catch (err) {
        await rm(fresh, { recursive: true, force: true }).catch(() => {});
        fail(res, err);
      }
    });

    app.put("/api/minigames/:id/cover", raw(MAX_COVER), async (req, res) => {
      const c = await requireAdmin(req, res); if (!c) return;
      const g = (await load()).find((x) => x.id === req.params.id);
      if (!g) return res.status(404).json({ error: "No such game." });
      const buf: Buffer = (req as any).rawBody;
      const ext = buf[0] === 0x89 && buf[1] === 0x50 ? ".png" : buf[0] === 0xff && buf[1] === 0xd8 ? ".jpg"
        : buf.subarray(0, 4).toString() === "RIFF" && buf.subarray(8, 12).toString() === "WEBP" ? ".webp"
        : buf.subarray(0, 3).toString() === "GIF" ? ".gif" : "";
      if (!ext) return res.status(400).json({ error: "Use a PNG, JPG, WebP or GIF picture." });
      for (const old of [".png", ".jpg", ".webp", ".gif"]) await rm(path.join(root, g.id, `cover${old}`), { force: true }).catch(() => {});
      await writeFile(path.join(root, g.id, `cover${ext}`), buf);
      g.cover = `cover${ext}`;
      g.updatedAt = new Date().toISOString();
      await save();
      res.json({ ok: true, game: view(g) });
    });

    app.delete("/api/minigames/:id", async (req, res) => {
      const c = await requireAdmin(req, res); if (!c) return;
      const list = await load();
      const at = list.findIndex((x) => x.id === req.params.id);
      if (at < 0) return res.status(404).json({ error: "No such game." });
      const [g] = list.splice(at, 1);
      await save();
      // Removed on purpose: the Agent Builder link must not add it back.
      if (g.source === "agent-builder" && g.sourceKey) await dismiss(g.sourceKey).catch(() => {});
      await rm(path.join(root, g.id), { recursive: true, force: true }).catch(() => {});
      receipt({ kind: "library", title: `Mini game removed: ${g.title}`, userId: c.userId, actor: c.username, data: { id: g.id } });
      res.json({ ok: true });
    });

    // ── Publish keys for the agent builder: admins ────────────────────────
    app.get("/api/minigames/keys", async (req, res) => {
      if (!(await requireAdmin(req, res))) return;
      res.json({ keys: (await loadKeys()).map(({ hash: _h, ...k }) => k) });
    });
    app.post("/api/minigames/keys", async (req, res) => {
      const c = await requireAdmin(req, res); if (!c) return;
      const name = String(req.query.name ?? "").trim().slice(0, 60) || "Agent builder";
      const rawKey = `ssk_${crypto.randomBytes(24).toString("base64url")}`;
      const keys = await loadKeys();
      const key = { id: crypto.randomBytes(6).toString("hex"), name, hash: hash(rawKey), createdAt: new Date().toISOString(), lastUsedAt: null };
      keys.push(key);
      await saveKeys(keys);
      receipt({ kind: "key", title: `Mini games publish key created: ${name}`, userId: c.userId, actor: c.username });
      res.json({ ok: true, key: { id: key.id, name, createdAt: key.createdAt }, rawKey });
    });
    app.delete("/api/minigames/keys/:id", async (req, res) => {
      const c = await requireAdmin(req, res); if (!c) return;
      const keys = await loadKeys();
      const left = keys.filter((k) => k.id !== req.params.id);
      if (left.length === keys.length) return res.status(404).json({ error: "No such key." });
      await saveKeys(left);
      receipt({ kind: "key", title: "Mini games publish key revoked", userId: c.userId, actor: c.username });
      res.json({ ok: true });
    });

    // ── The games themselves, sandboxed in their own origin ───────────────
    app.get("/mg-cover/:id", async (req, res) => {
      const g = (await load()).find((x) => x.id === req.params.id);
      if (!g?.cover) return res.status(404).end();
      res.setHeader("Cache-Control", "public, max-age=86400");
      res.type(path.extname(g.cover)).sendFile(path.join(root, g.id, g.cover));
    });

    // /mg/<id>/~<version>/<file>; the version only busts caches and is ignored here.
    app.get(/^\/mg\/([a-f0-9]{24})(?:\/~[0-9a-z]{1,12})?(\/.*)?$/, async (req, res) => {
      const id = (req.params as any)[0] as string;
      if (!isId(id)) return res.status(404).end();
      const g = (await load()).find((x) => x.id === id);
      if (!g) return res.status(404).type("text/plain").send("This game was removed.");
      let rel = ((req.params as any)[1] as string | undefined) ?? "/";
      try { rel = decodeURIComponent(rel); } catch { return res.status(400).end(); }
      if (rel === "/" || rel === "") rel = `/${g.entry}`;
      const site = path.resolve(root, id, "site");
      let file = path.resolve(site, `.${rel}`);
      if (file !== site && !file.startsWith(site + path.sep)) return res.status(403).end();
      const st = await stat(file).catch(() => null);
      if (st?.isDirectory()) { file = path.join(file, "index.html"); }
      const st2 = st?.isDirectory() ? await stat(file).catch(() => null) : st;
      if (!st2?.isFile()) return res.status(404).type("text/plain").send("Not found");

      const ext = path.extname(file).toLowerCase();
      res.setHeader("Content-Security-Policy", SANDBOX);
      res.setHeader("X-Content-Type-Options", "nosniff");
      // The page is its own (opaque) origin, so its scripts, modules and
      // fetch() of its own files are cross-origin and need this.
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      res.setHeader("X-Robots-Tag", "noindex, nofollow");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Content-Type", TYPES[ext] ?? "application/octet-stream");
      if (ext === ".html" || ext === ".htm") {
        // no-transform keeps Cloudflare from injecting its analytics script,
        // which touches localStorage before anything else and throws in the sandbox.
        res.setHeader("Cache-Control", "no-cache, no-transform");
        return res.send(withShim(await readFile(file, "utf8")));
      }
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.setHeader("Content-Length", String(st2.size));
      createReadStream(file).on("error", () => res.destroy()).pipe(res);
    });
  }

  /** Games that lost their files (folder removed by hand) are dropped from the list. */
  async function tidy() {
    const list = await load();
    const present = new Set(await readdir(root).catch(() => [] as string[]));
    const kept = list.filter((g) => present.has(g.id));
    if (kept.length !== list.length) { games = kept; await save(); }
  }

  return { register, tidy, syncAgentBuilder };
}
