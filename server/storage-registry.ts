/**
 * Centralized Storage Registry & Multi-Location Manager for SaveState (NexusEmu).
 *
 * Supports:
 * - Primary SSD, Secondary SSD, Internal HDDs
 * - External USB & SATA drives
 * - NAS Network Shares (SMB / NFS / UNC paths)
 * - Google Drive (rclone remotes)
 *
 * Guarantees:
 * - If a drive disappears: NEVER crash, NEVER delete library records, NEVER duplicate entries.
 * - NAS-First architecture support with "configured_pending_capacity" state (DO NOT move data until capacity is ready).
 * - Per-console storage policies (e.g. large PS2/GC vs lightweight retro systems).
 */
import path from "node:path";
import os from "node:os";
import { statfs, readFile, writeFile, mkdir, access } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type StorageType = "ssd" | "hdd" | "external_usb" | "external_sata" | "nas" | "gdrive";
export type HealthStatus = "healthy" | "warning" | "critical" | "offline";
export type ConnectivityStatus = "online" | "offline" | "degraded";

export interface NasConfig {
  host: string;
  shareName: string;
  protocol: "smb" | "nfs" | "unc";
  username?: string;
  mountPath: string;
  status: "configured_pending_capacity" | "active" | "offline";
  targetCapacityBytes?: number;
  notes?: string;
}

export interface ConsoleStoragePolicy {
  consoleId: string;
  displayName: string;
  preferredLocationId: string;
  allowNetworkStream: boolean;
  localCacheRequired: boolean;
  estimatedSizeBytes?: number;
  priority: number;
}

export interface StorageLocation {
  id: string;
  name: string;
  mountPath: string;
  storageType: StorageType;
  totalBytes: number;
  availableBytes: number;
  usedBytes: number;
  healthStatus: HealthStatus;
  connectivityStatus: ConnectivityStatus;
  permissions: "ro" | "rw";
  priority: number;
  assignedLibraries: string[]; // e.g. ["movies", "tv", "games:ps2", "games:retro", "backups"]
  lastHealthCheck: number;
  isNas: boolean;
  nasConfig?: NasConfig;
  missingSince?: number | null;
  warningMessage?: string | null;
}

const DEFAULT_CONSOLE_POLICIES: ConsoleStoragePolicy[] = [
  { consoleId: "ps2", displayName: "PlayStation 2", preferredLocationId: "drive_primary", allowNetworkStream: true, localCacheRequired: true, priority: 1 },
  { consoleId: "gamecube", displayName: "Nintendo GameCube", preferredLocationId: "drive_primary", allowNetworkStream: true, localCacheRequired: true, priority: 2 },
  { consoleId: "ps1", displayName: "PlayStation 1", preferredLocationId: "drive_primary", allowNetworkStream: true, localCacheRequired: false, priority: 3 },
  { consoleId: "genesis", displayName: "Sega Genesis / MegaDrive", preferredLocationId: "drive_primary", allowNetworkStream: true, localCacheRequired: false, priority: 4 },
  { consoleId: "snes", displayName: "Super Nintendo", preferredLocationId: "drive_primary", allowNetworkStream: true, localCacheRequired: false, priority: 5 },
  { consoleId: "nes", displayName: "Nintendo Entertainment System", preferredLocationId: "drive_primary", allowNetworkStream: true, localCacheRequired: false, priority: 6 },
  { consoleId: "gba", displayName: "Game Boy Advance", preferredLocationId: "drive_primary", allowNetworkStream: true, localCacheRequired: false, priority: 7 },
  { consoleId: "n64", displayName: "Nintendo 64", preferredLocationId: "drive_primary", allowNetworkStream: true, localCacheRequired: false, priority: 8 },
  { consoleId: "arcade", displayName: "Arcade / NeoGeo", preferredLocationId: "drive_primary", allowNetworkStream: true, localCacheRequired: false, priority: 9 },
  { consoleId: "psp", displayName: "PlayStation Portable", preferredLocationId: "drive_primary", allowNetworkStream: true, localCacheRequired: true, priority: 10 },
];

export class StorageRegistry {
  private persistDir: string;
  private registryFilePath: string;
  private policiesFilePath: string;
  private locations: Map<string, StorageLocation> = new Map();
  private policies: Map<string, ConsoleStoragePolicy> = new Map();
  private isScanning = false;
  private log: (level: string, msg: string, subsystem?: string) => void;

  constructor(persistDir: string, log?: (level: string, msg: string, subsystem?: string) => void) {
    this.persistDir = persistDir;
    this.registryFilePath = path.join(persistDir, "storage_locations.json");
    this.policiesFilePath = path.join(persistDir, "console_storage_policies.json");
    this.log = log || ((lvl, msg) => console.log(`[${lvl}] [storage-registry] ${msg}`));
  }

  public async initialize(): Promise<void> {
    await mkdir(this.persistDir, { recursive: true });
    await this.loadPersistedData();
    await this.discoverSystemDrives();
    await this.savePersistedData();
  }

  private async loadPersistedData(): Promise<void> {
    // 1. Load Storage Locations
    try {
      if (existsSync(this.registryFilePath)) {
        const raw = await readFile(this.registryFilePath, "utf8");
        const list: StorageLocation[] = JSON.parse(raw);
        for (const loc of list) {
          this.locations.set(loc.id, loc);
        }
      }
    } catch (err: any) {
      this.log("WARN", `Could not read storage_locations.json: ${err.message}`);
    }

    // 2. Load Console Policies
    try {
      if (existsSync(this.policiesFilePath)) {
        const raw = await readFile(this.policiesFilePath, "utf8");
        const list: ConsoleStoragePolicy[] = JSON.parse(raw);
        for (const pol of list) {
          this.policies.set(pol.consoleId, pol);
        }
      } else {
        for (const pol of DEFAULT_CONSOLE_POLICIES) {
          this.policies.set(pol.consoleId, pol);
        }
      }
    } catch {
      for (const pol of DEFAULT_CONSOLE_POLICIES) {
        this.policies.set(pol.consoleId, pol);
      }
    }
  }

  private async savePersistedData(): Promise<void> {
    try {
      await writeFile(this.registryFilePath, JSON.stringify(Array.from(this.locations.values()), null, 2), "utf8");
      await writeFile(this.policiesFilePath, JSON.stringify(Array.from(this.policies.values()), null, 2), "utf8");
    } catch (err: any) {
      this.log("ERROR", `Failed to save storage registry: ${err.message}`);
    }
  }

  /**
   * Discovers and refreshes stats across all physical and cloud drives.
   * If a previously registered drive is offline, it is preserved with status 'offline'.
   */
  public async discoverSystemDrives(): Promise<StorageLocation[]> {
    if (this.isScanning) return Array.from(this.locations.values());
    this.isScanning = true;

    try {
      const isWindows = process.platform === "win32";
      const discoveredMounts: Array<{ path: string; name: string; type: StorageType; isNas: boolean }> = [];

      if (isWindows) {
        // Windows drive detection: A-Z drive letters
        const letters = "CDEFGHIJKLMNOPQRSTUVWXYZ".split("");
        for (const l of letters) {
          const rootPath = `${l}:\\`;
          if (existsSync(rootPath)) {
            const isPrimary = l === "C";
            discoveredMounts.push({
              path: rootPath,
              name: isPrimary ? `Primary SSD (${l}:)` : `Local Disk (${l}:)`,
              type: isPrimary ? "ssd" : "hdd",
              isNas: false,
            });
          }
        }
      } else {
        // Linux / Unix drive detection
        discoveredMounts.push({ path: "/", name: "Root Filesystem (/)", type: "ssd", isNas: false });
        const mediaDirs = ["/media", "/mnt"];
        for (const md of mediaDirs) {
          if (existsSync(md)) {
            try {
              const entries = await readdirSafe(md);
              for (const e of entries) {
                const fullP = path.join(md, e);
                discoveredMounts.push({
                  path: fullP,
                  name: `Mount (${e})`,
                  type: fullP.toLowerCase().includes("nas") ? "nas" : "hdd",
                  isNas: fullP.toLowerCase().includes("nas"),
                });
              }
            } catch {}
          }
        }
      }

      // Merge discovered mounts into locations
      for (const dm of discoveredMounts) {
        const id = this.generateIdFromPath(dm.path);
        const existing = this.locations.get(id);

        try {
          const stats = await statfs(dm.path);
          const totalBytes = Number(stats.blocks) * Number(stats.bsize);
          const availableBytes = Number(stats.bavail) * Number(stats.bsize);
          const usedBytes = Math.max(0, totalBytes - availableBytes);

          const freePercent = totalBytes > 0 ? (availableBytes / totalBytes) * 100 : 0;
          let healthStatus: HealthStatus = "healthy";
          let warningMessage: string | null = null;
          if (freePercent < 5) {
            healthStatus = "critical";
            warningMessage = `Disk space critical (${freePercent.toFixed(1)}% free)`;
          } else if (freePercent < 12) {
            healthStatus = "warning";
            warningMessage = `Low disk space (${freePercent.toFixed(1)}% free)`;
          }

          const updated: StorageLocation = {
            id,
            name: existing?.name || dm.name,
            mountPath: dm.path,
            storageType: existing?.storageType || dm.type,
            totalBytes,
            availableBytes,
            usedBytes,
            healthStatus,
            connectivityStatus: "online",
            permissions: existing?.permissions || "rw",
            priority: existing?.priority || (dm.type === "ssd" ? 1 : 5),
            assignedLibraries: existing?.assignedLibraries || ["movies", "tv", "games"],
            lastHealthCheck: Date.now(),
            isNas: existing?.isNas || dm.isNas,
            nasConfig: existing?.nasConfig,
            missingSince: null,
            warningMessage,
          };
          this.locations.set(id, updated);
        } catch {
          // If statfs fails on existing location, mark offline but preserve
          if (existing) {
            existing.connectivityStatus = "offline";
            existing.healthStatus = "offline";
            existing.missingSince = existing.missingSince || Date.now();
            existing.warningMessage = "Drive disconnected or inaccessible";
          }
        }
      }

      // Check existing locations that weren't in discovered mounts (e.g. disconnected USB or NAS share)
      for (const [id, loc] of this.locations.entries()) {
        if (!loc.isNas && !discoveredMounts.some(dm => dm.path.toLowerCase() === loc.mountPath.toLowerCase())) {
          loc.connectivityStatus = "offline";
          loc.healthStatus = "offline";
          loc.missingSince = loc.missingSince || Date.now();
          loc.warningMessage = `Storage location ${loc.mountPath} not detected on system`;
        }
      }

      await this.savePersistedData();
    } catch (err: any) {
      this.log("ERROR", `Storage discovery error: ${err.message}`);
    } finally {
      this.isScanning = false;
    }

    return Array.from(this.locations.values());
  }

  /**
   * Register or configure a NAS storage destination without migrating files yet.
   */
  public async configureNas(config: {
    host: string;
    shareName: string;
    protocol: "smb" | "nfs" | "unc";
    mountPath: string;
    username?: string;
    targetCapacityBytes?: number;
    notes?: string;
    status?: "configured_pending_capacity" | "active";
  }): Promise<StorageLocation> {
    const id = "nas_" + config.host.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase() + "_" + config.shareName.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();
    
    let isOnline = false;
    let totalBytes = config.targetCapacityBytes || 0;
    let availableBytes = config.targetCapacityBytes || 0;
    let usedBytes = 0;

    // Check if mount path is accessible right now
    if (config.mountPath && existsSync(config.mountPath)) {
      try {
        const stats = await statfs(config.mountPath);
        totalBytes = Number(stats.blocks) * Number(stats.bsize);
        availableBytes = Number(stats.bavail) * Number(stats.bsize);
        usedBytes = Math.max(0, totalBytes - availableBytes);
        isOnline = true;
      } catch {}
    }

    const nasConfig: NasConfig = {
      host: config.host,
      shareName: config.shareName,
      protocol: config.protocol,
      mountPath: config.mountPath,
      username: config.username,
      status: config.status || (isOnline ? "active" : "configured_pending_capacity"),
      targetCapacityBytes: config.targetCapacityBytes,
      notes: config.notes || "Configured for planned media and retro gaming migration.",
    };

    const location: StorageLocation = {
      id,
      name: `NAS: ${config.shareName} (${config.host})`,
      mountPath: config.mountPath,
      storageType: "nas",
      totalBytes,
      availableBytes,
      usedBytes,
      healthStatus: isOnline ? "healthy" : "warning",
      connectivityStatus: isOnline ? "online" : "offline",
      permissions: "rw",
      priority: 2,
      assignedLibraries: ["movies", "tv", "games:retro"],
      lastHealthCheck: Date.now(),
      isNas: true,
      nasConfig,
      missingSince: isOnline ? null : Date.now(),
      warningMessage: isOnline ? null : "NAS configured: awaiting expansion / connectivity verification.",
    };

    this.locations.set(id, location);
    await this.savePersistedData();
    this.log("INFO", `NAS location registered: ${id} [${nasConfig.status}]`);
    return location;
  }

  public getLocations(): StorageLocation[] {
    return Array.from(this.locations.values());
  }

  public getLocationById(id: string): StorageLocation | undefined {
    return this.locations.get(id);
  }

  public getConsolePolicies(): ConsoleStoragePolicy[] {
    if (this.policies.size === 0) {
      for (const pol of DEFAULT_CONSOLE_POLICIES) {
        this.policies.set(pol.consoleId, pol);
      }
    }
    return Array.from(this.policies.values());
  }

  public getPolicies(): ConsoleStoragePolicy[] {
    return this.getConsolePolicies();
  }

  public async setConsolePolicy(policy: ConsoleStoragePolicy): Promise<void> {
    this.policies.set(policy.consoleId, policy);
    await this.savePersistedData();
  }

  public async updatePolicy(consoleId: string, partial: Partial<ConsoleStoragePolicy>): Promise<ConsoleStoragePolicy | null> {
    const existing = this.policies.get(consoleId) || {
      consoleId,
      displayName: consoleId.toUpperCase(),
      preferredLocationId: "drive_primary",
      allowNetworkStream: true,
      localCacheRequired: false,
      priority: 5,
    };
    const updated: ConsoleStoragePolicy = { ...existing, ...partial, consoleId };
    await this.setConsolePolicy(updated);
    return updated;
  }

  public async scanLocations(): Promise<StorageLocation[]> {
    return await this.discoverSystemDrives();
  }

  public async registerNasLocation(config: {
    host: string;
    shareName: string;
    protocol: "smb" | "nfs" | "unc";
    mountPath: string;
    username?: string;
    targetCapacityBytes?: number;
    notes?: string;
    status?: "configured_pending_capacity" | "active";
  }, assignedLibraries?: string[]): Promise<StorageLocation> {
    const loc = await this.configureNas(config);
    if (assignedLibraries && assignedLibraries.length > 0) {
      loc.assignedLibraries = assignedLibraries;
      await this.savePersistedData();
    }
    return loc;
  }

  private generateIdFromPath(p: string): string {
    const cleaned = p.replace(/[:\\/]/g, "").toLowerCase();
    return `drive_${cleaned || "root"}`;
  }
}

async function readdirSafe(dir: string): Promise<string[]> {
  try {
    const fs = await import("node:fs/promises");
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

let _instance: StorageRegistry | null = null;
export function getStorageRegistry(persistDir?: string): StorageRegistry {
  if (!_instance) {
    const p = persistDir || path.join(process.cwd(), ".nexus-persist");
    _instance = new StorageRegistry(p);
    _instance.initialize().catch((err) => console.error("[WARN] [storage-registry] init error:", err));
  }
  return _instance;
}
