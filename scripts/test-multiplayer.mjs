#!/usr/bin/env node
// Regression tests for multiplayer classification (server/multiplayer-db.ts +
// server/multiplayer-classify.ts). Fixtures are real games, and every
// expectation below comes from the evidence the classifier uses (LaunchBox
// Games Database and libretro maxusers, as shipped in
// server/data/multiplayer-evidence.json) or from the curated entry for that
// exact console. Run: npx tsx scripts/test-multiplayer.mjs
import { classifyGame } from "../server/multiplayer-db.ts";

let pass = 0, fail = 0;
const check = (name, cond, got) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}\n     got: ${JSON.stringify(got)}`); } };
const cls = (title, platform, file = "") => classifyGame("t", title, platform, [], "1", file);

// 1. GoldenEye 007 (N64): campaign is single-player; multiplayer is
//    competitive split-screen; there is no co-op campaign.
{
  const g = cls("GoldenEye 007", "n64", "GoldenEye 007 (USA).z64");
  check("GoldenEye: single-player campaign", g.is_single_player === true, g);
  check("GoldenEye: local competitive", g.is_local_competitive === true, g);
  check("GoldenEye: split-screen", g.is_split_screen === true, g);
  check("GoldenEye: no local co-op", g.is_local_coop === false && g.has_coop_campaign === false, g);
  check("GoldenEye: up to 4 players", g.max_players === 4, g);
  check("GoldenEye: not marked verified by itself", g.verification_status !== "VERIFIED", g.verification_status);
  check("GoldenEye: summary names the real mode", /Competitive/.test(g.gameplay_summary) && /Split-Screen/.test(g.gameplay_summary) && !/Co-op/.test(g.gameplay_summary), g.gameplay_summary);
}
// The N64 file named the other way round ("007 - GoldenEye") is the same game.
{
  const g = cls("007 - GoldenEye", "n64", "007 - GoldenEye.v64");
  check("GoldenEye (other name): competitive split-screen", g.is_local_competitive && g.is_split_screen && !g.is_local_coop, g);
}
// GoodTools pack titles keep their tags once the brackets are gone.
for (const [t, f] of [["GoldenEye 007 U !", "GoldenEye 007 (U) [!].z64"], ["Mario Kart 64 U !", "Mario Kart 64 (U) [!].z64"]]) {
  const g = cls(t, "n64", f);
  check(`${t}: matched despite the tags`, g.verification_status === "HIGH_CONFIDENCE" && (g.is_local_competitive || g.is_local_coop), g.gameplay_summary);
}
// ...but a letter or number that is part of the name stays.
{
  const { stripDumpTags } = await import("../server/multiplayer-classify.ts");
  for (const [inp, want] of [["Mega Man X", "Mega Man X"], ["Final Fantasy V", "Final Fantasy V"], ["Tekken 3", "Tekken 3"], ["Street Fighter II U", "Street Fighter II"], ["Tetris (World) (Rev 1)", "Tetris"]]) {
    check(`stripDumpTags("${inp}")`, stripDumpTags(inp) === want, stripDumpTags(inp));
  }
}
// 2. A different GoldenEye on another console must not borrow the N64 profile.
{
  const g = cls("GoldenEye: Rogue Agent", "gamecube");
  check("Rogue Agent: not given N64 GoldenEye's modes", !(g.is_split_screen && /Deathmatch/i.test(g.notes)), g);
  check("Rogue Agent: up to 4 players (LaunchBox)", g.max_players === 4, g);
  check("Rogue Agent: not claimed co-op", g.is_local_coop === false, g);
  check("Rogue Agent: mode left for review, not guessed", g.verification_status === "NEEDS_REVIEW" && /Mode not confirmed/.test(g.gameplay_summary), g);
}
// 3. Strictly single-player games.
for (const [t, p] of [["Metroid Prime", "gamecube"], ["Shadow of the Colossus", "ps2"]]) {
  const g = cls(t, p);
  check(`${t}: single-player only`, g.max_players === 1 && !g.is_local_coop && !g.is_local_competitive && /Single-Player Only/.test(g.gameplay_summary), g);
}
{
  const g = cls("The Legend of Zelda: Ocarina of Time", "n64", "Legend of Zelda, The - Ocarina of Time (USA).z64");
  check("Ocarina of Time: single-player only", !g.is_local_coop && !g.is_local_competitive && !g.is_split_screen, g);
}
// 4. A local co-op campaign.
{
  const g = cls("Champions of Norrath", "ps2");
  check("Champions of Norrath: local co-op", g.is_local_coop === true, g);
  check("Champions of Norrath: up to 4 players", g.max_players === 4, g);
}
// 5. Competitive split-screen.
{
  const g = cls("Mario Kart 64", "n64", "Mario Kart 64 (USA).z64");
  check("Mario Kart 64: competitive split-screen", g.is_local_competitive && g.is_split_screen, g);
}
// 6. Shared-screen co-op.
{
  const g = cls("Streets of Rage 2", "genesis", "Streets of Rage 2 (USA).md");
  check("Streets of Rage 2 (Genesis): shared-screen co-op", g.is_local_coop && g.is_shared_screen && !g.is_split_screen, g);
}
// 7. Taking turns (Super Mario Bros.: two players alternate).
{
  const g = cls("Super Mario Bros.", "nes", "Super Mario Bros. (World).nes");
  check("Super Mario Bros.: not co-op", !g.is_local_coop, g);
  check("Super Mario Bros.: 2 players", g.max_players === 2, g);
}
// 8. The same game, different consoles, different answers.
{
  const sms = cls("Streets of Rage II", "mastersystem", "Streets of Rage II (Europe, Brazil) (En).sms");
  const gen = cls("Streets of Rage 2", "genesis");
  check("Streets of Rage II (Master System): 1 player", sms.max_players === 1 && !sms.is_local_coop, sms);
  check("Streets of Rage 2: Genesis and Master System differ", gen.is_local_coop && !sms.is_local_coop, { gen: gen.gameplay_summary, sms: sms.gameplay_summary });
}
// 9. No evidence: unknown, never "single-player".
{
  const g = cls("Definitely Not A Real Game 9481", "ps2");
  check("Unknown game: UNKNOWN", g.verification_status === "UNKNOWN", g);
  check("Unknown game: no single-player claim", !/Single-Player/.test(g.gameplay_summary), g.gameplay_summary);
  check("Unknown game: no remote-play claim", g.is_remote_play_compatible === false, g);
}
// 10. Remote play is not native multiplayer.
{
  const g = cls("Metroid Prime", "gamecube");
  check("Single-player game: not offered for playing together", g.is_remote_play_compatible === false, g);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
