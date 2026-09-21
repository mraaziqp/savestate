#!/usr/bin/env npx tsx
/**
 * Metadata healer — cleans up game titles and backfills missing box art.
 *
 * Two jobs, both idempotent and safe to run on a schedule:
 *
 *   1. Titles. ROM filenames carry region, language and revision tags that the
 *      existing cleaner strips only partially, leaving artefacts like
 *      "007 Everything or Nothing USA, Europe) En,Fr,De)" — an opening paren
 *      removed but its closer left behind. 4,508 rows looked like that.
 *   2. Box art. Delegates to POST /api/art/fetch-batch, which already resolves
 *      art from the libretro thumbnail index. Re-implementing that here would
 *      be a second source of truth for no gain.
 *
 * DRY RUN by default — prints what it would change and writes nothing.
 *
 *   npx tsx scripts/metadata-healer.ts                 # preview
 *   npx tsx scripts/metadata-healer.ts --apply         # write titles
 *   npx tsx scripts/metadata-healer.ts --apply --art   # titles + fetch art
 *   npx tsx scripts/metadata-healer.ts --apply --limit 500
 *
 * Cron (daily at 04:00):
 *   0 4 * * * npx tsx scripts/metadata-healer.ts --apply --art >> ~/.nexus-data/metadata-healer.log 2>&1
 */
import dotenv from "dotenv";
import path from "path";
import pg from "pg";
import { fileURLToPath } from "url";

// package.json sets "type": "module", so this file is ESM — __dirname and
// require.main do not exist here.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const APPLY = process.argv.includes("--apply");
const WITH_ART = process.argv.includes("--art");
const LIMIT = (() => {
  const i = process.argv.indexOf("--limit");
  return i > 0 ? Math.max(1, parseInt(process.argv[i + 1] ?? "0", 10) || 0) : 0;
})();

/**
 * Region / language / dump tags.
 *
 * These are only stripped from a bracketed group or from a trailing tag
 * cluster — never from the middle of a title. An earlier version matched
 * anywhere and turned "Hot Wheels World Race" into "Hot Wheels Race", because
 * "World" is both a region tag and an ordinary title word. Position is what
 * makes a tag a tag.
 *
 * Written as literal regexes rather than built from strings: the escaping in a
 * dynamically constructed RegExp is where the first two attempts went wrong.
 */
const BRACKET_TAG =
  /[([{][^)\]}]*\b(?:USA|Europe|Japan|World|Australia|Korea|China|Taiwan|Brazil|Spain|France|Germany|Italy|Netherlands|Sweden|Asia|Canada|UK|Unl|Proto|Beta|Demo|Sample|PAL|NTSC|En|Fr|De|Es|It|Nl|Pt|Sv|No|Da|Fi|Ja|Ko|Zh|Ru|Rev\s*\w+|v\d+(?:\.\d+)*|Disc\s*\d+|Disk\s*\d+|Track\s*\d+)\b[^)\]}]*[)\]}]/gi;

/** A run of tags at the very end, with any orphaned brackets around them. */
const TRAILING_TAGS =
  /[\s,;+([{]*\b(?:USA|Europe|Japan|Australia|Korea|China|Taiwan|Brazil|Spain|France|Germany|Italy|Netherlands|Sweden|Asia|Canada|UK|Unl|Proto|Beta|Demo|Sample|PAL|NTSC|En|Fr|De|Es|It|Nl|Pt|Sv|No|Da|Fi|Ja|Ko|Zh|Ru|Rev\s*\w+|v\d+(?:\.\d+)*|Disc\s*\d+|Disk\s*\d+|Track\s*\d+)\b(?:[\s,;+)\]}]*\b(?:USA|Europe|Japan|Australia|Korea|China|Taiwan|Brazil|Spain|France|Germany|Italy|Netherlands|Sweden|Asia|Canada|UK|Unl|Proto|Beta|Demo|Sample|PAL|NTSC|En|Fr|De|Es|It|Nl|Pt|Sv|No|Da|Fi|Ja|Ko|Zh|Ru|Rev\s*\w+|v\d+(?:\.\d+)*|Disc\s*\d+|Disk\s*\d+|Track\s*\d+)\b)*[\s,;+)\]}]*$/i;

const ROM_EXT_RE =
  /\.(bin|iso|chd|cue|img|zip|7z|rar|rvz|nsp|xci|gcm|wbfs|nds|3ds|gba|gbc|gb|smc|sfc|z64|n64|v64|nes|md|gen|sms|gg|pce|ws|wsc|a26|a78|lnx|32x|ngp|ngc)$/i;

/**
 * Turn a ROM-derived title into something readable.
 *
 * Three passes: drop bracketed tag groups (so both brackets go together), drop
 * a trailing tag cluster, then tidy the punctuation those leave behind.
 */
export function cleanTitle(raw: string): string {
  let t = String(raw ?? "").replace(ROM_EXT_RE, "");

  // Twice: "(USA) (Rev 1)" exposes a second group once the first is removed.
  BRACKET_TAG.lastIndex = 0; t = t.replace(BRACKET_TAG, " ");
  BRACKET_TAG.lastIndex = 0; t = t.replace(BRACKET_TAG, " ");
  t = t.replace(TRAILING_TAGS, " ");
  t = t.replace(TRAILING_TAGS, " ");

  t = t
    .replace(/[_]+/g, " ")
    .replace(/\s*[,;]*\s*[+&]\s*$/g, "")   // dangling "+" from "A + B (tags)"
    .replace(/\s*[,;]+\s*$/g, "")
    .replace(/\s*[-–—]\s*$/g, "")
    .replace(/\s*[([{]+\s*$/g, "")         // orphan opener at the end
    .replace(/\s{2,}/g, " ")
    .trim();

  // Balance brackets only if one side is genuinely orphaned.
  const opens = (t.match(/[([{]/g) || []).length;
  const closes = (t.match(/[)\]}]/g) || []).length;
  if (closes > opens) t = t.replace(/\s*[)\]}]\s*$/g, "").trim();
  if (opens > closes) t = t.replace(/\s*[([{][^)\]}]*$/g, "").trim();

  // "Legend of Zelda, The" -> "The Legend of Zelda"
  const article = t.match(/^(.*),\s*(The|A|An|Le|La|Les|Der|Die|Das|El|Los)$/i);
  if (article) t = `${article[2]} ${article[1]}`.trim();

  return t;
}

async function main() {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();

  const rows = (await c.query(
    `SELECT id, title, box_art FROM games ORDER BY title${LIMIT ? ` LIMIT ${LIMIT}` : ""}`,
  )).rows as { id: string; title: string; box_art: string | null }[];

  const changes = rows
    .map((r) => ({ id: r.id, from: r.title, to: cleanTitle(r.title) }))
    .filter((x) => x.to && x.to !== x.from);

  const missingArt = rows.filter((r) => !r.box_art).length;

  console.log(`metadata-healer — ${APPLY ? "APPLY" : "DRY RUN"}`);
  console.log(`  rows examined     : ${rows.length}`);
  console.log(`  titles to clean   : ${changes.length}`);
  console.log(`  missing box art   : ${missingArt}`);
  if (changes.length) {
    console.log("\n  sample rewrites:");
    for (const x of changes.slice(0, 10)) console.log(`    ${JSON.stringify(x.from)}\n      -> ${JSON.stringify(x.to)}`);
  }

  if (!APPLY) {
    console.log("\n  Nothing written. Re-run with --apply.");
    await c.end();
    return;
  }

  let written = 0;
  for (let i = 0; i < changes.length; i += 200) {
    const chunk = changes.slice(i, i + 200);
    // One statement per batch via VALUES-join, not 200 round trips to Neon.
    const vals: string[] = [];
    const params: string[] = [];
    chunk.forEach((x, j) => { params.push(x.id, x.to); vals.push(`($${j * 2 + 1},$${j * 2 + 2})`); });
    await c.query(
      `UPDATE games SET title = v.title, updated_at = NOW()
         FROM (VALUES ${vals.join(",")}) AS v(id, title)
        WHERE games.id = v.id`,
      params,
    );
    written += chunk.length;
    if (written % 1000 === 0) console.log(`    …${written}`);
  }
  console.log(`\n  titles rewritten  : ${written}`);

  if (WITH_ART && missingArt > 0) {
    // Art resolution lives in the server (it holds the libretro index in
    // memory); ask it rather than duplicating that here.
    const base = process.env.NEXUS_SELF_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`;
    const jwt = await import("jsonwebtoken");
    const adminId = process.env.HEALER_ADMIN_ID ?? "";
    if (!adminId) {
      console.log("  box art           : skipped (set HEALER_ADMIN_ID to an admin user id)");
    } else {
      const tok = jwt.default.sign({ userId: adminId, username: "metadata-healer" }, process.env.JWT_SECRET!, { expiresIn: "15m" });
      try {
        const r = await fetch(`${base}/api/art/fetch-batch`, {
          method: "POST",
          headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
          body: JSON.stringify({ limit: Math.min(missingArt, 2000) }),
          signal: AbortSignal.timeout(600_000),
        });
        const d: any = await r.json().catch(() => ({}));
        console.log(`  box art           : ${r.status} ${JSON.stringify(d).slice(0, 160)}`);
      } catch (e: any) {
        console.log(`  box art           : failed (${e?.message ?? e})`);
      }
    }
  }

  await c.end();
}

// Only run when invoked directly, so cleanTitle() can be imported by tests.
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((e) => { console.error("healer failed:", e); process.exit(1); });
}
