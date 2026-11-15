// The AI model server on this PC (Ollama, for the Agent Builder and Jarvis):
// held off for as long as any reason wants it off ("pause all", "a game"),
// and started again once the last reason lets go, but only when it was SaveState
// that stopped it. A loaded model takes 4-6 GB of an 8 GB graphics card even
// when Ollama's own list says nothing is loaded (its runner, llama-server,
// keeps the weights), so it is stopped, not just asked to let go. The Agent
// Builder's "model-server" hold (data/host-holds.json) keeps its launcher and
// Jarvis from starting it again meanwhile. Reasons are kept on disk, so a
// restart in the middle of a game or a pause still starts it again afterwards.
import path from "node:path";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";

/** This process's environment without SaveState's own settings (.env keys, ports). */
export async function cleanEnv() {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const dotenv = await readFile(path.join(process.cwd(), ".env"), "utf8").catch(() => "");
  for (const line of dotenv.split(/\r?\n/)) { const k = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1]; if (k) delete env[k]; }
  for (const k of Object.keys(env)) if (/^(PORT|HOST|URLS|HTTPS?_PORTS|ASPNETCORE_.*|DOTNET_URLS|NODE_.*|NEXUS_.*|UV_THREADPOOL_SIZE)$/i.test(k)) delete env[k];
  return env;
}

export type ModelServer = ReturnType<typeof createModelServer>;

export function createModelServer(deps: {
  persistDir: string;
  ollamaUrl: string;
  /** The Agent Builder's folder (for its hold file); null when it is not on this PC. */
  agentBuilderDir: string | null;
  log: (level: string, msg: string) => void;
}) {
  const file = path.join(deps.persistDir, "model-server.json");
  let reasons = new Set<string>();
  let stoppedHere = false;
  const loaded = readFile(file, "utf8").then((t) => {
    const j = JSON.parse(t);
    reasons = new Set((j.reasons ?? []).map(String));
    stoppedHere = !!j.stopped;
  }).catch(() => {});
  const save = () => writeFile(file, JSON.stringify({ reasons: [...reasons], stopped: stoppedHere })).catch(() => {});

  const holdsFile = deps.agentBuilderDir ? path.join(deps.agentBuilderDir, "data", "host-holds.json") : null;
  async function setHold(on: boolean) {
    if (!holdsFile) return;
    const holds = await readFile(holdsFile, "utf8").then((t) => JSON.parse(t) as Record<string, unknown>).catch(() => ({} as Record<string, unknown>));
    if (on) holds["model-server"] = { since: new Date().toISOString(), by: `SaveState (${[...reasons].join(", ")})` };
    else delete holds["model-server"];
    await writeFile(holdsFile, JSON.stringify(holds)).catch(() => {});
  }

  const ollamaUp = () => fetch(`${deps.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(4000) }).then((r) => r.ok, () => false);
  const runnerAlive = () => new Promise<boolean>((resolve) => {
    if (process.platform !== "win32") return resolve(false);
    execFile("tasklist", ["/NH", "/FO", "CSV"], { windowsHide: true, timeout: 15_000 },
      (_e, out) => resolve(/^"(ollama|llama-server|ollama app)\.exe"/im.test(String(out ?? ""))));
  });
  const killAll = () => new Promise<void>((done) => {
    if (process.platform !== "win32") return done();
    // Every Ollama process (the server, its tray app) and the model runner.
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "Get-Process | Where-Object { $_.Name -match '^(ollama|llama-server)' } | Stop-Process -Force -ErrorAction SilentlyContinue"],
      { windowsHide: true, timeout: 20_000 }, () => done());
  });

  /** Stops it when it is running; true when something was stopped. */
  async function stopNow(): Promise<boolean> {
    const up = await ollamaUp();
    if (!up && !(await runnerAlive())) return false;
    if (up) {
      // Let go of the models first (a clean unload), then stop the server.
      const names = await fetch(`${deps.ollamaUrl}/api/ps`, { signal: AbortSignal.timeout(5000) })
        .then((r) => r.json()).then((j: any) => (j.models ?? []).map((m: any) => String(m.name))).catch(() => [] as string[]);
      for (const name of names) {
        await fetch(`${deps.ollamaUrl}/api/generate`, { method: "POST", body: JSON.stringify({ model: name, keep_alive: 0 }), signal: AbortSignal.timeout(20_000) }).catch(() => null);
      }
    }
    await killAll();
    return true;
  }

  // "stoppedHere" stays set until the server is really back: a game that
  // starts again while it is coming back (several in a row) must not make
  // SaveState forget that it owes the restart (it did, 2026-11-15).
  const backUp = async () => { stoppedHere = false; await save(); deps.log("INFO", "AI model server is back"); };
  async function startNow() {
    // The Agent Builder's launcher brings it back once the hold is gone; when
    // nothing does within 40 s, it is started here, set up as its Host Manager does.
    for (let i = 0; i < 8; i++) { if (await ollamaUp()) return backUp(); await new Promise((r) => setTimeout(r, 5000)); }
    if (reasons.size) return; // held again meanwhile: started when that lets go
    const exe = [path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Ollama", "ollama.exe"), "C:\\Program Files\\Ollama\\ollama.exe"].find((p) => existsSync(p));
    if (!exe) return;
    const child = spawn(exe, ["serve"], {
      cwd: path.dirname(exe), detached: true, windowsHide: true, stdio: "ignore",
      env: { ...(await cleanEnv()), OLLAMA_CONTEXT_LENGTH: process.env.OLLAMA_NUM_CTX || "16384", OLLAMA_FLASH_ATTENTION: "1", OLLAMA_KV_CACHE_TYPE: "q8_0", OLLAMA_MAX_LOADED_MODELS: "1" },
    });
    child.unref();
    for (let i = 0; i < 12; i++) { await new Promise((r) => setTimeout(r, 5000)); if (await ollamaUp()) return backUp(); }
    deps.log("WARN", "AI model server did not come back; it is started again next time a game ends");
  }

  let busy: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>) => { const p = busy.then(fn, fn); busy = p.catch(() => {}); return p; };

  /**
   * Holds the model server off for `reason` (on) or lets go (off). Resolves
   * true when holding stopped it just now (on), or when letting go started
   * it again (off).
   */
  function hold(reason: string, on: boolean): Promise<boolean> {
    return serial(async () => {
      await loaded;
      if (on) {
        const fresh = !reasons.has(reason);
        reasons.add(reason);
        if (fresh) await setHold(true);
        const stopped = await stopNow();
        if (stopped) { stoppedHere = true; deps.log("INFO", `AI model server stopped (${[...reasons].join(", ")}); it starts again afterwards`); }
        await save();
        return stopped;
      }
      if (!reasons.delete(reason)) return false;
      let started = false;
      if (!reasons.size) {
        await setHold(false);
        if (stoppedHere) { started = true; void startNow().catch(() => {}); deps.log("INFO", "AI model server starting again"); }
      } else await setHold(true);
      await save();
      return started;
    });
  }

  // A restart still owed from before this server started (killed mid-game).
  setTimeout(() => { void loaded.then(() => { if (!reasons.size && stoppedHere) void startNow().catch(() => {}); }); }, 60_000).unref?.();

  // Something may start it while held (a tray app, a manual start).
  setInterval(() => {
    if (!reasons.size) return;
    void serial(async () => { if (reasons.size && (await ollamaUp()) && (await stopNow())) { stoppedHere = true; await save(); } });
  }, 20_000).unref?.();

  return { hold, held: () => reasons.size > 0, reasons: () => [...reasons], stoppedHere: () => stoppedHere };
}
