import v8 from "node:v8";
import { classifyFromEvidence, canonicalPlatform, CLASSIFIER_VERSION, stripDumpTags } from "./multiplayer-classify.ts";
/**
 * SAVESTATE / NEXUSEMU — MULTIPLAYER & LOCAL CO-OP CLASSIFICATION ENGINE
 * 
 * Strict Evidence Hierarchy:
 * 1. Curated Database (exact canonical match) -> Status: VERIFIED, Confidence: 1.0
 * 2. Platform Documentation & Core Capabilities -> Status: HIGH_CONFIDENCE
 * 3. Rule-Based Heuristics (Genre + Franchise + Mechanics) -> Status: HIGH_CONFIDENCE or NEEDS_REVIEW
 * 4. Fallback / Ambiguous -> Status: UNVERIFIED / NEEDS_REVIEW (Confidence < 0.6)
 * 
 * GOLDENEYE 007 STANDARD:
 * - Single-player campaign: YES
 * - Local competitive multiplayer: YES (up to 4P)
 * - Split-screen: YES
 * - Local co-op campaign: NO (never marked co-op!)
 * - Multiplayer story campaign: NO
 */

import type express from 'express';
import type pg from 'pg';

export type MultiplayerMode =
  | 'single_player_only'
  | 'local_coop'
  | 'local_competitive'
  | 'local_versus'
  | 'split_screen'
  | 'shared_screen'
  | 'online_multiplayer'
  | 'lan_multiplayer'
  | 'remote_play_compatible'
  | 'hot_seat';

export type ScreenType = 'split_screen' | 'shared_screen' | 'turn_based' | 'none';
export type VerificationStatus = 'VERIFIED' | 'HIGH_CONFIDENCE' | 'UNVERIFIED' | 'NEEDS_REVIEW' | 'UNKNOWN';
export type EvidenceSource = 'curated_reference' | 'launchbox_db' | 'libretro_maxusers' | 'none' | 'curated_database' | 'manual_verified' | 'platform_docs' | 'rule_heuristics' | 'ai_inference';

export interface GameMultiplayerInfo {
  game_id: string;
  is_single_player: boolean;
  is_local_coop: boolean;
  has_coop_campaign: boolean;
  is_local_competitive: boolean;
  is_local_versus: boolean;
  is_split_screen: boolean;
  is_shared_screen: boolean;
  is_online_multiplayer: boolean;
  is_lan_multiplayer: boolean;
  is_remote_play_compatible: boolean;
  is_hot_seat: boolean;
  min_players: number;
  max_players: number;
  max_local_coop_players: number;
  max_local_competitive_players: number;
  max_split_screen_players: number;
  max_shared_screen_players: number;
  max_online_players: number;
  screen_type: ScreenType;
  controllers_required: number;
  gameplay_summary: string;
  notes: string;
  verification_status: VerificationStatus;
  evidence_source: EvidenceSource;
  confidence_score: number;
  verified_by?: string | null;
  verified_at?: string | null;
  /** What each source said, as JSON: [{ source, says, ref }]. */
  evidence_detail?: string;
  /** Why it needs a person to look (conflicting sources, mode not recorded). */
  review_reason?: string;
  classifier_version?: number;
  created_at?: string;
  updated_at?: string;
}

export type CuratedSpec = Omit<GameMultiplayerInfo, 'game_id' | 'created_at' | 'updated_at'>;

/**
 * Canonically Curated Games Knowledge Base.
 * Status is strictly VERIFIED with 1.0 confidence.
 */
export const CURATED_GAMES: Record<string, CuratedSpec> = {
  // ── Nintendo 64 Benchmarks ───────────────────────────────────────────────
  '007 goldeneye': {
    is_single_player: true,
    is_local_coop: false,
    has_coop_campaign: false,
    is_local_competitive: true,
    is_local_versus: true,
    is_split_screen: true,
    is_shared_screen: false,
    is_online_multiplayer: false,
    is_lan_multiplayer: false,
    is_remote_play_compatible: true,
    is_hot_seat: false,
    min_players: 1,
    max_players: 4,
    max_local_coop_players: 0,
    max_local_competitive_players: 4,
    max_split_screen_players: 4,
    max_shared_screen_players: 0,
    max_online_players: 0,
    screen_type: 'split_screen',
    controllers_required: 1,
    gameplay_summary: '1P Story Campaign | 2–4P Competitive Split-Screen Deathmatch',
    notes: 'GoldenEye 007 does NOT feature a cooperative campaign. Multiplayer is strictly split-screen deathmatch/versus for up to 4 players.',
    verification_status: 'VERIFIED',
    evidence_source: 'curated_database',
    confidence_score: 1.0,
  },
  'goldeneye 007': {
    is_single_player: true,
    is_local_coop: false,
    has_coop_campaign: false,
    is_local_competitive: true,
    is_local_versus: true,
    is_split_screen: true,
    is_shared_screen: false,
    is_online_multiplayer: false,
    is_lan_multiplayer: false,
    is_remote_play_compatible: true,
    is_hot_seat: false,
    min_players: 1,
    max_players: 4,
    max_local_coop_players: 0,
    max_local_competitive_players: 4,
    max_split_screen_players: 4,
    max_shared_screen_players: 0,
    max_online_players: 0,
    screen_type: 'split_screen',
    controllers_required: 1,
    gameplay_summary: '1P Story Campaign | 2–4P Competitive Split-Screen Deathmatch',
    notes: 'GoldenEye 007 does NOT feature a cooperative campaign. Multiplayer is strictly split-screen deathmatch/versus for up to 4 players.',
    verification_status: 'VERIFIED',
    evidence_source: 'curated_database',
    confidence_score: 1.0,
  },
  'perfect dark': {
    is_single_player: true,
    is_local_coop: true,
    has_coop_campaign: true,
    is_local_competitive: true,
    is_local_versus: true,
    is_split_screen: true,
    is_shared_screen: false,
    is_online_multiplayer: false,
    is_lan_multiplayer: false,
    is_remote_play_compatible: true,
    is_hot_seat: false,
    min_players: 1,
    max_players: 4,
    max_local_coop_players: 2,
    max_local_competitive_players: 4,
    max_split_screen_players: 4,
    max_shared_screen_players: 0,
    max_online_players: 0,
    screen_type: 'split_screen',
    controllers_required: 1,
    gameplay_summary: '1–2P Co-Op / Counter-Op Campaign | 2–4P Split-Screen Combat Simulator',
    notes: 'Unlike GoldenEye, Perfect Dark features a complete 2-player split-screen co-operative campaign alongside up to 4-player competitive combat simulator with bot challenges.',
    verification_status: 'VERIFIED',
    evidence_source: 'curated_database',
    confidence_score: 1.0,
  },
  'mario kart 64': {
    is_single_player: true,
    is_local_coop: false,
    has_coop_campaign: false,
    is_local_competitive: true,
    is_local_versus: true,
    is_split_screen: true,
    is_shared_screen: false,
    is_online_multiplayer: false,
    is_lan_multiplayer: false,
    is_remote_play_compatible: true,
    is_hot_seat: false,
    min_players: 1,
    max_players: 4,
    max_local_coop_players: 0,
    max_local_competitive_players: 4,
    max_split_screen_players: 4,
    max_shared_screen_players: 0,
    max_online_players: 0,
    screen_type: 'split_screen',
    controllers_required: 1,
    gameplay_summary: '1–4P Split-Screen Grand Prix, Versus & Battle',
    notes: '2-4 player competitive split-screen racing and balloon battle modes.',
    verification_status: 'VERIFIED',
    evidence_source: 'curated_database',
    confidence_score: 1.0,
  },
  'super smash bros': {
    is_single_player: true,
    is_local_coop: true,
    has_coop_campaign: false,
    is_local_competitive: true,
    is_local_versus: true,
    is_split_screen: false,
    is_shared_screen: true,
    is_online_multiplayer: false,
    is_lan_multiplayer: false,
    is_remote_play_compatible: true,
    is_hot_seat: false,
    min_players: 1,
    max_players: 4,
    max_local_coop_players: 4,
    max_local_competitive_players: 4,
    max_split_screen_players: 0,
    max_shared_screen_players: 4,
    max_online_players: 0,
    screen_type: 'shared_screen',
    controllers_required: 1,
    gameplay_summary: '1–4P Shared-Screen Free-For-All & Team Battle',
    notes: 'Dynamic single-camera shared arena. Supports competitive FFA or 2v2 team co-op.',
    verification_status: 'VERIFIED',
    evidence_source: 'curated_database',
    confidence_score: 1.0,
  },
  'super mario 64': {
    is_single_player: true,
    is_local_coop: false,
    has_coop_campaign: false,
    is_local_competitive: false,
    is_local_versus: false,
    is_split_screen: false,
    is_shared_screen: false,
    is_online_multiplayer: false,
    is_lan_multiplayer: false,
    is_remote_play_compatible: false,
    is_hot_seat: false,
    min_players: 1,
    max_players: 1,
    max_local_coop_players: 0,
    max_local_competitive_players: 0,
    max_split_screen_players: 0,
    max_shared_screen_players: 0,
    max_online_players: 0,
    screen_type: 'none',
    controllers_required: 1,
    gameplay_summary: 'Single-Player Only 3D Platformer',
    notes: 'Original N64 release has no official multiplayer functionality.',
    verification_status: 'VERIFIED',
    evidence_source: 'curated_database',
    confidence_score: 1.0,
  },
  'the legend of zelda ocarina of time': {
    is_single_player: true,
    is_local_coop: false,
    has_coop_campaign: false,
    is_local_competitive: false,
    is_local_versus: false,
    is_split_screen: false,
    is_shared_screen: false,
    is_online_multiplayer: false,
    is_lan_multiplayer: false,
    is_remote_play_compatible: false,
    is_hot_seat: false,
    min_players: 1,
    max_players: 1,
    max_local_coop_players: 0,
    max_local_competitive_players: 0,
    max_split_screen_players: 0,
    max_shared_screen_players: 0,
    max_online_players: 0,
    screen_type: 'none',
    controllers_required: 1,
    gameplay_summary: 'Single-Player Only Action-Adventure',
    notes: 'Single player story campaign.',
    verification_status: 'VERIFIED',
    evidence_source: 'curated_database',
    confidence_score: 1.0,
  },
  'the legend of zelda majoras mask': {
    is_single_player: true,
    is_local_coop: false,
    has_coop_campaign: false,
    is_local_competitive: false,
    is_local_versus: false,
    is_split_screen: false,
    is_shared_screen: false,
    is_online_multiplayer: false,
    is_lan_multiplayer: false,
    is_remote_play_compatible: false,
    is_hot_seat: false,
    min_players: 1,
    max_players: 1,
    max_local_coop_players: 0,
    max_local_competitive_players: 0,
    max_split_screen_players: 0,
    max_shared_screen_players: 0,
    max_online_players: 0,
    screen_type: 'none',
    controllers_required: 1,
    gameplay_summary: 'Single-Player Only Action-Adventure',
    notes: 'Single player story campaign.',
    verification_status: 'VERIFIED',
    evidence_source: 'curated_database',
    confidence_score: 1.0,
  },
  'diddy kong racing': {
    is_single_player: true,
    is_local_coop: false,
    has_coop_campaign: false,
    is_local_competitive: true,
    is_local_versus: true,
    is_split_screen: true,
    is_shared_screen: false,
    is_online_multiplayer: false,
    is_lan_multiplayer: false,
    is_remote_play_compatible: true,
    is_hot_seat: false,
    min_players: 1,
    max_players: 4,
    max_local_coop_players: 0,
    max_local_competitive_players: 4,
    max_split_screen_players: 4,
    max_shared_screen_players: 0,
    max_online_players: 0,
    screen_type: 'split_screen',
    controllers_required: 1,
    gameplay_summary: '1P Adventure Mode | 2–4P Split-Screen Trophy Race & Battle',
    notes: 'Adventure mode is single-player. Multiplayer is 2-4P split-screen racing/battle.',
    verification_status: 'VERIFIED',
    evidence_source: 'curated_database',
    confidence_score: 1.0,
  },
  'conkers bad fur day': {
    is_single_player: true,
    is_local_coop: true,
    has_coop_campaign: false,
    is_local_competitive: true,
    is_local_versus: true,
    is_split_screen: true,
    is_shared_screen: false,
    is_online_multiplayer: false,
    is_lan_multiplayer: false,
    is_remote_play_compatible: true,
    is_hot_seat: false,
    min_players: 1,
    max_players: 4,
    max_local_coop_players: 4,
    max_local_competitive_players: 4,
    max_split_screen_players: 4,
    max_shared_screen_players: 0,
    max_online_players: 0,
    screen_type: 'split_screen',
    controllers_required: 1,
    gameplay_summary: '1P Campaign | 2–4P Split-Screen Deathmatch, Heist, War & Co-Op Missions',
    notes: 'Story campaign is single player. Multiplayer includes 7 game modes including cooperative survival/heist missions.',
    verification_status: 'VERIFIED',
    evidence_source: 'curated_database',
    confidence_score: 1.0,
  },
  'mario party': {
    is_single_player: true,
    is_local_coop: true,
    has_coop_campaign: false,
    is_local_competitive: true,
    is_local_versus: true,
    is_split_screen: false,
    is_shared_screen: true,
    is_online_multiplayer: false,
    is_lan_multiplayer: false,
    is_remote_play_compatible: true,
    is_hot_seat: false,
    min_players: 1,
    max_players: 4,
    max_local_coop_players: 4,
    max_local_competitive_players: 4,
    max_split_screen_players: 0,
    max_shared_screen_players: 4,
    max_online_players: 0,
    screen_type: 'shared_screen',
    controllers_required: 1,
    gameplay_summary: '1–4P Shared-Screen Board Game & Mini-Games (FFA, 2v2, 1v3)',
    notes: '4-player board game party on one screen. Includes cooperative 2v2 and competitive FFA mini-games.',
    verification_status: 'VERIFIED',
    evidence_source: 'curated_database',
    confidence_score: 1.0,
  },
  'mario party 2': {
    is_single_player: true,
    is_local_coop: true,
    has_coop_campaign: false,
    is_local_competitive: true,
    is_local_versus: true,
    is_split_screen: false,
    is_shared_screen: true,
    is_online_multiplayer: false,
    is_lan_multiplayer: false,
    is_remote_play_compatible: true,
    is_hot_seat: false,
    min_players: 1,
    max_players: 4,
    max_local_coop_players: 4,
    max_local_competitive_players: 4,
    max_split_screen_players: 0,
    max_shared_screen_players: 4,
    max_online_players: 0,
    screen_type: 'shared_screen',
    controllers_required: 1,
    gameplay_summary: '1–4P Shared-Screen Board Game & Mini-Games (FFA, 2v2, 1v3)',
    notes: 'Shared-screen 4-player party game.',
    verification_status: 'VERIFIED',
    evidence_source: 'curated_database',
    confidence_score: 1.0,
  },
  'mario party 3': {
    is_single_player: true,
    is_local_coop: true,
    has_coop_campaign: false,
    is_local_competitive: true,
    is_local_versus: true,
    is_split_screen: false,
    is_shared_screen: true,
    is_online_multiplayer: false,
    is_lan_multiplayer: false,
    is_remote_play_compatible: true,
    is_hot_seat: false,
    min_players: 1,
    max_players: 4,
    max_local_coop_players: 4,
    max_local_competitive_players: 4,
    max_split_screen_players: 0,
    max_shared_screen_players: 4,
    max_online_players: 0,
    screen_type: 'shared_screen',
    controllers_required: 1,
    gameplay_summary: '1–4P Shared-Screen Board Game, Duel Mode & Mini-Games',
    notes: 'Shared-screen 4-player party game.',
    verification_status: 'VERIFIED',
    evidence_source: 'curated_database',
    confidence_score: 1.0,
  },
  'star fox 64': {
    is_single_player: true,
    is_local_coop: false,
    has_coop_campaign: false,
    is_local_competitive: true,
    is_local_versus: true,
    is_split_screen: true,
    is_shared_screen: false,
    is_online_multiplayer: false,
    is_lan_multiplayer: false,
    is_remote_play_compatible: true,
    is_hot_seat: false,
    min_players: 1,
    max_players: 4,
    max_local_coop_players: 0,
    max_local_competitive_players: 4,
    max_split_screen_players: 4,
    max_shared_screen_players: 0,
    max_online_players: 0,
    screen_type: 'split_screen',
    controllers_required: 1,
    gameplay_summary: '1P Campaign | 2–4P Split-Screen Dogfight Versus',
    notes: 'Single player story mode. Up to 4 players split-screen dogfight/battle mode (Arwing, Landmaster, on-foot).',
    verification_status: 'VERIFIED',
    evidence_source: 'curated_database',
    confidence_score: 1.0,
  },
  'wave race 64': {
    is_single_player: true,
    is_local_coop: false,
    has_coop_campaign: false,
    is_local_competitive: true,
    is_local_versus: true,
    is_split_screen: true,
    is_shared_screen: false,
    is_online_multiplayer: false,
    is_lan_multiplayer: false,
    is_remote_play_compatible: true,
    is_hot_seat: false,
    min_players: 1,
    max_players: 2,
    max_local_coop_players: 0,
    max_local_competitive_players: 2,
    max_split_screen_players: 2,
    max_shared_screen_players: 0,
    max_online_players: 0,
    screen_type: 'split_screen',
    controllers_required: 1,
    gameplay_summary: '1P Championship | 2P Split-Screen Head-to-Head Racing',
    notes: '2-player vertical split-screen watercraft racing.',
    verification_status: 'VERIFIED',
    evidence_source: 'curated_database',
    confidence_score: 1.0,
  },
  'f-zero x': {
    is_single_player: true,
    is_local_coop: false,
    has_coop_campaign: false,
    is_local_competitive: true,
    is_local_versus: true,
    is_split_screen: true,
    is_shared_screen: false,
    is_online_multiplayer: false,
    is_lan_multiplayer: false,
    is_remote_play_compatible: true,
    is_hot_seat: false,
    min_players: 1,
    max_players: 4,
    max_local_coop_players: 0,
    max_local_competitive_players: 4,
    max_split_screen_players: 4,
    max_shared_screen_players: 0,
    max_online_players: 0,
    screen_type: 'split_screen',
    controllers_required: 1,
    gameplay_summary: '1P Grand Prix | 2–4P Split-Screen 60FPS High-Speed Racing',
    notes: 'Up to 4 players split-screen racing running at a rock-solid 60 FPS.',
    verification_status: 'VERIFIED',
    evidence_source: 'curated_database',
    confidence_score: 1.0,
  },
  'banjo kazooie': {
    is_single_player: true,
    is_local_coop: false,
    has_coop_campaign: false,
    is_local_competitive: false,
    is_local_versus: false,
    is_split_screen: false,
    is_shared_screen: false,
    is_online_multiplayer: false,
    is_lan_multiplayer: false,
    is_remote_play_compatible: false,
    is_hot_seat: false,
    min_players: 1,
    max_players: 1,
    max_local_coop_players: 0,
    max_local_competitive_players: 0,
    max_split_screen_players: 0,
    max_shared_screen_players: 0,
    max_online_players: 0,
    screen_type: 'none',
    controllers_required: 1,
    gameplay_summary: 'Single-Player Only 3D Platformer',
    notes: 'Single player 3D platforming adventure.',
    verification_status: 'VERIFIED',
    evidence_source: 'curated_database',
    confidence_score: 1.0,
  },
  'banjo tooie': {
    is_single_player: true,
    is_local_coop: true,
    has_coop_campaign: false,
    is_local_competitive: true,
    is_local_versus: true,
    is_split_screen: true,
    is_shared_screen: false,
    is_online_multiplayer: false,
    is_lan_multiplayer: false,
    is_remote_play_compatible: true,
    is_hot_seat: false,
    min_players: 1,
    max_players: 4,
    max_local_coop_players: 4,
    max_local_competitive_players: 4,
    max_split_screen_players: 4,
    max_shared_screen_players: 0,
    max_online_players: 0,
    screen_type: 'split_screen',
    controllers_required: 1,
    gameplay_summary: '1P Story Adventure | 2–4P Split-Screen Mini-Game Shootout & Coliseum',
    notes: 'Main adventure is single-player. Standalone multiplayer offers 2-4P split-screen first-person shooter minigames and boss replay.',
    verification_status: 'VERIFIED',
    evidence_source: 'curated_database',
    confidence_score: 1.0,
  },
  'donkey kong 64': {
    is_single_player: true,
    is_local_coop: false,
    has_coop_campaign: false,
    is_local_competitive: true,
    is_local_versus: true,
    is_split_screen: true,
    is_shared_screen: false,
    is_online_multiplayer: false,
    is_lan_multiplayer: false,
    is_remote_play_compatible: true,
    is_hot_seat: false,
    min_players: 1,
    max_players: 4,
    max_local_coop_players: 0,
    max_local_competitive_players: 4,
    max_split_screen_players: 4,
    max_shared_screen_players: 0,
    max_online_players: 0,
    screen_type: 'split_screen',
    controllers_required: 1,
    gameplay_summary: '1P Adventure Mode | 2–4P Split-Screen Monkey Smash Arena',
    notes: 'Main quest is single-player. Monkey Smash multiplayer supports 2-4 players in split-screen arena battles.',
    verification_status: 'VERIFIED',
    evidence_source: 'curated_database',
    confidence_score: 1.0,
  },
  'pokemon stadium': {
    is_single_player: true,
    is_local_coop: true,
    has_coop_campaign: false,
    is_local_competitive: true,
    is_local_versus: true,
    is_split_screen: false,
    is_shared_screen: true,
    is_online_multiplayer: false,
    is_lan_multiplayer: false,
    is_remote_play_compatible: true,
    is_hot_seat: false,
    min_players: 1,
    max_players: 4,
    max_local_coop_players: 4,
    max_local_competitive_players: 4,
    max_split_screen_players: 0,
    max_shared_screen_players: 4,
    max_online_players: 0,
    screen_type: 'shared_screen',
    controllers_required: 1,
    gameplay_summary: '1–4P Shared-Screen Pokemon Battles & Kids Club Mini-Games',
    notes: '1-2 player turn-based arena battles, plus 1-4 player simultaneous shared-screen mini-games.',
    verification_status: 'VERIFIED',
    evidence_source: 'curated_database',
    confidence_score: 1.0,
  },
  'pokemon stadium 2': {
    is_single_player: true,
    is_local_coop: true,
    has_coop_campaign: false,
    is_local_competitive: true,
    is_local_versus: true,
    is_split_screen: false,
    is_shared_screen: true,
    is_online_multiplayer: false,
    is_lan_multiplayer: false,
    is_remote_play_compatible: true,
    is_hot_seat: false,
    min_players: 1,
    max_players: 4,
    max_local_coop_players: 4,
    max_local_competitive_players: 4,
    max_split_screen_players: 0,
    max_shared_screen_players: 4,
    max_online_players: 0,
    screen_type: 'shared_screen',
    controllers_required: 1,
    gameplay_summary: '1–4P Shared-Screen Pokemon Battles & 12 Mini-Games',
    notes: '1-2 player battle mode, 1-4 player party mini-games on one screen.',
    verification_status: 'VERIFIED',
    evidence_source: 'curated_database',
    confidence_score: 1.0,
  },
  'wwf no mercy': {
    is_single_player: true,
    is_local_coop: true,
    has_coop_campaign: true,
    is_local_competitive: true,
    is_local_versus: true,
    is_split_screen: false,
    is_shared_screen: true,
    is_online_multiplayer: false,
    is_lan_multiplayer: false,
    is_remote_play_compatible: true,
    is_hot_seat: false,
    min_players: 1,
    max_players: 4,
    max_local_coop_players: 2,
    max_local_competitive_players: 4,
    max_split_screen_players: 0,
    max_shared_screen_players: 4,
    max_online_players: 0,
    screen_type: 'shared_screen',
    controllers_required: 1,
    gameplay_summary: '1–2P Tag-Team Championship Co-Op | 2–4P Shared-Screen 4-Way Wrestling',
    notes: 'Tag-Team story mode can be played co-operatively by 2 players. Exhibition supports up to 4 players simultaneously on one screen.',
    verification_status: 'VERIFIED',
    evidence_source: 'curated_database',
    confidence_score: 1.0,
  },

  // ── Co-op Campaign Classics (NES, SNES, Genesis, Arcade) ───────────────────
  'contra': {
    is_single_player: true,
    is_local_coop: true,
    has_coop_campaign: true,
    is_local_competitive: false,
    is_local_versus: false,
    is_split_screen: false,
    is_shared_screen: true,
    is_online_multiplayer: false,
    is_lan_multiplayer: false,
    is_remote_play_compatible: true,
    is_hot_seat: false,
    min_players: 1,
    max_players: 2,
    max_local_coop_players: 2,
    max_local_competitive_players: 0,
    max_split_screen_players: 0,
    max_shared_screen_players: 2,
    max_online_players: 0,
    screen_type: 'shared_screen',
    controllers_required: 1,
    gameplay_summary: '1–2P Simultaneous Shared-Screen Co-Op Campaign',
    notes: '2 players fight side-by-side on the same screen through the entire campaign. Not split-screen.',
    verification_status: 'VERIFIED',
    evidence_source: 'curated_database',
    confidence_score: 1.0,
  },
  'super c': {
    is_single_player: true,
    is_local_coop: true,
    has_coop_campaign: true,
    is_local_competitive: false,
    is_local_versus: false,
    is_split_screen: false,
    is_shared_screen: true,
    is_online_multiplayer: false,
    is_lan_multiplayer: false,
    is_remote_play_compatible: true,
    is_hot_seat: false,
    min_players: 1,
    max_players: 2,
    max_local_coop_players: 2,
    max_local_competitive_players: 0,
    max_split_screen_players: 0,
    max_shared_screen_players: 2,
    max_online_players: 0,
    screen_type: 'shared_screen',
    controllers_required: 1,
    gameplay_summary: '1–2P Simultaneous Shared-Screen Co-Op Campaign',
    notes: '2-player cooperative campaign.',
    verification_status: 'VERIFIED',
    evidence_source: 'curated_database',
    confidence_score: 1.0,
  },
  'contra iii the alien wars': {
    is_single_player: true,
    is_local_coop: true,
    has_coop_campaign: true,
    is_local_competitive: false,
    is_local_versus: false,
    is_split_screen: false,
    is_shared_screen: true,
    is_online_multiplayer: false,
    is_lan_multiplayer: false,
    is_remote_play_compatible: true,
    is_hot_seat: false,
    min_players: 1,
    max_players: 2,
    max_local_coop_players: 2,
    max_local_competitive_players: 0,
    max_split_screen_players: 0,
    max_shared_screen_players: 2,
    max_online_players: 0,
    screen_type: 'shared_screen',
    controllers_required: 1,
    gameplay_summary: '1–2P Simultaneous Shared-Screen Co-Op Campaign',
    notes: '2-player cooperative run-and-gun. Side-scrolling stages share one viewport; top-down stages share one camera (or split in some versions).',
    verification_status: 'VERIFIED',
    evidence_source: 'curated_database',
    confidence_score: 1.0,
  },
  'contra hard corps': {
    is_single_player: true,
    is_local_coop: true,
    has_coop_campaign: true,
    is_local_competitive: false,
    is_local_versus: false,
    is_split_screen: false,
    is_shared_screen: true,
    is_online_multiplayer: false,
    is_lan_multiplayer: false,
    is_remote_play_compatible: true,
    is_hot_seat: false,
    min_players: 1,
    max_players: 2,
    max_local_coop_players: 2,
    max_local_competitive_players: 0,
    max_split_screen_players: 0,
    max_shared_screen_players: 2,
    max_online_players: 0,
    screen_type: 'shared_screen',
    controllers_required: 1,
    gameplay_summary: '1–2P Simultaneous Shared-Screen Co-Op Campaign',
    notes: '2-player cooperative branching story campaign on Genesis/Mega Drive.',
    verification_status: 'VERIFIED',
    evidence_source: 'curated_database',
    confidence_score: 1.0,
  },
  'metal slug': {
    is_single_player: true,
    is_local_coop: true,
    has_coop_campaign: true,
    is_local_competitive: false,
    is_local_versus: false,
    is_split_screen: false,
    is_shared_screen: true,
    is_online_multiplayer: false,
    is_lan_multiplayer: false,
    is_remote_play_compatible: true,
    is_hot_seat: false,
    min_players: 1,
    max_players: 2,
    max_local_coop_players: 2,
    max_local_competitive_players: 0,
    max_split_screen_players: 0,
    max_shared_screen_players: 2,
    max_online_players: 0,
    screen_type: 'shared_screen',
    controllers_required: 1,
    gameplay_summary: '1–2P Simultaneous Shared-Screen Co-Op Arcade Campaign',
    notes: '2-player cooperative arcade action on one screen.',
    verification_status: 'VERIFIED',
    evidence_source: 'curated_database',
    confidence_score: 1.0,
  },
  'streets of rage 2': {
    is_single_player: true,
    is_local_coop: true,
    has_coop_campaign: true,
    is_local_competitive: true,
    is_local_versus: true,
    is_split_screen: false,
    is_shared_screen: true,
    is_online_multiplayer: false,
    is_lan_multiplayer: false,
    is_remote_play_compatible: true,
    is_hot_seat: false,
    min_players: 1,
    max_players: 2,
    max_local_coop_players: 2,
    max_local_competitive_players: 2,
    max_split_screen_players: 0,
    max_shared_screen_players: 2,
    max_online_players: 0,
    screen_type: 'shared_screen',
    controllers_required: 1,
    gameplay_summary: '1–2P Shared-Screen Co-Op Beat Em Up Campaign & Duel Mode',
    notes: '2-player simultaneous cooperative campaign and 1v1 battle mode on shared screen.',
    verification_status: 'VERIFIED',
    evidence_source: 'curated_database',
    confidence_score: 1.0,
  },
  'teenage mutant ninja turtles iv turtles in time': {
    is_single_player: true,
    is_local_coop: true,
    has_coop_campaign: true,
    is_local_competitive: true,
    is_local_versus: true,
    is_split_screen: false,
    is_shared_screen: true,
    is_online_multiplayer: false,
    is_lan_multiplayer: false,
    is_remote_play_compatible: true,
    is_hot_seat: false,
    min_players: 1,
    max_players: 2,
    max_local_coop_players: 2,
    max_local_competitive_players: 2,
    max_split_screen_players: 0,
    max_shared_screen_players: 2,
    max_online_players: 0,
    screen_type: 'shared_screen',
    controllers_required: 1,
    gameplay_summary: '1–2P Shared-Screen Co-Op Beat Em Up Campaign & Versus Mode',
    notes: '2-player cooperative campaign on SNES (4-player on arcade). Shared screen.',
    verification_status: 'VERIFIED',
    evidence_source: 'curated_database',
    confidence_score: 1.0,
  },
  'secret of mana': {
    is_single_player: true,
    is_local_coop: true,
    has_coop_campaign: true,
    is_local_competitive: false,
    is_local_versus: false,
    is_split_screen: false,
    is_shared_screen: true,
    is_online_multiplayer: false,
    is_lan_multiplayer: false,
    is_remote_play_compatible: true,
    is_hot_seat: false,
    min_players: 1,
    max_players: 3,
    max_local_coop_players: 3,
    max_local_competitive_players: 0,
    max_split_screen_players: 0,
    max_shared_screen_players: 3,
    max_online_players: 0,
    screen_type: 'shared_screen',
    controllers_required: 1,
    gameplay_summary: '1–3P Shared-Screen Action RPG Co-Op Campaign',
    notes: 'Up to 3 players can play through the entire Action RPG story simultaneously using the SNES Multitap. Shared camera viewport.',
    verification_status: 'VERIFIED',
    evidence_source: 'curated_database',
    confidence_score: 1.0,
  },
  'zombies ate my neighbors': {
    is_single_player: true,
    is_local_coop: true,
    has_coop_campaign: true,
    is_local_competitive: false,
    is_local_versus: false,
    is_split_screen: false,
    is_shared_screen: true,
    is_online_multiplayer: false,
    is_lan_multiplayer: false,
    is_remote_play_compatible: true,
    is_hot_seat: false,
    min_players: 1,
    max_players: 2,
    max_local_coop_players: 2,
    max_local_competitive_players: 0,
    max_split_screen_players: 0,
    max_shared_screen_players: 2,
    max_online_players: 0,
    screen_type: 'shared_screen',
    controllers_required: 1,
    gameplay_summary: '1–2P Shared-Screen Co-Op Survival Campaign',
    notes: 'Zeke and Julie rescue neighbors side-by-side on one shared screen throughout 55 stages.',
    verification_status: 'VERIFIED',
    evidence_source: 'curated_database',
    confidence_score: 1.0,
  },

  // ── Competitive Fighting / Head-to-Head (Shared Screen, NOT Split Screen) ──
  'street fighter ii': {
    is_single_player: true,
    is_local_coop: false,
    has_coop_campaign: false,
    is_local_competitive: true,
    is_local_versus: true,
    is_split_screen: false,
    is_shared_screen: true,
    is_online_multiplayer: false,
    is_lan_multiplayer: false,
    is_remote_play_compatible: true,
    is_hot_seat: false,
    min_players: 1,
    max_players: 2,
    max_local_coop_players: 0,
    max_local_competitive_players: 2,
    max_split_screen_players: 0,
    max_shared_screen_players: 2,
    max_online_players: 0,
    screen_type: 'shared_screen',
    controllers_required: 1,
    gameplay_summary: '1P Arcade Ladder | 2P Shared-Screen 1v1 Versus Fighting',
    notes: '2-player head-to-head fighting on a single camera arena. Strictly shared-screen, NOT split-screen, and NOT cooperative.',
    verification_status: 'VERIFIED',
    evidence_source: 'curated_database',
    confidence_score: 1.0,
  },
  'street fighter ii turbo': {
    is_single_player: true,
    is_local_coop: false,
    has_coop_campaign: false,
    is_local_competitive: true,
    is_local_versus: true,
    is_split_screen: false,
    is_shared_screen: true,
    is_online_multiplayer: false,
    is_lan_multiplayer: false,
    is_remote_play_compatible: true,
    is_hot_seat: false,
    min_players: 1,
    max_players: 2,
    max_local_coop_players: 0,
    max_local_competitive_players: 2,
    max_split_screen_players: 0,
    max_shared_screen_players: 2,
    max_online_players: 0,
    screen_type: 'shared_screen',
    controllers_required: 1,
    gameplay_summary: '1P Arcade Ladder | 2P Shared-Screen 1v1 Versus Fighting',
    notes: '2-player head-to-head fighting on a single camera arena. Strictly shared-screen, NOT split-screen, and NOT cooperative.',
    verification_status: 'VERIFIED',
    evidence_source: 'curated_database',
    confidence_score: 1.0,
  },
  'tekken 3': {
    is_single_player: true,
    is_local_coop: false,
    has_coop_campaign: false,
    is_local_competitive: true,
    is_local_versus: true,
    is_split_screen: false,
    is_shared_screen: true,
    is_online_multiplayer: false,
    is_lan_multiplayer: false,
    is_remote_play_compatible: true,
    is_hot_seat: false,
    min_players: 1,
    max_players: 2,
    max_local_coop_players: 0,
    max_local_competitive_players: 2,
    max_split_screen_players: 0,
    max_shared_screen_players: 2,
    max_online_players: 0,
    screen_type: 'shared_screen',
    controllers_required: 1,
    gameplay_summary: '1P Arcade / Tekken Force | 2P Shared-Screen 1v1 Versus & Tekken Ball',
    notes: '2-player versus on one camera. Tekken Force mode is single player.',
    verification_status: 'VERIFIED',
    evidence_source: 'curated_database',
    confidence_score: 1.0,
  },

  // ── Turn-based / Hot-Seat Games ──────────────────────────────────────────
  'super mario bros': {
    is_single_player: true,
    is_local_coop: false,
    has_coop_campaign: false,
    is_local_competitive: false,
    is_local_versus: false,
    is_split_screen: false,
    is_shared_screen: false,
    is_online_multiplayer: false,
    is_lan_multiplayer: false,
    is_remote_play_compatible: false,
    is_hot_seat: true,
    min_players: 1,
    max_players: 2,
    max_local_coop_players: 0,
    max_local_competitive_players: 0,
    max_split_screen_players: 0,
    max_shared_screen_players: 0,
    max_online_players: 0,
    screen_type: 'turn_based',
    controllers_required: 1,
    gameplay_summary: '1P Campaign / 2P Alternating Turn-Based Hot-Seat',
    notes: '2-player mode is strictly alternating turns on death/level completion. Not simultaneous co-op.',
    verification_status: 'VERIFIED',
    evidence_source: 'curated_database',
    confidence_score: 1.0,
  },
  'super mario world': {
    is_single_player: true,
    is_local_coop: false,
    has_coop_campaign: false,
    is_local_competitive: false,
    is_local_versus: false,
    is_split_screen: false,
    is_shared_screen: false,
    is_online_multiplayer: false,
    is_lan_multiplayer: false,
    is_remote_play_compatible: false,
    is_hot_seat: true,
    min_players: 1,
    max_players: 2,
    max_local_coop_players: 0,
    max_local_competitive_players: 0,
    max_split_screen_players: 0,
    max_shared_screen_players: 0,
    max_online_players: 0,
    screen_type: 'turn_based',
    controllers_required: 1,
    gameplay_summary: '1P Adventure / 2P Alternating Turn-Based (Mario & Luigi)',
    notes: '2-player mode is strictly alternating turns on death/level completion. Not simultaneous co-op.',
    verification_status: 'VERIFIED',
    evidence_source: 'curated_database',
    confidence_score: 1.0,
  },
  'worms armageddon': {
    is_single_player: true,
    is_local_coop: true,
    has_coop_campaign: false,
    is_local_competitive: true,
    is_local_versus: true,
    is_split_screen: false,
    is_shared_screen: true,
    is_online_multiplayer: false,
    is_lan_multiplayer: false,
    is_remote_play_compatible: true,
    is_hot_seat: true,
    min_players: 1,
    max_players: 6,
    max_local_coop_players: 6,
    max_local_competitive_players: 6,
    max_split_screen_players: 0,
    max_shared_screen_players: 6,
    max_online_players: 0,
    screen_type: 'shared_screen',
    controllers_required: 1,
    gameplay_summary: '1–6P Shared-Screen Turn-Based Tactical Artillery (Hot-Seat)',
    notes: 'Players take turns controlling worm teams on one shared landscape. Can be played using a single pass-around controller.',
    verification_status: 'VERIFIED',
    evidence_source: 'curated_database',
    confidence_score: 1.0,
  },

  // ── Split-Screen Action & Shooters ───────────────────────────────────────
  'halo combat evolved': {
    is_single_player: true,
    is_local_coop: true,
    has_coop_campaign: true,
    is_local_competitive: true,
    is_local_versus: true,
    is_split_screen: true,
    is_shared_screen: false,
    is_online_multiplayer: false,
    is_lan_multiplayer: true,
    is_remote_play_compatible: true,
    is_hot_seat: false,
    min_players: 1,
    max_players: 4,
    max_local_coop_players: 2,
    max_local_competitive_players: 4,
    max_split_screen_players: 4,
    max_shared_screen_players: 0,
    max_online_players: 0,
    screen_type: 'split_screen',
    controllers_required: 1,
    gameplay_summary: '1–2P Split-Screen Co-Op Campaign | 2–4P Split-Screen Versus',
    notes: 'Full 2-player split-screen cooperative story campaign and up to 4-player competitive slayer/CTF.',
    verification_status: 'VERIFIED',
    evidence_source: 'curated_database',
    confidence_score: 1.0,
  },
  'timesplitters 2': {
    is_single_player: true,
    is_local_coop: true,
    has_coop_campaign: true,
    is_local_competitive: true,
    is_local_versus: true,
    is_split_screen: true,
    is_shared_screen: false,
    is_online_multiplayer: false,
    is_lan_multiplayer: false,
    is_remote_play_compatible: true,
    is_hot_seat: false,
    min_players: 1,
    max_players: 4,
    max_local_coop_players: 2,
    max_local_competitive_players: 4,
    max_split_screen_players: 4,
    max_shared_screen_players: 0,
    max_online_players: 0,
    screen_type: 'split_screen',
    controllers_required: 1,
    gameplay_summary: '1–2P Split-Screen Co-Op Story & Arcade | 2–4P Split-Screen Deathmatch',
    notes: '2-player split-screen story campaign co-op and 4-player arcade deathmatch with customizable bot sets.',
    verification_status: 'VERIFIED',
    evidence_source: 'curated_database',
    confidence_score: 1.0,
  },
  'crash team racing': {
    is_single_player: true,
    is_local_coop: false,
    has_coop_campaign: false,
    is_local_competitive: true,
    is_local_versus: true,
    is_split_screen: true,
    is_shared_screen: false,
    is_online_multiplayer: false,
    is_lan_multiplayer: false,
    is_remote_play_compatible: true,
    is_hot_seat: false,
    min_players: 1,
    max_players: 4,
    max_local_coop_players: 0,
    max_local_competitive_players: 4,
    max_split_screen_players: 4,
    max_shared_screen_players: 0,
    max_online_players: 0,
    screen_type: 'split_screen',
    controllers_required: 1,
    gameplay_summary: '1P Adventure Mode | 2–4P Split-Screen Arcade & Battle',
    notes: 'Adventure is 1P. Split-screen supports 2-4 players on PlayStation (via Multitap).',
    verification_status: 'VERIFIED',
    evidence_source: 'curated_database',
    confidence_score: 1.0,
  },
  'super mario kart': {
    is_single_player: true,
    is_local_coop: false,
    has_coop_campaign: false,
    is_local_competitive: true,
    is_local_versus: true,
    is_split_screen: true,
    is_shared_screen: false,
    is_online_multiplayer: false,
    is_lan_multiplayer: false,
    is_remote_play_compatible: true,
    is_hot_seat: false,
    min_players: 1,
    max_players: 2,
    max_local_coop_players: 0,
    max_local_competitive_players: 2,
    max_split_screen_players: 2,
    max_shared_screen_players: 0,
    max_online_players: 0,
    screen_type: 'split_screen',
    controllers_required: 1,
    gameplay_summary: '1–2P Split-Screen Grand Prix, Match Race & Battle Mode',
    notes: 'Original SNES 2-player split-screen racing and battle.',
    verification_status: 'VERIFIED',
    evidence_source: 'curated_database',
    confidence_score: 1.0,
  },
  'super smash bros melee': {
    is_single_player: true,
    is_local_coop: true,
    has_coop_campaign: false,
    is_local_competitive: true,
    is_local_versus: true,
    is_split_screen: false,
    is_shared_screen: true,
    is_online_multiplayer: false,
    is_lan_multiplayer: false,
    is_remote_play_compatible: true,
    is_hot_seat: false,
    min_players: 1,
    max_players: 4,
    max_local_coop_players: 4,
    max_local_competitive_players: 4,
    max_split_screen_players: 0,
    max_shared_screen_players: 4,
    max_online_players: 0,
    screen_type: 'shared_screen',
    controllers_required: 1,
    gameplay_summary: '1–4P Shared-Screen Free-For-All & Team Battle',
    notes: 'Up to 4 players on one dynamic camera screen. Strictly shared-screen, NOT split-screen.',
    verification_status: 'VERIFIED',
    evidence_source: 'curated_database',
    confidence_score: 1.0,
  },
  'mario kart double dash': {
    is_single_player: true,
    is_local_coop: true,
    has_coop_campaign: true,
    is_local_competitive: true,
    is_local_versus: true,
    is_split_screen: true,
    is_shared_screen: false,
    is_online_multiplayer: false,
    is_lan_multiplayer: true,
    is_remote_play_compatible: true,
    is_hot_seat: false,
    min_players: 1,
    max_players: 4,
    max_local_coop_players: 2,
    max_local_competitive_players: 4,
    max_split_screen_players: 4,
    max_shared_screen_players: 0,
    max_online_players: 0,
    screen_type: 'split_screen',
    controllers_required: 1,
    gameplay_summary: '1–2P Co-Op in One Kart | 2–4P Split-Screen Racing & Battle',
    notes: 'Unique cooperative mode allows 2 players to share one kart (one drives, one throws items). Also 2-4P split-screen competitive.',
    verification_status: 'VERIFIED',
    evidence_source: 'curated_database',
    confidence_score: 1.0,
  },
  'star wars battlefront ii': {
    is_single_player: true,
    is_local_coop: true,
    has_coop_campaign: true,
    is_local_competitive: true,
    is_local_versus: true,
    is_split_screen: true,
    is_shared_screen: false,
    is_online_multiplayer: false,
    is_lan_multiplayer: false,
    is_remote_play_compatible: true,
    is_hot_seat: false,
    min_players: 1,
    max_players: 2,
    max_local_coop_players: 2,
    max_local_competitive_players: 2,
    max_split_screen_players: 2,
    max_shared_screen_players: 0,
    max_online_players: 0,
    screen_type: 'split_screen',
    controllers_required: 1,
    gameplay_summary: '1–2P Split-Screen Galactic Conquest & Campaign Co-Op / Versus',
    notes: '2-player split-screen on console. Galactic conquest and instant action can be played cooperatively on the same team or head-to-head.',
    verification_status: 'VERIFIED',
    evidence_source: 'curated_database',
    confidence_score: 1.0,
  },
  'champions of norrath': {
    is_single_player: true,
    is_local_coop: true,
    has_coop_campaign: true,
    is_local_competitive: false,
    is_local_versus: false,
    is_split_screen: false,
    is_shared_screen: true,
    is_online_multiplayer: false,
    is_lan_multiplayer: false,
    is_remote_play_compatible: true,
    is_hot_seat: false,
    min_players: 1,
    max_players: 4,
    max_local_coop_players: 4,
    max_local_competitive_players: 0,
    max_split_screen_players: 0,
    max_shared_screen_players: 4,
    max_online_players: 0,
    screen_type: 'shared_screen',
    controllers_required: 1,
    gameplay_summary: '1–4P Shared-Screen Hack-and-Slash Action RPG Co-Op Campaign',
    notes: 'Up to 4 players adventure together on one screen through the entire story campaign (PS2 Multitap).',
    verification_status: 'VERIFIED',
    evidence_source: 'curated_database',
    confidence_score: 1.0,
  },
  'baldurs gate dark alliance': {
    is_single_player: true,
    is_local_coop: true,
    has_coop_campaign: true,
    is_local_competitive: false,
    is_local_versus: false,
    is_split_screen: false,
    is_shared_screen: true,
    is_online_multiplayer: false,
    is_lan_multiplayer: false,
    is_remote_play_compatible: true,
    is_hot_seat: false,
    min_players: 1,
    max_players: 2,
    max_local_coop_players: 2,
    max_local_competitive_players: 0,
    max_split_screen_players: 0,
    max_shared_screen_players: 2,
    max_online_players: 0,
    screen_type: 'shared_screen',
    controllers_required: 1,
    gameplay_summary: '1–2P Shared-Screen Action RPG Co-Op Campaign',
    notes: '2-player cooperative campaign on shared screen.',
    verification_status: 'VERIFIED',
    evidence_source: 'curated_database',
    confidence_score: 1.0,
  },
  'gran turismo 2': {
    is_single_player: true,
    is_local_coop: false,
    has_coop_campaign: false,
    is_local_competitive: true,
    is_local_versus: true,
    is_split_screen: true,
    is_shared_screen: false,
    is_online_multiplayer: false,
    is_lan_multiplayer: false,
    is_remote_play_compatible: true,
    is_hot_seat: false,
    min_players: 1,
    max_players: 2,
    max_local_coop_players: 0,
    max_local_competitive_players: 2,
    max_split_screen_players: 2,
    max_shared_screen_players: 0,
    max_online_players: 0,
    screen_type: 'split_screen',
    controllers_required: 1,
    gameplay_summary: '1P Simulation Career | 2P Split-Screen Head-to-Head Racing',
    notes: '2-player horizontal split-screen racing on Arcade disc. Simulation career is single-player.',
    verification_status: 'VERIFIED',
    evidence_source: 'curated_database',
    confidence_score: 1.0,
  },
  'burnout 3 takedown': {
    is_single_player: true,
    is_local_coop: false,
    has_coop_campaign: false,
    is_local_competitive: true,
    is_local_versus: true,
    is_split_screen: true,
    is_shared_screen: false,
    is_online_multiplayer: false,
    is_lan_multiplayer: false,
    is_remote_play_compatible: true,
    is_hot_seat: true,
    min_players: 1,
    max_players: 2,
    max_local_coop_players: 0,
    max_local_competitive_players: 2,
    max_split_screen_players: 2,
    max_shared_screen_players: 0,
    max_online_players: 0,
    screen_type: 'split_screen',
    controllers_required: 1,
    gameplay_summary: '1P World Tour | 2P Split-Screen Race / Road Rage / Party Crash (Pass Controller)',
    notes: '2-player split-screen race and road rage. Crash mode supports party pass-and-play for up to 16 players.',
    verification_status: 'VERIFIED',
    evidence_source: 'curated_database',
    confidence_score: 1.0,
  },
};

/**
 * Normalizes title for lookup in canonical curated dictionary.
 */
export function normalizeTitle(title: string): string {
  return String(title ?? '')
    .toLowerCase()
    .replace(/\s*\(.*?\)/g, '') // remove (USA), (Rev 1), (Europe)
    .replace(/\s*\[.*?\]/g, '') // remove [!], [b1]
    .replace(/[^a-z0-9]/g, ' ')  // remove punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Checks if a game title matches an entry in the canonical curated database.
 */
// Which console each curated entry describes. A curated entry only applies
// to its own console: GoldenEye 007 (N64) said nothing about GoldenEye:
// Rogue Agent (GameCube), which a catch-all for "goldeneye" used to give it.
const CURATED_PLATFORMS: Record<string, string[]> = {
  '007 goldeneye': ['n64'], 'goldeneye 007': ['n64'], 'perfect dark': ['n64'], 'mario kart 64': ['n64'], 'super smash bros': ['n64'],
  'super mario 64': ['n64'], 'the legend of zelda ocarina of time': ['n64'], 'the legend of zelda majoras mask': ['n64'],
  'diddy kong racing': ['n64'], 'conkers bad fur day': ['n64'], 'mario party': ['n64'], 'mario party 2': ['n64'], 'mario party 3': ['n64'],
  'star fox 64': ['n64'], 'wave race 64': ['n64'], 'f-zero x': ['n64'], 'banjo kazooie': ['n64'], 'banjo tooie': ['n64'],
  'donkey kong 64': ['n64'], 'pokemon stadium': ['n64'], 'pokemon stadium 2': ['n64'], 'wwf no mercy': ['n64'],
  'contra': ['nes'], 'super c': ['nes'], 'contra iii the alien wars': ['snes'], 'contra hard corps': ['genesis'],
  'metal slug': ['neogeo', 'mame'], 'streets of rage 2': ['genesis'], 'teenage mutant ninja turtles iv turtles in time': ['snes'],
  'secret of mana': ['snes'], 'zombies ate my neighbors': ['snes', 'genesis'], 'street fighter ii': ['snes', 'genesis', 'mame'], 'street fighter ii turbo': ['snes', 'genesis', 'mame'],
  'tekken 3': ['psx'], 'super mario bros': ['nes'], 'super mario world': ['snes'], 'worms armageddon': ['psx', 'n64', 'dreamcast'],
  'halo combat evolved': ['xbox'], 'timesplitters 2': ['ps2', 'gamecube', 'xbox'], 'crash team racing': ['psx'], 'super mario kart': ['snes'],
  'super smash bros melee': ['gamecube'], 'mario kart double dash': ['gamecube'], 'star wars battlefront ii': ['ps2', 'psp', 'xbox'],
  'champions of norrath': ['ps2'], 'baldurs gate dark alliance': ['ps2', 'gamecube', 'xbox'], 'gran turismo 2': ['psx'], 'burnout 3 takedown': ['ps2', 'xbox'],
};
export function findCuratedGame(title: string, platform?: string): CuratedSpec | null {
  const norm = normalizeTitle(title);
  const plat = platform ? canonicalPlatform(platform) : '';
  const fits = (key: string) => !plat || (CURATED_PLATFORMS[key] ?? []).includes(plat);
  if (CURATED_GAMES[norm] && fits(norm)) return CURATED_GAMES[norm];
  // "GoldenEye 007 (USA)" or "Super Mario Bros. Deluxe" must not borrow a
  // shorter title's entry, so only an exact match (after normalising) counts.
  return null;
}

/**
 * Platform constraints: certain retro platforms cannot do local split-screen without special link hardware.
 */
const SINGLE_PLAYER_SYSTEMS = new Set([
  'gb', 'gbc', 'gamegear', 'wonderswan', 'ngp', 'ngpc', 'pokemonmini'
]);

/**
 * Rule-based heuristic classifier when title is not in the curated dictionary.
 * STRICT RULE: Does NOT assume "multiplayer" or "2 players" means cooperative campaign!
 * Confidence is capped at HIGH_CONFIDENCE (never claims VERIFIED).
 */
export function classifyGameHeuristics(
  title: string,
  platform: string,
  genreList: string[] = [],
  rawPlayersText = '1'
): CuratedSpec {
  const norm = normalizeTitle(title);
  const plat = String(platform ?? '').toLowerCase();
  const genres = genreList.map(g => String(g).toLowerCase());

  // 1. Handhelds with no native local split-screen / simultaneous local multiplayer
  if (SINGLE_PLAYER_SYSTEMS.has(plat)) {
    return {
      is_single_player: true,
      is_local_coop: false,
      has_coop_campaign: false,
      is_local_competitive: false,
      is_local_versus: false,
      is_split_screen: false,
      is_shared_screen: false,
      is_online_multiplayer: false,
      is_lan_multiplayer: false,
      is_remote_play_compatible: false,
      is_hot_seat: false,
      min_players: 1,
      max_players: 1,
      max_local_coop_players: 0,
      max_local_competitive_players: 0,
      max_split_screen_players: 0,
      max_shared_screen_players: 0,
      max_online_players: 0,
      screen_type: 'none',
      controllers_required: 1,
      gameplay_summary: 'Single-Player Handheld Title',
      notes: 'Handheld platform without simultaneous local screen sharing.',
      verification_status: 'HIGH_CONFIDENCE',
      evidence_source: 'platform_docs',
      confidence_score: 0.9,
    };
  }

  // 2. Fighting Games -> Shared Screen Versus, NOT split-screen, NOT co-op campaign
  const isFighting = genres.some(g => g.includes('fighting') || g.includes('versus')) ||
    /\b(street fighter|tekken|mortal kombat|guilty gear|king of fighters|samurai shodown|fatal fury|virtua fighter|dead or alive|bloody roar|darkstalkers|soulcalibur|killer instinct|marvel vs|capcom vs)\b/.test(norm);
  if (isFighting) {
    return {
      is_single_player: true,
      is_local_coop: false,
      has_coop_campaign: false,
      is_local_competitive: true,
      is_local_versus: true,
      is_split_screen: false,
      is_shared_screen: true,
      is_online_multiplayer: false,
      is_lan_multiplayer: false,
      is_remote_play_compatible: true,
      is_hot_seat: false,
      min_players: 1,
      max_players: 2,
      max_local_coop_players: 0,
      max_local_competitive_players: 2,
      max_split_screen_players: 0,
      max_shared_screen_players: 2,
      max_online_players: 0,
      screen_type: 'shared_screen',
      controllers_required: 1,
      gameplay_summary: '1P Arcade Ladder | 2P Shared-Screen 1v1 Versus',
      notes: 'Fighting game: shared single-camera arena, head-to-head competitive versus.',
      verification_status: 'HIGH_CONFIDENCE',
      evidence_source: 'rule_heuristics',
      confidence_score: 0.85,
    };
  }

  // 3. Beat 'Em Up / Side-Scrolling Brawler -> Shared Screen Co-Op Campaign
  const isBeatEmUp = genres.some(g => g.includes('beat') || g.includes('brawler')) ||
    /\b(streets of rage|final fight|double dragon|golden axe|tmnt|turtles in time|river city|sunset riders|cadillacs and dinosaurs|captain commando|knights of the round|battletoads|ninja baseball)\b/.test(norm);
  if (isBeatEmUp) {
    return {
      is_single_player: true,
      is_local_coop: true,
      has_coop_campaign: true,
      is_local_competitive: false,
      is_local_versus: false,
      is_split_screen: false,
      is_shared_screen: true,
      is_online_multiplayer: false,
      is_lan_multiplayer: false,
      is_remote_play_compatible: true,
      is_hot_seat: false,
      min_players: 1,
      max_players: 2,
      max_local_coop_players: 2,
      max_local_competitive_players: 0,
      max_split_screen_players: 0,
      max_shared_screen_players: 2,
      max_online_players: 0,
      screen_type: 'shared_screen',
      controllers_required: 1,
      gameplay_summary: '1–2P Shared-Screen Co-Op Beat Em Up Campaign',
      notes: 'Co-op brawler: players share the camera and advance cooperatively.',
      verification_status: 'HIGH_CONFIDENCE',
      evidence_source: 'rule_heuristics',
      confidence_score: 0.85,
    };
  }

  // 4. Split-Screen Racing
  const isRacing = genres.some(g => g.includes('racing') || g.includes('driving')) ||
    /\b(kart|racing|grand prix|burnout|need for speed|f-zero|wipeout|ridge racer|gran turismo|crash team racing|ctr|top gear)\b/.test(norm);
  if (isRacing) {
    const maxP = /4/.test(rawPlayersText) || plat === 'n64' || plat === 'gamecube' ? 4 : 2;
    return {
      is_single_player: true,
      is_local_coop: false,
      has_coop_campaign: false,
      is_local_competitive: true,
      is_local_versus: true,
      is_split_screen: true,
      is_shared_screen: false,
      is_online_multiplayer: false,
      is_lan_multiplayer: false,
      is_remote_play_compatible: true,
      is_hot_seat: false,
      min_players: 1,
      max_players: maxP,
      max_local_coop_players: 0,
      max_local_competitive_players: maxP,
      max_split_screen_players: maxP,
      max_shared_screen_players: 0,
      max_online_players: 0,
      screen_type: 'split_screen',
      controllers_required: 1,
      gameplay_summary: `1–${maxP}P Split-Screen Competitive Racing`,
      notes: 'Racing game with divided viewport multiplayer.',
      verification_status: 'HIGH_CONFIDENCE',
      evidence_source: 'rule_heuristics',
      confidence_score: 0.8,
    };
  }

  // 5. Sports (Soccer, Basketball, Football, Tennis) -> Shared screen competitive/team co-op
  const isSports = genres.some(g => g.includes('sports')) ||
    /\b(fifa|pes|pro evolution|nba|nfl|nhl|tennis|virtua tennis|madden|soccer|smackdown|wwe|wwf)\b/.test(norm);
  if (isSports) {
    const maxP = /4/.test(rawPlayersText) || plat === 'n64' || plat === 'gamecube' || plat === 'ps2' ? 4 : 2;
    return {
      is_single_player: true,
      is_local_coop: true,
      has_coop_campaign: false,
      is_local_competitive: true,
      is_local_versus: true,
      is_split_screen: false,
      is_shared_screen: true,
      is_online_multiplayer: false,
      is_lan_multiplayer: false,
      is_remote_play_compatible: true,
      is_hot_seat: false,
      min_players: 1,
      max_players: maxP,
      max_local_coop_players: maxP,
      max_local_competitive_players: maxP,
      max_split_screen_players: 0,
      max_shared_screen_players: maxP,
      max_online_players: 0,
      screen_type: 'shared_screen',
      controllers_required: 1,
      gameplay_summary: `1–${maxP}P Shared-Screen Versus & Team Play`,
      notes: 'Sports title: dynamic camera on single playing field. Supports head-to-head or same-team co-op.',
      verification_status: 'HIGH_CONFIDENCE',
      evidence_source: 'rule_heuristics',
      confidence_score: 0.75,
    };
  }

  // 6. RPG / JRPG / Story-driven Adventure -> Single player only
  const isSinglePlayerStory = genres.some(g => g.includes('rpg') || g.includes('role-playing') || g.includes('visual novel')) ||
    /\b(final fantasy|chrono|dragon quest|xenogears|suikoden|star ocean|breath of fire|persona|shin megami|grandia|valkyrie profile|wild arms|tales of)\b/.test(norm);
  if (isSinglePlayerStory) {
    return {
      is_single_player: true,
      is_local_coop: false,
      has_coop_campaign: false,
      is_local_competitive: false,
      is_local_versus: false,
      is_split_screen: false,
      is_shared_screen: false,
      is_online_multiplayer: false,
      is_lan_multiplayer: false,
      is_remote_play_compatible: false,
      is_hot_seat: false,
      min_players: 1,
      max_players: 1,
      max_local_coop_players: 0,
      max_local_competitive_players: 0,
      max_split_screen_players: 0,
      max_shared_screen_players: 0,
      max_online_players: 0,
      screen_type: 'none',
      controllers_required: 1,
      gameplay_summary: 'Single-Player Story Campaign',
      notes: 'Narrative role-playing game designed for one player.',
      verification_status: 'HIGH_CONFIDENCE',
      evidence_source: 'rule_heuristics',
      confidence_score: 0.85,
    };
  }

  // 7. General multi-player tag in raw text (e.g. 2, 4) without known genre:
  // Must NOT guess co-op campaign! Mark as NEEDS_REVIEW so user/admin can verify.
  const hasMultiplePlayers = /^[2-8]$/.test(rawPlayersText) || /^[1-8]-[2-8]$/.test(rawPlayersText);
  if (hasMultiplePlayers) {
    const num = parseInt(rawPlayersText.replace(/^.*-/, ''), 10) || 2;
    return {
      is_single_player: true,
      is_local_coop: false,
      has_coop_campaign: false,
      is_local_competitive: true,
      is_local_versus: true,
      is_split_screen: false,
      is_shared_screen: true,
      is_online_multiplayer: false,
      is_lan_multiplayer: false,
      is_remote_play_compatible: true,
      is_hot_seat: false,
      min_players: 1,
      max_players: num,
      max_local_coop_players: 0,
      max_local_competitive_players: num,
      max_split_screen_players: 0,
      max_shared_screen_players: num,
      max_online_players: 0,
      screen_type: 'shared_screen',
      controllers_required: 1,
      gameplay_summary: `1–${num}P Multiplayer (Needs Review)`,
      notes: 'Game supports multiple players but specific campaign/split-screen details require review.',
      verification_status: 'NEEDS_REVIEW',
      evidence_source: 'rule_heuristics',
      confidence_score: 0.5,
    };
  }

  // 8. Default: Single Player Only
  return {
    is_single_player: true,
    is_local_coop: false,
    has_coop_campaign: false,
    is_local_competitive: false,
    is_local_versus: false,
    is_split_screen: false,
    is_shared_screen: false,
    is_online_multiplayer: false,
    is_lan_multiplayer: false,
    is_remote_play_compatible: false,
    is_hot_seat: false,
    min_players: 1,
    max_players: 1,
    max_local_coop_players: 0,
    max_local_competitive_players: 0,
    max_split_screen_players: 0,
    max_shared_screen_players: 0,
    max_online_players: 0,
    screen_type: 'none',
    controllers_required: 1,
    gameplay_summary: 'Single-Player Game',
    notes: 'Standard single-player experience.',
    verification_status: 'UNVERIFIED',
    evidence_source: 'rule_heuristics',
    confidence_score: 0.6,
  };
}

/**
 * Classifies a game by applying the Evidence Hierarchy:
 * 1. Exact Curated Match -> VERIFIED
 * 2. Platform / Rules Heuristic -> HIGH_CONFIDENCE or NEEDS_REVIEW
 */
const ENGINE_PLATFORMS = new Set(['nes', 'snes', 'n64', 'gb', 'gbc', 'gba', 'genesis', 'mastersystem', 'gamegear', 'psx', 'ps2', 'psp', 'gamecube', 'wii', 'dreamcast', 'neogeo', 'mame', 'atari2600', 'atari7800', 'pce', 'segacd', '32x']);

export function classifyGame(
  gameId: string,
  title: string,
  platform: string,
  genreList: string[] = [],
  rawPlayersText = '1',
  fileName = '',
  romCrc = ''
): GameMultiplayerInfo {
  const plat = canonicalPlatform(platform);
  const curated = findCuratedGame(stripDumpTags(title), plat) ?? (fileName ? findCuratedGame(stripDumpTags(fileName.replace(/\.[a-z0-9]{2,4}$/i, '')), plat) : null);
  // The old genre rules are kept only as a hint shown to reviewers.
  const hint = curated ? null : classifyGameHeuristics(title, plat, genreList, rawPlayersText);
  const c = classifyFromEvidence({ title, platform: plat, fileName, romCrc, curated, hints: hint && hint.evidence_source === 'rule_heuristics' && hint.gameplay_summary && !/Single-Player Game|Needs Review/.test(hint.gameplay_summary) ? [hint.gameplay_summary] : [] });
  const max = c.max_players ?? 0;
  const together = max > 1 || !!c.modes.local_coop || !!c.modes.local_competitive;
  return {
    game_id: gameId,
    is_single_player: c.modes.single_player !== false,
    is_local_coop: !!c.modes.local_coop,
    // "Cooperative" in a database doesn't say the story can be played together.
    has_coop_campaign: curated ? !!curated.has_coop_campaign : false,
    is_local_competitive: !!c.modes.local_competitive,
    is_local_versus: curated ? !!curated.is_local_versus : false,
    is_split_screen: !!c.modes.split_screen,
    is_shared_screen: !!c.modes.shared_screen,
    is_online_multiplayer: !!c.modes.online,
    is_lan_multiplayer: !!c.modes.lan,
    // Can be shared through SaveState's own remote play (a second person's
    // controls reach the game), which is not the same as native multiplayer.
    is_remote_play_compatible: together && ENGINE_PLATFORMS.has(plat),
    is_hot_seat: !!c.modes.hot_seat,
    min_players: 1,
    max_players: max,
    max_local_coop_players: c.max_local_coop_players ?? 0,
    max_local_competitive_players: curated ? curated.max_local_competitive_players : (c.modes.local_competitive ? max : 0),
    max_split_screen_players: curated ? curated.max_split_screen_players : 0,
    max_shared_screen_players: curated ? curated.max_shared_screen_players : 0,
    max_online_players: curated ? curated.max_online_players : 0,
    screen_type: c.modes.split_screen ? 'split_screen' : c.modes.shared_screen ? 'shared_screen' : c.modes.hot_seat ? 'turn_based' : 'none',
    controllers_required: Math.max(1, max),
    gameplay_summary: c.summary,
    notes: curated ? curated.notes : '',
    verification_status: c.status as VerificationStatus,
    evidence_source: c.evidence_source as EvidenceSource,
    confidence_score: c.confidence,
    evidence_detail: JSON.stringify(c.claims),
    review_reason: c.review_reason,
    classifier_version: CLASSIFIER_VERSION,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// DATABASE PERSISTENCE & LIFECYCLE
// ─────────────────────────────────────────────────────────────────────────────

export async function initMultiplayerSchema(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS game_multiplayer (
      game_id                        TEXT PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
      is_single_player               BOOLEAN NOT NULL DEFAULT TRUE,
      is_local_coop                  BOOLEAN NOT NULL DEFAULT FALSE,
      has_coop_campaign              BOOLEAN NOT NULL DEFAULT FALSE,
      is_local_competitive           BOOLEAN NOT NULL DEFAULT FALSE,
      is_local_versus                BOOLEAN NOT NULL DEFAULT FALSE,
      is_split_screen                BOOLEAN NOT NULL DEFAULT FALSE,
      is_shared_screen               BOOLEAN NOT NULL DEFAULT FALSE,
      is_online_multiplayer          BOOLEAN NOT NULL DEFAULT FALSE,
      is_lan_multiplayer             BOOLEAN NOT NULL DEFAULT FALSE,
      is_remote_play_compatible      BOOLEAN NOT NULL DEFAULT TRUE,
      is_hot_seat                    BOOLEAN NOT NULL DEFAULT FALSE,
      min_players                    INTEGER NOT NULL DEFAULT 1,
      max_players                    INTEGER NOT NULL DEFAULT 1,
      max_local_coop_players         INTEGER NOT NULL DEFAULT 0,
      max_local_competitive_players   INTEGER NOT NULL DEFAULT 0,
      max_split_screen_players       INTEGER NOT NULL DEFAULT 0,
      max_shared_screen_players      INTEGER NOT NULL DEFAULT 0,
      max_online_players             INTEGER NOT NULL DEFAULT 0,
      screen_type                    TEXT NOT NULL DEFAULT 'none',
      controllers_required           INTEGER NOT NULL DEFAULT 1,
      gameplay_summary               TEXT NOT NULL DEFAULT '',
      notes                          TEXT NOT NULL DEFAULT '',
      verification_status            TEXT NOT NULL DEFAULT 'UNVERIFIED',
      evidence_source                TEXT NOT NULL DEFAULT 'rule_heuristics',
      confidence_score               REAL NOT NULL DEFAULT 0.5,
      verified_by                    TEXT DEFAULT NULL,
      verified_at                    TIMESTAMPTZ DEFAULT NULL,
      created_at                     TIMESTAMPTZ DEFAULT NOW(),
      updated_at                     TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_gm_local_coop ON game_multiplayer(is_local_coop);
    CREATE INDEX IF NOT EXISTS idx_gm_has_coop_campaign ON game_multiplayer(has_coop_campaign);
    CREATE INDEX IF NOT EXISTS idx_gm_split_screen ON game_multiplayer(is_split_screen);
    CREATE INDEX IF NOT EXISTS idx_gm_local_competitive ON game_multiplayer(is_local_competitive);
    CREATE INDEX IF NOT EXISTS idx_gm_shared_screen ON game_multiplayer(is_shared_screen);
    CREATE INDEX IF NOT EXISTS idx_gm_remote_play ON game_multiplayer(is_remote_play_compatible);
    CREATE INDEX IF NOT EXISTS idx_gm_max_players ON game_multiplayer(max_players);
    CREATE INDEX IF NOT EXISTS idx_gm_status ON game_multiplayer(verification_status);
    ALTER TABLE game_multiplayer ADD COLUMN IF NOT EXISTS evidence_detail TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE game_multiplayer ADD COLUMN IF NOT EXISTS review_reason TEXT NOT NULL DEFAULT '';
    ALTER TABLE game_multiplayer ADD COLUMN IF NOT EXISTS classifier_version INTEGER NOT NULL DEFAULT 0;
    CREATE INDEX IF NOT EXISTS idx_gm_version ON game_multiplayer(classifier_version);
  `);
}

const GM_COLS = ['game_id', 'is_single_player', 'is_local_coop', 'has_coop_campaign', 'is_local_competitive', 'is_local_versus', 'is_split_screen', 'is_shared_screen',
  'is_online_multiplayer', 'is_lan_multiplayer', 'is_remote_play_compatible', 'is_hot_seat', 'min_players', 'max_players', 'max_local_coop_players',
  'max_local_competitive_players', 'max_split_screen_players', 'max_shared_screen_players', 'max_online_players', 'screen_type', 'controllers_required',
  'gameplay_summary', 'notes', 'verification_status', 'evidence_source', 'confidence_score', 'verified_by', 'verified_at',
  'evidence_detail', 'review_reason', 'classifier_version'] as const;

/**
 * A small host (the NAS: 490 MB of RAM, a 192 MB heap) can't hold the
 * evidence index or every row's evidence text: loading them there kept it
 * collecting garbage for 7-9 s at a time (2026-11-09). It keeps only what the
 * game list shows and leaves classifying to the main host (same database).
 */
export const LOW_HEAP = v8.getHeapStatistics().heap_size_limit < 600 * 1024 * 1024;

/** What the game list shows, kept in memory: the saved rows (corrections included). */
export const mpCache = new Map<string, GameMultiplayerInfo>();
export async function loadMpCache(pool: pg.Pool): Promise<number> {
  const r = await pool.query(`SELECT game_id, is_single_player, is_local_coop, has_coop_campaign, is_local_competitive, is_local_versus,
    is_split_screen, is_shared_screen, is_online_multiplayer, is_lan_multiplayer, is_remote_play_compatible, is_hot_seat,
    min_players, max_players, max_local_coop_players, max_local_competitive_players, max_split_screen_players, screen_type,
    gameplay_summary, verification_status, evidence_source, confidence_score, review_reason FROM game_multiplayer`);
  mpCache.clear();
  for (const row of r.rows) mpCache.set(String(row.game_id), row as GameMultiplayerInfo);
  return mpCache.size;
}

/** Saves many profiles in a few statements (one per 200), not one round trip each. */
export async function saveManyGameMultiplayer(pool: pg.Pool, rows: GameMultiplayerInfo[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const params: any[] = [];
    const values = chunk.map((r) => {
      const v = GM_COLS.map((c) => {
        const x = (r as any)[c];
        if (c === 'evidence_detail') return x ?? '[]';
        if (c === 'review_reason') return x ?? '';
        if (c === 'classifier_version') return x ?? 0;
        return x ?? null;
      });
      const start = params.length;
      params.push(...v);
      return '(' + v.map((_, k) => '$' + (start + k + 1)).join(', ') + ', NOW())';
    });
    await pool.query(
      `INSERT INTO game_multiplayer (${GM_COLS.join(', ')}, updated_at) VALUES ${values.join(', ')}
       ON CONFLICT (game_id) DO UPDATE SET ${GM_COLS.slice(1).map((c) => `${c} = EXCLUDED.${c}`).join(', ')}, updated_at = NOW()`,
      params,
    );
    for (const r of chunk) mpCache.set(String(r.game_id), r);
  }
}

/** Saves or updates one game's multiplayer profile. */
export async function saveGameMultiplayer(pool: pg.Pool, info: GameMultiplayerInfo): Promise<void> {
  await saveManyGameMultiplayer(pool, [info]);
}

/**
 * Retrieves multiplayer details for a single game.
 */
export async function getGameMultiplayer(
  pool: pg.Pool,
  gameId: string
): Promise<GameMultiplayerInfo | null> {
  const r = await pool.query(
    'SELECT * FROM game_multiplayer WHERE game_id = $1 LIMIT 1',
    [gameId]
  );
  if (!r.rows || r.rows.length === 0) return null;
  return r.rows[0] as GameMultiplayerInfo;
}

/**
 * Batch classification worker: populates `game_multiplayer` for all games.
 * Preserves existing VERIFIED or manual overrides unless force=true.
 */
export async function batchClassifyLibrary(
  pool: pg.Pool,
  options: { force?: boolean; onProgress?: (done: number, total: number) => void } = {}
): Promise<{ total: number; classified: number; verified: number; kept: number }> {
  const gamesRes = await pool.query(`
    SELECT g.id, g.title, g.platform, g.genre, g.players, g.relative_path,
           gm.verification_status, gm.evidence_source, COALESCE(gm.classifier_version, 0) AS classifier_version
    FROM games g
    LEFT JOIN game_multiplayer gm ON g.id = gm.game_id
  `);
  const games = gamesRes.rows;
  let kept = 0, verified = 0;
  const todo: GameMultiplayerInfo[] = [];
  for (const g of games) {
    // A person's correction is never replaced by the automatic classifier.
    if (g.evidence_source === 'manual_verified') { kept++; verified++; continue; }
    // Already done by this version of the classifier: nothing to redo.
    if (!options.force && Number(g.classifier_version) >= CLASSIFIER_VERSION) { kept++; continue; }
    const fileName = String(g.relative_path ?? '').split(/[\\/]/).pop() ?? '';
    todo.push(classifyGame(g.id, g.title, g.platform, Array.isArray(g.genre) ? g.genre : [], String(g.players ?? '1'), fileName));
  }
  for (let i = 0; i < todo.length; i += 200) {
    await saveManyGameMultiplayer(pool, todo.slice(i, i + 200));
    options.onProgress?.(Math.min(todo.length, i + 200), todo.length);
    // Let requests in between batches.
    await new Promise((r) => setTimeout(r, 50));
  }
  return { total: games.length, classified: todo.length, verified, kept };
}

// ─────────────────────────────────────────────────────────────────────────────
// REST API ROUTE REGISTRATION
// ─────────────────────────────────────────────────────────────────────────────

export interface MultiplayerApiOptions {
  app: express.Express;
  pool: pg.Pool | null;
  mem: any;
  log: (lvl: string, msg: string, sub?: string) => void;
  requireAuth: (req: express.Request, res: express.Response) => any;
  isAdmin: (auth: any) => Promise<boolean>;
}

export function registerMultiplayerApi(options: MultiplayerApiOptions): void {
  const { app, pool, mem, log, requireAuth, isAdmin } = options;

  /**
   * GET /api/multiplayer/games
   * Discovers and filters games by specific multiplayer mode, screen type, and player count.
   */
  app.get('/api/multiplayer/games', async (req, res) => {
    try {
      const mode = String(req.query.mode ?? '').toLowerCase();
      const minPlayers = parseInt(String(req.query.players ?? '1'), 10) || 1;
      const platform = String(req.query.platform ?? '').toLowerCase();
      const search = String(req.query.search ?? '').trim().toLowerCase();
      const status = String(req.query.status ?? '').toUpperCase();
      const limit = Math.min(2000, Math.max(1, parseInt(String(req.query.limit ?? '100'), 10) || 100));
      const offset = Math.max(0, parseInt(String(req.query.offset ?? '0'), 10) || 0);

      if (pool) {
        let whereClauses: string[] = ["g.relative_path IS NOT NULL AND g.relative_path != ''"];
        const params: any[] = [];
        let pIdx = 1;

        if (mode === 'coop' || mode === 'local_coop') {
          whereClauses.push('(gm.is_local_coop = TRUE OR gm.has_coop_campaign = TRUE)');
        } else if (mode === 'coop_campaign' || mode === 'campaign') {
          whereClauses.push('gm.has_coop_campaign = TRUE');
        } else if (mode === 'split_screen') {
          whereClauses.push('gm.is_split_screen = TRUE');
        } else if (mode === 'competitive' || mode === 'versus' || mode === 'local_competitive') {
          whereClauses.push('(gm.is_local_competitive = TRUE OR gm.is_local_versus = TRUE)');
        } else if (mode === 'shared_screen') {
          whereClauses.push('gm.is_shared_screen = TRUE');
        } else if (mode === 'remote_play') {
          whereClauses.push('gm.is_remote_play_compatible = TRUE');
        } else if (mode === 'single_player') {
          whereClauses.push('gm.is_single_player = TRUE');
        }

        if (minPlayers > 1) {
          whereClauses.push(`gm.max_players >= $${pIdx++}`);
          params.push(minPlayers);
        }

        if (platform) {
          whereClauses.push(`LOWER(g.platform) = $${pIdx++}`);
          params.push(platform);
        }

        if (search) {
          whereClauses.push(`(g.title ILIKE $${pIdx} OR gm.gameplay_summary ILIKE $${pIdx})`);
          params.push(`%${search}%`);
          pIdx++;
        }

        if (status && ['VERIFIED', 'HIGH_CONFIDENCE', 'NEEDS_REVIEW', 'UNVERIFIED'].includes(status)) {
          whereClauses.push(`gm.verification_status = $${pIdx++}`);
          params.push(status);
        }

        const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
        const countQuery = `
          SELECT COUNT(*) as count
          FROM games g
          LEFT JOIN game_multiplayer gm ON g.id = gm.game_id
          ${whereSql}
        `;
        const countRes = await pool.query(countQuery, params);
        const total = parseInt(countRes.rows[0]?.count ?? '0', 10);

        const dataQuery = `
          SELECT 
            g.id, g.title, g.platform, g.box_art, g.hero_image, g.playtime, g.dominant_color,
            gm.is_single_player, gm.is_local_coop, gm.has_coop_campaign, gm.is_local_competitive,
            gm.is_local_versus, gm.is_split_screen, gm.is_shared_screen, gm.is_remote_play_compatible,
            gm.is_hot_seat, gm.min_players, gm.max_players, gm.max_local_coop_players,
            gm.max_local_competitive_players, gm.max_split_screen_players, gm.screen_type,
            gm.gameplay_summary, gm.verification_status, gm.evidence_source, gm.confidence_score
          FROM games g
          LEFT JOIN game_multiplayer gm ON g.id = gm.game_id
          ${whereSql}
          ORDER BY g.title ASC
          LIMIT $${pIdx++} OFFSET $${pIdx++}
        `;
        params.push(limit, offset);
        const dataRes = await pool.query(dataQuery, params);

        return res.json({
          ok: true,
          total,
          limit,
          offset,
          games: dataRes.rows.map((row) => ({
            id: row.id,
            title: row.title,
            platform: row.platform,
            boxArt: row.box_art ?? '',
            heroImage: row.hero_image ?? '',
            dominantColor: row.dominant_color ?? '#1a1a2e',
            multiplayer: {
              isSinglePlayer: row.is_single_player ?? true,
              isLocalCoop: row.is_local_coop ?? false,
              hasCoopCampaign: row.has_coop_campaign ?? false,
              isLocalCompetitive: row.is_local_competitive ?? false,
              isLocalVersus: row.is_local_versus ?? false,
              isSplitScreen: row.is_split_screen ?? false,
              isSharedScreen: row.is_shared_screen ?? false,
              isRemotePlayCompatible: row.is_remote_play_compatible ?? true,
              isHotSeat: row.is_hot_seat ?? false,
              minPlayers: row.min_players ?? 1,
              maxPlayers: row.max_players ?? 1,
              maxLocalCoopPlayers: row.max_local_coop_players ?? 0,
              maxLocalCompetitivePlayers: row.max_local_competitive_players ?? 0,
              maxSplitScreenPlayers: row.max_split_screen_players ?? 0,
              screenType: row.screen_type ?? 'none',
              summary: row.gameplay_summary ?? '',
              verificationStatus: row.verification_status ?? 'UNVERIFIED',
              evidenceSource: row.evidence_source ?? 'rule_heuristics',
              confidenceScore: row.confidence_score ?? 0.5,
            },
          })),
        });
      }

      // In-memory fallback
      let list = (mem.games ?? []).map((g: any) => {
        const multi = classifyGame(g.id, g.title, g.platform, g.metadata?.genre ?? [], g.metadata?.players ?? '1');
        return {
          id: g.id,
          title: g.title,
          platform: g.platform,
          boxArt: g.boxArt ?? '',
          heroImage: g.heroImage ?? '',
          dominantColor: g.dominantColor ?? '#1a1a2e',
          multiplayer: {
            isSinglePlayer: multi.is_single_player,
            isLocalCoop: multi.is_local_coop,
            hasCoopCampaign: multi.has_coop_campaign,
            isLocalCompetitive: multi.is_local_competitive,
            isLocalVersus: multi.is_local_versus,
            isSplitScreen: multi.is_split_screen,
            isSharedScreen: multi.is_shared_screen,
            isRemotePlayCompatible: multi.is_remote_play_compatible,
            isHotSeat: multi.is_hot_seat,
            minPlayers: multi.min_players,
            maxPlayers: multi.max_players,
            maxLocalCoopPlayers: multi.max_local_coop_players,
            maxLocalCompetitivePlayers: multi.max_local_competitive_players,
            maxSplitScreenPlayers: multi.max_split_screen_players,
            screenType: multi.screen_type,
            summary: multi.gameplay_summary,
            verificationStatus: multi.verification_status,
            evidenceSource: multi.evidence_source,
            confidenceScore: multi.confidence_score,
          },
        };
      });

      if (mode === 'coop') list = list.filter((g: any) => g.multiplayer.isLocalCoop || g.multiplayer.hasCoopCampaign);
      if (mode === 'coop_campaign') list = list.filter((g: any) => g.multiplayer.hasCoopCampaign);
      if (mode === 'split_screen') list = list.filter((g: any) => g.multiplayer.isSplitScreen);
      if (mode === 'competitive') list = list.filter((g: any) => g.multiplayer.isLocalCompetitive || g.multiplayer.isLocalVersus);
      if (mode === 'shared_screen') list = list.filter((g: any) => g.multiplayer.isSharedScreen);
      if (minPlayers > 1) list = list.filter((g: any) => g.multiplayer.maxPlayers >= minPlayers);
      if (platform) list = list.filter((g: any) => g.platform.toLowerCase() === platform);
      if (search) list = list.filter((g: any) => g.title.toLowerCase().includes(search));

      const total = list.length;
      res.json({
        ok: true,
        total,
        limit,
        offset,
        games: list.slice(offset, offset + limit),
      });
    } catch (err: any) {
      log('ERROR', `Multiplayer games query failed: ${err.message}`, 'multiplayer');
      res.status(500).json({ error: String(err?.message ?? err) });
    }
  });

  /**
   * GET /api/multiplayer/details/:gameId
   * Returns full multiplayer profile for a specific game.
   */
  app.get('/api/multiplayer/details/:gameId', async (req, res) => {
    try {
      const { gameId } = req.params;
      if (pool) {
        const stored = await getGameMultiplayer(pool, gameId);
        if (stored) return res.json({ ok: true, details: stored });
        const gameRes = await pool.query('SELECT title, platform, genre, players FROM games WHERE id = $1 LIMIT 1', [gameId]);
        if (gameRes.rows && gameRes.rows[0]) {
          const g = gameRes.rows[0];
          const classified = classifyGame(gameId, g.title, g.platform, Array.isArray(g.genre) ? g.genre : [], g.players ?? '1');
          await saveGameMultiplayer(pool, classified).catch(() => {});
          return res.json({ ok: true, details: classified });
        }
      }

      const memGame = (mem.games ?? []).find((g: any) => g.id === gameId);
      if (memGame) {
        const classified = classifyGame(gameId, memGame.title, memGame.platform, memGame.metadata?.genre ?? [], memGame.metadata?.players ?? '1');
        return res.json({ ok: true, details: classified });
      }

      res.status(404).json({ error: 'Game not found' });
    } catch (err: any) {
      res.status(500).json({ error: String(err?.message ?? err) });
    }
  });

  /**
   * POST /api/multiplayer/classify/:gameId
   * Re-evaluates classification and saves to DB.
   */
  app.post('/api/multiplayer/classify/:gameId', async (req, res) => {
    try {
      const auth = requireAuth(req, res);
      if (!auth) return;
      const { gameId } = req.params;
      if (!pool) return res.status(503).json({ error: 'Database unavailable' });

      const gameRes = await pool.query('SELECT title, platform, genre, players FROM games WHERE id = $1 LIMIT 1', [gameId]);
      if (!gameRes.rows || !gameRes.rows[0]) return res.status(404).json({ error: 'Game not found' });

      const g = gameRes.rows[0];
      const classified = classifyGame(gameId, g.title, g.platform, Array.isArray(g.genre) ? g.genre : [], g.players ?? '1');
      await saveGameMultiplayer(pool, classified);
      res.json({ ok: true, details: classified });
    } catch (err: any) {
      res.status(500).json({ error: String(err?.message ?? err) });
    }
  });

  /**
   * POST /api/multiplayer/classify-all
   * Admin-only batch classification of the library.
   */
  app.post('/api/multiplayer/classify-all', async (req, res) => {
    try {
      const auth = requireAuth(req, res);
      if (!auth) return;
      if (!(await isAdmin(auth))) return res.status(403).json({ error: 'Admin only' });
      if (!pool) return res.status(503).json({ error: 'Database unavailable' });

      const force = Boolean(req.body?.force);
      // Run batch asynchronously so the HTTP request completes quickly
      void batchClassifyLibrary(pool, { force }).then((result) => {
        log('INFO', `Library multiplayer batch complete: ${result.classified} classified, ${result.verified} verified`, 'multiplayer');
      }).catch((e) => log('ERROR', `Batch multiplayer failed: ${e.message}`, 'multiplayer'));

      res.json({ ok: true, message: 'Classification job queued successfully' });
    } catch (err: any) {
      res.status(500).json({ error: String(err?.message ?? err) });
    }
  });

  /**
   * PUT /api/multiplayer/override/:gameId
   * Admin-only tool to manually correct multiplayer properties and mark VERIFIED.
   */
  app.put('/api/multiplayer/override/:gameId', async (req, res) => {
    try {
      const auth = requireAuth(req, res);
      if (!auth) return;
      if (!(await isAdmin(auth))) return res.status(403).json({ error: 'Admin only' });
      if (!pool) return res.status(503).json({ error: 'Database unavailable' });

      const { gameId } = req.params;
      const b = req.body ?? {};

      const info: GameMultiplayerInfo = {
        game_id: gameId,
        is_single_player: b.is_single_player ?? true,
        is_local_coop: Boolean(b.is_local_coop),
        has_coop_campaign: Boolean(b.has_coop_campaign),
        is_local_competitive: Boolean(b.is_local_competitive),
        is_local_versus: Boolean(b.is_local_versus),
        is_split_screen: Boolean(b.is_split_screen),
        is_shared_screen: Boolean(b.is_shared_screen),
        is_online_multiplayer: Boolean(b.is_online_multiplayer),
        is_lan_multiplayer: Boolean(b.is_lan_multiplayer),
        is_remote_play_compatible: b.is_remote_play_compatible !== false,
        is_hot_seat: Boolean(b.is_hot_seat),
        min_players: parseInt(String(b.min_players ?? '1'), 10) || 1,
        max_players: parseInt(String(b.max_players ?? '1'), 10) || 1,
        max_local_coop_players: parseInt(String(b.max_local_coop_players ?? '0'), 10) || 0,
        max_local_competitive_players: parseInt(String(b.max_local_competitive_players ?? '0'), 10) || 0,
        max_split_screen_players: parseInt(String(b.max_split_screen_players ?? '0'), 10) || 0,
        max_shared_screen_players: parseInt(String(b.max_shared_screen_players ?? '0'), 10) || 0,
        max_online_players: parseInt(String(b.max_online_players ?? '0'), 10) || 0,
        screen_type: b.screen_type ?? 'none',
        controllers_required: parseInt(String(b.controllers_required ?? '1'), 10) || 1,
        gameplay_summary: String(b.gameplay_summary ?? '').trim(),
        notes: String(b.notes ?? '').trim(),
        verification_status: 'VERIFIED',
        evidence_source: 'manual_verified',
        confidence_score: 1.0,
        verified_by: auth.userId ? String(auth.userId) : 'admin',
        verified_at: new Date().toISOString(),
      };

      await saveGameMultiplayer(pool, info);
      log('INFO', `Admin updated multiplayer for game ${gameId}: ${info.gameplay_summary}`, 'multiplayer');
      res.json({ ok: true, details: info });
    } catch (err: any) {
      res.status(500).json({ error: String(err?.message ?? err) });
    }
  });

  /**
   * GET /api/multiplayer/stats
   * Returns classification coverage, verified counts, and mode totals.
   */
  app.get('/api/multiplayer/stats', async (_req, res) => {
    try {
      if (!pool) {
        return res.json({
          ok: true,
          mode: 'memory',
          total: (mem.games ?? []).length,
          classified: (mem.games ?? []).length,
          verified: Object.keys(CURATED_GAMES).length,
        });
      }

      const r = await pool.query(`
        SELECT 
          COUNT(*)::int as total_classified,
          COUNT(CASE WHEN verification_status = 'VERIFIED' THEN 1 END)::int as verified_count,
          COUNT(CASE WHEN verification_status = 'HIGH_CONFIDENCE' THEN 1 END)::int as high_confidence_count,
          COUNT(CASE WHEN verification_status = 'NEEDS_REVIEW' THEN 1 END)::int as needs_review_count,
          COUNT(CASE WHEN has_coop_campaign = TRUE THEN 1 END)::int as coop_campaign_count,
          COUNT(CASE WHEN is_local_coop = TRUE THEN 1 END)::int as local_coop_count,
          COUNT(CASE WHEN is_split_screen = TRUE THEN 1 END)::int as split_screen_count,
          COUNT(CASE WHEN is_local_competitive = TRUE THEN 1 END)::int as competitive_count,
          COUNT(CASE WHEN is_shared_screen = TRUE THEN 1 END)::int as shared_screen_count
        FROM game_multiplayer
      `);

      const totalGamesRes = await pool.query('SELECT COUNT(*)::int as total FROM games');
      const totalLibrary = totalGamesRes.rows[0]?.total ?? 0;

      res.json({
        ok: true,
        libraryTotal: totalLibrary,
        ...r.rows[0],
      });
    } catch (err: any) {
      res.status(500).json({ error: String(err?.message ?? err) });
    }
  });
}
