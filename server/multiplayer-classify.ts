/**
 * Multiplayer classification from evidence (2026-11-08), replacing guesses
 * from genres and title keywords.
 *
 * For one game on one platform it gathers what each source says, keeps the
 * source with every claim, and only states a gameplay mode when a source
 * actually supports it:
 *
 *   1. Manual correction by an admin           -> VERIFIED (never overwritten)
 *   2. Curated entry for this exact platform   -> HIGH_CONFIDENCE
 *      (written into the code from well-known game facts; not independently
 *      verified, so never VERIFIED on its own)
 *   3. LaunchBox Games Database, this platform -> MaxPlayers, Cooperative
 *   4. libretro-database maxusers, this ROM    -> most simultaneous players
 *   5. Genre / keyword hints                   -> notes only, never a mode
 *
 * What the databases cannot say is left open, not guessed: "4 players, not
 * cooperative" does not mean competitive (it can be turn-taking), and no
 * player count says whether the screen is shared or split. Those games are
 * NEEDS_REVIEW with the reason. A game with no evidence is UNKNOWN, never
 * "single-player".
 *
 * server/data/multiplayer-evidence.json is built by
 * scripts/build-multiplayer-evidence.mjs.
 */
import evidenceFile from "./data/multiplayer-evidence.json" with { type: "json" };

export const CLASSIFIER_VERSION = 3;

type Evidence = {
  sources: Record<string, { name: string; url: string }>;
  launchbox: Record<string, Array<[string, number, 0 | 1 | null, number, 1?]>>;
  maxusers: Record<string, Array<[string, number, string]>>;
};
const EV = evidenceFile as unknown as Evidence;

// The same console under the names the library uses.
const PLATFORM_ALIASES: Record<string, string> = {
  ps1: "psx", playstation: "psx", psone: "psx", megadrive: "genesis", "sega genesis": "genesis", md: "genesis",
  sms: "mastersystem", gg: "gamegear", famicom: "nes", sfc: "snes", "super nintendo": "snes",
  gc: "gamecube", ngc: "gamecube", arcade: "mame", fbneo: "neogeo", "neo geo": "neogeo", tg16: "pce", turbografx: "pce",
};
export const canonicalPlatform = (p: string) => { const k = String(p ?? "").toLowerCase().trim(); return PLATFORM_ALIASES[k] ?? k; };

/** "The Legend of Zelda - Ocarina of Time (USA) (Rev 1)" -> "legend of zelda ocarina of time" */
export function normTitle(t: string): string {
  return String(t ?? "").toLowerCase()
    .replace(/\.[a-z0-9]{2,4}$/, "")
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .replace(/&/g, " and ")
    .replace(/[''`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(the|a|an)\b/g, " ")
    .replace(/\s+/g, " ").trim();
}
/**
 * A title without the dump tags GoodTools-style packs leave in it once the
 * brackets are gone: "GoldenEye 007 U !" -> "GoldenEye 007" (U = USA, ! =
 * verified dump, V1.1, M3 = 3 languages). "I" (Italy) is not one of them: it ate the "II" of Street Fighter II. Only trailing codes are removed, and
 * never a number or a letter that is part of a name ("Mega Man X", "Final Fantasy V").
 */
export function stripDumpTags(t: string): string {
  let s = String(t ?? "").replace(/\([^)]*\)|\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
  for (let i = 0; i < 6; i++) {
    const next = s.replace(/\s+(?:[UEJWBFGSK]{1,3}|!|V\d+(?:\.\d+)?|M\d|PRG\d|PAL|NTSC)$/i, "").trim();
    if (next === s || !next) break;
    s = next;
  }
  return s;
}

// Word order ignored: "007 - GoldenEye" and "GoldenEye 007" are one game.
const tokenKey = (t: string) => normTitle(t).split(" ").filter(Boolean).sort().join(" ");

type LbHit = { name: string; max: number; coop: 0 | 1 | null };
type MuHit = { name: string; users: number };
let lbIndex: Map<string, Map<string, LbHit>> | null = null;
let muIndex: Map<string, { byName: Map<string, MuHit>; byTitle: Map<string, MuHit>; byCrc: Map<string, MuHit> }> | null = null;
function indexes() {
  if (lbIndex && muIndex) return;
  lbIndex = new Map();
  for (const [p, rows] of Object.entries(EV.launchbox ?? {})) {
    const m = new Map<string, LbHit>();
    for (const [name, max, coop, , alt] of rows) {
      for (const k of [normTitle(name), "~" + tokenKey(name)]) {
        // A real title wins over a regional alternate name for the same key.
        if (k && (!m.has(k) || !alt)) if (!m.has(k) || !alt) m.set(k, { name, max, coop });
      }
    }
    lbIndex.set(p, m);
  }
  muIndex = new Map();
  for (const [p, rows] of Object.entries(EV.maxusers ?? {})) {
    const byName = new Map<string, MuHit>(), byTitle = new Map<string, MuHit>(), byCrc = new Map<string, MuHit>();
    for (const [name, users, crc] of rows) {
      const hit = { name, users };
      byName.set(name.toLowerCase(), hit);
      // Several regional dumps of one game: keep the highest count only when they agree.
      const t = normTitle(name);
      const prev = byTitle.get(t);
      if (!prev) byTitle.set(t, hit); else if (prev.users !== users) byTitle.set(t, { name: prev.name, users: -1 });
      if (crc) byCrc.set(crc, hit);
    }
    muIndex.set(p, { byName, byTitle, byCrc });
  }
}

export type Claim = { source: string; says: string; ref?: string };
export type Classified = {
  modes: {
    single_player: boolean | null;
    local_coop: boolean | null;
    local_competitive: boolean | null;
    split_screen: boolean | null;
    shared_screen: boolean | null;
    hot_seat: boolean | null;
    online: boolean | null;
    lan: boolean | null;
  };
  max_players: number | null;
  max_local_coop_players: number | null;
  status: "VERIFIED" | "HIGH_CONFIDENCE" | "NEEDS_REVIEW" | "UNKNOWN";
  evidence_source: string;
  confidence: number;
  claims: Claim[];
  review_reason: string;
  summary: string;
};

export type CuratedLike = {
  is_single_player: boolean; is_local_coop: boolean; has_coop_campaign: boolean; is_local_competitive: boolean; is_local_versus: boolean;
  is_split_screen: boolean; is_shared_screen: boolean; is_online_multiplayer: boolean; is_lan_multiplayer: boolean; is_hot_seat: boolean;
  max_players: number; max_local_coop_players: number; gameplay_summary: string; notes: string;
};

/** What the evidence says about one game. `curated` must already be for this platform. */
export function classifyFromEvidence(input: { title: string; platform: string; fileName?: string; romCrc?: string; curated?: CuratedLike | null; hints?: string[] }): Classified {
  indexes();
  const platform = canonicalPlatform(input.platform);
  input = { ...input, title: stripDumpTags(input.title) };
  const claims: Claim[] = [];
  const out: Classified = {
    modes: { single_player: null, local_coop: null, local_competitive: null, split_screen: null, shared_screen: null, hot_seat: null, online: null, lan: null },
    max_players: null, max_local_coop_players: null, status: "UNKNOWN", evidence_source: "none", confidence: 0, claims, review_reason: "", summary: "",
  };

  // libretro maxusers: by ROM checksum, then the No-Intro file name, then title.
  const mu = muIndex!.get(platform);
  let muHit: MuHit | undefined;
  if (mu) {
    if (input.romCrc) muHit = mu.byCrc.get(input.romCrc.toLowerCase());
    if (!muHit && input.fileName) muHit = mu.byName.get(input.fileName.replace(/\.[a-z0-9]{2,4}$/i, "").toLowerCase());
    if (!muHit) { const t = mu.byTitle.get(normTitle(input.fileName || input.title)) ?? mu.byTitle.get(normTitle(input.title)); if (t && t.users > 0) muHit = t; }
  }
  if (muHit) claims.push({ source: "libretro-database maxusers", says: `${muHit.users} player${muHit.users === 1 ? "" : "s"} at once`, ref: muHit.name });

  // LaunchBox: this platform, by title (word order ignored as a fallback).
  const lb = lbIndex!.get(platform);
  const lbHit = lb ? (lb.get(normTitle(input.title)) ?? lb.get("~" + tokenKey(input.title)) ?? (input.fileName ? lb.get(normTitle(input.fileName)) : undefined)) : undefined;
  if (lbHit) {
    claims.push({ source: "LaunchBox Games Database", says: `${lbHit.max ? `up to ${lbHit.max} player${lbHit.max === 1 ? "" : "s"}` : "player count not listed"}${lbHit.coop === 1 ? ", cooperative" : lbHit.coop === 0 ? ", not cooperative" : ""}`, ref: lbHit.name });
  }

  // Player count: the ROM-level count first (it is per dump), else LaunchBox.
  const counts = [muHit?.users, lbHit?.max].filter((n): n is number => !!n && n > 0);
  if (counts.length) out.max_players = muHit?.users || lbHit!.max;
  const countsDisagree = counts.length === 2 && counts[0] !== counts[1];

  if (input.curated) {
    const c = input.curated;
    claims.push({ source: "SaveState curated list", says: c.gameplay_summary || "curated entry", ref: c.notes });
    out.modes = {
      single_player: c.is_single_player, local_coop: c.is_local_coop || c.has_coop_campaign, local_competitive: c.is_local_competitive || c.is_local_versus,
      split_screen: c.is_split_screen, shared_screen: c.is_shared_screen, hot_seat: c.is_hot_seat, online: c.is_online_multiplayer, lan: c.is_lan_multiplayer,
    };
    out.max_players = c.max_players || out.max_players;
    out.max_local_coop_players = c.max_local_coop_players || (out.modes.local_coop ? out.max_players : 0);
    // Curated entries are written into the code, not checked by a person:
    // never VERIFIED on their own, whatever the entry says (only an admin's
    // correction is). A database that disagrees sends the game to review.
    out.status = "HIGH_CONFIDENCE"; out.evidence_source = "curated_reference"; out.confidence = 0.85;
    if (lbHit && lbHit.coop === 1 && !out.modes.local_coop) out.review_reason = "LaunchBox lists it as cooperative; the curated entry says it isn't";
    if (lbHit && lbHit.coop === 0 && out.modes.local_coop) out.review_reason = "The curated entry says co-op; LaunchBox says it isn't cooperative";
    if (out.review_reason) { out.status = "NEEDS_REVIEW"; out.confidence = 0.5; }
  } else if (out.max_players === 1 && !countsDisagree) {
    out.modes = { single_player: true, local_coop: false, local_competitive: false, split_screen: false, shared_screen: false, hot_seat: false, online: null, lan: null };
    out.max_local_coop_players = 0;
    out.status = "HIGH_CONFIDENCE"; out.evidence_source = muHit ? "libretro_maxusers" : "launchbox_db"; out.confidence = counts.length === 2 ? 0.9 : 0.8;
  } else if (out.max_players && out.max_players > 1) {
    out.modes.single_player = null;
    out.evidence_source = lbHit ? "launchbox_db" : "libretro_maxusers";
    if (lbHit?.coop === 1) {
      out.modes.local_coop = true;
      out.max_local_coop_players = out.max_players;
      out.status = "HIGH_CONFIDENCE"; out.confidence = 0.8;
      out.review_reason = "Co-op confirmed; whether players share the screen or split it isn't recorded";
    } else {
      out.modes.local_coop = lbHit?.coop === 0 ? false : null;
      out.status = "NEEDS_REVIEW"; out.confidence = 0.6;
      out.review_reason = lbHit?.coop === 0
        ? `Up to ${out.max_players} players and not cooperative, but whether that is head-to-head or taking turns isn't recorded`
        : `Up to ${out.max_players} players; the mode (co-op, versus or taking turns) isn't recorded`;
    }
    if (countsDisagree) out.review_reason += `; the databases disagree on the player count (${counts.join(" vs ")})`;
  } else {
    out.status = "UNKNOWN"; out.evidence_source = "none"; out.confidence = 0;
    out.review_reason = "No database entry found for this game on this console";
  }
  if (input.hints?.length && out.status !== "HIGH_CONFIDENCE") claims.push({ source: "genre hint (not evidence)", says: input.hints.join(", ") });
  out.summary = summarize(out);
  return out;
}

/** "1–4 Players | Competitive | Split-Screen", only from what is known. */
export function summarize(c: Pick<Classified, "modes" | "max_players" | "status">): string {
  const m = c.modes;
  const parts: string[] = [];
  if (c.max_players) parts.push(c.max_players === 1 ? "1 Player" : `1–${c.max_players} Players`);
  if (c.max_players === 1 && m.single_player) return "1 Player | Single-Player Only";
  if (m.local_coop) parts.push("Local Co-op");
  if (m.local_competitive) parts.push("Competitive");
  if (m.hot_seat) parts.push("Take Turns");
  if (m.split_screen) parts.push("Split-Screen");
  if (m.shared_screen) parts.push("Shared Screen");
  if (m.online) parts.push("Online");
  if (m.lan) parts.push("LAN");
  if (c.status === "NEEDS_REVIEW" && !m.local_coop && !m.local_competitive && !m.hot_seat) parts.push("Mode not confirmed");
  if (c.status === "UNKNOWN") return "Player info not known yet";
  return parts.join(" | ");
}

/** The ROM's CRC32 from a .zip's directory (no unpacking), for the libretro match. */
export function crcFromZipHeader(buf: Buffer): string {
  // Local file header: CRC32 at offset 14 (little-endian), first entry.
  if (buf.length < 30 || buf.readUInt32LE(0) !== 0x04034b50) return "";
  return buf.readUInt32LE(14).toString(16).padStart(8, "0");
}

export const evidenceSources = () => EV.sources;
