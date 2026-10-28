// Name lookups that survive a DNS blip. The NAS logged 397 "getaddrinfo
// EAI_AGAIN" failures for the database's address (2026-10-28): each one is a
// sign-in or page that fails while the router's DNS is briefly away. Every
// address looked up is remembered (and kept on disk across restarts); when a
// lookup fails for a temporary reason, the last known address is used.
// Installed once at start-up, it covers everything that connects by name:
// the database, fetch, rclone's API calls.
import dns from "node:dns";
import { readFile, writeFile } from "node:fs/promises";

const TEMPORARY = new Set(["EAI_AGAIN", "ETIMEOUT", "ECONNREFUSED", "ENOTFOUND", "ESERVFAIL"]);

export function installDnsCache(file: string, log: (level: string, msg: string) => void) {
  const known = new Map<string, unknown[]>();
  let dirty = false;
  void readFile(file, "utf8").then((t) => {
    for (const [k, v] of Object.entries(JSON.parse(t) as Record<string, unknown[]>)) if (!known.has(k)) known.set(k, v);
  }).catch(() => {});
  setInterval(() => {
    if (!dirty) return;
    dirty = false;
    void writeFile(file, JSON.stringify(Object.fromEntries(known))).catch(() => {});
  }, 60_000).unref();

  const original = dns.lookup;
  let rescued = 0;
  const patched = function (hostname: string, options: any, callback?: any) {
    if (typeof options === "function") { callback = options; options = {}; }
    else if (typeof options === "number") options = { family: options };
    else options = options ?? {};
    // Addresses typed as numbers need no lookup and nothing to remember.
    const key = `${hostname}|${options.family ?? 0}|${options.all ? 1 : 0}`;
    return (original as any).call(dns, hostname, options, (err: NodeJS.ErrnoException | null, ...rest: unknown[]) => {
      if (!err) {
        const prev = known.get(key);
        if (!prev || JSON.stringify(prev) !== JSON.stringify(rest)) { known.set(key, rest); dirty = true; }
        return callback(null, ...rest);
      }
      const hit = known.get(key);
      if (hit && TEMPORARY.has(String(err.code))) {
        if (rescued++ % 50 === 0) log("WARN", `DNS didn't answer for ${hostname} (${err.code}); using its last known address`);
        return callback(null, ...hit);
      }
      callback(err, ...rest);
    });
  };
  (dns as any).lookup = patched;
}
