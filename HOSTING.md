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

A Cloudflare Worker (`cloudflare-worker/`) sits on the domain's routes and
picks who answers each request:

1. **This host**, through the tunnel. Always tried first; normal traffic
   passes straight through, streaming and Range requests intact.
2. **`STANDBY_ORIGIN`**: the AWS App Runner copy of the app
   (`aws-infrastructure.yaml`). It gets everything, API included, but only
   while this host is down.
3. **`FALLBACK_ORIGIN`**: the Amplify static build. Page loads only; `/api/*`
   gets a clean JSON 503 instead of HTML.
4. The built-in offline page.

"Down" means the request never reached the app: Cloudflare's 52x/530 (1033 is
a tunnel with no connector), a failed fetch, or a 502/503/504 **without** the
`X-SaveState-Origin` header. The app stamps that header on every response, so
its own 503s ("Database unavailable") pass through instead of triggering a
failover. Once a Cloudflare location sees this host down, it sends traffic
straight to the standby for 20 seconds, then tries this host again. Traffic
comes back here on its own when this host answers again. Nothing needs to be switched by hand.

To turn the standby on:

```bash
bash scripts/deploy-aws-serverless.sh          # prints the App Runner ServiceUrl
# put that URL in cloudflare-worker/wrangler.toml as STANDBY_ORIGIN, then:
cd cloudflare-worker && npx wrangler deploy
```

Check which machine answered: the `X-SaveState-Origin` response header, or
`"origin"` in `/api/health`, reads `primary`, `standby` or `static`.

What the standby can't do (it's a managed container with no GPU and no
desktop): hardware transcoding (software x264 only, about one concurrent
viewer on 2 vCPU), local RetroArch launches and Remote Play. In-browser games,
the library, accounts and saves work, because they live in Neon and Google
Drive, which both machines share. POST bodies over 1 MB (uploads) are not
replayed to the standby; they get a 503 while this host is down.
Co-op and Watch Party run over WebSockets. Check that `/ws/coop` connects on
the App Runner URL before counting on multiplayer during an outage. Their
sessions live in memory, so sessions already running are dropped when traffic
moves between machines.

The standby is always running, so it costs money while idle; App Runner bills
provisioned memory when there is no traffic. Lower `Cpu`/`Memory` in the stack
if it is only there for failover.

Test the Worker without deploying: `node scripts/test-failover-worker.mjs`.
