/**
 * Files still downloading on this PC (torrents into the ROM folders).
 *
 * A torrent creates each file at its full size and fills it in as pieces
 * arrive, so a half-downloaded PS2 disc looks complete: same name, same
 * size. Played, it crashed PCSX2 ("Jump to unaligned address"); copied, it
 * put a broken game on Drive. Windows keeps such files sparse until they
 * are full, and knows how much of each is really on disk, so a PowerShell
 * pass over the folders every few minutes finds them. Until a file is
 * complete it is left out of Games, refused for download, and skipped by
 * Drive copies.
 */
import { execFile } from "node:child_process";
import path from "node:path";

export type Incomplete = { path: string; size: number; onDisk: number; share: number };

const SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -Namespace Nx -Name A -MemberDefinition '[DllImport("kernel32.dll",CharSet=CharSet.Unicode)] public static extern uint GetCompressedFileSizeW(string f, out uint hi);'
$inv = [Globalization.CultureInfo]::InvariantCulture
foreach ($root in $env:NX_ROOTS.Split([char]10)) {
  if (-not $root -or -not (Test-Path -LiteralPath $root)) { continue }
  Get-ChildItem -LiteralPath $root -Recurse -File -Attributes SparseFile | ForEach-Object {
    $hi = [uint32]0; $lo = [Nx.A]::GetCompressedFileSizeW($_.FullName, [ref]$hi)
    $on = ([int64]$hi -shl 32) + $lo
    if ($_.Length -gt 0 -and $on -lt $_.Length * 0.999) { [Console]::Out.WriteLine($_.FullName + [char]9 + $_.Length.ToString($inv) + [char]9 + $on.ToString($inv)) }
  }
}`;

export function createIncompleteFiles(deps: { roots: () => Promise<string[]>; log: (level: string, msg: string) => void }) {
  let byPath = new Map<string, Incomplete>();
  let scannedAt = 0;
  let running: Promise<void> | null = null;

  function scan(): Promise<void> {
    if (process.platform !== "win32") return Promise.resolve();
    running ??= (async () => {
      const roots = [...new Set((await deps.roots().catch(() => [])).filter(Boolean))];
      // Folders on Google Drive are never half-downloaded torrents.
      const local = roots.filter((r) => /^[A-Za-z]:[\\/]/.test(r) && !/nexus-cloud-media|My Drive/i.test(r));
      if (!local.length) { byPath = new Map(); scannedAt = Date.now(); return; }
      const out = await new Promise<string>((resolve) => {
        execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", SCRIPT],
          { windowsHide: true, timeout: 5 * 60_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, NX_ROOTS: local.join("\n") } },
          (_err, stdout) => resolve(String(stdout ?? "")));
      });
      const next = new Map<string, Incomplete>();
      for (const line of out.split(/\r?\n/)) {
        const [p, size, onDisk] = line.split("\t");
        if (!p || !size) continue;
        const s = Number(size), o = Number(onDisk);
        if (s > 0) next.set(path.resolve(p).toLowerCase(), { path: p, size: s, onDisk: o, share: o / s });
      }
      if (next.size !== byPath.size) deps.log("INFO", `${next.size} file(s) still downloading in the game folders`);
      byPath = next;
      scannedAt = Date.now();
    })().finally(() => { running = null; });
    return running;
  }
  const timer = setInterval(() => { void scan(); }, 3 * 60_000);
  timer.unref?.();
  setTimeout(() => { void scan(); }, 500).unref?.();
  void scan();

  return {
    scan,
    /** How much of this file is downloaded (0..1), or null when it is complete. */
    get(file: string): Incomplete | null { return byPath.get(path.resolve(file).toLowerCase()) ?? null; },
    list: () => [...byPath.values()],
    scannedAt: () => scannedAt,
  };
}
