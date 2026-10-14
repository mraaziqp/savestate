# Hosting savestate.co.za

How this app is served, and how to move it to another machine.

## What a "host" actually is

The domain does not point at an IP address. `savestate.co.za` is proxied by
Cloudflare, and Cloudflare reaches the app through a **named tunnel**. The
tunnel's credential file lives at `~/.cloudflared/<tunnel-id>.json`.

**Whichever machine runs `cloudflared` with that file receives the domain's
traffic.** That file is the host identity. It cannot be regenerated from this
repo, and it is the one thing that must be carried across by hand.

Everything else is either in git or on Google Drive.

## Where things live

| | Where | Moves with the host? |
|---|---|---|
| App code, prebuilt frontend | this repo | `git clone` |
| systemd units | `deploy/systemd/*.template` | rendered by `setup-host.sh` |
| Tunnel credential | `~/.cloudflared/*.json` | **host bundle** |
| Drive token (rclone) | `~/.config/rclone/` | **host bundle** |
| App secrets | `.env`, `.env.production` | **host bundle** |
| Library index, progress | `~/.nexus-data/*.json` | **host bundle** |
| BIOS images | `~/.nexus-data/bios` | **host bundle** |
| Books, per-user storage, music | `~/.nexus-data/{books,user-storage,music}` | **host bundle** |
| Media and ROMs | Google Drive (`NexusArchive`) | already there — nothing to move |
| HLS cache | `~/.nexus-data/tmp/hls-cache` | regenerated; never copy it |

### BIOS

`bios_path` used to point at `/media/moh/500GB Hardrive/Emu/Bios` — the drive
that failed. The app would have recreated that as a stray directory on any new
host, and the BIOS upload flow would have written into a phantom path. It now
points at `~/.nexus-data/bios`, which the host bundle carries.

The Drive mount is deliberately `--read-only`, so BIOS images cannot live
there; they travel in the bundle instead.

No BIOS images survived the drive failure. Until they are re-added, PS1, PS2,
Saturn and Nintendo DS titles will pause at launch and ask for one — the
server answers `202` with the exact accepted filenames, and the player opens a
file picker, installs it, and retries automatically.

## Moving to another machine

On the **old** host:

```bash
bash scripts/export-host-bundle.sh --encrypt
```

Produces `~/savestate-host-bundle-<stamp>.tar.gz.gpg` (a few hundred KB). It
holds the tunnel credential, Drive token and app secrets in plaintext inside
the archive, so move it over USB or `scp` — never chat or cloud storage.

On the **new** host:

```bash
git clone git@github.com:mraaziqp/savestate.git NexussEmu
cd NexussEmu
bash scripts/setup-host.sh                       # deps + systemd units
bash scripts/import-host-bundle.sh ~/savestate-host-bundle-*.tar.gz.gpg
```

Then stop the old machine serving **before** starting the new one — Cloudflare
will run a single tunnel from two hosts and balance between them, which shows
up as a library that randomly appears half empty:

```bash
# on the OLD machine
systemctl --user disable --now cloudflared-nexus nexus-host

# on the NEW machine
systemctl --user enable --now nexus-rclone-rcd nexus-cloud-media
systemctl --user enable --now nexus-host cloudflared-nexus
```

Verify:

```bash
curl -s localhost:3000/api/health
curl -s https://savestate.co.za/api/health/full
```

The second should report `"overall": "healthy"` with every check passing.

### Windows hosts (native, no WSL)

One PowerShell command sets up a Windows PC as the host. The script installs
anything missing with winget: Node, ffmpeg, cloudflared, and rclone + WinFsp
for the Drive library. It restores the tunnel credential and secrets from the
USB bundle, which it finds by itself, and builds the server. It registers a
"SaveState Host" task that starts everything at logon and restarts anything
that stops, then checks the domain answers from outside.

```powershell
winget install -e --id Git.Git --accept-source-agreements --accept-package-agreements
$env:Path += ";$env:ProgramFiles\Git\cmd"
git clone -b claude/eloquent-hamilton-rypbw3 https://github.com/mraaziqp/savestate.git $HOME\NexussEmu
powershell -NoProfile -ExecutionPolicy Bypass -File $HOME\NexussEmu\scripts\windows\host-up.ps1
```

Run it again at any time to repair or update the setup. The files it uses:

| | |
|---|---|
| Tunnel credential | `%USERPROFILE%\.cloudflared\<tunnel-id>.json` |
| Tunnel config | `%USERPROFILE%\.nexus-data\cloudflared\config.yml` (run by tunnel ID, no Cloudflare login needed) |
| Data | `%USERPROFILE%\.nexus-data` (or `%APPDATA%\NexusEmuHost` from an older install) |
| Logs | `<data>\logs\server.log`, `tunnel.err.log`, `drive-mount.err.log`, `watchdog.log` |
| Drive mount | `%USERPROFILE%\nexus-cloud-media` |

Keep the PC signed in and plugged in; the script turns off sleep on mains power.
Hardware transcoding reports a warning on Windows (VAAPI is Linux-only).

A Linux host, or WSL2, uses `scripts/setup-host.sh` and `scripts/host-up.sh`
instead.

## Services

| Unit | Purpose |
|---|---|
| `nexus-host` | the app itself, on `:3000` |
| `cloudflared-nexus` | the tunnel — this is what carries the domain |
| `nexus-cloud-media` | rclone FUSE mount of Drive at `~/nexus-cloud-media` |
| `nexus-rclone-rcd` | rclone RC daemon, cloud-to-cloud transfers |
| `nexus-client-launcher` | local launcher companion on `:17373` |

They are systemd **user** units. Enable lingering or they stop at logout:

```bash
sudo loginctl enable-linger $USER
```

## Health

`GET /api/health/full` is the dashboard's source of truth. It reports what is
actually serving, not just what is configured:

- database, games library, ROM vault
- RetroArch and the six essential cores
- ffmpeg, and whether **hardware** transcoding is available (VAAPI is ~9x
  realtime against ~3x in software — the difference between smooth playback
  and a spinner)
- the Cloudflare tunnel process, because from outside a dead tunnel and a dead
  server look identical
- Google Drive connectivity
- HLS cache size against its cap

## Two things that will bite you

**Never run `vite build`.** The Vite sources were lost with the drive
(commit `a52fa94`); `dist/` is the committed, working build and there is no
`vite.config` or root `index.html`. A build fails with
`Cannot resolve entry module index.html` and would replace a working frontend
with a broken one. `amplify.yml` skips the build for the same reason.

**Fixes to the frontend are made in `dist/assets` directly — then rename.**
Those files are served `immutable, max-age=1y` and Cloudflare caches them, so
an edited file never reaches anyone who has visited before. After patching,
run `node scripts/rev-dist.mjs r<N>` with the next revision number: it renames
every asset and rewrites every reference, including the service worker's
precache list. The current revision is the `-rN` suffix in `dist/index.html`.

**The Windows host reads Drive through Google Drive for Desktop**, not rclone.
rclone's shared client id is so rate-limited (403 `rateLimitExceeded`) that
reads fell to 0.2–0.7 MB/s and video stalled; Drive for Desktop measured
~6 MB/s. `~\nexus-cloud-media` is a junction to `I:\My Drive\NexusArchive`;
its cache lives on `F:\SaveState\DriveFS-cache` (60 GB cap, set in
`HKCU\Software\Google\DriveFS`). `host-up.ps1` detects Drive for Desktop and
sets this up instead of an rclone mount.

On the Linux host, **Drive access used a service account**, not user OAuth. A refresh token from
an app in Google's "Testing" status expires after 7 days; a service account
never expires and needs no consent screen. It reads whatever is shared with
`savestate-drive@…iam.gserviceaccount.com`, so if the library goes empty after
a move, check that the `NexusArchive` folder is still shared with it.

## Streaming

- Files the browser can play are sent as-is (`/api/media/file`, Range
  requests). Anything else — MKV, HEVC, 10-bit — goes through adaptive HLS: a
  master playlist with 1080p/720p/480p, and hls.js picks from measured speed.
- HLS segments past the first three come from **one continuous ffmpeg per
  viewer** (an "HLS session"), not one ffmpeg per segment: per-segment builds
  paid file open + seek + encoder start every 6s and ran at about realtime.
  Sessions stop after 90s idle or 4 min ahead of the viewer, max 3 at once.
- Encoding uses NVIDIA NVENC when present (VAAPI on Linux, x264 otherwise).
  NVENC needs `-bf 0` and `-forced-idr 1`, or segments break.
- The player stays on Auto. A direct-play title that keeps stalling switches
  itself to the adaptive stream. Desktop Chrome reports native HLS support;
  the player still uses hls.js there, because the native player never steps
  down on a weak link.

## Accounts, access and plans

Sign-up is open, so what an account can reach is decided in one place,
`server/access.ts`, for every `/api` route:

- **admin**: host administration (config, scans, installers, logs, keys).
  Roles `admin`, `superadmin`, `ultra_admin`, and the PIN / Brain-key session.
- **media** / **games**: the host's own films, music, books, photos, ROMs and
  BIOS files. Per-person switches (Plans > Members). Invites, groups and
  access approvals only grant them when they come from an admin. A tier never
  grants them.
- **member**: any signed-in account. A new account can use its own files,
  Discover, the setup guide and whatever its tier includes, and sees a
  "request access" screen on the host's library.

Plans (`server/tiers.ts`, Plans tab): admins create tiers and choose which
features are paid. Nothing is paid until a feature is switched to "Paid".
There is no payment processor: a tier can carry a payment link, members ask
for an upgrade, and an admin approves it (optionally with an end date).

**PayFast** (`server/payfast.ts`): with `PAYFAST_MERCHANT_ID` and
`PAYFAST_MERCHANT_KEY` in `.env`, "Get <tier>" on the Plans page sends the
member to PayFast, and the tier switches on when PayFast's notification
(`https://savestate.co.za/api/payments/payfast/notify`) passes the signature
check, PayFast's own confirmation and the amount check. `PAYFAST_PASSPHRASE`
must equal the passphrase in PayFast > Settings > Security (if one is set
there, nothing works without it) and turns monthly/yearly tiers into
subscriptions. Prices must be in ZAR, at least R5. Plans > Payments &
requests lists payments and has a "Check PayFast connection" button.
`PAYFAST_SANDBOX=1` uses PayFast's test site.

Password resets are emailed when `RESEND_API_KEY` is set and the account has
an email; otherwise the request appears under Plans > Requests and an admin
sends the link. A reset or password change signs every other device out.

The films themselves (`/api/media/file`, `/stream`, `/hls/`, `/info` and
`/api/stream/gdrive|media/`) need a signed-in account with media access. A
`<video>` sends the session cookie; the players also add `?token=`.

**Household profiles** (`server/household.ts`, Profiles tab): an account adds
profiles for the people it shares with. Each has its own watch history and,
set by the account holder: the sections it may open, the highest age rating
(certifications from TMDB, cached in `certifications.json`; unrated titles
are hidden from capped profiles unless allowed), a daily allowance, allowed
hours, and a PIN. A parent PIN guards leaving a profile. "Share link" puts
one profile on another device without the password; such a session can only
sign out, and a new link, "Revoke" or "Sign out everywhere" ends it. A profile
session is a token with `profileId`: access.ts makes it a non-admin caller and
`household.gate` refuses anything outside its sections, over its rating or out
of time. Tiers can cap profiles per account ("Household profiles" on a tier).

`.env` switches: `NEXUS_SIGNUP=closed` stops new sign-ups.
`NEXUS_MUSIC_ROOTS` adds music folders (default: uploads, `~/Music`,
`<files root>/Music`, `<media root>/music`, `Music` at the top of D:-H:).

Check it all: `node scripts/test-accounts-plans.mjs` (creates and removes two
test accounts), `node scripts/audit-routes.cjs` (every GET route, as an admin).

## Game mode

When a game runs on the host PC the server steps aside (`server/game-mode.ts`):
below-normal priority for itself and its ffmpeg processes, no library scans,
artwork fetches or compression, and qBittorrent on its alternative speed
limits. Streams to other people keep running. It ends ~25 s after the game
closes. Recognised: emulators, anything under a Steam / Epic / GOG / Xbox /
`Games` folder or a PC-games library folder, exclusive full-screen apps, and
programs an admin has marked under Plans > Host PC. `NEXUS_GAME_MODE=off`
disables it; `NEXUS_GAME_EXES` / `NEXUS_GAME_DIRS` add names and folders.

The watchdog starts the server and tunnel at normal priority (a scheduled
task would otherwise run them below normal), and restarts Google Drive when
the library path has been missing for 30 seconds.

## Changing the frontend

Only the compiled bundle in `dist/` survives (see `.gitignore`). New screens
are written as source under `web-src/` and wired into the bundle:

```bash
node web-src/watch/build.mjs     # Discover, What to Watch
node web-src/app/build.mjs       # sign-in, welcome, Plans, setup guide, tab gate
node scripts/rev-dist.mjs r<N>   # always: new file names, or browsers keep the old ones
```

Then rebuild the server (`host-up.ps1` does, or the esbuild line in it) and
restart it.

## Cloud Drives (Google Drive accounts, upload & verify)

The Cloud Drives tab (admins) is `server/drives.ts` on top of rclone, which
holds a sign-in per Google account (`rclone config` remotes; `gdrive` =
backupe9@gmail.com, 5 TB, is also Drive for Desktop's `I:`; `groms` =
mraaziqp@gmail.com, 15 GB). Two panes show any account or local disk:
browse, new folder, rename, delete (to Drive's trash), download, upload,
copy/move between accounts.

"Upload & verify" moves a folder from this PC to Drive: `rclone copy`
(resumes after pause, restart or reboot; state in `offload-jobs.json` in the
data folder), then `rclone check` compares every file's size and MD5 with
Drive. Only then does the page offer to delete the local copies, and only
files that check confirmed and that have not changed since are deleted (they
skip the Recycle Bin; the Drive copies stay). Movies, TV, music and ROMs put
under `NexusArchive/` appear in SaveState through `I:`.

Uploads share the internet uplink with the site and streams, and a full
uplink makes everything slow, so they are capped: `NEXUS_UPLOAD_BWLIMIT`
(default 650k) by day, full speed during `NEXUS_UPLOAD_FULL_HOURS` (default
1-7), `NEXUS_UPLOAD_BWLIMIT_GAMING` (64k) while game mode is on. One upload
runs at a time.

Failed uploads retry after 5 min, 15 min, 1 h and 6 h; an upload that moves
no bytes for 30 min is restarted. "Keep synced" (on by default for ROMs)
re-copies the folder daily, so new ROMs reach Drive without anyone asking.
A job refuses relative paths, the app and data folders, the home folder,
Windows and Program Files.

**Connecting drives from the app** (`server/connect.ts`). Google sign-in
needs an OAuth client once: Cloud Drives → "Connect a drive" walks an admin
through creating it in Google Cloud and pasting the ID and secret (stored
encrypted in `cloud-connect.json`, or set `GOOGLE_OAUTH_CLIENT_ID` /
`GOOGLE_OAUTH_CLIENT_SECRET`). After that, "Connect Google Drive" is a
button: in Cloud Drives it adds a host drive, in My Drives it adds the
member's own drive (rclone remote `u_<userId>_<n>`, visible only to them).
WebDAV drives (Nextcloud, pCloud, Koofr...) connect with a URL and password.
The redirect URI to register in Google is `https://<domain>/api/drives/oauth/callback`.
Cloud Drives flags remotes still on rclone's shared client ID (retired
during 2026); reconnect them once your own client is set up.

## Downloader (Sonarr, Radarr, Prowlarr, qBittorrent)

The server pushes a release policy into the Arr apps on start
(`ARR_POLICY_VERSION`): every indexer and the Prowlarr app profile require
`NEXUS_MIN_SEEDERS` (default 5) seeders, so dead releases are never grabbed.
The stuck-download watchdog removes and blocklists torrents that stall, and
also ones that crawl (under 90% after 6 h with an ETA over 3 days or below
20 kB/s), and Sonarr/Radarr search for another release. Search results
are cached for 10 minutes.

Downloads > Downloader setup (admins, `server/downloader.ts`) asks each app
how it is doing and says what to fix in plain words: sites failing in
Prowlarr, no download client, no indexers, a full or missing library folder,
a firewalled qBittorrent, stuck queue items. "Find on this PC" reads Sonarr
and Radarr's address and API key from `C:\ProgramData\<App>\config.xml`.
"Add more sites" adds recommended public sites to Prowlarr (Knaben, The
Pirate Bay, LimeTorrents, Uindex, kickasstorrents.to...); Prowlarr tests each
one first, and they are sent on to Sonarr and Radarr. There is a beginner's
guide with the official download links.

**Deep search** (same module): every 6 hours, and from "Deep search now",
missing seasons and films are searched in Prowlarr under several wordings
("Show (2009) Season 4", "Film (2019)") and well-seeded matches are pushed to
Sonarr/Radarr (`/api/v3/release/push`), which still apply their own quality
rules. At most `NEXUS_DEEP_MAX_PER_RUN` (3) grabs a run; shows with more than
`NEXUS_DEEP_MAX_MISSING` (150) missing episodes are skipped; 50 GB is always
left free. When downloads "sit", first compare qBittorrent's newest torrent
with Sonarr's log: in October 2026 Sonarr had lost its program files and
could not hand anything to qBittorrent (the health card now says so).

## Media uploads

Movies & TV > Upload (`server/upload-batches.ts`, `web-src/app/MediaUpload.jsx`):
a folder is described to the server first, which plans every file's place
as a whole (episodes without a show name take it from their folders or
siblings, spelling variants merge, Specials are season 0, subtitles and
posters follow their video, samples are skipped). The plan and each file's
state live in `upload-batches/` in the data folder, so an interrupted upload
continues from any device; Chrome remembers the folder, elsewhere the folder
is picked again and finished files are skipped. Chunks are kept in
`tmp/uploads/` and cleared after 14 days untouched.

## Service keys

Plans > Service keys (`server/service-keys.ts`): Resend, PayFast passphrase,
Gemini and TMDB keys, entered in the app, stored encrypted in
`service-keys.json`, tested against the service. A saved key wins over `.env`.

## App builds

Android: `scripts/windows/build-apk.ps1` (version from package.json, so
1.0.60 is versionCode 1000060). The desktop installer (Tauri) was built from
`I:\NexussEmu`, which is no longer on the Drive; `releases/updates` keeps the
last installer (1.0.41) until its source is found.

## Box art

Art comes from libretro's thumbnail index: exact name first, then the
closest title by shared words (disc numbers must agree). Until real art is
found, `/api/art/<id>` serves a cover drawn from the title and the console's
colours, so no shelf shows a blank tile. A background job keeps filling.

## App downloads

- **Android**: `powershell -ExecutionPolicy Bypass -File scripts\windows\build-apk.ps1`
  builds, signs and publishes `releases\updates\SaveState-<version>.apk`
  (served by `/api/downloads/apk`). The app is a thin client of the live site,
  so it only needs rebuilding when the Android shell changes. Signing key:
  `NEXUS_APK_KEYSTORE` (in the host data folder) and its password in `.env`.
  **Back the keystore up**: Android refuses an update signed with another key.
- **Windows**: with no packaged desktop build in `releases\updates`, the
  download hands out the one-click client installer
  (`/api/client-launcher/windows-installer`).

## Failover

The site runs **only from the home host**. Nothing is served from AWS.

**The failover Worker is no longer on the domain** (routes removed
2026-10-01). Workers on the free plan allow 100,000 requests a day, and with
the Worker on every route each video segment, Range read and thumbnail
counted: the limit ran out and Cloudflare blocked the whole domain with
error 1027 on every network. Do not put it back on `savestate.co.za/*` unless
the account has a paid Workers plan, or the routes are narrowed to page loads.

The description below is kept for reference. A Cloudflare Worker (`cloudflare-worker/`) sat on the domain's routes. Normal
traffic passes straight through to this host, streaming and Range requests
intact. When this host is down it answers with a built-in offline page instead
of Cloudflare's raw 1033/502 error, and `/api/*` gets a clean JSON 503.

"Down" means the request never reached the app: Cloudflare's 52x/530, a
failed fetch, or a 502/503/504 **without** the `X-SaveState-Origin` header
that the app stamps on every response. The app's own 503s ("Database
unavailable") pass through unchanged.

Deploying it again re-adds the routes (see the warning above):

```bash
cd cloudflare-worker && npx wrangler deploy
```

The Worker can also fall back to a second copy of the app (`STANDBY_ORIGIN`)
or a static frontend (`FALLBACK_ORIGIN`). Both are deliberately unset. The AWS
files (`aws-infrastructure.yaml`, `deploy-aws*.sh`, `amplify.yml`) are unused.

Test the Worker without deploying: `node scripts/test-failover-worker.mjs`.
