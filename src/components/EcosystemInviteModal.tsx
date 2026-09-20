import React, { useState, useEffect, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  X,
  Search,
  Users,
  Send,
  Check,
  Copy,
  Loader2,
  Gamepad2,
  Tv,
  FolderLock,
  Sparkles,
  Wifi,
  ExternalLink,
  MessageSquare,
} from 'lucide-react';

export interface EcosystemContact {
  id: string;
  name: string;
  username?: string;
  avatarUrl?: string;
  online?: boolean;
  status?: string;
}

export interface EcosystemInviteModalProps {
  isOpen: boolean;
  onClose: () => void;
  gameOrTitle?: string;
  sessionId?: string;
  type?: 'coop' | 'stream' | 'vault';
  customInviteUrl?: string;
  onInviteSent?: (contactId: string) => void;
}

export const EcosystemInviteModal: React.FC<EcosystemInviteModalProps> = ({
  isOpen,
  onClose,
  gameOrTitle = 'NexusEmu Session',
  sessionId,
  type = 'coop',
  customInviteUrl,
  onInviteSent,
}) => {
  const [contacts, setContacts] = useState<EcosystemContact[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [filterOnline, setFilterOnline] = useState(false);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [sentMap, setSentMap] = useState<Record<string, boolean>>({});
  const [copiedLink, setCopiedLink] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const inviteUrl = useMemo(() => {
    if (customInviteUrl) return customInviteUrl;
    const origin = typeof window !== 'undefined' ? window.location.origin : 'https://savestate.co.za';
    if (sessionId) {
      return `${origin}/?join=${encodeURIComponent(sessionId)}&type=${type}`;
    }
    return `${origin}/?action=watch&title=${encodeURIComponent(gameOrTitle)}`;
  }, [customInviteUrl, sessionId, type, gameOrTitle]);

  const deepLink = useMemo(() => {
    if (sessionId) return `nexus://join/${encodeURIComponent(sessionId)}`;
    return `nexus://play/${encodeURIComponent(gameOrTitle.toLowerCase().replace(/\s+/g, '-'))}`;
  }, [sessionId, gameOrTitle]);

  // Load contacts
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setErrorMsg(null);
      try {
        const token = localStorage.getItem('nexus_token') ?? '';
        const res = await fetch('/api/integrations/ecosystem/contacts', {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled && data.contacts) {
          setContacts(data.contacts);
        }
      } catch (err: any) {
        if (!cancelled) {
          setErrorMsg('Failed to load contacts list. Fallback mode active.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  // Focus search on open
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => searchInputRef.current?.focus(), 100);
    } else {
      setSearch('');
      setSentMap({});
      setCopiedLink(false);
    }
  }, [isOpen]);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const filteredContacts = useMemo(() => {
    return contacts.filter((c) => {
      if (filterOnline && !c.online) return false;
      if (!search.trim()) return true;
      const q = search.toLowerCase();
      return (
        c.name.toLowerCase().includes(q) ||
        (c.username && c.username.toLowerCase().includes(q)) ||
        (c.status && c.status.toLowerCase().includes(q))
      );
    });
  }, [contacts, search, filterOnline]);

  const handleSendInvite = async (contact: EcosystemContact) => {
    if (sendingId || sentMap[contact.id]) return;
    setSendingId(contact.id);
    try {
      const token = localStorage.getItem('nexus_token') ?? '';
      const res = await fetch('/api/integrations/ecosystem/invite', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          contactId: contact.id,
          type,
          inviteUrl: deepLink || inviteUrl,
          title: gameOrTitle,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setSentMap((prev) => ({ ...prev, [contact.id]: true }));
        if (onInviteSent) onInviteSent(contact.id);
      } else {
        setErrorMsg(data.error || 'Failed to send invite');
      }
    } catch {
      // Fallback optimistic send
      setSentMap((prev) => ({ ...prev, [contact.id]: true }));
      if (onInviteSent) onInviteSent(contact.id);
    } finally {
      setSendingId(null);
    }
  };

  const handleCopyLink = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2500);
    } catch {
      // fallback
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/80 backdrop-blur-md"
          />

          {/* Modal Dialog */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 15 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 15 }}
            transition={{ type: 'spring', damping: 25, stiffness: 350 }}
            className="relative w-full max-w-lg bg-zinc-950/90 border border-zinc-800/80 rounded-2xl shadow-2xl shadow-cyan-950/20 backdrop-blur-xl overflow-hidden flex flex-col max-h-[85vh] z-10"
          >
            {/* Header */}
            <div className="p-5 border-b border-zinc-800/60 bg-gradient-to-r from-zinc-900/80 via-zinc-900/40 to-transparent flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-500/20 to-blue-600/20 border border-cyan-500/30 flex items-center justify-center text-cyan-400 shadow-inner">
                  {type === 'coop' ? (
                    <Gamepad2 className="w-5 h-5" />
                  ) : type === 'stream' ? (
                    <Tv className="w-5 h-5" />
                  ) : (
                    <FolderLock className="w-5 h-5" />
                  )}
                </div>
                <div>
                  <h3 className="text-base font-bold text-white tracking-wide flex items-center gap-2">
                    Invite to {type === 'coop' ? 'Co-Op Play' : type === 'stream' ? 'Stream' : 'Vault'}
                    <span className="text-xs px-2 py-0.5 rounded-full bg-cyan-500/10 text-cyan-300 border border-cyan-500/20">
                      AwehChat
                    </span>
                  </h3>
                  <p className="text-xs text-zinc-400 line-clamp-1 mt-0.5">
                    Target: <span className="text-zinc-200 font-medium">{gameOrTitle}</span>
                  </p>
                </div>
              </div>
              <button
                onClick={onClose}
                className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800/80 transition-colors"
                title="Close (Esc)"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Search & Filter Bar */}
            <div className="p-4 border-b border-zinc-800/40 bg-zinc-900/30 flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="w-4 h-4 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  ref={searchInputRef}
                  type="text"
                  placeholder="Search contacts by name or status..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full bg-zinc-900/80 border border-zinc-800 rounded-xl pl-9 pr-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-cyan-500/60 focus:ring-1 focus:ring-cyan-500/40 transition-all"
                />
                {search && (
                  <button
                    onClick={() => setSearch('')}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 p-0.5"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              <button
                onClick={() => setFilterOnline(!filterOnline)}
                className={`px-3 py-2 rounded-xl text-xs font-medium border flex items-center gap-1.5 transition-all ${
                  filterOnline
                    ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-400'
                    : 'bg-zinc-900/60 border-zinc-800 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <span className={`w-2 h-2 rounded-full ${filterOnline ? 'bg-emerald-400 animate-pulse' : 'bg-zinc-600'}`} />
                Online
              </button>
            </div>

            {/* Error Message */}
            {errorMsg && (
              <div className="px-4 py-2 bg-amber-500/10 border-b border-amber-500/20 text-amber-300 text-xs flex items-center justify-between">
                <span>{errorMsg}</span>
                <button onClick={() => setErrorMsg(null)} className="underline hover:text-white">
                  Dismiss
                </button>
              </div>
            )}

            {/* Contact List */}
            <div className="flex-1 overflow-y-auto p-3 space-y-1.5 min-h-[220px]">
              {loading ? (
                <div className="h-44 flex flex-col items-center justify-center gap-2 text-zinc-500">
                  <Loader2 className="w-6 h-6 animate-spin text-cyan-400" />
                  <span className="text-xs">Fetching AwehChat ecosystem directory...</span>
                </div>
              ) : filteredContacts.length === 0 ? (
                <div className="h-44 flex flex-col items-center justify-center gap-2 text-zinc-500">
                  <Users className="w-8 h-8 opacity-40" />
                  <span className="text-xs">No contacts match your query.</span>
                </div>
              ) : (
                filteredContacts.map((contact) => {
                  const isSent = !!sentMap[contact.id];
                  const isSending = sendingId === contact.id;

                  return (
                    <div
                      key={contact.id}
                      className="group flex items-center justify-between p-2.5 rounded-xl bg-zinc-900/40 hover:bg-zinc-900/80 border border-zinc-800/40 hover:border-cyan-500/20 transition-all"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        {/* Avatar */}
                        <div className="relative flex-shrink-0">
                          {contact.avatarUrl ? (
                            <img
                              src={contact.avatarUrl}
                              alt={contact.name}
                              className="w-10 h-10 rounded-full object-cover border border-zinc-800"
                            />
                          ) : (
                            <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-zinc-800 to-zinc-700 flex items-center justify-center text-sm font-semibold text-zinc-200 border border-zinc-700/60">
                              {contact.name.charAt(0).toUpperCase()}
                            </div>
                          )}
                          <span
                            className={`absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-zinc-950 ${
                              contact.online ? 'bg-emerald-500' : 'bg-zinc-600'
                            }`}
                          />
                        </div>

                        {/* Name & Status */}
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-sm font-semibold text-zinc-200 truncate">
                              {contact.name}
                            </span>
                            {contact.username && (
                              <span className="text-xs text-zinc-500 truncate">
                                @{contact.username}
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-zinc-400 truncate">
                            {contact.status || (contact.online ? 'Active now' : 'Offline')}
                          </p>
                        </div>
                      </div>

                      {/* Invite Button */}
                      <button
                        onClick={() => handleSendInvite(contact)}
                        disabled={isSending || isSent}
                        className={`px-3 py-1.5 rounded-xl text-xs font-medium flex items-center gap-1.5 transition-all flex-shrink-0 ${
                          isSent
                            ? 'bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 cursor-default'
                            : isSending
                            ? 'bg-zinc-800 border border-zinc-700 text-zinc-400 cursor-wait'
                            : 'bg-cyan-500 hover:bg-cyan-400 text-zinc-950 shadow-md shadow-cyan-500/20 active:scale-95'
                        }`}
                      >
                        {isSent ? (
                          <>
                            <Check className="w-3.5 h-3.5" />
                            Sent
                          </>
                        ) : isSending ? (
                          <>
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            Sending
                          </>
                        ) : (
                          <>
                            <Send className="w-3.5 h-3.5" />
                            Invite
                          </>
                        )}
                      </button>
                    </div>
                  );
                })
              )}
            </div>

            {/* Footer / Direct Share Link */}
            <div className="p-4 border-t border-zinc-800/60 bg-zinc-950/80 space-y-2">
              <div className="flex items-center justify-between text-xs text-zinc-400">
                <span className="flex items-center gap-1">
                  <Sparkles className="w-3 h-3 text-cyan-400" />
                  Or copy direct 1-click launch link:
                </span>
                {copiedLink && <span className="text-emerald-400 font-medium">Copied!</span>}
              </div>

              <div className="flex items-center gap-2">
                <div className="flex-1 bg-zinc-900/90 border border-zinc-800 rounded-xl px-3 py-2 text-xs font-mono text-zinc-300 truncate select-all">
                  {deepLink || inviteUrl}
                </div>
                <button
                  onClick={() => handleCopyLink(deepLink || inviteUrl)}
                  className="p-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-zinc-200 border border-zinc-800 hover:border-zinc-700 transition-colors flex items-center gap-1"
                  title="Copy link to clipboard"
                >
                  {copiedLink ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};

export default EcosystemInviteModal;
