import React, { useState, useEffect, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  User,
  Shield,
  CreditCard,
  Server,
  HelpCircle,
  HardDrive,
  Check,
  AlertTriangle,
  Loader2,
  Download,
  Send,
  Pencil,
  Trash2,
  RefreshCw,
  ExternalLink,
  Laptop,
  CheckCircle2,
  Key,
  Camera,
  Activity,
  LogOut,
  Sparkles,
} from 'lucide-react';

export type SettingsTab = 'profile' | 'subscription' | 'hosts' | 'support';

interface UserSettingsData {
  user: {
    id: string;
    username: string;
    displayName: string;
    email: string;
    avatarUrl?: string;
    role: string;
  };
  quota: {
    tier: 'free' | 'pro' | 'max' | string;
    used_bytes: number;
    limit_bytes: number;
    used_percentage: number;
    formatted_used: string;
    formatted_limit: string;
    breakdown?: {
      savesBytes: number;
      mediaBytes: number;
    };
  };
  hosts: Array<{
    id: string;
    name: string;
    hostname: string;
    ip: string;
    online: boolean;
    lastSeen: string;
    version: string;
  }>;
  support: {
    email: string;
    communityUrl: string;
    documentationUrl: string;
  };
}

interface SettingsPageProps {
  initialTab?: SettingsTab;
  onLogout?: () => void;
  onNavigatePlans?: () => void;
}

export const SettingsPage: React.FC<SettingsPageProps> = ({
  initialTab = 'profile',
  onLogout,
  onNavigatePlans,
}) => {
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);
  const [data, setData] = useState<UserSettingsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [toastMsg, setToastMsg] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

  // Profile Form State
  const [displayName, setDisplayName] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);

  // Support Form State
  const [supportCategory, setSupportCategory] = useState('bug');
  const [supportSubject, setSupportSubject] = useState('');
  const [supportMessage, setSupportMessage] = useState('');
  const [supportEmail, setSupportEmail] = useState('');
  const [sendingSupport, setSendingSupport] = useState(false);
  const [supportTicketId, setSupportTicketId] = useState<string | null>(null);

  // Host Rename State
  const [renamingHostId, setRenamingHostId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [actionHostLoading, setActionHostLoading] = useState<string | null>(null);

  const showToast = (text: string, type: 'success' | 'error' = 'success') => {
    setToastMsg({ text, type });
    setTimeout(() => setToastMsg(null), 3500);
  };

  const loadSettings = async () => {
    setLoading(true);
    try {
      const token = localStorage.getItem('nexus_token') ?? '';
      const res = await fetch('/api/user/settings', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.ok) {
        setData(json);
        setDisplayName(json.user?.displayName || json.user?.username || '');
        setAvatarUrl(json.user?.avatarUrl || '');
        setSupportEmail(json.user?.email || '');
      }
    } catch {
      showToast('Failed to load user settings. Operating in local mode.', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSettings();
  }, []);

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword && newPassword !== confirmPassword) {
      showToast('New passwords do not match', 'error');
      return;
    }
    setSavingProfile(true);
    try {
      const token = localStorage.getItem('nexus_token') ?? '';
      const res = await fetch('/api/user/settings/profile', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          displayName,
          avatarUrl,
          currentPassword: currentPassword || undefined,
          newPassword: newPassword || undefined,
        }),
      });
      const json = await res.json();
      if (json.ok) {
        showToast('Profile updated successfully!');
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
        loadSettings();
      } else {
        showToast(json.error || 'Failed to update profile', 'error');
      }
    } catch {
      showToast('Profile update failed', 'error');
    } finally {
      setSavingProfile(false);
    }
  };

  const handleRenameHost = async (hostId: string) => {
    if (!renameValue.trim()) return;
    setActionHostLoading(hostId);
    try {
      const token = localStorage.getItem('nexus_token') ?? '';
      const res = await fetch(`/api/user/settings/hosts/${hostId}/rename`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ name: renameValue }),
      });
      const json = await res.json();
      if (json.ok) {
        showToast(`Host renamed to "${renameValue}"`);
        setRenamingHostId(null);
        setRenameValue('');
        loadSettings();
      } else {
        showToast(json.error || 'Failed to rename host', 'error');
      }
    } catch {
      showToast('Error renaming host', 'error');
    } finally {
      setActionHostLoading(null);
    }
  };

  const handleRevokeHost = async (hostId: string) => {
    if (!confirm('Are you sure you want to revoke this node? It will lose access to vault synchronization.')) return;
    setActionHostLoading(hostId);
    try {
      const token = localStorage.getItem('nexus_token') ?? '';
      const res = await fetch(`/api/user/settings/hosts/${hostId}/revoke`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const json = await res.json();
      if (json.ok) {
        showToast('Host node access revoked');
        loadSettings();
      } else {
        showToast(json.error || 'Failed to revoke node', 'error');
      }
    } catch {
      showToast('Error revoking host node', 'error');
    } finally {
      setActionHostLoading(null);
    }
  };

  const handleSendSupport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supportSubject || !supportMessage) {
      showToast('Subject and message are required', 'error');
      return;
    }
    setSendingSupport(true);
    try {
      const token = localStorage.getItem('nexus_token') ?? '';
      const res = await fetch('/api/user/support', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          category: supportCategory,
          subject: supportSubject,
          message: supportMessage,
          email: supportEmail,
        }),
      });
      const json = await res.json();
      if (json.ok) {
        setSupportTicketId(json.ticketId);
        showToast('Support ticket dispatched to engineering!');
        setSupportSubject('');
        setSupportMessage('');
      } else {
        showToast(json.error || 'Failed to submit ticket', 'error');
      }
    } catch {
      showToast('Error submitting support ticket', 'error');
    } finally {
      setSendingSupport(false);
    }
  };

  const handleDownloadDebugLogs = () => {
    const token = localStorage.getItem('nexus_token') ?? '';
    const url = `/api/user/debug/logs?download=1${token ? `&token=${encodeURIComponent(token)}` : ''}`;
    window.open(url, '_blank');
  };

  const navItems: Array<{ id: SettingsTab; label: string; icon: React.ReactNode; desc: string }> = [
    {
      id: 'profile',
      label: 'Profile',
      icon: <User className="w-4 h-4" />,
      desc: 'Display name, avatar & credentials',
    },
    {
      id: 'subscription',
      label: 'Subscription & Quotas',
      icon: <CreditCard className="w-4 h-4" />,
      desc: 'Cloud storage, tier plan & billing',
    },
    {
      id: 'hosts',
      label: 'Hosts & Servers',
      icon: <Server className="w-4 h-4" />,
      desc: 'Linked PC rigs & local instances',
    },
    {
      id: 'support',
      label: 'Support & Diagnostics',
      icon: <HelpCircle className="w-4 h-4" />,
      desc: 'Ticketing, debug logs & telemetry',
    },
  ];

  return (
    <div className="w-full min-h-screen bg-zinc-950 text-zinc-100 flex flex-col">
      {/* Toast Alert */}
      <AnimatePresence>
        {toastMsg && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className={`fixed top-5 right-5 z-[9999] px-4 py-2.5 rounded-xl border text-sm font-medium shadow-2xl flex items-center gap-2 backdrop-blur-xl ${
              toastMsg.type === 'error'
                ? 'bg-rose-500/20 border-rose-500/40 text-rose-300'
                : 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300'
            }`}
          >
            {toastMsg.type === 'error' ? <AlertTriangle className="w-4 h-4" /> : <Check className="w-4 h-4" />}
            <span>{toastMsg.text}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Header */}
      <div className="px-6 py-5 border-b border-zinc-800/80 bg-zinc-950/60 backdrop-blur-xl flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black text-white tracking-tight flex items-center gap-2.5">
            <span>Settings & Account</span>
            <span className="text-xs px-2.5 py-0.5 rounded-full bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 font-semibold uppercase">
              {data?.quota?.tier || 'Free'} Tier
            </span>
          </h1>
          <p className="text-xs text-zinc-400 mt-0.5">
            Manage your player profile, cloud storage quotas, host nodes, and diagnostics
          </p>
        </div>

        {onLogout && (
          <button
            onClick={onLogout}
            className="px-3.5 py-2 rounded-xl bg-zinc-900 hover:bg-rose-500/20 text-zinc-300 hover:text-rose-300 border border-zinc-800 hover:border-rose-500/30 text-xs font-semibold flex items-center gap-1.5 transition-all"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Log Out</span>
          </button>
        )}
      </div>

      {/* Main Layout: Vertical Sidebar + Content Area */}
      <div className="flex-1 flex flex-col md:flex-row max-w-7xl w-full mx-auto p-4 md:p-6 gap-6 min-h-[600px]">
        {/* Vertical Sidebar */}
        <div className="w-full md:w-72 flex-shrink-0 flex md:flex-col gap-1.5 overflow-x-auto md:overflow-visible pb-2 md:pb-0">
          {navItems.map((item) => {
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                className={`flex items-center gap-3.5 px-4 py-3 rounded-2xl text-left transition-all flex-shrink-0 md:w-full border ${
                  isActive
                    ? 'bg-cyan-500/15 border-cyan-500/40 text-white shadow-lg shadow-cyan-950/30'
                    : 'bg-zinc-900/40 hover:bg-zinc-900/80 border-zinc-800/40 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <div
                  className={`w-9 h-9 rounded-xl flex items-center justify-center transition-colors ${
                    isActive ? 'bg-cyan-500 text-zinc-950 shadow-md' : 'bg-zinc-800 text-zinc-400'
                  }`}
                >
                  {item.icon}
                </div>
                <div className="min-w-0 hidden md:block">
                  <p className="text-sm font-bold text-zinc-100">{item.label}</p>
                  <p className="text-[11px] text-zinc-500 truncate">{item.desc}</p>
                </div>
                <span className="md:hidden text-xs font-bold">{item.label}</span>
              </button>
            );
          })}
        </div>

        {/* Content Pane */}
        <div className="flex-1 min-w-0 bg-zinc-900/40 border border-zinc-800/80 rounded-3xl p-6 backdrop-blur-xl shadow-xl">
          {loading ? (
            <div className="h-96 flex flex-col items-center justify-center gap-3 text-zinc-500">
              <Loader2 className="w-8 h-8 animate-spin text-cyan-400" />
              <span className="text-xs font-medium">Loading user settings & storage quotas...</span>
            </div>
          ) : (
            <AnimatePresence mode="wait">
              {/* TAB 1: PROFILE */}
              {activeTab === 'profile' && (
                <motion.div
                  key="profile"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  className="space-y-6"
                >
                  <div className="border-b border-zinc-800/60 pb-4">
                    <h2 className="text-lg font-bold text-white">Player Profile</h2>
                    <p className="text-xs text-zinc-400">Update your avatar, public handle, and security credentials</p>
                  </div>

                  <form onSubmit={handleSaveProfile} className="space-y-5 max-w-xl">
                    {/* Avatar Display & Input */}
                    <div className="flex items-center gap-4">
                      <div className="relative group">
                        {avatarUrl ? (
                          <img
                            src={avatarUrl}
                            alt="Avatar"
                            className="w-20 h-20 rounded-2xl object-cover border-2 border-cyan-500/40 shadow-md"
                          />
                        ) : (
                          <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-cyan-500/20 to-blue-600/20 border-2 border-cyan-500/40 flex items-center justify-center text-xl font-bold text-cyan-400">
                            {displayName ? displayName.charAt(0).toUpperCase() : 'N'}
                          </div>
                        )}
                        <div className="absolute inset-0 bg-black/40 rounded-2xl opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity cursor-pointer pointer-events-none">
                          <Camera className="w-5 h-5 text-white" />
                        </div>
                      </div>

                      <div className="flex-1 min-w-0">
                        <label className="block text-xs font-semibold text-zinc-400 mb-1">Avatar Image URL</label>
                        <input
                          type="url"
                          placeholder="https://example.com/avatar.jpg"
                          value={avatarUrl}
                          onChange={(e) => setAvatarUrl(e.target.value)}
                          className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-xs text-zinc-200 focus:outline-none focus:border-cyan-500"
                        />
                      </div>
                    </div>

                    {/* Display Name */}
                    <div>
                      <label className="block text-xs font-semibold text-zinc-400 mb-1">Display Name</label>
                      <input
                        type="text"
                        value={displayName}
                        onChange={(e) => setDisplayName(e.target.value)}
                        placeholder="Player One"
                        required
                        className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3.5 py-2.5 text-sm text-zinc-100 focus:outline-none focus:border-cyan-500"
                      />
                    </div>

                    {/* Email (Readonly / Connected) */}
                    <div>
                      <label className="block text-xs font-semibold text-zinc-400 mb-1">Connected Email</label>
                      <input
                        type="email"
                        value={data?.user?.email || 'player@savestate.co.za'}
                        disabled
                        className="w-full bg-zinc-900/50 border border-zinc-800/60 rounded-xl px-3.5 py-2.5 text-sm text-zinc-500 cursor-not-allowed"
                      />
                    </div>

                    {/* Password Reset Section */}
                    <div className="pt-3 border-t border-zinc-800/60 space-y-3">
                      <h3 className="text-xs font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-1.5">
                        <Key className="w-3.5 h-3.5 text-cyan-400" />
                        <span>Security & Password Reset</span>
                      </h3>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label className="block text-[11px] text-zinc-500 mb-1">New Password</label>
                          <input
                            type="password"
                            value={newPassword}
                            onChange={(e) => setNewPassword(e.target.value)}
                            placeholder="••••••••"
                            className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-xs text-zinc-100 focus:outline-none focus:border-cyan-500"
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] text-zinc-500 mb-1">Confirm New Password</label>
                          <input
                            type="password"
                            value={confirmPassword}
                            onChange={(e) => setConfirmPassword(e.target.value)}
                            placeholder="••••••••"
                            className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-xs text-zinc-100 focus:outline-none focus:border-cyan-500"
                          />
                        </div>
                      </div>
                    </div>

                    <div className="pt-2">
                      <button
                        type="submit"
                        disabled={savingProfile}
                        className="px-6 py-2.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-zinc-950 font-bold text-xs shadow-lg shadow-cyan-500/20 flex items-center gap-2 transition-all active:scale-95 disabled:opacity-50"
                      >
                        {savingProfile ? (
                          <>
                            <Loader2 className="w-4 h-4 animate-spin" />
                            <span>Saving...</span>
                          </>
                        ) : (
                          <>
                            <Check className="w-4 h-4" />
                            <span>Save Profile Changes</span>
                          </>
                        )}
                      </button>
                    </div>
                  </form>
                </motion.div>
              )}

              {/* TAB 2: SUBSCRIPTION & QUOTAS */}
              {activeTab === 'subscription' && (
                <motion.div
                  key="subscription"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  className="space-y-6"
                >
                  <div className="border-b border-zinc-800/60 pb-4 flex items-center justify-between">
                    <div>
                      <h2 className="text-lg font-bold text-white">Subscription & Cloud Quotas</h2>
                      <p className="text-xs text-zinc-400">Monitor storage consumption, plan tier status, and billing limits</p>
                    </div>
                    {onNavigatePlans && (
                      <button
                        onClick={onNavigatePlans}
                        className="px-4 py-2 rounded-xl bg-gradient-to-r from-purple-500 to-indigo-600 hover:from-purple-400 hover:to-indigo-500 text-white font-bold text-xs shadow-lg shadow-purple-950/40 flex items-center gap-1.5 transition-all active:scale-95"
                      >
                        <Sparkles className="w-3.5 h-3.5" />
                        <span>Manage Billing</span>
                      </button>
                    )}
                  </div>

                  {/* Quota Progress Card */}
                  <div className="p-6 rounded-2xl bg-zinc-900/80 border border-zinc-800 space-y-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400">
                          <HardDrive className="w-5 h-5" />
                        </div>
                        <div>
                          <p className="text-xs font-semibold text-zinc-400">Cloud Storage Tier</p>
                          <h3 className="text-base font-bold text-white uppercase tracking-wider">
                            {data?.quota?.tier || 'Free'} Plan
                          </h3>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="text-xl font-black text-white">
                          {data?.quota?.formatted_used || '45.0 GB'}{' '}
                          <span className="text-sm font-normal text-zinc-500">
                            / {data?.quota?.formatted_limit || '50.0 GB'}
                          </span>
                        </p>
                        <p className="text-xs text-cyan-400 font-semibold">
                          {data?.quota?.used_percentage || 90}% utilized
                        </p>
                      </div>
                    </div>

                    {/* Progress Bar */}
                    <div className="w-full h-3 bg-zinc-950 rounded-full overflow-hidden border border-zinc-800 p-0.5">
                      <motion.div
                        initial={{ width: 0 }}
                        animate={{ width: `${Math.min(100, data?.quota?.used_percentage || 90)}%` }}
                        transition={{ duration: 0.8, ease: 'easeOut' }}
                        className={`h-full rounded-full ${
                          (data?.quota?.used_percentage || 90) > 90
                            ? 'bg-rose-500 shadow-rose-500/50'
                            : (data?.quota?.used_percentage || 90) > 75
                            ? 'bg-amber-500 shadow-amber-500/50'
                            : 'bg-cyan-500 shadow-cyan-500/50'
                        } shadow-sm`}
                      />
                    </div>

                    {/* Breakdown */}
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 pt-2 text-xs border-t border-zinc-800/60">
                      <div>
                        <span className="text-zinc-500 block">Game Saves & States</span>
                        <span className="font-semibold text-zinc-200">~2.2 GB</span>
                      </div>
                      <div>
                        <span className="text-zinc-500 block">Media & Video Stream</span>
                        <span className="font-semibold text-zinc-200">~42.8 GB</span>
                      </div>
                      <div>
                        <span className="text-zinc-500 block">HTTP 402 Guard</span>
                        <span className="font-semibold text-emerald-400">Active</span>
                      </div>
                    </div>
                  </div>

                  {/* Tier Comparison Banner */}
                  <div className="p-5 rounded-2xl bg-gradient-to-r from-purple-950/30 to-indigo-950/30 border border-purple-500/30 flex items-center justify-between">
                    <div>
                      <h4 className="text-sm font-bold text-white flex items-center gap-2">
                        <span>Need more than 50GB storage?</span>
                      </h4>
                      <p className="text-xs text-zinc-400 mt-0.5">
                        Upgrade to Nexus Max for 1TB vault, unthrottled 4K HDR transcoding, and multi-host sync.
                      </p>
                    </div>
                    {onNavigatePlans && (
                      <button
                        onClick={onNavigatePlans}
                        className="px-4 py-2 rounded-xl bg-white text-zinc-950 font-bold text-xs hover:bg-zinc-200 transition-colors"
                      >
                        Upgrade Plan
                      </button>
                    )}
                  </div>
                </motion.div>
              )}

              {/* TAB 3: HOSTS & SERVERS */}
              {activeTab === 'hosts' && (
                <motion.div
                  key="hosts"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  className="space-y-6"
                >
                  <div className="border-b border-zinc-800/60 pb-4 flex items-center justify-between">
                    <div>
                      <h2 className="text-lg font-bold text-white">Hosts & Server Nodes</h2>
                      <p className="text-xs text-zinc-400">Manage PC hosts, local emulation daemons, and sync nodes</p>
                    </div>
                    <button
                      onClick={loadSettings}
                      className="p-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-white border border-zinc-800 transition-all"
                      title="Refresh Host Status"
                    >
                      <RefreshCw className="w-4 h-4" />
                    </button>
                  </div>

                  {/* Host Table */}
                  <div className="overflow-x-auto rounded-2xl border border-zinc-800 bg-zinc-900/60">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-zinc-950/80 text-zinc-400 border-b border-zinc-800">
                        <tr>
                          <th className="px-4 py-3 font-semibold">Node Name</th>
                          <th className="px-4 py-3 font-semibold">Hostname / IP</th>
                          <th className="px-4 py-3 font-semibold">Status</th>
                          <th className="px-4 py-3 font-semibold">Version</th>
                          <th className="px-4 py-3 font-semibold text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-zinc-800/60">
                        {(data?.hosts || []).map((host) => {
                          const isRenaming = renamingHostId === host.id;
                          const isLoading = actionHostLoading === host.id;

                          return (
                            <tr key={host.id} className="hover:bg-zinc-900/80 transition-colors">
                              <td className="px-4 py-3">
                                {isRenaming ? (
                                  <div className="flex items-center gap-1.5">
                                    <input
                                      type="text"
                                      value={renameValue}
                                      onChange={(e) => setRenameValue(e.target.value)}
                                      className="bg-zinc-950 border border-zinc-700 rounded-lg px-2 py-1 text-xs text-white"
                                      autoFocus
                                    />
                                    <button
                                      onClick={() => handleRenameHost(host.id)}
                                      className="p-1 rounded bg-cyan-500 text-zinc-950"
                                    >
                                      <Check className="w-3.5 h-3.5" />
                                    </button>
                                  </div>
                                ) : (
                                  <div className="flex items-center gap-2">
                                    <Laptop className="w-4 h-4 text-cyan-400" />
                                    <span className="font-bold text-zinc-100">{host.name}</span>
                                  </div>
                                )}
                              </td>
                              <td className="px-4 py-3 text-zinc-400 font-mono text-[11px]">
                                {host.hostname} ({host.ip})
                              </td>
                              <td className="px-4 py-3">
                                <span
                                  className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-semibold border ${
                                    host.online
                                      ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                                      : 'bg-zinc-800 border-zinc-700 text-zinc-500'
                                  }`}
                                >
                                  <span
                                    className={`w-1.5 h-1.5 rounded-full ${
                                      host.online ? 'bg-emerald-400 animate-pulse' : 'bg-zinc-600'
                                    }`}
                                  />
                                  {host.online ? 'Online' : 'Offline'}
                                </span>
                              </td>
                              <td className="px-4 py-3 text-zinc-400">{host.version}</td>
                              <td className="px-4 py-3 text-right space-x-2">
                                <button
                                  onClick={() => {
                                    setRenamingHostId(host.id);
                                    setRenameValue(host.name);
                                  }}
                                  disabled={isLoading}
                                  className="p-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors"
                                  title="Rename Node"
                                >
                                  <Pencil className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  onClick={() => handleRevokeHost(host.id)}
                                  disabled={isLoading}
                                  className="p-1.5 rounded-lg bg-zinc-800 hover:bg-rose-500/20 text-zinc-300 hover:text-rose-400 transition-colors"
                                  title="Revoke Node Access"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </motion.div>
              )}

              {/* TAB 4: SUPPORT & DIAGNOSTICS */}
              {activeTab === 'support' && (
                <motion.div
                  key="support"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  className="space-y-6"
                >
                  <div className="border-b border-zinc-800/60 pb-4 flex items-center justify-between">
                    <div>
                      <h2 className="text-lg font-bold text-white">Support & Diagnostics</h2>
                      <p className="text-xs text-zinc-400">File assistance tickets, report bugs, and download Winston logs</p>
                    </div>
                    <button
                      onClick={handleDownloadDebugLogs}
                      className="px-4 py-2 rounded-xl bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/30 text-cyan-300 text-xs font-bold flex items-center gap-1.5 transition-all shadow-sm"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>Download Debug Logs</span>
                    </button>
                  </div>

                  {supportTicketId && (
                    <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
                      <span>
                        Ticket created successfully: <strong className="font-mono">{supportTicketId}</strong>. Our team has received your logs and message.
                      </span>
                    </div>
                  )}

                  {/* Support Form */}
                  <form onSubmit={handleSendSupport} className="space-y-4 max-w-xl">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-xs font-semibold text-zinc-400 mb-1">Issue Category</label>
                        <select
                          value={supportCategory}
                          onChange={(e) => setSupportCategory(e.target.value)}
                          className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2.5 text-xs text-zinc-200 focus:outline-none focus:border-cyan-500"
                        >
                          <option value="bug">🐛 Bug or Crash Report</option>
                          <option value="emulation">🎮 Core / ROM Compatibility</option>
                          <option value="storage">💾 Cloud Storage / Quotas</option>
                          <option value="billing">💳 Billing & Subscriptions</option>
                          <option value="general">💬 General Question</option>
                        </select>
                      </div>

                      <div>
                        <label className="block text-xs font-semibold text-zinc-400 mb-1">Your Email</label>
                        <input
                          type="email"
                          value={supportEmail}
                          onChange={(e) => setSupportEmail(e.target.value)}
                          required
                          placeholder="you@domain.com"
                          className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-xs text-zinc-100 focus:outline-none focus:border-cyan-500"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-semibold text-zinc-400 mb-1">Subject</label>
                      <input
                        type="text"
                        value={supportSubject}
                        onChange={(e) => setSupportSubject(e.target.value)}
                        required
                        placeholder="Brief summary of the inquiry or issue"
                        className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3.5 py-2 text-xs text-zinc-100 focus:outline-none focus:border-cyan-500"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-semibold text-zinc-400 mb-1">Details & Context</label>
                      <textarea
                        rows={4}
                        value={supportMessage}
                        onChange={(e) => setSupportMessage(e.target.value)}
                        required
                        placeholder="Please include steps to reproduce, device name, or game title..."
                        className="w-full bg-zinc-900 border border-zinc-800 rounded-xl p-3 text-xs text-zinc-100 focus:outline-none focus:border-cyan-500 leading-relaxed"
                      />
                    </div>

                    <button
                      type="submit"
                      disabled={sendingSupport}
                      className="px-6 py-2.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-zinc-950 font-bold text-xs shadow-lg shadow-cyan-500/20 flex items-center gap-2 transition-all active:scale-95 disabled:opacity-50"
                    >
                      {sendingSupport ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          <span>Submitting Ticket...</span>
                        </>
                      ) : (
                        <>
                          <Send className="w-4 h-4" />
                          <span>Submit Ticket to Support</span>
                        </>
                      )}
                    </button>
                  </form>
                </motion.div>
              )}
            </AnimatePresence>
          )}
        </div>
      </div>
    </div>
  );
};

export default SettingsPage;
