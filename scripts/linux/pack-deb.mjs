#!/usr/bin/env node
// Packs a package folder (with DEBIAN/control) into a .deb without dpkg-deb,
// for building on Windows (Git Bash) when WSL isn't available. Windows drives
// can't hold Linux permissions, so they're set here: folders, DEBIAN scripts,
// usr/bin/* and opt/savestate/node/bin/node get 0755, everything else 0644,
// all owned by root. Layout as dpkg-deb writes it: an "ar" archive holding
// debian-binary, control.tar.gz and data.tar.gz.
//
//   node scripts/linux/pack-deb.mjs <package-folder> <out.deb>
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

const [dir, out] = process.argv.slice(2);
if (!dir || !out) { console.error("usage: pack-deb.mjs <package-folder> <out.deb>"); process.exit(1); }

const EXEC = [/^DEBIAN\/(preinst|postinst|prerm|postrm)$/, /^usr\/bin\/[^/]+$/, /^opt\/savestate\/node\/bin\/node$/];
const mtime = Math.floor(Date.now() / 1000);

// One ustar header + content, padded to 512 bytes. Long names use the prefix field.
function tarEntry(name, data, mode, isDir) {
  const h = Buffer.alloc(512);
  let prefix = "", base = name;
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf("/", 155);
    if (cut <= 0 || Buffer.byteLength(name.slice(cut + 1)) > 100) throw new Error(`path too long for ustar: ${name}`);
    prefix = name.slice(0, cut); base = name.slice(cut + 1);
  }
  const put = (s, off, len) => h.write(s, off, len, "utf8");
  const oct = (n, len) => n.toString(8).padStart(len - 1, "0") + "\0";
  put(base, 0, 100);
  put(oct(mode, 8), 100, 8);
  put(oct(0, 8), 108, 8); put(oct(0, 8), 116, 8);          // uid, gid: root
  put(oct(isDir ? 0 : data.length, 12), 124, 12);
  put(oct(mtime, 12), 136, 12);
  h.fill(" ", 148, 156);                                     // checksum placeholder
  put(isDir ? "5" : "0", 156, 1);
  put("ustar\0", 257, 6); put("00", 263, 2);
  put("root", 265, 32); put("root", 297, 32);
  put(prefix, 345, 155);
  let sum = 0; for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  const parts = [h];
  if (!isDir && data.length) { parts.push(data); const pad = (512 - (data.length % 512)) % 512; if (pad) parts.push(Buffer.alloc(pad)); }
  return Buffer.concat(parts);
}

function tarOf(root, rel, skip) {
  const parts = [];
  const walk = (sub) => {
    for (const name of readdirSync(path.join(root, sub)).sort()) {
      const r = sub ? `${sub}/${name}` : name;
      if (skip?.(r)) continue;
      const full = path.join(root, r);
      if (statSync(full).isDirectory()) { parts.push(tarEntry(`./${r}/`, null, 0o755, true)); walk(r); }
      else parts.push(tarEntry(`./${r}`, readFileSync(full), EXEC.some((re) => re.test(rel(r))) ? 0o755 : 0o644, false));
    }
  };
  parts.push(tarEntry("./", null, 0o755, true));
  walk("");
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts), { level: 9 });
}

function arMember(name, data) {
  const h = Buffer.alloc(60, " ");
  h.write(name, 0); h.write(String(mtime), 16); h.write("0", 28); h.write("0", 34); h.write("100644", 40);
  h.write(String(data.length), 48); h.write("`\n", 58);
  return Buffer.concat(data.length % 2 ? [h, data, Buffer.from("\n")] : [h, data]);
}

const control = tarOf(path.join(dir, "DEBIAN"), (r) => `DEBIAN/${r}`);
const data = tarOf(dir, (r) => r, (r) => r === "DEBIAN");
writeFileSync(out, Buffer.concat([
  Buffer.from("!<arch>\n"),
  arMember("debian-binary", Buffer.from("2.0\n")),
  arMember("control.tar.gz", control),
  arMember("data.tar.gz", data),
]));
console.log(`packed ${out} (${(statSync(out).size / 1024 ** 2).toFixed(1)} MB)`);
