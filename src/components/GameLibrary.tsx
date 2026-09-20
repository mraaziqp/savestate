import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Play,
  Sparkles,
  Gamepad2,
  Users,
  Clock,
  Flame,
  ChevronLeft,
  ChevronRight,
  Share2,
  Info,
  Layers,
  LayoutGrid,
  Search,
  Check,
  Star,
  ExternalLink,
  Loader2,
} from 'lucide-react';
import { Game } from '../types';
import EcosystemInviteModal from './EcosystemInviteModal';

interface RecommendationPayload {
  topPick?: {
    gameId: string;
    title: string;
    platform: string;
    boxArt?: string;
    reason: string;
    tags?: string[];
  };
  recommendations?: Array<{
    gameId: string;
    title: string;
    platform: string;
    boxArt?: string;
    reason: string;
  }>;
}

interface GameLibraryProps {
  games: Game[];
  loading: boolean;
  onSelect: (game: Game) => void;
  onSwitchToGrid?: () => void;
  gpFocusIdx?: number;
}

const PLATFORM_COLORS: Record<string, string> = {
  snes: 'from-purple-600 to-indigo-800',
  ps1: 'from-blue-600 to-slate-900',
  n64: 'from-green-600 to-emerald-900',
  arcade: 'from-amber-600 to-red-900',
  steam: 'from-cyan-600 to-blue-900',
  gba: 'from-indigo-600 to-purple-900',
  genesis: 'from-red-600 to-zinc-900',
  dreamcast: 'from-orange-500 to-amber-800',
};

const COOP_KEYWORDS = [
  'coop', 'co-op', 'multiplayer', 'party', 'kart', 'smash', 'left 4 dead',
  'borderlands', 'halo', 'contra', 'street fighter', 'turtles', 'portal 2',
  'cuphead', 'overcooked', 'diablo', 'bomberman', 'metal slug', 'gauntlet'
];

export const GameLibrary: React.FC<GameLibraryProps> = ({
  games,
  loading,
  onSelect,
  onSwitchToGrid,
  gpFocusIdx = 0,
}) => {
  const [recData, setRecData] = useState<RecommendationPayload | null>(null);
  const [recLoading, setRecLoading] = useState(false);
  const [inviteModalOpen, setInviteModalOpen] = useState(false);
  const [targetInviteGame, setTargetInviteGame] = useState<Game | null>(null);

  // Fetch AI Recommendations
  useEffect(() => {
    let cancelled = false;
    const fetchRecs = async () => {
      setRecLoading(true);
      try {
        const token = localStorage.getItem('nexus_token') ?? '';
        const res = await fetch('/api/games/recommendations', {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled && data.ok) {
          setRecData(data);
        }
      } catch {
        // Handled silently with fallback
      } finally {
        if (!cancelled) setRecLoading(false);
      }
    };
    fetchRecs();
    return () => {
      cancelled = true;
    };
  }, []);

  // Top Pick Game resolution
  const topPickGame: Game | null = useMemo(() => {
    if (recData?.topPick?.gameId) {
      const match = games.find(g => g.id === recData.topPick!.gameId);
      if (match) return match;
    }
    if (games.length > 0) {
      // Find one with highest playtime or first game
      return [...games].sort((a, b) => (b.playtime || 0) - (a.playtime || 0))[0] || games[0];
    }
    return null;
  }, [recData, games]);

  // Jump Back In (recently played)
  const jumpBackInGames = useMemo(() => {
    return [...games]
      .filter(g => (g.playtime && g.playtime > 0) || g.lastPlayed)
      .sort((a, b) => new Date(b.lastPlayed || 0).getTime() - new Date(a.lastPlayed || 0).getTime())
      .slice(0, 16);
  }, [games]);

  // Couch Co-Op Ready
  const couchCoopGames = useMemo(() => {
    return games
      .filter(g => {
        if (g.platform === 'steam') return true;
        const t = g.title.toLowerCase();
        return COOP_KEYWORDS.some(kw => t.includes(kw));
      })
      .slice(0, 16);
  }, [games]);

  // Newly Added (simulate by reverse order or id)
  const newlyAddedGames = useMemo(() => {
    return [...games].slice(-16).reverse();
  }, [games]);

  // Group by popular platforms
  const platformRows = useMemo(() => {
    const counts = new Map<string, Game[]>();
    for (const g of games) {
      const p = (g.platform || 'arcade').toLowerCase();
      if (!counts.has(p)) counts.set(p, []);
      counts.get(p)!.push(g);
    }
    return Array.from(counts.entries())
      .filter(([_, list]) => list.length >= 2)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 5);
  }, [games]);

  const handleOpenInvite = (g: Game, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setTargetInviteGame(g);
    setInviteModalOpen(true);
  };

  return (
    <div className="w-full min-h-screen bg-zinc-950 text-zinc-100 flex flex-col pb-20 select-none">
      {/* ── Top Bar Controls ──────────────────────────────────────────────── */}
      <div className="sticky top-0 z-30 flex items-center justify-between px-6 py-3 bg-zinc-950/85 backdrop-blur-xl border-b border-zinc-800/60">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 text-xs font-semibold tracking-wide uppercase">
            <Sparkles className="w-3.5 h-3.5" />
            Discover & Recommendations
          </div>
          <span className="text-xs text-zinc-400 hidden sm:inline">
            Curated via Gemini 2.5 & AwehChat Ecosystem
          </span>
        </div>

        {onSwitchToGrid && (
          <button
            onClick={onSwitchToGrid}
            className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-zinc-300 hover:text-white border border-zinc-800 text-xs font-medium transition-all shadow-sm active:scale-95"
          >
            <LayoutGrid className="w-3.5 h-3.5 text-zinc-400" />
            <span>Switch to BigBox Grid</span>
          </button>
        )}
      </div>

      {/* ── Hero Banner (Gemini Top Pick) ─────────────────────────────────── */}
      {topPickGame && (
        <div className="relative w-full overflow-hidden bg-gradient-to-b from-zinc-900 to-zinc-950 border-b border-zinc-800/60 min-h-[380px] md:min-h-[460px] flex items-end">
          {/* Backdrop Image */}
          <div className="absolute inset-0 z-0 overflow-hidden">
            <img
              src={topPickGame.heroImage || topPickGame.boxArt}
              alt={topPickGame.title}
              className="w-full h-full object-cover object-center filter blur-md brightness-40 scale-105 transition-transform duration-1000"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-zinc-950 via-zinc-950/70 to-transparent" />
            <div className="absolute inset-0 bg-gradient-to-r from-zinc-950 via-zinc-950/50 to-transparent" />
          </div>

          {/* Hero Content */}
          <div className="relative z-10 w-full max-w-7xl mx-auto px-6 py-8 md:py-12 flex flex-col md:flex-row items-center md:items-end gap-6 md:gap-10">
            {/* Box Art Standout */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="relative w-40 sm:w-48 md:w-56 aspect-[3/4] rounded-2xl overflow-hidden shadow-2xl shadow-black/80 border-2 border-cyan-500/40 flex-shrink-0 group cursor-pointer"
              onClick={() => onSelect(topPickGame)}
            >
              <img
                src={topPickGame.boxArt}
                alt={topPickGame.title}
                className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
              />
              <div className="absolute inset-0 bg-black/30 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                <div className="w-14 h-14 rounded-full bg-cyan-500 text-zinc-950 flex items-center justify-center shadow-lg shadow-cyan-500/50">
                  <Play className="w-7 h-7 fill-current ml-1" />
                </div>
              </div>
            </motion.div>

            {/* Info and Actions */}
            <motion.div
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.1 }}
              className="flex-1 text-center md:text-left space-y-3"
            >
              <div className="flex flex-wrap items-center justify-center md:justify-start gap-2">
                <span className="px-2.5 py-0.5 rounded-md bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 text-xs font-bold tracking-wider uppercase">
                  Gemini Top Pick
                </span>
                <span className="px-2.5 py-0.5 rounded-md bg-zinc-800/80 text-zinc-300 border border-zinc-700/60 text-xs font-semibold uppercase">
                  {topPickGame.platform}
                </span>
                {recData?.topPick?.tags?.map((tag, idx) => (
                  <span
                    key={idx}
                    className="px-2 py-0.5 rounded-md bg-zinc-900/60 text-zinc-400 border border-zinc-800 text-xs"
                  >
                    {tag}
                  </span>
                ))}
              </div>

              <h1 className="text-3xl sm:text-4xl md:text-5xl font-black text-white tracking-tight drop-shadow-md">
                {topPickGame.title}
              </h1>

              {/* Reasoning */}
              <p className="text-sm sm:text-base text-zinc-300 max-w-2xl leading-relaxed italic bg-zinc-900/50 backdrop-blur-md p-3 rounded-xl border border-zinc-800/50">
                "{recData?.topPick?.reason || `High-rated classic in your ${topPickGame.platform.toUpperCase()} collection, verified ready to launch.`}"
              </p>

              {/* Action Buttons */}
              <div className="flex flex-wrap items-center justify-center md:justify-start gap-3 pt-2">
                <button
                  onClick={() => onSelect(topPickGame)}
                  className="px-6 py-3 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-zinc-950 font-bold text-sm shadow-xl shadow-cyan-500/25 flex items-center gap-2 transform active:scale-95 transition-all"
                >
                  <Play className="w-5 h-5 fill-current" />
                  <span>Play Now</span>
                </button>

                <button
                  onClick={(e) => handleOpenInvite(topPickGame, e)}
                  className="px-4 py-3 rounded-xl bg-zinc-900/90 hover:bg-zinc-800 text-zinc-200 border border-zinc-700 hover:border-cyan-500/40 font-semibold text-sm flex items-center gap-2 transition-all active:scale-95"
                >
                  <Share2 className="w-4 h-4 text-cyan-400" />
                  <span>Invite via AwehChat</span>
                </button>
              </div>
            </motion.div>
          </div>
        </div>
      )}

      {/* ── Content Rows ─────────────────────────────────────────────────── */}
      <div className="max-w-7xl mx-auto w-full px-6 py-8 space-y-10">
        {/* 1. Jump Back In */}
        {jumpBackInGames.length > 0 && (
          <GameCarouselRow
            title="Jump Back In"
            subtitle="Pick up where you left off with synchronized save states"
            icon={<Clock className="w-4 h-4 text-emerald-400" />}
            games={jumpBackInGames}
            onSelect={onSelect}
            onInvite={handleOpenInvite}
            badgeText="Recent"
          />
        )}

        {/* 2. Couch Co-Op Ready */}
        {couchCoopGames.length > 0 && (
          <GameCarouselRow
            title="Couch Co-Op & Multiplayer Ready"
            subtitle="Multi-controller and Nucleus Co-Op compatible for local & remote play"
            icon={<Users className="w-4 h-4 text-cyan-400" />}
            games={couchCoopGames}
            onSelect={onSelect}
            onInvite={handleOpenInvite}
            badgeText="Co-Op"
          />
        )}

        {/* 3. Gemini Recommendations Runners-Up */}
        {recData?.recommendations && recData.recommendations.length > 0 && (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-amber-400" />
              <div>
                <h3 className="text-lg font-bold text-white tracking-wide">
                  More Recommended For You
                </h3>
                <p className="text-xs text-zinc-400">
                  Tailored based on your historical play style
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
              {recData.recommendations.map((rec, i) => {
                const matched = games.find(g => g.id === rec.gameId);
                const art = rec.boxArt || matched?.boxArt || '/placeholder-cover.jpg';
                return (
                  <div
                    key={i}
                    onClick={() => matched && onSelect(matched)}
                    className="p-4 rounded-2xl bg-zinc-900/60 hover:bg-zinc-900 border border-zinc-800/80 hover:border-cyan-500/40 cursor-pointer transition-all flex gap-3 group"
                  >
                    <img
                      src={art}
                      alt={rec.title}
                      className="w-16 h-20 rounded-lg object-cover flex-shrink-0 border border-zinc-800"
                    />
                    <div className="flex-1 min-w-0 flex flex-col justify-between">
                      <div>
                        <div className="flex items-center justify-between gap-1">
                          <h4 className="text-sm font-bold text-zinc-100 truncate group-hover:text-cyan-400 transition-colors">
                            {rec.title}
                          </h4>
                          <span className="text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">
                            {rec.platform}
                          </span>
                        </div>
                        <p className="text-xs text-zinc-400 line-clamp-2 mt-1 italic">
                          "{rec.reason}"
                        </p>
                      </div>
                      <div className="flex items-center gap-2 pt-1 text-[11px] text-cyan-400 font-medium">
                        <Play className="w-3 h-3 fill-current" />
                        <span>Launch Now</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* 4. Newly Added */}
        {newlyAddedGames.length > 0 && (
          <GameCarouselRow
            title="Newly Added to Vault"
            subtitle="Latest additions synced to your local host and storage tier"
            icon={<Flame className="w-4 h-4 text-orange-400" />}
            games={newlyAddedGames}
            onSelect={onSelect}
            onInvite={handleOpenInvite}
            badgeText="New"
          />
        )}

        {/* 5. Platforms */}
        {platformRows.map(([platform, pGames]) => (
          <GameCarouselRow
            key={platform}
            title={platform.toUpperCase()}
            subtitle={`${pGames.length} titles available`}
            icon={<Gamepad2 className="w-4 h-4 text-purple-400" />}
            games={pGames}
            onSelect={onSelect}
            onInvite={handleOpenInvite}
          />
        ))}
      </div>

      {/* ── Ecosystem Invite Modal ────────────────────────────────────────── */}
      <EcosystemInviteModal
        isOpen={inviteModalOpen}
        onClose={() => setInviteModalOpen(false)}
        gameOrTitle={targetInviteGame?.title || 'NexusEmu Session'}
        type="coop"
      />
    </div>
  );
};

// ── Carousel Row Sub-component ────────────────────────────────────────────────
interface GameCarouselRowProps {
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  games: Game[];
  badgeText?: string;
  onSelect: (game: Game) => void;
  onInvite: (game: Game, e?: React.MouseEvent) => void;
}

const GameCarouselRow: React.FC<GameCarouselRowProps> = ({
  title,
  subtitle,
  icon,
  games,
  badgeText,
  onSelect,
  onInvite,
}) => {
  const rowRef = useRef<HTMLDivElement>(null);

  const scroll = (direction: 'left' | 'right') => {
    if (!rowRef.current) return;
    const scrollAmount = rowRef.current.clientWidth * 0.75;
    rowRef.current.scrollBy({
      left: direction === 'left' ? -scrollAmount : scrollAmount,
      behavior: 'smooth',
    });
  };

  return (
    <div className="space-y-3 relative group/row">
      {/* Row Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {icon}
          <div>
            <h3 className="text-lg font-bold text-white tracking-wide">{title}</h3>
            {subtitle && <p className="text-xs text-zinc-400">{subtitle}</p>}
          </div>
        </div>

        {/* Scroll Controls */}
        <div className="flex items-center gap-1 opacity-0 group-hover/row:opacity-100 transition-opacity">
          <button
            onClick={() => scroll('left')}
            className="p-1.5 rounded-lg bg-zinc-900/80 hover:bg-zinc-800 text-zinc-300 border border-zinc-800 shadow-sm"
            title="Scroll Left"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            onClick={() => scroll('right')}
            className="p-1.5 rounded-lg bg-zinc-900/80 hover:bg-zinc-800 text-zinc-300 border border-zinc-800 shadow-sm"
            title="Scroll Right"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Horizontal Scroll Track */}
      <div
        ref={rowRef}
        className="flex items-center gap-4 overflow-x-auto scrollbar-none snap-x snap-mandatory py-2 px-1"
      >
        {games.map((game) => (
          <div
            key={game.id}
            onClick={() => onSelect(game)}
            className="group relative flex-shrink-0 w-36 sm:w-44 md:w-48 aspect-[3/4] rounded-xl overflow-hidden bg-zinc-900 border border-zinc-800 hover:border-cyan-500/60 shadow-lg hover:shadow-2xl hover:shadow-cyan-950/40 snap-start cursor-pointer transition-all duration-300 hover:scale-[1.03] flex flex-col justify-end"
          >
            {/* Box Art */}
            <img
              src={game.boxArt}
              alt={game.title}
              loading="lazy"
              className="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
            />

            {/* Gradient Scrim */}
            <div className="absolute inset-0 bg-gradient-to-t from-zinc-950 via-zinc-950/40 to-transparent opacity-70 group-hover:opacity-90 transition-opacity" />

            {/* Badge pill */}
            {badgeText && (
              <div className="absolute top-2 left-2 z-10">
                <span className="px-2 py-0.5 rounded-md bg-cyan-500/90 text-zinc-950 text-[10px] font-extrabold uppercase shadow-sm">
                  {badgeText}
                </span>
              </div>
            )}

            {/* Quick Invite Button in Corner */}
            <button
              onClick={(e) => onInvite(game, e)}
              className="absolute top-2 right-2 z-10 p-1.5 rounded-lg bg-zinc-950/70 hover:bg-cyan-500 text-zinc-300 hover:text-zinc-950 border border-zinc-700/60 opacity-0 group-hover:opacity-100 transition-all shadow-md"
              title="Invite friend to play"
            >
              <Share2 className="w-3 h-3" />
            </button>

            {/* Title & Platform */}
            <div className="relative z-10 p-3 space-y-1">
              <span className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider">
                {game.platform}
              </span>
              <h4 className="text-xs sm:text-sm font-bold text-white truncate drop-shadow">
                {game.title}
              </h4>
            </div>

            {/* Quick Launch hover icon */}
            <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
              <div className="w-10 h-10 rounded-full bg-cyan-500/90 text-zinc-950 flex items-center justify-center shadow-lg shadow-cyan-500/50 transform scale-90 group-hover:scale-100 transition-transform">
                <Play className="w-5 h-5 fill-current ml-0.5" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default GameLibrary;
