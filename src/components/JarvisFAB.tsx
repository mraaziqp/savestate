import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Bot, X, Send, Sparkles, Activity, Terminal, RefreshCw,
  Cpu, HardDrive, Film, Play, CheckCircle, AlertCircle
} from 'lucide-react';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolExecuted?: {
    name: string;
    args?: any;
    result: any;
  };
  timestamp: string;
}

interface TelemetryLog {
  timestamp: string;
  level: string;
  message: string;
  source?: string;
}

interface TelemetryStatus {
  host: string;
  platform: string;
  uptime: number;
  memory?: { totalMB: number; freeMB: number };
}

export function JarvisFAB() {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome',
      role: 'assistant',
      content: "Jarvis online. Connected to CachyOS host. I can launch games, scan local directories, and diagnose HLS streaming transcoders.",
      timestamp: new Date().toLocaleTimeString(),
    },
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [telemetryWsConnected, setTelemetryWsConnected] = useState(false);
  const [telemetryLogs, setTelemetryLogs] = useState<TelemetryLog[]>([]);
  const [showLogsDrawer, setShowLogsDrawer] = useState(false);
  const [hostStatus, setHostStatus] = useState<TelemetryStatus | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // Connect to Jarvis Telemetry WebSocket (/api/v1/telemetry/jarvis)
  useEffect(() => {
    let reconnectTimeout: any;

    const connectWebSocket = () => {
      try {
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${proto}//${window.location.host}/api/v1/telemetry/jarvis`;
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          setTelemetryWsConnected(true);
        };

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.type === 'jarvis_telemetry_init') {
              setHostStatus({
                host: data.host,
                platform: data.platform,
                uptime: data.uptime,
                memory: data.memory,
              });
              if (Array.isArray(data.recentLogs)) {
                setTelemetryLogs(data.recentLogs.slice(-20));
              }
            } else if (data.level && data.message) {
              // Incoming Winston JSON Log
              setTelemetryLogs((prev) => [...prev.slice(-49), {
                timestamp: data.timestamp || new Date().toISOString(),
                level: data.level,
                message: data.message,
                source: data.source || 'host',
              }]);
            }
          } catch {}
        };

        ws.onclose = () => {
          setTelemetryWsConnected(false);
          reconnectTimeout = setTimeout(connectWebSocket, 5000);
        };

        ws.onerror = () => {
          setTelemetryWsConnected(false);
        };
      } catch {
        setTelemetryWsConnected(false);
      }
    };

    connectWebSocket();

    return () => {
      clearTimeout(reconnectTimeout);
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  useEffect(() => {
    if (isOpen) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isOpen]);

  const sendMessage = async (customPrompt?: string) => {
    const text = (customPrompt || input).trim();
    if (!text || loading) return;

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };

    setMessages((prev) => [...prev, userMsg]);
    if (!customPrompt) setInput('');
    setLoading(true);

    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('nexus_token') ?? ''}`,
        },
        body: JSON.stringify({
          message: text,
          history: messages.slice(-6).map((m) => ({ role: m.role, content: m.content })),
        }),
      });

      const data = await res.json();
      const botMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: data.response || 'Action processed.',
        toolExecuted: data.toolExecuted,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };
      setMessages((prev) => [...prev, botMsg]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: `Communication error: ${String((err as Error).message ?? err)}`,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      {/* Floating Action Button */}
      <div className="fixed bottom-6 right-6 z-[120]">
        <motion.button
          whileHover={{ scale: 1.08 }}
          whileTap={{ scale: 0.92 }}
          onClick={() => setIsOpen(!isOpen)}
          aria-label="Open Jarvis AI Command Center"
          className="relative flex items-center justify-center w-14 h-14 rounded-full bg-gradient-to-tr from-nexus-accent via-indigo-600 to-purple-600 text-white shadow-2xl shadow-nexus-accent/30 border border-white/20 transition-all focus:outline-none"
        >
          {isOpen ? (
            <X className="w-6 h-6" />
          ) : (
            <>
              <Bot className="w-6 h-6 animate-pulse" />
              {/* Telemetry live status indicator dot */}
              <span
                className={`absolute top-1 right-1 w-3 h-3 rounded-full border-2 border-black ${
                  telemetryWsConnected ? 'bg-emerald-400 animate-ping' : 'bg-amber-400'
                }`}
              />
              <span
                className={`absolute top-1 right-1 w-3 h-3 rounded-full border-2 border-black ${
                  telemetryWsConnected ? 'bg-emerald-400' : 'bg-amber-400'
                }`}
                title={telemetryWsConnected ? 'Telemetry WebSocket Live' : 'Telemetry Connecting…'}
              />
            </>
          )}
        </motion.button>
      </div>

      {/* Slide-out AI Command Center Panel */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: 30, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 30, scale: 0.95 }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            className="fixed bottom-24 right-4 md:right-6 z-[120] w-[calc(100vw-2rem)] sm:w-[440px] h-[580px] max-h-[80vh] flex flex-col rounded-3xl bg-[#090a16]/95 backdrop-blur-2xl border border-white/15 shadow-2xl shadow-black/80 overflow-hidden"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-white/10 bg-white/[0.02]">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-nexus-accent/15 border border-nexus-accent/30 flex items-center justify-center text-nexus-accent">
                  <Sparkles className="w-5 h-5" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-black text-white tracking-wide">JARVIS AI</h3>
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 font-bold border border-emerald-500/30 flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                      Live
                    </span>
                  </div>
                  <p className="text-[11px] text-white/40">CachyOS Linux Host Buddy</p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowLogsDrawer(!showLogsDrawer)}
                  className={`px-2.5 py-1.5 rounded-xl text-xs font-bold transition-all border flex items-center gap-1.5 ${
                    showLogsDrawer
                      ? 'bg-nexus-accent/20 border-nexus-accent text-nexus-accent'
                      : 'bg-white/5 border-white/10 text-white/60 hover:text-white'
                  }`}
                  title="Toggle Winston Telemetry Log Feed"
                >
                  <Terminal className="w-3.5 h-3.5" />
                  <span className="text-[10px] uppercase tracking-wider">Logs</span>
                </button>
                <button
                  onClick={() => setIsOpen(false)}
                  className="p-1.5 rounded-xl hover:bg-white/10 text-white/50 hover:text-white transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Quick Host Diagnostic Chips */}
            <div className="flex items-center gap-1.5 px-4 py-2 bg-white/[0.01] border-b border-white/5 overflow-x-auto no-scrollbar">
              <button
                onClick={() => sendMessage('diagnose_hls_stream')}
                className="px-2.5 py-1 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-[11px] font-bold text-white/80 shrink-0 flex items-center gap-1 transition-colors"
              >
                <Film className="w-3 h-3 text-cyan-400" />
                Diagnose HLS
              </button>
              <button
                onClick={() => sendMessage('scan_directory cloud')}
                className="px-2.5 py-1 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-[11px] font-bold text-white/80 shrink-0 flex items-center gap-1 transition-colors"
              >
                <HardDrive className="w-3 h-3 text-pink-400" />
                Scan Media
              </button>
              <button
                onClick={() => sendMessage('launch_game Super Mario')}
                className="px-2.5 py-1 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-[11px] font-bold text-white/80 shrink-0 flex items-center gap-1 transition-colors"
              >
                <Play className="w-3 h-3 text-nexus-accent" />
                Launch Test
              </button>
            </div>

            {/* Live Telemetry Drawer */}
            {showLogsDrawer && (
              <div className="h-44 bg-black/80 border-b border-white/10 p-3 font-mono text-[10px] overflow-y-auto space-y-1.5 flex-shrink-0">
                <div className="flex items-center justify-between text-white/40 pb-1 border-b border-white/10 text-[9px] uppercase tracking-wider">
                  <span>Winston JSON Log Stream</span>
                  <span>{telemetryLogs.length} events</span>
                </div>
                {telemetryLogs.length === 0 ? (
                  <p className="text-white/30 italic py-2">Listening on /api/v1/telemetry/jarvis…</p>
                ) : (
                  telemetryLogs.slice(-15).map((log, i) => (
                    <div key={i} className="text-white/70 leading-relaxed break-all">
                      <span className="text-white/30">[{new Date(log.timestamp).toLocaleTimeString()}]</span>{' '}
                      <span
                        className={
                          log.level === 'error'
                            ? 'text-red-400 font-bold'
                            : log.level === 'warn'
                            ? 'text-amber-400'
                            : 'text-nexus-accent'
                        }
                      >
                        [{log.level.toUpperCase()}]
                      </span>{' '}
                      <span className="text-white/40">({log.source}):</span> {log.message}
                    </div>
                  ))
                )}
              </div>
            )}

            {/* Message Stream */}
            <div className="flex-1 p-4 overflow-y-auto space-y-3.5">
              {messages.map((m) => (
                <div
                  key={m.id}
                  className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}
                >
                  <div
                    className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-xs leading-relaxed ${
                      m.role === 'user'
                        ? 'bg-nexus-accent text-black font-semibold rounded-tr-sm shadow-md shadow-nexus-accent/20'
                        : 'bg-white/[0.06] text-white/90 border border-white/10 rounded-tl-sm'
                    }`}
                  >
                    {m.content}

                    {/* Render Tool Execution Output Card if tool was invoked */}
                    {m.toolExecuted && (
                      <div className="mt-2.5 p-2.5 rounded-xl bg-black/40 border border-white/15 text-[11px] font-mono space-y-1">
                        <div className="flex items-center gap-1.5 text-nexus-accent font-bold">
                          <Activity className="w-3.5 h-3.5" />
                          <span>Tool: {m.toolExecuted.name}</span>
                        </div>
                        {m.toolExecuted.result?.message && (
                          <p className="text-white/80 font-sans text-[11px]">{m.toolExecuted.result.message}</p>
                        )}
                        {m.toolExecuted.result?.ramBuffer && (
                          <div className="text-emerald-400 text-[10px]">
                            Buffer: {m.toolExecuted.result.ramBuffer.freeMB} MB free in {m.toolExecuted.result.ramBuffer.path}
                          </div>
                        )}
                        {m.toolExecuted.result?.activeTranscoders !== undefined && (
                          <div className="text-cyan-400 text-[10px]">
                            Active FFMPEG Transcoders: {m.toolExecuted.result.activeTranscoders}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  <span className="text-[9px] text-white/30 mt-1 px-1">{m.timestamp}</span>
                </div>
              ))}

              {loading && (
                <div className="flex items-center gap-2 text-white/50 text-xs px-2 py-1">
                  <RefreshCw className="w-3.5 h-3.5 animate-spin text-nexus-accent" />
                  <span>Jarvis executing on host…</span>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Input Bar */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                sendMessage();
              }}
              className="p-3 border-t border-white/10 bg-white/[0.02] flex items-center gap-2"
            >
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ask Jarvis or run: diagnose_hls, launch, scan…"
                className="flex-1 bg-black/50 border border-white/10 rounded-xl px-3.5 py-2.5 text-xs text-white placeholder-white/30 focus:border-nexus-accent outline-none"
              />
              <button
                type="submit"
                disabled={!input.trim() || loading}
                className="w-10 h-10 rounded-xl bg-nexus-accent text-black flex items-center justify-center hover:bg-nexus-accent/90 transition-colors disabled:opacity-40"
              >
                <Send className="w-4 h-4" />
              </button>
            </form>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
