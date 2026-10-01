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
