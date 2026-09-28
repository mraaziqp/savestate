#!/usr/bin/env node
// One-time helper: turns a Google Cloud OAuth client into a refresh token for
// GDRIVE_CLIENT_ID / GDRIVE_CLIENT_SECRET / GDRIVE_REFRESH_TOKEN in
// .env.production. Run locally — it opens a consent URL for you to approve
// in your own browser and never sends the resulting token anywhere but your
// own terminal.
//
// Prerequisites (Google Cloud Console, one-time):
//   1. console.cloud.google.com → select/create a project.
//   2. APIs & Services → Library → enable "Google Drive API".
//   3. APIs & Services → Credentials → Create Credentials → OAuth client ID.
//      Application type: "Web application".
//      Authorized redirect URIs: add http://localhost:8080/oauth2callback
//   4. Copy the Client ID and Client Secret it gives you.
//
// Usage:
//   node scripts/get-gdrive-refresh-token.mjs            (prompts for both)
//   node scripts/get-gdrive-refresh-token.mjs CLIENT_ID  (prompts for secret)
//
// The secret is prompted for rather than passed as an argument so it never
// lands in shell history or in `ps` output.

import http from "node:http";
import readline from "node:readline";
import { URL } from "node:url";

function ask(question, { hidden = false } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) {
    // Suppress echo so the secret isn't shown on screen as it's typed.
    rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); };
  }
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); if (hidden) process.stdout.write("\n"); resolve(answer.trim()); }));
}

let clientId = process.argv[2];
if (!clientId) clientId = await ask("Client ID (ends in .apps.googleusercontent.com): ");
const clientSecret = await ask("Client secret (starts with GOCSPX-, input hidden): ", { hidden: true });

if (!clientId || !clientSecret) {
  console.error("Both a client ID and a client secret are required.");
  process.exit(1);
}
if (/^YOUR_|_HERE$|^<.*>$/.test(clientSecret) || !clientSecret.startsWith("GOCSPX-")) {
  console.error(`\nThat doesn't look like a real client secret ("${clientSecret.slice(0, 12)}...").`);
  console.error("Find it in Google Cloud Console -> APIs & Services -> Credentials ->");
  console.error("click your Web application client -> 'Client secret' (starts with GOCSPX-).");
  process.exit(1);
}

const REDIRECT_URI = "http://localhost:8080/oauth2callback";
// Full read/write Drive scope — server.ts references upload functionality
// (gdriveUploads) alongside the read-only streaming proxy, so this needs to
// cover both. Narrow to drive.readonly later if uploads turn out unused.
const SCOPE = "https://www.googleapis.com/auth/drive";

const { google } = await import("googleapis");
const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: "offline",
  prompt: "consent", // forces a refresh_token even if this client was authorized before
  scope: [SCOPE],
});

console.log("\n1. Open this URL in your browser and approve access:\n");
console.log(authUrl);
console.log("\n2. Waiting for the redirect back to localhost:8080 ...\n");

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT_URI);
  if (url.pathname !== "/oauth2callback") { res.writeHead(404); res.end(); return; }

  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  if (error) {
    res.writeHead(400); res.end(`Authorization failed: ${error}. You can close this tab.`);
    console.error(`Authorization failed: ${error}`);
    server.close(); process.exit(1);
  }
  if (!code) { res.writeHead(400); res.end("Missing code"); return; }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<h2>Done — you can close this tab.</h2>");

    console.log("Success. Add these to .env.production:\n");
    console.log(`GDRIVE_CLIENT_ID=${clientId}`);
    console.log(`GDRIVE_CLIENT_SECRET=${clientSecret}`);
    console.log(`GDRIVE_REFRESH_TOKEN=${tokens.refresh_token ?? "(none returned — re-run with prompt=consent, or revoke prior access at https://myaccount.google.com/permissions and retry)"}`);
  } catch (e) {
    res.writeHead(500); res.end("Token exchange failed — see terminal.");
    console.error("Token exchange failed:", e?.message ?? e);
  } finally {
    server.close();
    setTimeout(() => process.exit(0), 500);
  }
});

server.listen(8080);
