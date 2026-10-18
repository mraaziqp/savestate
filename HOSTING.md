# Hosting savestate.co.za

How this app is served, and how to move it to another machine.

## Handover (October 2026)

Where things stand, for whoever picks this up next.

**Day to day.** Everything runs from this PC: the server (`dist/server.mjs`,
restarted by the scheduled task "SaveState Host" / `scripts/windows/run-host.ps1`),
the Cloudflare tunnel, Google Drive for Desktop (`I:`), rclone, and the
downloader apps (qBittorrent :8100, Prowlarr :9696, Sonarr :8989,
Radarr :7878). Plans > Setup checklist shows what is configured;
System & Tools > Activity log shows what is running and a receipt for
everything that finished; Downloads > Downloader setup says why downloads
stall; Host Health runs the self-checks.

**Changing code.** Server: edit `server.ts` / `server/*.ts`, then
`node_modules/.bin/esbuild server.ts --bundle --platform=node --target=node22 --format=esm --packages=external --outfile=dist/server.mjs`
and kill the node process on :3000 (the watchdog restarts it). Frontend:
edit `web-src/app` (or `web-src/watch` for Discover / What to Watch), run
`node web-src/app/build.mjs` (and `node web-src/watch/build.mjs`), then
`node scripts/rev-dist.mjs rN` with the next revision number so browsers
fetch the new files. The compiled chunks are patched by `build.mjs`; each
patch says why. Checks: `node scripts/test-accounts-plans.mjs`,
`AUDIT_ADMIN_ID=<an admin's id> node scripts/audit-routes.cjs`.

**Modules added in this round** (each file starts with what it does):
`server/access.ts` (who may call what), `tiers.ts` (plans), `payfast.ts`,
`household.ts` (profiles), `drives.ts` + `connect.ts` (Drive accounts,
upload & verify, free space), `upload-batches.ts` (media folder uploads),
`downloader.ts` (setup, health, deep search), `service-keys.ts`,
`receipts.ts` (activity log), `game-mode.ts`.

**Decisions.** `mraaziqp` is the master (ultra) admin. The host's own media,
games and BIOS files are shared only by an admin's per-person grant, never
by a paid tier. Local files are deleted only after their copy on Drive
matches by checksum, and only when the owner asks (or switched on
"free automatically" for that folder).

**Open items.** Prices for the tiers (Plans > Tiers). Resend: the
`rsend` CNAME in Cloudflare must be "DNS only" (grey cloud); the other
records are in. The old Tauri desktop app cannot be rebuilt (its source,
`I:\NexussEmu\src-tauri`, is gone); Windows now gets `SaveState-Setup`
(see App downloads). The Neo Geo BIOS is the MAME 0.251 `neogeo.zip`
(2026-10-17) in the BIOS folder, RetroArch `system` and beside the Neo Geo
games; the old set is kept as `neogeo.old-set.zip`. BIOS archives are hidden
from the games list (isPlayableEntry). RPCS3 is at `E:\RPCS3` with Sony firmware 4.93
installed (the installer file is in `%APPDATA%\NexusEmuHost\firmware`).
Ryujinx 1.1.1403 is at `E:\Ryujinx` (portable; from the user's download, a
SourceForge mirror, Defender-scanned 2026-10-17); desktop clients get it
through the emulator export. Switch games still need the user's own
`prod.keys` in `E:\Ryujinx\portable\system` and firmware (Tools > Install
Firmware). Sunshine is
installed and lists SaveState (added 2026-10-17 with
`scripts\windows\Add SaveState to Sunshine.cmd`, which needs admin; rerun it
after reinstalling Sunshine). Back up `.env` and the Android signing key
(`%APPDATA%\NexusEmuHost\android-release.keystore`) somewhere off this PC:
without the key, installed Android apps can never be updated.

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

## Games: how a member plays

On a member's device the game page's "How do you want to play?" puts first
what works there: the desktop launcher if it answers on 127.0.0.1:17373
(Chrome/Edge ask once to allow local access), otherwise "Play in this
browser" for systems a browser can run (GBA, NES, SNES, Neo Geo with its
BIOS, ...), otherwise "Stream from the host PC". Big Picture (menu: Play
Offline) follows the same rule: it downloads the game to the device and plays
it there, and for PS2/GameCube without the launcher it says to install the
app instead of downloading a disc image the browser can't run. Only a
browser on the host's own address launches games on this PC.

Launch check (`/api/games/launch/check/:id`): PS2 looks for its BIOS beside
standalone PCSX2 (`E:\PCSX2\bios`), in `Documents\PCSX2\bios` and in
RetroArch's folder; GameCube/Wii use standalone Dolphin, or RetroArch's
Dolphin core when that is all there is. 300 of 303 games pass.

### Playing anything from anywhere (Sunshine + Moonlight)

The site's own stream (`/api/stream/*`, ffmpeg JPEG frames, input through a
PowerShell call per key) is too slow for games. "Stream from the host PC"
starts the game on the host, and the player sees and controls it through
Sunshine (on this PC) and the Moonlight app (phone, tablet, TV, Vita).
`scripts\windows\add-sunshine-app.ps1` adds a **SaveState** entry to
Sunshine that opens `/?tab=consoles&host=1&bp=1`: Big Picture, in host mode
(games start on this PC directly), straight away. Pair a device by entering
its PIN at `https://localhost:47990`. Outside the home: Tailscale on both
ends, or forward TCP 47984/47989/47990/48010 and UDP 47998-48000/48010.

## Mini Games (agent builder games)

Games > Mini Games (`web-src/app/MiniGames.jsx`, `server/minigames.ts`).
Admins add a game as one `.html` file or a `.zip` with `index.html` (drag it
onto the page), then edit the title and description, add a cover, replace the
files or remove it. Every signed-in member can play. Files live in
`<persist>/minigames/<id>/site`, the list in `minigames/games.json`.

The agent builder publishes without a sign-in, using a publish key made on the
same page (stored hashed; it can only add games):

```bash
curl -X POST "https://savestate.co.za/api/minigames/publish?title=Snake&description=..." \
  -H "X-SaveState-Publish-Key: ssk_..." -H "X-Filename: snake.html" \
  -H "Content-Type: application/octet-stream" --data-binary @snake.html
```

Safety: a game is someone else's JavaScript on our domain, so `/mg/<id>/...`
is served with a CSP `sandbox` (no same-origin) and played in an equally
sandboxed iframe. It cannot read the sign-in token, cookies or call the API
as the player. In that sandbox localStorage throws, so each page gets a
small stand-in (saves are kept per game on the device by the player page),
and `no-transform` stops Cloudflare injecting its analytics script. The
`~<version>` part of a game's address changes when its files are replaced,
so cached copies of the old scripts are never mixed in. Game addresses are
random and need no token (a sandboxed page can't send one).

### The Agent Builder link

`E:\Projects\Agent-Builder` (or `NEXUS_AGENT_BUILDER_DIR`) is scanned every
10 minutes: `games/<name>/index.html` and `builds/<name>_<time>/dist` whose
name or brief says "game", with `data/builds.json` saying which passed.
Finished and passing games go on the shelf by themselves (a rebuild updates
the same entry, plays and cover kept); an admin's removal is remembered in
`minigames/agent-builder-removed.json`. Other attempts are listed on the
Mini Games page with **Add**. Jarvis orders games through the Agent Builder,
so they arrive the same way. The Agent Builder's own API (port 4000,
`agent.savestate.co.za`) was not running at the time.

## Activity log: Completed

`/api/activity/completed` collects finished work: Drive copies report
themselves (`addCompletedSource` in `server/drives.ts`: files checked and
matched, missing or different, active time, freed space, and the
file-by-file report at `/api/admin/offload/<job>/report`); other finished
work comes from receipts. An item can carry `actions` (buttons that POST
with `{ confirm: id }`): a copy whose every file matched on Drive and whose
folder is still on this PC offers **Delete the local folder** (asks first;
only files checked and unchanged since are deleted, so anything still
downloading or skipped as a duplicate stays) and **Check against Drive
again**. Time left on uploads is worked out from the last
five minutes of progress and withheld while rclone is still counting.

## Upload speed

`desiredRate()` in `server/drives.ts`: gaming on the host 64k; 01:00-07:00
or nobody on the site: no limit; someone browsing: 70% of the line;
someone streaming: 40% (never under 650k). The line's speed is learned from
uncapped runs and kept in `%APPDATA%\NexusEmuHost\upload-capacity.json`
(about 24 MB/s here). ROM and music folders copy 8 files at a time.
`run-host.ps1` starts the server with `UV_THREADPOOL_SIZE=16`: with Node's
default 4, slow first reads from the Drive folder made the page itself take
up to 5 s to serve. It is read at start-up, so changing it means reloading
the host task (see Moving to another machine > Windows hosts).

## Adding games (Add games page)

`web-src/app/AddGames.jsx` + `/api/games/intake/*` in server.ts (admins
only, as is the old `/api/games/upload-rom`). `classify` runs the library's
own `inferPlatformFromRecord` on each file name and path (a bare `.iso` over
1.4 GB is guessed PS2; bare `.zip`/`.iso` otherwise need a choice) and marks
files already in the library (same name and size). Parts are written at
their offsets into `<persist>/tmp/rom-intake` and moved into
`<library>/<SYSTEM>/` only when every byte is there (never a half file in
the Drive folder), then `addRomToLibrary` adds the row, puts the file in the
name index (playable at once) and fetches art. The folder watcher may add
the same file first, with an AI-cleaned title; both use the same id.

## Browser uploads (Drive panes, Add games, uploader.js)

One engine (`web-src/app/uploader.js`): 8 MB parts, six in flight, three
files at once, retries with back-off, overall progress with speed and time
left. Drive panes upload files, whole folders (keeping sub-folders) or a
drop. Until 2026-10-17 the parts went without the sign-in and every upload
failed. The move onto Drive uses rclone with 64M chunks; files over 100 MB
finish in the background (Activity log). While someone's own upload is
going onto Drive, background folder copies drop to 30% of the line, and a
game being downloaded to play counts as a stream (copies at 40%).

## Help & guides

`web-src/app/Guides.jsx` is the in-app manual (Help & guides in the menu,
`/?tab=help&guide=<id>`). Members see the everyday guides; admins also see
host setup. Keep it in step when a screen changes.

## Plans: screens at once and games (server/planlimits.ts)

- **Screens.** A tier's `maxStreams` is how many devices of one account (with
  its household profiles) may play films and shows at once. `introStreams` for
  the first `introDays` after sign-up is the welcome allowance (Free: 2 screens
  for 90 days, then 1). A device is address + browser; one that keeps watching
  or changes title keeps its place, and a place frees itself 2 minutes after
  the last video request. Music, pictures and subtitles never count. Over the
  limit the video request gets `409 stream_limit`; boot.js spots it (fetch,
  hls.js XHR or a failed `<video>`) and the app shows "All your screens are in
  use" (ScreensInUse.jsx) with a Stop button per device
  (`POST /api/plans/streams/stop`). `GET /api/plans/streams` lists them.
- **Games.** Feature `games.full` ("Every console, on any screen"): when gated,
  other plans can't download PS2, GameCube/Wii, PS3, Switch, PSP, 3DS, Vita or
  Xbox games (`402`), launch on the host PC or start a host stream. The retro
  systems keep playing in the browser. Big Picture and game details say so
  before anything downloads.
- Admins and their household profiles are never limited, and plans never
  grant the host's library (still per-person grants).
- Set up on 2026-10-17: Free (1 screen, 2 for the first 90 days, 2 profiles,
  retro games), **Plus** (id `pro`, 3 screens, every console, 4 profiles) and
  **Family** (5 screens, every console, 8 profiles) are drafts until they
  have prices; Unlimited stays private for the household. `games.full` is
  gated to Plus, Family and Unlimited.

## Manage Users (server/adminpeople.ts, AdminUsers.jsx)

Admin > Manage Users (`?tab=users`) lists every account and every group,
whoever created it. Per person: plan and end date, host library (films,
games, uploads), display name and email, role (owner only), groups, a
one-hour password link, sign out everywhere, suspend (refused at sign-in and
on every request; ends sessions) and remove (type the username). The owner
account and your own can't be changed there. Groups: create, rename, colour,
what they open, members. API: `GET /api/admin/people`, `PATCH/DELETE
/api/admin/people/:id`, `POST .../sign-out`, `POST .../reset-link`,
`/api/admin/groups` (+ `/:id`, `/:id/members`). Plan and access changes
go through `PUT /api/admin/plans/users/:id` (receipts). `users.suspended_at`
is read with `to_jsonb(users)` so sign-in keeps working before the column exists.

## Set up games (GameSetup.jsx, launcher v7)

One guided path for members and admins, opened from Emulation Setup, the
note on Games / Play Offline, Get started and Help & guides (event
`nexus:game-setup`, or `?gamesetup`): pick consoles (browser ones need
nothing; heavy ones show "Paid plan" without `games.full`) → on Windows, ask
for SaveState for Windows until the launcher answers on 127.0.0.1:17373
(v7 or newer), then `POST /setup-consoles` sets up every chosen console in
one go (RetroArch + cores; PCSX2, RPCS3, Cemu from their releases; the
host's own Dolphin/Switch emulator where there is no public download) →
system files: `/bios-check` and `/bios-add` put the person's own BIOS where
each console looks (RetroArch `system`, PCSX2 `bios`, Ryujinx
`portable/system`) and compare MD5s → games: the host's library, or a folder
on the PC (`/add-rom-folder` opens Windows' folder picker). The launcher has
no self-update: an installed one updates by running the installer again
(the wizard says so when it finds an older version).

Launcher v8 (2026-10-17): the installed launcher is one file, so it no
longer needs `adm-zip`/`7zip-bin` (v7 failed every core download with
"Cannot find module 'adm-zip'"): zips open with Windows' `tar.exe`, 7z with
7-Zip's `7zr.exe` 24.09 from its GitHub release, pinned by SHA-256. Setup
copies from the host first (RetroArch without cores/system/saves, PCSX2,
RPCS3 without firmware, Ryujinx without keys; `/api/emulator/export/standalone?name=`
and `/export/cores?only=`), then the official download, each tried twice.
Emulators at the top of a drive (E:\RPCS3, E:\Ryujinx) are found, and the
PCSX2 that has a BIOS wins. A fresh simulated PC set up 14 consoles in 60 s.

**The host never hands out system files any more:** the export manifest's
BIOS part is empty, `/api/emulator/export/bios` answers 410, and emulator
exports skip `bios`, `portable`, `bis`, `nand`, `keys`, `firmware`, `user`
folders and `.keys`/`.pup` files.

## After Play (PlayOverlay.jsx, launcher v9)

Play on a card, in game details or Play Offline shows SaveState's own panel:
the cover with the real steps ("Getting the game ready" with the launcher's
copy progress, "Starting PCSX2", "Playing"), Stop game, and "closed" when
the game ends; a failure says why with Try again (and Set up games when the
launcher is missing). Driven by `nexus:play` events that build.mjs adds to
the shared native launch (`gc`) and to Play Offline's copy step. Native
emulators can't be drawn inside a web page, so they open full screen over
SaveState (`-f` RetroArch, `-batch -fullscreen -nogui` PCSX2, `--fullscreen`
Ryujinx) and the panel follows them (`/launch/status`, `/launch/stop`).
Browser-capable consoles play inside the app itself (EmulatorJS).

## Games still downloading (server/incomplete.ts)

A torrent creates each file at full size and fills it in (a sparse file); a
half-full PS2 disc crashed PCSX2 ("Jump to unaligned address"). Every 3
minutes PowerShell lists sparse files under the ROM folders whose real size
on disk is short of their size. Those games are left out of the lists, both
download routes answer 409 `still_downloading`, Drive copies skip them, the
launcher refuses them, and Activity shows "Games still downloading: N". On
2026-10-17 the PS2 essentials pack (BitTorrent, not qBittorrent) had 140 of
154 files unfinished.

## Films ready for every device (server/videoprep.ts)

Browsers play MP4 (H.264 + AAC/MP3) and WebM; the rest of the library
(HEVC and 10-bit rips, MKV/AVI, AC-3/DTS/TrueHD sound, HDR) needed live
conversion, which the NAS can't do. This PC (the converter: Windows, not
`NEXUS_LOW_MEMORY`, an rclone account named `gdrive`; override with
`NEXUS_VIDEO_PREP=0/1`, `NEXUS_VIDEO_PREP_REMOTE`, `NEXUS_VIDEO_PREP_FOLDER`)
checks every film once and prepares those that need it:

- **direct**: plays as it is, nothing to do (AAC 5.1 in MP4 included).
- **remux**: H.264 already; the picture is copied, the sound becomes AAC
  stereo unless an English AAC/MP3 stereo track exists (then it is copied).
- **convert**: H.264 on the GPU (h264_nvenc, CQ 23, at most 1080p, HDR
  tone-mapped to SDR with zscale/hable).

Each film comes down from Drive with rclone to
`<data>/tmp/video-prep` (`NEXUS_VIDEO_PREP_TMP`; not through Drive for
Desktop, whose cache disk is small), is converted, checked (H.264, full
length), and goes up next to the original as
`<folder>/.nxweb/<name>.mp4` (size checked on Drive). Originals are never
touched. State is the `video_prep` table, shared by every host; requested
films (someone pressed Play on the NAS) go first, then quick repacks, then
smallest first. It stops while a game runs, when paused (Activity, or
`POST /api/admin/video-prep/pause|resume|retry|rescan`), and with under
200 GB free on Drive. About 16 minutes for a 45-minute HEVC episode,
most of it moving the file.

Every host then plays the copy: the library marks the film `webReady`,
the player opens it directly (`/api/media/file` serves the copy for the
original's path), and info, streaming and HLS use it as their source. The
player now sends any file that isn't MP4/WebM through the server (only
eight extensions did). On the NAS (`NEXUS_LOW_MEMORY`) a film without a
copy, or a quality change, goes to the PC (`NEXUS_TRANSCODE_HELPER`,
which converts it live on the GPU) and is put first in line; with the PC
off it answers 503 "preparing" and the player shows that message. Scanners
skip `.nxweb` folders.

## Play on this phone (PhonePlay.jsx, Android app 1.0.67)

PSP, PS2, GameCube, Wii, 3DS, Dreamcast and Saturn have Android emulator
apps (`PHONE_APPS` in `web-src/app/devices.js`). On an Android phone,
game details > Play on this phone opens PhonePlay: in the SaveState app
(`NxAndroidPlugin.java`, called as `Capacitor.nativePromise("NxAndroid", ...)`)
the game downloads with Android's download manager to
`Downloads/SaveState/<console>/` and opens in the emulator (PPSSPP by
ACTION_VIEW, NetherSX2 with `bootPath`, Dolphin with `AutoStartFiles`); a
second Play opens the copy already there. In a phone's browser it downloads
the browser's way and says where to open it. The owner can copy the host's
PS2 BIOS to the phone. MainActivity also gives the WebView a download
listener, so plain download links in the app save to Downloads/SaveState
(they went nowhere before).

CapacitorHttp is off (`capacitor.config.ts`): it routed the page's fetches
through Android's networking and garbled game files (a GBA game "loaded but
isn't running"). Browser play now always names the game (`EJS_gameName`),
so FinalBurn Neo recognises arcade sets fetched by URL ("Romset is unknown"
for kof98 before).

## Where it plays (Where.jsx, devices.js)

The Games hub and grid are wrapped in a filter (`NxWhere`, build.mjs 3n):
This phone / This PC, All, In the browser, On phones, Needs a PC, with
counts. Phones start on This phone, so a PS2 game only shows where it can
run. `window.nxRuns` (set in boot.js) answers the same question for the
compiled code. Set up games marks each console "Any device", "PC" and
"Android: <app>", has "Everything this phone plays", lists the Android apps
with install links, and in the system files step shows the files the host
already has; the owner's PCs get them copied from the host by themselves,
and the owner can add files to the host from a phone ("Add to host").

## SaveState for Linux (scripts/client-install-linux.sh, launcher v10)

`curl -fsSL https://savestate.co.za/api/client-launcher/linux-installer | sh`
(also /api/downloads/desktop?platform=linux and the download page). No
sudo: Node.js 18+ (or the official nodejs.org build, SHA-256 checked) and
the launcher go in `~/.local/share/NexusEmuClient`, `run.sh` keeps it
running, a desktop autostart entry starts it at sign-in, and "SaveState"
appears in the applications menu (Chromium app window, else the browser).
`uninstall.sh` removes it. Launcher v10 on Linux installs standalone
emulators from Flathub (`flatpak install --user`), RetroArch and cores as
before, picks folders with zenity or kdialog, never copies the host's
Windows emulators, and reports `platform` in /health. Tested in WSL Ubuntu
22.04 (install, run, health, uninstall, the Node download).

## QNAP NAS host (deploy/qnap)

The TS-431 (192.168.31.201, ARMv7, 480 MB RAM) runs the app natively, not
in Docker: Entware Node 18 (no ICU), the Node 18 bundle
(`esbuild ... --target=node18`), `NEXUS_LOW_MEMORY=1`, Google Drive
mounted with rclone at `SaveState/library`, ROM and music copies under
`Multimedia`. `savestate.sh start|stop|restart|status` supervises the
server and, only while `SaveState/tunnel.on` exists, cloudflared.
`/opt/etc/init.d/S99savestate` starts it at boot.

Moving savestate.co.za to it (not done yet; it needs the owner): every
connector of tunnel d7c61183 must send the site to the same server, because
Cloudflare spreads visitors over all of them. That means this PC's tunnel
off (`tunnel.off` in the host data folder, which run-host.ps1 checks every
loop), Agent Builder's own connector (`~/.cloudflared/config.yml`, started
by its launcher) pointing savestate.co.za and www at
`http://192.168.31.201:3000`, then `touch tunnel.on` on the NAS. The NAS
reaches Agent Builder on 192.168.31.217:4000 and Jarvis through
`scripts/windows/lan-forward.cjs` (3006 -> 127.0.0.1:3005, home network
only; `lanForward` in the host config). This PC keeps its server for the
Drive uploads and the Arr apps. Back: `rm tunnel.on` on the NAS, delete
`tunnel.off`, restore the Agent Builder config.

## NAS / Linux hosts (install.sh)

`curl -fsSL https://savestate.co.za/install.sh | bash` (served from
`scripts/install.sh`) needs Docker. It downloads the repo to
`~/savestate` (or `SAVESTATE_DIR`), asks for the films, music and games
folders (mounted read-only) and the port, writes `deploy/nas/.env` with
generated passwords, and runs `deploy/nas/docker-compose.yml` (the app from
the Dockerfile plus its own Postgres, `NEXUS_DB_SSL=0`). The first account
made on a brand-new host becomes its owner (`ultra_admin`). Re-running it
updates and keeps the settings. Not tested end to end on a NAS yet (no
Docker on this PC).

## Local cache (server/hotcache.ts)

The library is on Google Drive, so a first play fetches from Google (7 s for
the first MB of an episode, measured). The hot cache keeps a copy on a fast
local disk of each film or episode someone starts (after its first 45 s, so
it never competes with the start of playback), the next episode in the same
folder, each game downloaded to play, and each game added through Add games.
Reads use the copy when its size and modified time still match the original
(a seek into a cached episode: 0.22 s). LRU eviction at the size limit, never
one file over a third of it, always 10 GB free on its disk. Settings in
`hot-cache.json` (persist dir): on this host `H:\SaveStateCache`, 30 GB
(H: is an SSD). Admin panel: Cloud Drives > Local cache; API
`/api/admin/hot-cache` (GET, PUT `{dir,maxGb,enabled}`, POST `/clear`).
Files on a local disk (or a NAS's own disks) are never copied.

## Changing the frontend

`build.mjs` ends by parsing every chunk; a patch that breaks one stops the
build instead of the site. Only the compiled bundle in `dist/` survives (see `.gitignore`). New screens
are written as source under `web-src/` and wired into the bundle:

```bash
node web-src/watch/build.mjs     # Discover, What to Watch
node web-src/app/build.mjs       # sign-in, welcome, Plans, setup guide, tab gate
node scripts/rev-dist.mjs r<N>   # always: new file names, or browsers keep the old ones
```

Then rebuild the server (`host-up.ps1` does, or the esbuild line in it) and
restart it.

## Cloud Drives (Google Drive accounts, upload & verify)

**Interrupted copies carry on, duplicates are skipped.** Jobs are saved in
`offload-jobs.json`; a restart (or a server restart) queues them again and
rclone skips every file already at the destination, so only the files that
were mid-transfer start over. Progress keeps what earlier runs sent
(`carriedBytes`). Before each copy the whole archive on that Drive is listed
once (cached 30 min) and any local file of 5 MB or more with the same name and
size as a file elsewhere in the archive is left out of the copy and of the
check (`offload-reports/<job>.dupes.txt`); those are never deleted from the
PC. Seen 2026-10-17: F:\movies had 136 files (69 GB) already on Drive under
`media/TV Shows`. Each server restart still costs the files mid-transfer, so
batch server changes while a big copy runs.

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
runs at a time. The daytime cap only applies while someone is using the
site: a browser (or the apps) opening SaveState or streaming. With nobody
there for 3 minutes uploads run at `NEXUS_UPLOAD_BWLIMIT_IDLE` (default off,
measured 7-24 MB/s) and drop back the moment someone arrives. Health probes
(non-browser user agents) don't count. `GET /api/admin/site-activity` shows
what last counted.

Cloud Drives > Free up space on this PC: every disk's free space, "Free X GB
now" for folders already confirmed on Drive, and the video folders on the
host's disks that aren't on Drive (found in the background every 6 hours,
biggest first). Folders of release-named films and shows go to
`NexusArchive/From this PC/...` and appear in Movies & TV; phone clips,
recordings and other personal video go to `Personal/From this PC/...`,
which SaveState never shows to members. "Upload & free" turns on a job's
auto-free: each file is deleted from the PC once its copy on Drive matches.

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

## Activity log and receipts

System & Tools > Activity log (`server/receipts.ts`, `ActivityLog.jsx`):
admins see what is running now with progress bars (Drive uploads, torrents,
media uploads, deep search; each module registers an `addLiveSource`) and
every receipt; members see their own receipts. A receipt is written with
`receipt({ kind, title, detail, ... })` from anywhere once `initReceipts` has
run (table `activity_receipts`): uploads confirmed on Drive, space freed,
media folders uploaded, Sonarr/Radarr downloads (webhook), deep-search
grabs, payments, plan/access changes, profiles, service keys. Receipts can
be filtered, searched, exported as CSV and printed one by one.

## Service keys

Plans > Service keys (`server/service-keys.ts`): Resend, PayFast passphrase,
Gemini and TMDB keys, entered in the app, stored encrypted in
`service-keys.json`, tested against the service. A saved key wins over `.env`.

## App builds

Android: `scripts/windows/build-apk.ps1` (version from package.json, so
1.0.64 is versionCode 1000064). Windows: `SaveState-Setup-<version>.exe` is
the one-click installer (`/api/client-launcher/windows-installer`) wrapped
by IExpress (built into Windows); see App downloads.

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
- **Windows**: `releases\updates\SaveState-Setup-<version>.exe` (the newest
  `.exe` there is what `/api/downloads/desktop` serves). It runs the one-click
  installer: the PC's own Node.js, or a private copy in
  `%LOCALAPPDATA%\NexusEmuClient\node` from nodejs.org (winget only if that is
  blocked); the game launcher (`client-launcher.cjs`); the runner
  (`/api/client-launcher/runner.vbs`, started at sign-in and by `nexusemu://`)
  which keeps the launcher running and restarts it within ~10 s if it stops
  (one runner at a time; a second launcher on the port exits); and a
  SaveState shortcut on the Desktop and Start menu (Edge app window).
  Re-running it replaces a running launcher with the new one. To rebuild: save
  `https://savestate.co.za/api/client-launcher/windows-installer` (through the
  public site: fetched from localhost it points PCs at localhost) as `SaveState-Setup.cmd` in an
  empty folder and run `iexpress /N /Q savestate.sed` with an SED whose
  `AppLaunched` is `cmd.exe /c SaveState-Setup.cmd`. PCs that already have the
  launcher get a new one by running the installer again (the launcher does
  not update itself).

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
