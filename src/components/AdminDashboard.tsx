import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { LayoutDashboard, TrendingUp, Stethoscope, Hammer, Shield } from 'lucide-react';
import { ActivityStats } from './ActivityStats';
import { HostHealthCheck } from './HostHealthCheck';
import { CoreForge } from './CoreForge';

export type AdminSubTab = 'activity' | 'health' | 'forge';

interface AdminDashboardProps {
  initialTab?: AdminSubTab;
}

export const AdminDashboard: React.FC<AdminDashboardProps> = ({ initialTab = 'activity' }) => {
  const [activeTab, setActiveTab] = useState<AdminSubTab>(initialTab);

  const TABS: { id: AdminSubTab; label: string; icon: React.ComponentType<{ className?: string }>; desc: string }[] = [
    {
      id: 'activity',
      label: 'Activity & Audit',
      icon: TrendingUp,
      desc: 'Real-time telemetry, user sessions, and audit events',
    },
    {
      id: 'health',
      label: 'System Health',
      icon: Stethoscope,
      desc: 'Subsystem diagnostics, storage headroom, and connectivity tests',
    },
    {
      id: 'forge',
      label: 'Core Forge',
      icon: Hammer,
      desc: 'Emulator core manager, BIOS verifier, and hardware acceleration',
    },
  ];

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500 pb-20">
      {/* Admin Dashboard Header */}
      <div className="glass-panel p-6 rounded-3xl border border-white/10 bg-black/40 backdrop-blur-xl relative overflow-hidden shadow-2xl">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <LayoutDashboard className="w-4 h-4 text-emerald-400" />
              <span className="text-[11px] font-black uppercase tracking-[0.25em] text-emerald-400">
                Administration Console
              </span>
            </div>
            <h1 className="text-2xl md:text-3xl font-black italic tracking-tight uppercase text-white">
              Admin System Dashboard
            </h1>
          </div>

          {/* Segmented Pill Selector */}
          <div className="flex items-center gap-1.5 p-1.5 rounded-2xl bg-white/[0.04] border border-white/10 backdrop-blur-md">
            {TABS.map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`relative px-4 py-2 rounded-xl text-xs font-black uppercase tracking-wider flex items-center gap-2 transition-all ${
                    isActive ? 'text-white shadow-lg' : 'text-white/50 hover:text-white/80 hover:bg-white/5'
                  }`}
                >
                  {isActive && (
                    <motion.div
                      layoutId="admin-dashboard-active-pill"
                      className="absolute inset-0 rounded-xl bg-gradient-to-r from-emerald-500/80 to-cyan-500/80 -z-10 shadow-lg shadow-emerald-500/20"
                      transition={{ type: 'spring', bounce: 0.18, duration: 0.4 }}
                    />
                  )}
                  <Icon className={`w-3.5 h-3.5 ${isActive ? 'text-white' : 'text-white/60'}`} />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Active Sub-Tab View */}
      <AnimatePresence mode="wait">
        <motion.div
          key={activeTab}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={{ duration: 0.2 }}
        >
          {activeTab === 'activity' && <ActivityStats />}
          {activeTab === 'health' && <HostHealthCheck />}
          {activeTab === 'forge' && <CoreForge />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
};
