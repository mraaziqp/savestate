// Neo Geo romsets as FinalBurn Neo knows them (server/neogeo-sets.json,
// made from FBNeo's "Neogeo only" DAT): the game's name, its year, and the
// parent set of a clone. Without it a scanned pack showed "2020bba" next to
// "2020bb", and sets FBNeo can't run were offered as games.
import sets from "./neogeo-sets.json";

export type NeoGeoSet = { title: string; year: string; parent: string; bios: boolean };

const table = sets as unknown as Record<string, [string, string, string?, string?]>;

/** The set for a zip's stem ("mslug2"), or null when FBNeo has no such Neo Geo set. */
export function neoGeoSet(stem: string): NeoGeoSet | null {
  const key = String(stem ?? "").toLowerCase();
  if (key.startsWith("_")) return null;
  const row = table[key];
  return row ? { title: row[0], year: row[1] ?? "", parent: row[2] ?? "", bios: row[3] === "b" } : null;
}

/** Zip name -> set stem: "./NEOGEO/mslug2.zip" -> "mslug2", anything else -> "". */
export function zipStem(relativePath: string): string {
  const m = /([^\\/]+)\.(zip|7z)$/i.exec(String(relativePath ?? ""));
  return m ? m[1].toLowerCase() : "";
}
