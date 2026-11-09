import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export type ControllerLayout = "modern" | "nintendo";

export interface DetectedController {
  index: number;
  name: string;
  type: "xinput" | "dinput" | "sdl" | "hid";
  connected: boolean;
}

export interface DolphinConfigResult {
  ok: boolean;
  message: string;
  controllersDetected: DetectedController[];
  pathsUpdated: string[];
  layoutUsed: ControllerLayout;
  deadzoneUsed: number;
  details: {
    standalonePaths: string[];
    libretroPaths: string[];
  };
}

/**
 * Detect connected physical and virtual gamepads on Windows/Linux/macOS
 */
export async function detectConnectedGamepads(): Promise<DetectedController[]> {
  const controllers: DetectedController[] = [];
  const isWin = process.platform === "win32";

  if (isWin) {
    try {
      // Check XInput slots 0..3 via PowerShell
      const psScript = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class XICheck {
    [StructLayout(LayoutKind.Sequential)]
    public struct XINPUT_STATE { public uint dwPacketNumber; public ushort wButtons; public byte bLeftTrigger; public byte bRightTrigger; public short sThumbLX; public short sThumbLY; public short sThumbRX; public short sThumbRY; }
    [DllImport("xinput1_4.dll")]
    public static extern int XInputGetState(int userIndex, ref XINPUT_STATE state);
    public static string Query() {
        string res = "";
        for (int i = 0; i < 4; i++) {
            XINPUT_STATE st = new XINPUT_STATE();
            int r = -1;
            try { r = XInputGetState(i, ref st); } catch {}
            if (r == 0) res += i + ";";
        }
        return res;
    }
}
'@ -ErrorAction SilentlyContinue
[XICheck]::Query()
`;
      // -EncodedCommand keeps the script's line breaks: the @'...'@ block
      // needs them (flattened onto one line it never compiled, and the old
      // fallback then reported a controller that wasn't there). Only what
      // PowerShell needs from the environment; nothing from SaveState's .env.
      const env: NodeJS.ProcessEnv = {};
      for (const k of ["SystemRoot", "windir", "PATH", "Path", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "PSModulePath", "ComSpec"]) if (process.env[k]) env[k] = process.env[k];
      const { stdout } = await execAsync(`powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(psScript, "utf16le").toString("base64")}`, { timeout: 8000, env, windowsHide: true });
      const connectedSlots = stdout.trim().split(";").filter(Boolean).map((s) => parseInt(s, 10));
      for (const i of connectedSlots) {
        if (!(i >= 0 && i < 4)) continue;
        controllers.push({ index: i, name: `Xbox-type controller (player ${i + 1})`, type: "xinput", connected: true });
      }
    } catch {
      // Unknown: report none rather than invent one.
    }
  } else {
    // Linux / Mac: Check /dev/input/js*
    try {
      if (fs.existsSync("/dev/input")) {
        const jsFiles = fs.readdirSync("/dev/input").filter((f) => f.startsWith("js"));
        jsFiles.slice(0, 4).forEach((f, i) => controllers.push({ index: i, name: `Gamepad (${f})`, type: "sdl", connected: true }));
      }
    } catch {}
  }

  return controllers;
}

/**
 * Generate Standalone Dolphin GCPadNew.ini content for 4 controller ports
 */
export function generateStandaloneGCPadIni(layout: ControllerLayout = "modern", deadzone: number = 10.0): string {
  const isNintendo = layout === "nintendo";
  const dz = deadzone.toFixed(1);

  // Modern Xbox Layout:
  // GameCube A = Xbox A (Button A), GameCube B = Xbox B (Button B)
  // GameCube X = Xbox X (Button X), GameCube Y = Xbox Y (Button Y)
  // Nintendo Position Layout:
  // GameCube A = Xbox B (Button B), GameCube B = Xbox A (Button A)
  // GameCube X = Xbox Y (Button Y), GameCube Y = Xbox X (Button X)
  const aBtn = isNintendo ? "`Button B`|`Button 1`" : "`Button A`|`Button 0`";
  const bBtn = isNintendo ? "`Button A`|`Button 0`" : "`Button B`|`Button 1`";
  const xBtn = isNintendo ? "`Button Y`|`Button 3`" : "`Button X`|`Button 2`";
  const yBtn = isNintendo ? "`Button X`|`Button 2`" : "`Button Y`|`Button 3`";

  let out = "";
  for (let port = 1; port <= 4; port++) {
    const idx = port - 1;
    out += `[GCPad${port}]
Device = XInput/${idx}/Gamepad|SDL/${idx}/Gamepad|SDL/${idx}/Xbox 360 Controller|DInput/${idx}/Gamepad
Buttons/A = ${aBtn}
Buttons/B = ${bBtn}
Buttons/X = ${xBtn}
Buttons/Y = ${yBtn}
Buttons/Z = \`Shoulder R\`|\`Button 10\`|\`Button 5\`
Buttons/Start = Start|\`Button 6\`|\`Button 7\`
Main Stick/Up = \`Left Y+\`|\`Axis 1-\`
Main Stick/Down = \`Left Y-\`|\`Axis 1+\`
Main Stick/Left = \`Left X-\`|\`Axis 0-\`
Main Stick/Right = \`Left X+\`|\`Axis 0+\`
Main Stick/Dead Zone = ${dz}
C-Stick/Up = \`Right Y+\`|\`Axis 3-\`
C-Stick/Down = \`Right Y-\`|\`Axis 3+\`
C-Stick/Left = \`Right X-\`|\`Axis 2-\`
C-Stick/Right = \`Right X+\`|\`Axis 2+\`
C-Stick/Dead Zone = ${dz}
Triggers/L = \`Trigger L\`|\`Axis 4+\`|\`Button 4\`
Triggers/R = \`Trigger R\`|\`Axis 5+\`|\`Button 5\`
Triggers/L-Analog = \`Trigger L\`|\`Axis 4+\`
Triggers/R-Analog = \`Trigger R\`|\`Axis 5+\`
Triggers/Threshold = 85.0
D-Pad/Up = \`Pad N\`|\`Hat 0 N\`
D-Pad/Down = \`Pad S\`|\`Hat 0 S\`
D-Pad/Left = \`Pad W\`|\`Hat 0 W\`
D-Pad/Right = \`Pad E\`|\`Hat 0 E\`
Rumble/Motor = \`Motor L\`|\`Motor R\`
Options/Always Connected = True
`;
  }
  return out;
}

/**
 * Generate Dolphin-libretro / RetroArch / SaveState Engine GCPadNew.ini
 */
export function generateLibretroGCPadIni(layout: ControllerLayout = "modern", deadzone: number = 10.0): string {
  const isNintendo = layout === "nintendo";
  const dz = deadzone.toFixed(1);

  // In Libretro:
  // Retropad B = Xbox A (South button, ID 0)
  // Retropad A = Xbox B (East button, ID 8)
  // Retropad Y = Xbox X (West button, ID 1)
  // Retropad X = Xbox Y (North button, ID 9)
  //
  // For Modern Layout (Xbox A = GameCube A):
  // GameCube A should bind to Retropad B (South)
  // GameCube B should bind to Retropad A (East)
  // GameCube X should bind to Retropad Y (West)
  // GameCube Y should bind to Retropad X (North)
  //
  // For Nintendo Position Layout (Xbox B = GameCube A):
  // GameCube A binds to Retropad A
  // GameCube B binds to Retropad B
  // GameCube X binds to Retropad X
  // GameCube Y binds to Retropad Y
  const gcA = isNintendo ? "A" : "B";
  const gcB = isNintendo ? "B" : "A";
  const gcX = isNintendo ? "X" : "Y";
  const gcY = isNintendo ? "Y" : "X";

  let out = "";
  for (let port = 1; port <= 4; port++) {
    const idx = port - 1;
    out += `[GCPad${port}]
Device = Libretro/${idx}/Joypad
Buttons/A = ${gcA}
Buttons/B = ${gcB}
Buttons/X = ${gcX}
Buttons/Y = ${gcY}
Buttons/Z = R
Buttons/Start = Start
Main Stick/Up = \`Libretro/${idx}/Analog:Y0-\`
Main Stick/Down = \`Libretro/${idx}/Analog:Y0+\`
Main Stick/Left = \`Libretro/${idx}/Analog:X0-\`
Main Stick/Right = \`Libretro/${idx}/Analog:X0+\`
Main Stick/Dead Zone = ${dz}
C-Stick/Up = \`Libretro/${idx}/Analog:Y1-\`
C-Stick/Down = \`Libretro/${idx}/Analog:Y1+\`
C-Stick/Left = \`Libretro/${idx}/Analog:X1-\`
C-Stick/Right = \`Libretro/${idx}/Analog:X1+\`
C-Stick/Dead Zone = ${dz}
Triggers/L = \`Libretro/${idx}/Analog:Trigger0+\`|(L2&!\`Libretro/${idx}/Analog:Trigger0+\`)
Triggers/R = \`Libretro/${idx}/Analog:Trigger1+\`|(R2&!\`Libretro/${idx}/Analog:Trigger1+\`)
Triggers/L-Analog = \`Libretro/${idx}/Analog:Trigger0+\`|L3
Triggers/R-Analog = \`Libretro/${idx}/Analog:Trigger1+\`|R3
Triggers/Threshold = 85.0
D-Pad/Up = Up
D-Pad/Down = Down
D-Pad/Left = Left
D-Pad/Right = Right
Triforce/Test = L
Triforce/Service = L3&R3
Triforce/Coin = Select
Rumble/Motor = Rumble
Options/Always Connected = True
`;
  }
  return out;
}

/**
 * Generate Standalone WiimoteNew.ini
 */
export function generateStandaloneWiimoteIni(): string {
  let out = "";
  for (let port = 1; port <= 2; port++) {
    const idx = port - 1;
    out += `[Wiimote${port}]
Device = XInput/${idx}/Gamepad|SDL/${idx}/Gamepad|DInput/${idx}/Gamepad
Options/Sideways Wiimote = 1
Buttons/A = \`Button A\`|\`Button 0\`
Buttons/B = \`Button B\`|\`Button 1\`
Buttons/1 = \`Button X\`|\`Button 2\`
Buttons/2 = \`Button Y\`|\`Button 3\`
Buttons/- = Back|\`Button 4\`
Buttons/+ = Start|\`Button 6\`
D-Pad/Up = \`Left Y+\`|\`Pad N\`
D-Pad/Down = \`Left Y-\`|\`Pad S\`
D-Pad/Left = \`Left X-\`|\`Pad W\`
D-Pad/Right = \`Left X+\`|\`Pad E\`
Extension = Nunchuk
Nunchuk/Stick/Up = \`Left Y+\`
Nunchuk/Stick/Down = \`Left Y-\`
Nunchuk/Stick/Left = \`Left X-\`
Nunchuk/Stick/Right = \`Left X+\`
Nunchuk/Buttons/C = \`Shoulder L\`|\`Button 4\`
Nunchuk/Buttons/Z = \`Trigger L\`|\`Axis 4+\`
`;
  }
  return out;
}

/**
 * Generate Libretro WiimoteNew.ini
 */
export function generateLibretroWiimoteIni(): string {
  let out = "";
  for (let port = 1; port <= 2; port++) {
    const idx = port - 1;
    out += `[Wiimote${port}]
Device = Libretro/${idx}/Joypad
Buttons/A = \`Button 0\` | A
Buttons/B = \`Button 1\` | B
Buttons/1 = \`Button 2\` | X
Buttons/2 = \`Button 3\` | Y
Buttons/- = Select
Buttons/+ = Start
Buttons/Home = Home
D-Pad/Up = Up
D-Pad/Down = Down
D-Pad/Left = Left
D-Pad/Right = Right
IR/Up = \`Libretro/${idx}/Analog:Y1-\`
IR/Down = \`Libretro/${idx}/Analog:Y1+\`
IR/Left = \`Libretro/${idx}/Analog:X1-\`
IR/Right = \`Libretro/${idx}/Analog:X1+\`
Extension = Nunchuk
Nunchuk/Buttons/C = L
Nunchuk/Buttons/Z = \`Libretro/${idx}/Analog:Trigger0+\`|L2
Nunchuk/Stick/Up = \`Libretro/${idx}/Analog:Y0-\`
Nunchuk/Stick/Down = \`Libretro/${idx}/Analog:Y0+\`
Nunchuk/Stick/Left = \`Libretro/${idx}/Analog:X0-\`
Nunchuk/Stick/Right = \`Libretro/${idx}/Analog:X0+\`
`;
  }
  return out;
}

/**
 * Update Dolphin.ini core section safely
 */
export function updateDolphinIni(iniPath: string, siDeviceValue: number): void {
  try {
    let text = fs.existsSync(iniPath) ? fs.readFileSync(iniPath, "utf8") : "";

    // Replace SIDevice0..3
    text = text.replace(/^(SIDevice[0-3][ \t]*=[ \t]*)\d+([ \t]*\r?)$/gm, `$1${siDeviceValue}$2`);

    if (!text.includes("[Core]")) {
      text = `[Core]\nSIDevice0 = ${siDeviceValue}\nSIDevice1 = ${siDeviceValue}\nSIDevice2 = ${siDeviceValue}\nSIDevice3 = ${siDeviceValue}\nWiimoteSource0 = 1\nWiimoteSource1 = 1\n${text}`;
    } else {
      if (!text.includes("SIDevice0")) {
        text = text.replace("[Core]", `[Core]\nSIDevice0 = ${siDeviceValue}\nSIDevice1 = ${siDeviceValue}\nSIDevice2 = ${siDeviceValue}\nSIDevice3 = ${siDeviceValue}`);
      }
      if (!text.includes("WiimoteSource0")) {
        text = text.replace("[Core]", `[Core]\nWiimoteSource0 = 1\nWiimoteSource1 = 1`);
      }
    }

    fs.mkdirSync(path.dirname(iniPath), { recursive: true });
    fs.writeFileSync(iniPath, text, "utf8");
  } catch (err) {
    console.warn(`[dolphin-controller] unable to update ${iniPath}:`, err);
  }
}

/**
 * Discover all Dolphin configuration directories across Standalone and Libretro installations
 */
export function discoverDolphinDirs(): { standaloneDirs: string[]; libretroDirs: string[] } {
  const home = os.homedir();
  const isWin = process.platform === "win32";
  const standaloneDirs: string[] = [];
  const libretroDirs: string[] = [];

  if (isWin) {
    // 1. Standalone Dolphin user directories
    if (process.env.USERPROFILE) {
      standaloneDirs.push(path.join(process.env.USERPROFILE, "Documents", "Dolphin Emulator", "Config"));
    }
    if (process.env.APPDATA) {
      standaloneDirs.push(path.join(process.env.APPDATA, "Dolphin Emulator", "Config"));
    }
    standaloneDirs.push(path.join(home, "Documents", "Dolphin Emulator", "Config"));

    // 2. RetroArch Dolphin core directories
    const retroBase = "C:\\RetroArch-Win64";
    if (fs.existsSync(retroBase)) {
      libretroDirs.push(path.join(retroBase, "saves", "User", "Config"));
      libretroDirs.push(path.join(retroBase, "system", "dolphin-emu", "User", "Config"));
    }

    // 3. User native-saves folders created by SaveState
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    const nativeSavesRoot = path.join(appData, "NexusEmuHost", "native-saves");
    if (fs.existsSync(nativeSavesRoot)) {
      try {
        const userDirs = fs.readdirSync(nativeSavesRoot);
        for (const u of userDirs) {
          const userRoot = path.join(nativeSavesRoot, u);
          try {
            if (fs.statSync(userRoot).isDirectory()) {
              const userConf = path.join(userRoot, "User", "Config");
              libretroDirs.push(userConf);
            }
          } catch {}
        }
      } catch {}
    }

    // 4. SaveState Client Engine directories
    const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    const clientRoot = path.join(localAppData, "NexusEmuClient");
    libretroDirs.push(path.join(clientRoot, "engine", "saves", "User", "Config"));
    libretroDirs.push(path.join(clientRoot, "engine", "system", "dolphin-emu", "User", "Config"));
    libretroDirs.push(path.join(clientRoot, "Emulation", "saves", "User", "Config"));
  } else {
    // Linux / Mac
    standaloneDirs.push(path.join(home, ".config", "dolphin-emu"));
    standaloneDirs.push(path.join(home, ".var", "app", "org.DolphinEmu.dolphin-emu", "config", "dolphin-emu"));
    standaloneDirs.push(path.join(home, "Library", "Application Support", "Dolphin", "Config"));

    // RetroArch on Linux
    libretroDirs.push(path.join(home, ".config", "retroarch", "saves", "User", "Config"));
    libretroDirs.push(path.join(home, ".config", "retroarch", "system", "dolphin-emu", "User", "Config"));
  }

  // De-duplicate paths
  const uniq = (arr: string[]) => Array.from(new Set(arr));
  return {
    standaloneDirs: uniq(standaloneDirs),
    libretroDirs: uniq(libretroDirs),
  };
}

/**
 * Configure and Auto-Provision GameCube and Wii controllers across ALL emulator instances
 */
export async function configureDolphinControllers(opts: {
  layout?: ControllerLayout;
  deadzone?: number;
} = {}): Promise<DolphinConfigResult> {
  const layout = opts.layout ?? "modern";
  const deadzone = opts.deadzone ?? 10.0;
  const pathsUpdated: string[] = [];

  const controllers = await detectConnectedGamepads();
  const { standaloneDirs, libretroDirs } = discoverDolphinDirs();

  const standaloneGCPad = generateStandaloneGCPadIni(layout, deadzone);
  const standaloneWiimote = generateStandaloneWiimoteIni();
  const libretroGCPad = generateLibretroGCPadIni(layout, deadzone);
  const libretroWiimote = generateLibretroWiimoteIni();

  // 1. Standalone Dolphin: SIDevice 6 is the Standard Controller there too (1
  //    is the N64 microphone, which made every pad ignore its buttons).
  for (const dir of standaloneDirs) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "GCPadNew.ini"), standaloneGCPad, "utf8");
      fs.writeFileSync(path.join(dir, "WiimoteNew.ini"), standaloneWiimote, "utf8");
      updateDolphinIni(path.join(dir, "Dolphin.ini"), 6);
      pathsUpdated.push(dir);
    } catch (e) {
      console.warn(`[dolphin-controller] skipping standalone dir ${dir}:`, e);
    }
  }

  // 2. Provision Libretro / RetroArch / SaveState Engine paths (SIDevice = 6 for GC controller in Libretro)
  for (const dir of libretroDirs) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "GCPadNew.ini"), libretroGCPad, "utf8");
      fs.writeFileSync(path.join(dir, "WiimoteNew.ini"), libretroWiimote, "utf8");
      updateDolphinIni(path.join(dir, "Dolphin.ini"), 6);
      pathsUpdated.push(dir);
    } catch (e) {
      console.warn(`[dolphin-controller] skipping libretro dir ${dir}:`, e);
    }
  }

  const activeCount = controllers.filter((c) => c.connected).length;
  const primaryName = controllers.find((c) => c.connected)?.name || "Default Controller";

  return {
    ok: true,
    message: `GameCube controller configured successfully for ${activeCount > 0 ? `${activeCount} controller(s) (${primaryName})` : "Standard Gamepad"} across ${pathsUpdated.length} configurations.`,
    controllersDetected: controllers,
    pathsUpdated,
    layoutUsed: layout,
    deadzoneUsed: deadzone,
    details: {
      standalonePaths: standaloneDirs,
      libretroPaths: libretroDirs,
    },
  };
}
