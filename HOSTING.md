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

### Windows hosts: run the stack in WSL2

`setup-host.sh`, the systemd units and the rclone FUSE mount are Linux-only,
and the PowerShell `host:*` scripts named in `package.json` no longer exist.
On a Windows PC, run the host inside WSL2 (Ubuntu), where the steps above
work unchanged.

```powershell
# PowerShell as Administrator, then reboot
wsl --install -d Ubuntu-24.04
```

Inside Ubuntu:

```bash
# systemd must be on (recent WSL images have it already)
grep -q 'systemd=true' /etc/wsl.conf || printf '[boot]\nsystemd=true\n' | sudo tee -a /etc/wsl.conf
# then run `wsl --shutdown` in PowerShell and reopen Ubuntu

git clone git@github.com:mraaziqp/savestate.git ~/NexussEmu   # in ~, not /mnt/c
cd ~/NexussEmu
bash scripts/setup-host.sh
cp /mnt/d/savestate-host-bundle-*.tar.gz.gpg ~/       # D: is the USB stick
bash scripts/import-host-bundle.sh ~/savestate-host-bundle-*.tar.gz.gpg
sudo loginctl enable-linger $USER
```

Differences from a Linux host:

- **WSL has to stay running.** It can stop the Ubuntu VM once no Windows
  program is attached to it, and that takes the site down. Add a Task
  Scheduler task that runs at startup whether or not anyone is signed in:
  `wsl.exe -d Ubuntu-24.04 --exec /bin/sleep infinity`. Check that the site
  stays up after you close every terminal and after a reboot.
- **Windows must not sleep.** A sleeping PC counts as the host being down,
  and traffic moves to the AWS standby.
- **Hardware transcoding reports a warning.** WSL has no VAAPI `/dev/dri`,
  so ffmpeg encodes in software.
- Local RetroArch launches and Remote Play drive a Linux desktop inside WSL,
  not the Windows desktop.

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

**Drive access uses a service account**, not user OAuth. A refresh token from
an app in Google's "Testing" status expires after 7 days; a service account
never expires and needs no consent screen. It reads whatever is shared with
`savestate-drive@…iam.gserviceaccount.com`, so if the library goes empty after
a move, check that the `NexusArchive` folder is still shared with it.

## Failover

The site runs **only from the home host**. Nothing is served from AWS.

A Cloudflare Worker (`cloudflare-worker/`) sits on the domain's routes. Normal
traffic passes straight through to this host, streaming and Range requests
intact. When this host is down it answers with a built-in offline page instead
of Cloudflare's raw 1033/502 error, and `/api/*` gets a clean JSON 503.

"Down" means the request never reached the app: Cloudflare's 52x/530, a
failed fetch, or a 502/503/504 **without** the `X-SaveState-Origin` header
that the app stamps on every response. The app's own 503s ("Database
unavailable") pass through unchanged.

Deploy or update it (this is what removes the old Amplify fallback from the
live domain):

```bash
cd cloudflare-worker && npx wrangler deploy
```

The Worker can also fall back to a second copy of the app (`STANDBY_ORIGIN`)
or a static frontend (`FALLBACK_ORIGIN`). Both are deliberately unset. The AWS
files (`aws-infrastructure.yaml`, `deploy-aws*.sh`, `amplify.yml`) are unused.

Test the Worker without deploying: `node scripts/test-failover-worker.mjs`.
