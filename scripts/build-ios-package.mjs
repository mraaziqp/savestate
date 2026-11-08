#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
const version = pkg.version || "1.0.75";
const updatesDir = path.join(rootDir, "releases", "updates");

if (!fs.existsSync(updatesDir)) {
  fs.mkdirSync(updatesDir, { recursive: true });
}

console.log(`[iOS Builder] Building iOS artifacts for SaveState v${version}...`);

// 1. Generate iOS WebClip Configuration Profile (.mobileconfig)
const iconPath = path.join(rootDir, "dist", "apple-touch-icon.png");
let iconBase64 = "";
if (fs.existsSync(iconPath)) {
  iconBase64 = fs.readFileSync(iconPath).toString("base64");
}

export function generateMobileConfig(targetUrl = "https://savestate.co.za", appName = "SaveState") {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>PayloadContent</key>
    <array>
        <dict>
            <key>FullScreen</key>
            <true/>
            ${iconBase64 ? `<key>Icon</key>\n            <data>\n            ${iconBase64}\n            </data>` : ""}
            <key>IsRemovable</key>
            <true/>
            <key>Label</key>
            <string>${appName}</string>
            <key>PayloadDescription</key>
            <string>Configures ${appName} WebClip on Home Screen with full-screen experience and hardware controller support</string>
            <key>PayloadDisplayName</key>
            <string>${appName}</string>
            <key>PayloadIdentifier</key>
            <string>com.savestate.nexus.webclip</string>
            <key>PayloadType</key>
            <string>com.apple.webClip.managed</string>
            <key>PayloadUUID</key>
            <string>A55B2E10-3C84-4B7B-B962-92AEF1F1070A</string>
            <key>PayloadVersion</key>
            <integer>1</integer>
            <key>Precomposed</key>
            <true/>
            <key>URL</key>
            <string>${targetUrl}</string>
        </dict>
    </array>
    <key>PayloadDescription</key>
    <string>Installs ${appName} native full-screen app directly to your iPhone or iPad Home Screen.</string>
    <key>PayloadDisplayName</key>
    <string>${appName} iOS Installer</string>
    <key>PayloadIdentifier</key>
    <string>com.savestate.nexus.profile</string>
    <key>PayloadOrganization</key>
    <string>SaveState</string>
    <key>PayloadRemovalDisallowed</key>
    <false/>
    <key>PayloadType</key>
    <string>Configuration</string>
    <key>PayloadUUID</key>
    <string>E7A6B459-009A-40C9-8809-7CF06D5E62FA</string>
    <key>PayloadVersion</key>
    <integer>1</integer>
</dict>
</plist>`;
}

const mobileConfigContent = generateMobileConfig("https://savestate.co.za", "SaveState");
const mobileConfigPath = path.join(updatesDir, "SaveState.mobileconfig");
fs.writeFileSync(mobileConfigPath, mobileConfigContent, "utf8");
console.log(`[iOS Builder] Generated WebClip profile: ${mobileConfigPath} (${fs.statSync(mobileConfigPath).size} bytes)`);

// 2. Build Unsigned Sideload IPA (SaveState-<version>.ipa)
const iosAppDir = path.join(rootDir, "ios", "App", "App");
if (fs.existsSync(iosAppDir)) {
  console.log(`[iOS Builder] Packaging iOS IPA from ${iosAppDir}...`);
  const zip = new AdmZip();
  
  // Add all app bundle contents under Payload/SaveState.app/
  zip.addLocalFolder(iosAppDir, "Payload/SaveState.app");

  const ipaName = `SaveState-${version}.ipa`;
  const ipaPath = path.join(updatesDir, ipaName);
  zip.writeZip(ipaPath);

  // Also maintain unversioned SaveState.ipa symlink or copy
  const unversionedIpa = path.join(updatesDir, "SaveState.ipa");
  fs.copyFileSync(ipaPath, unversionedIpa);

  const ipaSizeMB = (fs.statSync(ipaPath).size / (1024 * 1024)).toFixed(2);
  console.log(`[iOS Builder] Generated Sideload IPA: ${ipaPath} (${ipaSizeMB} MB)`);
} else {
  console.warn(`[iOS Builder] Notice: ${iosAppDir} not found, run npx cap add ios first.`);
}

console.log("[iOS Builder] iOS build completed successfully!");
