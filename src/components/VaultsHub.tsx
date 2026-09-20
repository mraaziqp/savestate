import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Shield, HardDrive, Cloud, Layers, RefreshCw } from 'lucide-react';
import { VaultManager } from './VaultManager';
import { StorageHub } from './StorageHub';
import { SyncEngine } from './SyncEngine';
import { StorageTiering } from './StorageTiering';

export type VaultsSubTab = 'vault' | 'storage' | 'sync';

interface VaultsHubProps {
  initialTab?: VaultsSubTab;
  onNavigate?: (tab: string) => void;
}

export const VaultsHub: React.FC<VaultsHubProps> = ({ initialTab = 'vault', onNavigate }) => {
  const [activeTab, setActiveTab] = useState<VaultsSubTab>(initialTab);

  const TABS: { id: VaultsSubTab; label: string; icon: React.ComponentType<{ className?: string }>; desc: string }[] = [
    {
      id: 'vault',
      label: 'ROM Vaults',
      icon: Shield,
      desc: 'Local library roots, BIOS paths, and folder scanners',
    },
    {
      id: 'storage',
      label: 'Cloud & Storage',
      icon: HardDrive,
      desc: 'Cloud files, stored media, quotas, and tiered storage',
    },
    {
      id: 'sync',
      label: 'Sync Engine',
      icon: Cloud,
      desc: 'Database sync, daemon telemetry, and event stream',
    },
  ];

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500 pb-20">
      {/* Unified Hub Navigation Header */}
      <div className="glass-panel p-6 rounded-3xl border border-white/10 bg-black/40 backdrop-blur-xl relative overflow-hidden shadow-2xl">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Layers className="w-4 h-4 text-rose-400" />
              <span className="text-[11px] font-black uppercase tracking-[0.25em] text-rose-400">
                Unified Storage Hub
              </span>
            </div>
            <h1 className="text-2xl md:text-3xl font-black italic tracking-tight uppercase text-white">
              Vaults & Storage Hub
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
                      layoutId="vaults-hub-active-pill"
                      className="absolute inset-0 rounded-xl bg-gradient-to-r from-rose-500/80 to-amber-500/80 -z-10 shadow-lg shadow-rose-500/20"
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
          {activeTab === 'vault' && <VaultManager />}
          {activeTab === 'storage' && (
            <div className="space-y-8">
              <StorageHub onNavigate={onNavigate} />
              <div className="border-t border-white/10 pt-6">
                <StorageTiering />
              </div>
            </div>
          )}
          {activeTab === 'sync' && <SyncEngine />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
};
