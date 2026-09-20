import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Shield, Zap, HardDrive, Database, Users, CheckCircle2,
  XCircle, AlertCircle, RefreshCw, Loader2, ArrowRight,
  Eye, Lock, Sliders, Cpu, Film, Sparkles, ExternalLink,
  ChevronRight, Check
} from 'lucide-react';

interface TierDef {
  id: string;
  name: string;
  storageLimitBytes: number;
  storageDisplay: string;
  price: string;
  billingPeriod: string;
  color: string;
  badge: string;
  transcodeSlots: number;
  maxResolution: string;
  adSupported: boolean;
  nucleusCoOp: string;
  webrtcGameStream: string;
  perks: string[];
}

interface TierStat {
  storage_tier: string;
  user_count: string | number;
  total_allocated_bytes: string | number;
  total_used_bytes: string | number;
}

interface UserSummary {
  id: string;
  username: string;
  display_name: string | null;
  role: string;
  storage_tier: string;
  storage_limit_bytes: number | string;
  used_bytes: number | string;
  last_seen: string | null;
}

interface VisibilityItem {
  id: string;
  name: string;
  category: string;
  userVisible: boolean;
  adminOnly: boolean;
  description: string;
  reason?: string;
}

interface TiersOverviewResponse {
  ok: boolean;
  tiers: TierDef[];
  stats: TierStat[];
  users: UserSummary[];
  visibilityMatrix: VisibilityItem[];
}

const formatBytes = (bytes: number | string): string => {
  const n = Number(bytes) || 0;
  if (n === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(n) / Math.log(k));
  return `${(n / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
};

export const AdminTiersMatrix: React.FC = () => {
  const [data, setData] = useState<TiersOverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<'tiers' | 'matrix'>('tiers');
  const [matrixFilter, setMatrixFilter] = useState<'all' | 'user' | 'admin'>('all');
  const [updatingUser, setUpdatingUser] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const fetchOverview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = localStorage.getItem('nexus_token') ?? '';
      const res = await fetch('/api/admin/tiers-overview', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: Failed to load tiers overview`);
      }
      const json = await res.json();
      setData(json);
    } catch (err: any) {
      setError(err.message || 'Failed to load tiers data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchOverview();
  }, [fetchOverview]);

  const handleUpdateTier = async (userId: string, newTier: string) => {
    setUpdatingUser(userId);
    setSuccessMsg(null);
    try {
      const token = localStorage.getItem('nexus_token') ?? '';
      const res = await fetch(`/api/admin/users/${userId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ storage_tier: newTier }),
      });
      if (!res.ok) throw new Error(`Failed to update tier: HTTP ${res.status}`);
      setSuccessMsg(`Successfully updated user storage tier to ${newTier.toUpperCase()}`);
      await fetchOverview();
    } catch (err: any) {
      setError(err.message || 'Failed to update user tier');
    } finally {
      setUpdatingUser(null);
    }
  };

  if (loading && !data) {
    return (
      <div className="flex flex-col items-center justify-center p-16 space-y-4 text-white/60">
        <Loader2 className="w-8 h-8 animate-spin text-emerald-400" />
        <p className="text-sm font-medium">Querying PostgreSQL live tier quotas &amp; permission matrix…</p>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="glass-panel p-8 rounded-3xl border border-red-500/20 bg-red-500/5 text-red-300 flex flex-col items-center gap-4">
        <AlertCircle className="w-8 h-8 text-red-400" />
        <p className="font-bold">{error}</p>
        <button
          onClick={fetchOverview}
          className="px-4 py-2 rounded-xl bg-white/10 hover:bg-white/15 text-white text-xs font-bold transition-all"
        >
          Retry
        </button>
      </div>
    );
  }

  const tiers = data?.tiers || [];
  const stats = data?.stats || [];
  const users = data?.users || [];
  const matrix = data?.visibilityMatrix || [];

  const filteredMatrix = matrix.filter((item) => {
    if (matrixFilter === 'user') return item.userVisible;
    if (matrixFilter === 'admin') return item.adminOnly;
    return true;
  });

  return (
    <div className="space-y-8 animate-in fade-in duration-300">
      {/* View Switcher & Live Stats Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 rounded-2xl bg-white/[0.03] border border-white/10">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setActiveView('tiers')}
            className={`px-4 py-2 rounded-xl text-xs font-black uppercase tracking-wider flex items-center gap-2 transition-all ${
              activeView === 'tiers'
                ? 'bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 shadow-lg shadow-emerald-500/10'
                : 'text-white/50 hover:text-white/80 hover:bg-white/5'
            }`}
          >
            <HardDrive className="w-4 h-4" />
            <span>Storage Tiers &amp; Capabilities</span>
          </button>
          <button
            onClick={() => setActiveView('matrix')}
            className={`px-4 py-2 rounded-xl text-xs font-black uppercase tracking-wider flex items-center gap-2 transition-all ${
              activeView === 'matrix'
                ? 'bg-cyan-500/20 border border-cyan-500/40 text-cyan-300 shadow-lg shadow-cyan-500/10'
                : 'text-white/50 hover:text-white/80 hover:bg-white/5'
            }`}
          >
            <Eye className="w-4 h-4" />
            <span>User vs Admin View (Access Matrix)</span>
          </button>
        </div>

        <button
          onClick={fetchOverview}
          disabled={loading}
          className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-white/5 hover:bg-white/10 text-white/60 hover:text-white text-xs font-bold transition-all self-start sm:self-auto"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-emerald-400' : ''}`} />
          <span>Refresh Live Data</span>
        </button>
      </div>

      {successMsg && (
        <div className="p-3.5 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs font-semibold flex items-center gap-2.5">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
          <span>{successMsg}</span>
        </div>
      )}

      {/* ── View 1: Tiers & Offerings ───────────────────────────────────── */}
      {activeView === 'tiers' && (
        <div className="space-y-8">
          {/* Tiers Cards Grid */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {tiers.map((t) => {
              const tierStat = stats.find((s) => s.storage_tier === t.id);
              const count = Number(tierStat?.user_count || 0);
              const allocated = Number(tierStat?.total_allocated_bytes || 0);
              const used = Number(tierStat?.total_used_bytes || 0);

              const isPro = t.id === 'pro';
              const isMax = t.id === 'max';

              return (
                <div
                  key={t.id}
                  className={`glass-panel p-6 rounded-3xl border flex flex-col justify-between transition-all relative overflow-hidden ${
                    isMax
                      ? 'border-purple-500/30 bg-purple-950/10 shadow-xl shadow-purple-500/5'
                      : isPro
                      ? 'border-cyan-500/30 bg-cyan-950/10 shadow-xl shadow-cyan-500/5'
                      : 'border-white/10 bg-white/[0.02]'
                  }`}
                >
                  <div className="space-y-4">
                    {/* Header */}
                    <div className="flex items-center justify-between">
                      <span className={`px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-wider border ${
                        isMax ? 'border-purple-400/40 bg-purple-500/20 text-purple-300' :
                        isPro ? 'border-cyan-400/40 bg-cyan-500/20 text-cyan-300' :
                        'border-emerald-400/40 bg-emerald-500/20 text-emerald-300'
                      }`}>
                        {t.badge}
                      </span>
                      <span className="text-xs font-mono text-white/40">{t.billingPeriod}</span>
                    </div>

                    <div>
                      <h3 className="text-xl font-black text-white">{t.name}</h3>
                      <div className="flex items-baseline gap-2 mt-1">
                        <span className="text-3xl font-black text-white">{t.price}</span>
                        <span className="text-sm font-semibold text-emerald-400">{t.storageDisplay} Vault</span>
                      </div>
                    </div>

                    {/* Live Usage Metrics */}
                    <div className="p-3 rounded-2xl bg-black/40 border border-white/5 space-y-1.5 text-[11px]">
                      <div className="flex justify-between text-white/60">
                        <span>Active Users:</span>
                        <span className="font-bold text-white">{count} accounts</span>
                      </div>
                      <div className="flex justify-between text-white/60">
                        <span>Allocated Quota:</span>
                        <span className="font-mono text-white/90">{formatBytes(allocated)}</span>
                      </div>
                      <div className="flex justify-between text-white/60">
                        <span>Synced Cloud Data:</span>
                        <span className="font-mono text-emerald-400 font-bold">{formatBytes(used)}</span>
                      </div>
                    </div>

                    {/* Core Specs */}
                    <div className="space-y-2 border-t border-white/10 pt-4 text-xs">
                      <div className="flex items-center justify-between text-white/70">
                        <span>Concurrent Transcodes:</span>
                        <span className="font-bold text-white">{t.transcodeSlots} stream{t.transcodeSlots > 1 ? 's' : ''}</span>
                      </div>
                      <div className="flex items-center justify-between text-white/70">
                        <span>Max Resolution:</span>
                        <span className="font-semibold text-white">{t.maxResolution}</span>
                      </div>
                      <div className="flex items-center justify-between text-white/70">
                        <span>Nucleus Co-Op:</span>
                        <span className="font-semibold text-white">{t.nucleusCoOp}</span>
                      </div>
                      <div className="flex items-center justify-between text-white/70">
                        <span>Ad Experience:</span>
                        <span className={t.adSupported ? 'text-amber-300 font-medium' : 'text-emerald-400 font-bold'}>
                          {t.adSupported ? 'Community Sponsored' : '100% Ad-Free'}
                        </span>
                      </div>
                    </div>

                    {/* Feature List */}
                    <div className="space-y-2 pt-2">
                      <p className="text-[11px] font-black uppercase tracking-wider text-white/40">Included Capabilities</p>
                      <ul className="space-y-1.5 text-xs text-white/80">
                        {t.perks.map((p, idx) => (
                          <li key={idx} className="flex items-start gap-2">
                            <Check className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0 mt-0.5" />
                            <span className="leading-snug">{p}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* User Tier Management Table */}
          <div className="glass-panel p-6 rounded-3xl border border-white/10 bg-black/40 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-white/10 pb-4">
              <div>
                <h3 className="text-lg font-black text-white uppercase tracking-tight">
                  User Storage Tier Allocations
                </h3>
                <p className="text-xs text-white/50">
                  Real database records from PostgreSQL <code className="text-emerald-400 font-mono">users</code> table. Modify user storage tiers live.
                </p>
              </div>
              <span className="text-xs font-mono px-3 py-1 rounded-full bg-white/5 border border-white/10 text-white/70">
                {users.length} Total Users Registered
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-white/10 text-white/40 font-mono uppercase text-[10px]">
                    <th className="py-3 px-3">User</th>
                    <th className="py-3 px-3">Role</th>
                    <th className="py-3 px-3">Current Tier</th>
                    <th className="py-3 px-3">Storage Quota</th>
                    <th className="py-3 px-3">Live Storage Used</th>
                    <th className="py-3 px-3 text-right">Assign Tier</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5 text-white/80">
                  {users.map((u) => {
                    const isCurrentUpdating = updatingUser === u.id;
                    const tier = u.storage_tier || 'free';
                    return (
                      <tr key={u.id} className="hover:bg-white/[0.02] transition-colors">
                        <td className="py-3 px-3 font-semibold text-white">
                          <div>{u.username}</div>
                          {u.display_name && <div className="text-[10px] text-white/40">{u.display_name}</div>}
                        </td>
                        <td className="py-3 px-3">
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${
                            u.role === 'ultra_admin' || u.role === 'admin'
                              ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                              : 'bg-white/5 text-white/60'
                          }`}>
                            {u.role}
                          </span>
                        </td>
                        <td className="py-3 px-3">
                          <span className={`px-2.5 py-1 rounded-xl text-[10px] font-black uppercase ${
                            tier === 'max' ? 'bg-purple-500/20 text-purple-300 border border-purple-500/40' :
                            tier === 'pro' ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40' :
                            'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                          }`}>
                            {tier}
                          </span>
                        </td>
                        <td className="py-3 px-3 font-mono text-white/70">
                          {formatBytes(u.storage_limit_bytes)}
                        </td>
                        <td className="py-3 px-3 font-mono text-emerald-400 font-bold">
                          {formatBytes(u.used_bytes)}
                        </td>
                        <td className="py-3 px-3 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            {['free', 'pro', 'max'].map((tOption) => (
                              <button
                                key={tOption}
                                disabled={isCurrentUpdating || tier === tOption}
                                onClick={() => handleUpdateTier(u.id, tOption)}
                                className={`px-2.5 py-1 rounded-lg text-[10px] font-bold uppercase transition-all ${
                                  tier === tOption
                                    ? 'bg-white/10 text-white/30 cursor-default'
                                    : 'bg-white/5 hover:bg-white/15 text-white/80 hover:text-white border border-white/10'
                                }`}
                              >
                                {isCurrentUpdating && tOption === tier ? '…' : tOption}
                              </button>
                            ))}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ── View 2: User vs Admin Perspective (Access Matrix) ───────────── */}
      {activeView === 'matrix' && (
        <div className="space-y-6">
          {/* Explanation Banner */}
          <div className="glass-panel p-6 rounded-3xl border border-cyan-500/30 bg-cyan-950/10 space-y-3">
            <div className="flex items-center gap-2">
              <Eye className="w-5 h-5 text-cyan-400" />
              <h3 className="text-lg font-black text-white uppercase tracking-tight">
                User Perspective &amp; Access Differentiation Matrix
              </h3>
            </div>
            <p className="text-xs text-white/70 leading-relaxed max-w-4xl">
              Standard users access a curated entertainment and personal storage experience. 
              High-privilege system operations, raw drive partition management, container orchestration, 
              Jarvis AI brain configurations, and user administrative tools are strictly isolated to admin accounts.
            </p>

            <div className="flex items-center gap-2 pt-2">
              <button
                onClick={() => setMatrixFilter('all')}
                className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all ${
                  matrixFilter === 'all'
                    ? 'bg-cyan-500/20 border border-cyan-500/40 text-cyan-300'
                    : 'bg-white/5 text-white/50 hover:text-white'
                }`}
              >
                All Features ({matrix.length})
              </button>
              <button
                onClick={() => setMatrixFilter('user')}
                className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all ${
                  matrixFilter === 'user'
                    ? 'bg-emerald-500/20 border border-emerald-500/40 text-emerald-300'
                    : 'bg-white/5 text-white/50 hover:text-white'
                }`}
              >
                What Regular Users See ({matrix.filter(m => m.userVisible).length})
              </button>
              <button
                onClick={() => setMatrixFilter('admin')}
                className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all ${
                  matrixFilter === 'admin'
                    ? 'bg-amber-500/20 border border-amber-500/40 text-amber-300'
                    : 'bg-white/5 text-white/50 hover:text-white'
                }`}
              >
                Admin-Only (Hidden from Users) ({matrix.filter(m => m.adminOnly).length})
              </button>
            </div>
          </div>

          {/* Matrix Table */}
          <div className="glass-panel p-6 rounded-3xl border border-white/10 bg-black/40 space-y-4">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-white/10 text-white/40 font-mono uppercase text-[10px]">
                    <th className="py-3 px-3">Section / Capability</th>
                    <th className="py-3 px-3">Category</th>
                    <th className="py-3 px-3 text-center">User Visible?</th>
                    <th className="py-3 px-3 text-center">Admin Only?</th>
                    <th className="py-3 px-3">Description &amp; Security Boundary</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5 text-white/80">
                  {filteredMatrix.map((item) => (
                    <tr
                      key={item.id}
                      className={`hover:bg-white/[0.02] transition-colors ${
                        item.adminOnly ? 'bg-amber-500/[0.03]' : ''
                      }`}
                    >
                      <td className="py-3.5 px-3 font-semibold text-white">
                        <div className="flex items-center gap-2">
                          {item.adminOnly ? (
                            <Lock className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
                          ) : (
                            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
                          )}
                          <span>{item.name}</span>
                        </div>
                      </td>
                      <td className="py-3.5 px-3">
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-white/5 text-white/60">
                          {item.category}
                        </span>
                      </td>
                      <td className="py-3.5 px-3 text-center">
                        {item.userVisible ? (
                          <span className="inline-flex items-center gap-1 text-emerald-400 font-bold text-[11px]">
                            <Check className="w-3.5 h-3.5" /> Yes
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-red-400/60 font-bold text-[11px]">
                            <XCircle className="w-3.5 h-3.5" /> No (Hidden)
                          </span>
                        )}
                      </td>
                      <td className="py-3.5 px-3 text-center">
                        {item.adminOnly ? (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wide bg-amber-500/20 text-amber-300 border border-amber-500/30">
                            Admin Only
                          </span>
                        ) : (
                          <span className="text-white/40 text-[11px]">Public / User</span>
                        )}
                      </td>
                      <td className="py-3.5 px-3">
                        <p className="text-white/80 leading-relaxed">{item.description}</p>
                        {item.reason && (
                          <p className="text-[10px] text-amber-400/80 font-mono mt-0.5 flex items-center gap-1">
                            <span>Boundary:</span> {item.reason}
                          </p>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
