/**
 * Game mode: notice when a game is running on the host PC and get out of its way.
 *
 * The host shares its CPU, GPU, disk and uplink with whatever the owner is
 * playing. While a game is detected the server:
 *   - drops itself (and the ffmpeg processes it runs) to below-normal priority,
 *     so streams to other people keep going but never win against the game;
 *   - holds back background work (library scans, artwork, compression,
 *     wanted-retries; callers ask `active()` before starting);
 *   - switches qBittorrent to its alternative speed limits.
 * Everything is put back a little after the game exits.
 *
 * Detection (Windows): one small PowerShell helper stays running and reports
 * the foreground window's process and the shell's "a full-screen Direct3D app
 * is running" state every few seconds. A process counts as a game when it is
 * a known emulator, lives in a game store's install folder (Steam, Epic, GOG,
 * Xbox, ...) or one of the host's PC-game folders, or runs exclusive
 * full-screen. Once a game is seen, its process id is tracked, so alt-tabbing
 * out does not end game mode; only the process exiting does.
 *
 * NEXUS_GAME_MODE=off disables it; NEXUS_GAME_EXES and NEXUS_GAME_DIRS
 * (comma/semicolon lists) add processes and folders to recognise.
 */
import type express from "express";
import os from "node:os";
import path from "node:path";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

export type GameModeDeps = {
  persistDir: string;
  /** Install folders of the host's PC games (Steam/Epic/GOG libraries). */
  pcGameDirs: () => string[];
  /** GPU utilisation 0-100, or -1 when unknown. */
  gpuLoad: () => number;
  /** Turn qBittorrent's alternative speed limits on or off; resolves false when it is not reachable. */
  throttleTorrents?: (on: boolean) => Promise<boolean>;
  /** Tell signed-in admins (SSE). */
  announce?: (state: GameModeStatus) => void;
  log: (level: string, msg: string) => void;
};

export type GameModeStatus = {
  supported: boolean;
  setting: "auto" | "on" | "off";
  active: boolean;
  game: string | null;
  since: number | null;
  reason: string | null;
  torrentsThrottled: boolean;
  /** The app in front right now, so an admin can mark it as a game. */
  foreground: string | null;
  /** Process names an admin has marked as games (without .exe). */
  myGames: string[];
};

const EMULATORS = new Set([
  "retroarch", "pcsx2", "pcsx2-qt", "pcsx2-qtx64", "pcsx2-qtx64-avx2", "dolphin", "rpcs3", "ppssppwindows", "ppssppwindows64",
  "ppssppsdl", "ppssppqt", "duckstation-qt-x64-releaseltcg", "duckstation-nogui-x64-releaseltcg", "duckstation", "cemu",
  "xemu", "xenia", "xenia_canary", "yuzu", "ryujinx", "ryujinx.ava", "eden", "sudachi", "suyu", "citron", "citra-qt",
  "lime3ds", "azahar", "melonds", "desmume", "mgba", "visualboyadvance-m", "snes9x", "snes9x-x64", "bsnes", "mesen",
  "project64", "mupen64plus-ui-console", "rmg", "simple64-gui", "redream", "flycast", "mame", "vita3k", "shadps4",
  "scummvm", "dosbox", "dosbox-x", "ares", "kega-fusion", "blastem", "epsxe", "nucleuscoop",
]);
// Launchers, overlays and tools that live inside game-store folders but are not games.
const NOT_GAMES = new Set([
  "steam", "steamwebhelper", "steamservice", "gameoverlayui", "epicgameslauncher", "epicwebhelper", "galaxyclient",
  "galaxyclient helper", "riotclientservices", "riotclientux", "riotclientuxrender", "upc", "ubisoftconnect", "eadesktop",
  "ealauncher", "origin", "battle.net", "agent", "rockstarservice", "launcher", "socialclubhelper", "gamingservices",
  "wallpaper32", "wallpaper64", "wallpaperservice32", "webwallpaper32", "ui32", "crashhandler", "unitycrashhandler64",
  "chrome", "msedge", "firefox", "brave", "opera", "vivaldi", "explorer", "vlc", "mpv", "mpc-hc64", "mpc-be64", "potplayermini64",
  "wmplayer", "obs64", "code", "devenv", "powershell", "windowsterminal", "cmd", "node", "applicationframehost", "textinputhost",
  "video.ui", "microsoft.media.player", "mediaplayer", "photos", "searchhost", "shellexperiencehost", "lockapp", "dwm", "taskmgr", "discord", "spotify", "teams", "zoom", "slack",
]);
const STORE_DIRS = /\\(steamapps\\common|epic games|gog games|gog galaxy\\games|riot games|xboxgames|ubisoft game launchers\\games|ea games|origin games|rockstar games|roblox\\versions|games)\\/i;

const HELPER = String.raw`
param([int]$ServerPid)
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -Namespace Nx -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint pid);
[DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int state);
'@
$lastPid = 0; $name = ''; $exe = ''
while ($true) {
  # The server was killed without a chance to stop this helper.
  if (-not (Get-Process -Id $ServerPid -ErrorAction SilentlyContinue)) { exit }
  [int]$state = 0; [void][Nx.Win]::SHQueryUserNotificationState([ref]$state)
  [uint32]$fgPid = 0; [void][Nx.Win]::GetWindowThreadProcessId([Nx.Win]::GetForegroundWindow(), [ref]$fgPid)
  if ($fgPid -ne $lastPid) {
    $lastPid = $fgPid; $name = ''; $exe = ''
    $p = Get-Process -Id $fgPid
    if ($p) { $name = $p.ProcessName; $exe = $p.Path }
  }
  [Console]::Out.WriteLine(('{0}|{1}|{2}|{3}' -f $state, $fgPid, $name, $exe))
  Start-Sleep -Seconds 5
}
`;

const splitList = (raw: string | undefined) => String(raw ?? "").split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);

export function createGameMode(deps: GameModeDeps) {
  const supported = process.platform === "win32" && process.env.NEXUS_GAME_MODE !== "off";
  const extraExes = new Set(splitList(process.env.NEXUS_GAME_EXES).map((e) => e.toLowerCase().replace(/\.exe$/, "")));
  const extraDirs = splitList(process.env.NEXUS_GAME_DIRS).map((d) => d.toLowerCase().replace(/[\\/]+$/, "") + "\\");

  // Games the built-in rules miss (a game in a folder of its own, a launcher
  // the list does not know): an admin adds them from the Plans > Host PC tab.
  const myGamesFile = path.join(deps.persistDir, "game-mode.json");
  const myGames = new Set<string>();
  readFile(myGamesFile, "utf8").then((raw) => { for (const n of JSON.parse(raw)?.games ?? []) myGames.add(String(n).toLowerCase()); }).catch(() => {});
  const saveMyGames = () => writeFile(myGamesFile, JSON.stringify({ games: [...myGames].sort() }, null, 2)).catch(() => {});
  let foreground: string | null = null;

  let setting: GameModeStatus["setting"] = "auto";
  let active = false;
  let game: { pid: number; name: string; reason: string } | null = null;
  let since: number | null = null;
  let torrentsThrottled = false;
  let helper: ChildProcess | null = null;
  let helperBackoff = 5_000;
  let goneAt = 0;
  let fullscreenBusyTicks = 0;
  let stopping = false;

  const status = (): GameModeStatus => ({
    supported, setting, active, game: active ? (game?.name ?? "Manual") : null, since,
    reason: active ? (game?.reason ?? "turned on by an admin") : null, torrentsThrottled,
    foreground, myGames: [...myGames].sort(),
  });

  const alive = (pid: number) => {
    try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; }
  };

  function classify(state: number, name: string, exe: string): string | null {
    const n = name.toLowerCase();
    if (!n) return null;
    if (myGames.has(n)) return "marked as a game";
    if (NOT_GAMES.has(n)) return null;
    if (EMULATORS.has(n) || extraExes.has(n)) return "emulator";
    const p = exe.toLowerCase();
    if (p) {
      if (extraDirs.some((d) => p.startsWith(d))) return "in a game folder";
      if (STORE_DIRS.test(p)) return "installed game";
      const dirs = deps.pcGameDirs();
      if (dirs.some((d) => d && p.startsWith(d.toLowerCase().replace(/[\\/]+$/, "") + "\\"))) return "library game";
    }
    // 3 = QUNS_RUNNING_D3D_FULL_SCREEN: exclusive full-screen Direct3D.
    if (state === 3) return "full-screen game";
    // 2 = QUNS_BUSY: some full-screen app. Only a game if it is also working the GPU.
    if (state === 2 && deps.gpuLoad() >= 45) return ++fullscreenBusyTicks >= 3 ? "full-screen, GPU busy" : null;
    fullscreenBusyTicks = 0;
    return null;
  }

  function setPriorities(low: boolean) {
    const prio = low ? os.constants.priority.PRIORITY_BELOW_NORMAL : os.constants.priority.PRIORITY_NORMAL;
    try { os.setPriority(0, prio); } catch { /* not permitted: leave as is */ }
    if (process.platform !== "win32") return;
    // ffmpeg and rclone uploads started from now on inherit a below-normal class from this
    // process; the ones already running are changed here.
    const cls = low ? "BelowNormal" : "Normal";
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid}" | Where-Object { $_.Name -match '^(ffmpeg|ffprobe|rclone)' } | ForEach-Object { try { (Get-Process -Id $_.ProcessId).PriorityClass = '${cls}' } catch {} }`],
      { windowsHide: true, timeout: 20_000 }, () => {});
  }

  async function apply(next: boolean, why: string) {
    if (next === active) return;
    active = next;
    since = next ? Date.now() : null;
    setPriorities(next);
    if (deps.throttleTorrents) {
      // Only undo a throttle this module applied, never one the owner set by hand.
      if (next) torrentsThrottled = await deps.throttleTorrents(true).catch(() => false);
      else if (torrentsThrottled) { await deps.throttleTorrents(false).catch(() => false); torrentsThrottled = false; }
    }
    deps.log("INFO", next ? `Game mode on: ${why}` : `Game mode off: ${why}`);
    deps.announce?.(status());
  }

  function onTick(state: number, pid: number, name: string, exe: string) {
    foreground = name || null;
    if (setting !== "auto") return;
    if (game && !alive(game.pid)) {
      // Launchers hand over to the real game, and games restart themselves
      // between menus, so wait before deciding it is over.
      if (!goneAt) goneAt = Date.now();
      else if (Date.now() - goneAt > 25_000) {
        const ended = game.name;
        game = null; goneAt = 0;
        void apply(false, `${ended} closed`);
      }
    } else goneAt = 0;

    const reason = pid ? classify(state, name, exe) : null;
    if (reason && (!game || game.pid !== pid)) {
      game = { pid, name: exe ? path.win32.basename(exe, ".exe") : name, reason };
      goneAt = 0;
      void apply(true, `${game.name} (${reason})`);
    }
  }

  async function startHelper() {
    if (!supported || helper || stopping) return;
    const file = path.join(deps.persistDir, "game-watch.ps1");
    try { await writeFile(file, HELPER); } catch (e: any) { deps.log("WARN", `Game mode: cannot write helper (${e?.message ?? e})`); return; }
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file, "-ServerPid", String(process.pid)],
      { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    helper = child;
    try { os.setPriority(child.pid!, os.constants.priority.PRIORITY_LOW); } catch { /* fine */ }
    let buf = "";
    let lines = 0;
    child.stdout!.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        const [state, pid, name, ...exe] = line.split("|");
        if (!/^\d+$/.test(state ?? "")) continue;
        if (++lines === 1) helperBackoff = 5_000;
        try { onTick(Number(state), Number(pid) || 0, name ?? "", exe.join("|")); } catch { /* never kill the reader */ }
      }
    });
    const ended = () => {
      if (helper !== child) return;
      helper = null;
      if (stopping) return;
      helperBackoff = Math.min(10 * 60_000, helperBackoff * 2);
      setTimeout(() => { void startHelper(); }, helperBackoff).unref?.();
    };
    child.on("exit", ended);
    child.on("error", ended);
  }

  function stop() {
    stopping = true;
    try { helper?.kill(); } catch { /* gone */ }
    helper = null;
  }
  process.once("exit", stop);

  function register(app: express.Express) {
    app.get("/api/host/game-mode", (_req, res) => { res.json(status()); });
    app.post("/api/host/game-mode", async (req, res) => {
      const mode = req.body?.mode;
      if (mode !== "auto" && mode !== "on" && mode !== "off") return res.status(400).json({ error: "mode must be auto, on or off" });
      setting = mode;
      if (mode === "on") { game = null; await apply(true, "turned on by an admin"); }
      else if (mode === "off") { game = null; await apply(false, "turned off by an admin"); }
      else if (!game) await apply(false, "back to automatic");
      res.json(status());
    });
    app.post("/api/host/game-mode/games", async (req, res) => {
      const name = String(req.body?.name ?? "").trim().toLowerCase().replace(/\.exe$/, "");
      if (!/^[\w .+-]{1,80}$/.test(name)) return res.status(400).json({ error: "Give the program's name, for example eldenring" });
      if (req.body?.remove) {
        myGames.delete(name);
        if (game && game.name.toLowerCase() === name && setting === "auto") { game = null; await apply(false, `${name} is no longer marked as a game`); }
      } else myGames.add(name);
      await saveMyGames();
      res.json(status());
    });
  }

  // Task Scheduler starts its tasks at below-normal priority and children
  // inherit it, so the server and every ffmpeg it ran were permanently
  // deprioritised (streams stuttered whenever the PC was busy with anything).
  // Normal is the baseline; below-normal is what game mode is for.
  try { os.setPriority(0, os.constants.priority.PRIORITY_NORMAL); } catch { /* not permitted: leave as is */ }
  if (supported) setTimeout(() => { void startHelper(); }, 20_000).unref?.();

  return { register, active: () => active, status, stop };
}
