// Help & guides: how to set up and use every part of SaveState, written for
// the people using it. Members see the everyday guides; admins also see how
// to run the host (BIOS, emulators, Drive, the downloader, plans).
// Each guide links to the screen it describes (goTab).
import React, { useState, useEffect, useMemo } from "react";
import { useStyles, api, Icon, goTab } from "./lib.jsx";

const CSS = `
.nxg{display:grid;grid-template-columns:240px minmax(0,1fr);gap:18px;align-items:start}
.nxg-nav{position:sticky;top:12px;display:flex;flex-direction:column;gap:4px}
.nxg-nav button{all:unset;cursor:pointer;padding:8px 12px;border-radius:10px;font-size:13.5px;color:var(--dim);display:flex;gap:8px;align-items:center}
.nxg-nav button:hover{background:rgba(255,255,255,.06);color:var(--text)}
.nxg-nav button.on{background:rgba(34,211,238,.12);color:var(--text);font-weight:700}
.nxg-nav .nxg-group{font-size:10.5px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--faint);margin:12px 12px 4px}
.nxg-guide h2{font-size:21px;font-weight:800;margin:0 0 4px}
.nxg-guide .lead{color:var(--dim);margin:0 0 16px;font-size:14px}
.nxg-sec{margin:18px 0 0}
.nxg-sec h4{font-size:15px;margin:0 0 8px;display:flex;gap:8px;align-items:center}
.nxg-sec ol,.nxg-sec ul{margin:0;padding-left:20px;display:grid;gap:6px;font-size:14px;line-height:1.5}
.nxg-sec p{font-size:14px;line-height:1.55;margin:0 0 6px;color:var(--text)}
.nxg-tip{margin-top:10px;padding:10px 12px;border-radius:12px;background:rgba(34,211,238,.07);border:1px solid rgba(34,211,238,.2);font-size:13px}
.nxg-code{font:12.5px ui-monospace,Consolas,monospace;background:rgba(0,0,0,.35);border:1px solid var(--line);border-radius:6px;padding:1px 6px}
.nxg-chips{display:none}
@media (max-width:860px){.nxg{grid-template-columns:1fr}.nxg-nav{display:none}.nxg-chips{display:flex;gap:6px;overflow-x:auto;padding-bottom:6px;margin-bottom:6px}.nxg-chips button{flex:none}}
`;

const C = ({ children }) => <span className="nxg-code">{children}</span>;
const Go = ({ tab, children }) => <button className="nxa-btn sm" style={{ marginTop: 10 }} onClick={() => goTab(tab)}><Icon name="arrow" size={13} /> {children}</button>;

// Each guide: id, group, title, words people might search for, and its body.
const GUIDES = [
  {
    id: "start", group: "Getting started", title: "Welcome to SaveState", icon: "star",
    words: "start begin sign in account install app phone iphone android windows home screen",
    body: (
      <>
        <p className="lead">SaveState is your own media and games service: films and shows, music, books, photos and a games library, on any screen, from anywhere.</p>
        <div className="nxg-sec"><h4>1. Sign in</h4>
          <p>Open <b>savestate.co.za</b> and sign in. If you share the account with family, pick your profile when asked.</p></div>
        <div className="nxg-sec"><h4>2. Put SaveState on your devices</h4>
          <ul>
            <li><b>Android phone or tablet:</b> Get the App &gt; Android, open the downloaded file and allow the install. It updates itself.</li>
            <li><b>iPhone or iPad:</b> open the site in Safari, tap Share, then <b>Add to Home Screen</b>.</li>
            <li><b>Windows PC:</b> Get the App &gt; Windows. The installer adds SaveState to your Desktop and Start menu and sets up the game launcher, so games can run on your PC at full speed.</li>
            <li><b>TV or console browser:</b> just open the site; it is made to work with a remote or a controller.</li>
          </ul></div>
        <div className="nxg-sec"><h4>3. Find your way around</h4>
          <p>The menu on the left (or <b>More</b> at the bottom on a phone) has three parts: <b>Media</b> (films, music, books, photos), <b>Games</b> and <b>System &amp; tools</b>. Search is at the top of most pages.</p></div>
        <div className="nxg-tip">Something not working? See <b>Troubleshooting</b> at the bottom of this list.</div>
        <button className="nxa-btn sm" style={{ marginTop: 10 }} onClick={() => { try { localStorage.setItem("nx_get_started", "1"); } catch { /* private mode */ } location.reload(); }}><Icon name="star" size={13} /> Show the Get started steps again</button>
      </>
    ),
  },
  {
    id: "watch", group: "Media", title: "Films & shows", icon: "film",
    words: "movies tv shows series watch video subtitles resume continue watching quality buffering watch party",
    body: (
      <>
        <p className="lead">Everything in the library plays straight away, on any device, and remembers where you stopped.</p>
        <div className="nxg-sec"><h4>Watching</h4>
          <ol>
            <li>Open <b>Movies &amp; TV</b>, pick a film or show, then press <b>Play</b>.</li>
            <li>Use the player's buttons for subtitles, playback speed and full screen. Volume and speed are remembered.</li>
            <li>Stop any time: <b>Continue watching</b> on the first page picks up where you left off, on any device.</li>
          </ol></div>
        <div className="nxg-sec"><h4>Finding something to watch</h4>
          <ul>
            <li><b>What to Watch</b> suggests titles from what you like.</li>
            <li><b>Discover</b> shows what's new and popular; ask for a title and an admin can add it.</li>
          </ul></div>
        <div className="nxg-sec"><h4>Watching together</h4>
          <p><b>Watch Party</b> plays the same film for several people at once, kept in step.</p></div>
        <div className="nxg-tip">If a video stutters, it is nearly always the connection: Wi-Fi beats mobile data, and other big downloads on the same line slow it down.</div>
        <Go tab="media">Open Movies &amp; TV</Go>
      </>
    ),
  },
  {
    id: "music", group: "Media", title: "Music", icon: "music",
    words: "music songs albums playlist listen background player",
    body: (
      <>
        <p className="lead">Your music library, with playlists, that keeps playing while you use the rest of the app.</p>
        <div className="nxg-sec"><h4>Listening</h4>
          <ol>
            <li>Open <b>Music</b> and pick an album, artist or song.</li>
            <li>The player bar stays at the bottom while you move to other pages, so the music doesn't stop.</li>
            <li>Make and play playlists in Music.</li>
          </ol></div>
        <Go tab="music">Open Music</Go>
      </>
    ),
  },
  {
    id: "books", group: "Media", title: "eBooks", icon: "folder",
    words: "books ebooks epub pdf read reading upload offline comics",
    body: (
      <>
        <p className="lead">Read books in the browser, on any device, and pick up where you stopped.</p>
        <div className="nxg-sec"><h4>Reading</h4>
          <ol>
            <li>Open <b>eBooks</b> and tap a cover.</li>
            <li>Use <b>Offline</b> to keep a book on this device for when you have no signal.</li>
            <li><b>Find Books</b> searches free, legal books; <b>Upload</b> adds your own EPUB or PDF files (if your account may upload).</li>
          </ol></div>
        <Go tab="codex">Open eBooks</Go>
      </>
    ),
  },
  {
    id: "photos", group: "Media", title: "Photos, files & your own Drive", icon: "cloud",
    words: "photos albums files upload my drives google drive phone backup booklet storage",
    body: (
      <>
        <p className="lead">Keep photos and files in SaveState, and connect your own Google Drive.</p>
        <div className="nxg-sec"><h4>Photos and files</h4>
          <ul>
            <li><b>Photos</b> holds your albums and pictures.</li>
            <li><b>Files &amp; Uploads</b> takes files of any kind. Big uploads resume if the connection drops.</li>
            <li><b>Phone Backup</b> copies your phone's photos here.</li>
          </ul></div>
        <div className="nxg-sec"><h4>Your own Google Drive</h4>
          <p>In <b>My Drives</b>, press <b>Connect Google Drive</b> and sign in with Google. Your Drive then appears in SaveState; only you can see it.</p></div>
        <Go tab="files">Open My Drives</Go>
      </>
    ),
  },
  {
    id: "play", group: "Games", title: "Playing games: the three ways", icon: "game",
    words: "games play browser pc phone stream host desktop app launcher emulator rom recommended how",
    body: (
      <>
        <p className="lead">Open any game in <b>Games</b>. Under <b>How do you want to play?</b> the option that works best on the device you're holding comes first, marked <b>Recommended</b>.</p>
        <div className="nxg-sec"><h4>Play in this browser</h4>
          <p>For older consoles and handhelds (NES, SNES, Game Boy, GBA, Mega Drive, PS1, arcade and more). Nothing to install: the game downloads once and runs on your device. Works on phones, tablets and PCs.</p></div>
        <div className="nxg-sec"><h4>Play on this PC</h4>
          <p>For PS2, GameCube, PSP, PS3, Switch and the rest, at full speed with your own controller. Needs the SaveState app for Windows once (see <b>Setting up a Windows PC for games</b>). The game is copied to your PC, so it keeps running even if the internet drops.</p></div>
        <div className="nxg-sec"><h4>Stream from the host PC</h4>
          <p>The host's PC runs the game and the free <b>Moonlight</b> app shows it on your device, with your controls. This is how to play PS2, GameCube or PS3 on a phone. See <b>Play from anywhere with Moonlight</b>.</p></div>
        <div className="nxg-tip">The details page also shows the game's system, playtime, a guide written by the AI, and whether its emulator is ready.</div>
        <Go tab="library">Open Games</Go>
      </>
    ),
  },
  {
    id: "pcsetup", group: "Games", title: "Setting up a Windows PC for games", icon: "down",
    words: "windows install installer desktop app launcher setup node shortcut permission local network chrome edge allow",
    body: (
      <>
        <p className="lead">One install, about two minutes. After that, <b>Play</b> just works on that PC.</p>
        <div className="nxg-sec"><h4>Install</h4>
          <ol>
            <li>On the PC, open SaveState and choose <b>Get the App &gt; Windows</b> (or <b>Emulation Setup &gt; Get SaveState for Windows</b>).</li>
            <li>Run <C>SaveState-Setup</C>. If Windows warns about an unknown app, choose <b>More info &gt; Run anyway</b>.</li>
            <li>A small window shows each step. It gets what it needs (including Node.js if the PC has none), sets up the game launcher and adds <b>SaveState</b> to the Desktop and Start menu.</li>
            <li>When it says <b>All set</b>, open SaveState from the Desktop.</li>
          </ol></div>
        <div className="nxg-sec"><h4>The first time you press Play</h4>
          <p>Chrome or Edge asks whether <b>savestate.co.za</b> may connect to apps on this device. Choose <b>Allow</b>: that is how the site talks to the game launcher on your PC.</p></div>
        <div className="nxg-sec"><h4>It keeps itself running</h4>
          <p>The launcher starts with Windows and restarts by itself within seconds if it ever stops. To update it, run the installer again.</p></div>
        <Go tab="emulation">Open Emulation Setup</Go>
      </>
    ),
  },
  {
    id: "phone", group: "Games", title: "Games on your phone, anywhere", icon: "game",
    words: "phone mobile android iphone touch controls offline download play anywhere stream",
    body: (
      <>
        <p className="lead">Your whole library is playable on a phone.</p>
        <ul className="nxg-sec">
          <li><b>Older systems</b> play on the phone itself, with on-screen buttons. Choose <b>Play on this phone</b>.</li>
          <li><b>PS2, GameCube and other big systems</b> are too heavy for a phone: choose <b>Stream from the host PC</b>.</li>
          <li><b>Without signal:</b> in <b>Play Offline</b>, press <b>Get &amp; Play</b> on a game while you're online. It stays on the phone and plays later with no connection.</li>
          <li>A Bluetooth controller works: pair it with the phone, then press any button in the game.</li>
        </ul>
        <div className="nxg-tip">Turn the phone sideways for the biggest picture. Saves are kept on the device, and cloud saves follow you where the game supports them.</div>
        <Go tab="consoles">Open Play Offline</Go>
      </>
    ),
  },
  {
    id: "moonlight", group: "Games", title: "Play from anywhere with Moonlight", icon: "game",
    words: "moonlight sunshine stream remote phone tablet tv vita anywhere ps2 gamecube ps3 switch controller",
    body: (
      <>
        <p className="lead">Play every game in the library, even PS2, GameCube and PS3, on a phone, tablet or TV. The host's PC runs the game; Moonlight shows it on your screen and sends your controls back.</p>
        <div className="nxg-sec"><h4>Set up (once per device)</h4>
          <ol>
            <li>Install <b>Moonlight</b> (free): Google Play, the App Store, or <C>moonlight-stream.org</C> for PCs and TVs.</li>
            <li>Open Moonlight. On the same Wi-Fi as the host, the host's PC appears by itself; tap it.</li>
            <li>Moonlight shows a 4-digit PIN. Send it to the host, who enters it in Sunshine (one time per device).</li>
          </ol></div>
        <div className="nxg-sec"><h4>Play</h4>
          <ol>
            <li>In Moonlight, tap the host's PC, then <b>SaveState</b>.</li>
            <li>SaveState's Big Picture opens. Pick any game and press <b>A</b>.</li>
            <li>A Bluetooth controller paired with your device works as the console's controller; on a phone, Moonlight also has on-screen controls.</li>
          </ol></div>
        <div className="nxg-sec"><h4>Away from home</h4>
          <p>Moonlight reaches the host directly, so away from the host's Wi-Fi both ends join the same private network with <b>Tailscale</b> (free):</p>
          <ol>
            <li>Install <b>Tailscale</b> on your phone, tablet or PC (Google Play, the App Store or <C>tailscale.com</C>).</li>
            <li>Sign in with your own account, then accept the invite the host sends you from Tailscale (they share the host PC with you once).</li>
            <li>In Moonlight, tap <b>+</b> and enter the host PC's Tailscale address (the host can tell you; it starts with 100.).</li>
          </ol>
          <p>Then it works anywhere with a steady connection. 15 Mbps or more gives a sharp picture.</p></div>
      </>
    ),
  },
  {
    id: "bigpicture", group: "Games", title: "Big Picture (couch mode)", icon: "game",
    words: "big picture couch tv controller gamepad console vault fullscreen keyboard",
    body: (
      <>
        <p className="lead">A full-screen game browser made for the TV and a controller.</p>
        <div className="nxg-sec"><h4>Using it</h4>
          <ol>
            <li>Open <b>Play Offline</b>, then <b>Big Picture</b>.</li>
            <li>Move with the D-pad or left stick, <b>A</b> or <b>Enter</b> to play, <b>B</b> or <b>Esc</b> to go back.</li>
            <li><b>LB / RB</b> change system, <b>X</b> or <b>F</b> searches, <b>Tab</b> switches layout, <b>F11</b> full screen.</li>
          </ol></div>
        <p className="nxg-sec">Play works the same as on the game page: on your device when it can, with the Windows app for big systems.</p>
        <Go tab="consoles">Open Big Picture</Go>
      </>
    ),
  },
  {
    id: "minigames", group: "Games", title: "Mini Games", icon: "game",
    words: "mini games agent builder jarvis html browser games quick play",
    body: (
      <>
        <p className="lead">Small games made with our Agent Builder. They play instantly on any device, nothing to install.</p>
        <ol className="nxg-sec">
          <li>Open <b>Mini Games</b> and press <b>Play</b>.</li>
          <li>Use <b>Full screen</b> for the best view, <b>Restart</b> to start over. High scores are kept on your device.</li>
          <li>On a phone or tablet, an on-screen pad appears under the game (arrows, <b>Start</b> and <b>A</b>) for games made for a keyboard. <b>Hide pad</b> if the game has its own touch controls.</li>
        </ol>
        <Go tab="minigames">Open Mini Games</Go>
      </>
    ),
  },
  {
    id: "profiles", group: "Your account", title: "Profiles, kids and screen time", icon: "users",
    words: "profiles household family kids children pin rating screen time parental",
    body: (
      <>
        <p className="lead">One account, a profile for each person, with limits for children.</p>
        <ol className="nxg-sec">
          <li>Open <b>Profiles</b> and add one per person.</li>
          <li>For a child, choose what they may open, the highest age rating, a daily time allowance and the hours it can be used.</li>
          <li>Add a PIN so a child can't switch to your profile. You can send a profile to another device as a link.</li>
        </ol>
        <Go tab="household">Open Profiles</Go>
      </>
    ),
  },
  {
    id: "activity", group: "Your account", title: "Activity log: progress and proof", icon: "check",
    words: "activity log receipts completed progress upload download verified checksum report time left",
    body: (
      <>
        <p className="lead">See what is running, what has finished, and the receipt for everything.</p>
        <div className="nxg-sec"><h4>Happening now</h4>
          <p>Uploads, downloads and searches with progress, speed and time left. Time left is based on the last few minutes, and it says when it is still counting what's left.</p></div>
        <div className="nxg-sec"><h4>Completed</h4>
          <p>Everything that finished. A folder copied to Google Drive shows <b>Done and checked</b> only after every file was compared with the copy on Drive. Open it to see how many files matched, how long it took, any file that needs another go, and a download of the file-by-file check.</p></div>
        <div className="nxg-sec"><h4>Receipts</h4>
          <p>A permanent record of every upload, payment, plan change and more, which you can print or export.</p></div>
        <Go tab="receipts">Open the Activity log</Go>
      </>
    ),
  },
  {
    id: "plans", group: "Your account", title: "Plans & access", icon: "star",
    words: "plans pricing upgrade payment payfast access request library screens streams devices limit stop watching free family plus",
    body: (
      <>
        <p className="lead">Your plan decides how many screens can watch at once and which games you can play. Pay securely with PayFast in <b>Plans &amp; Pricing</b>.</p>
        <div className="nxg-sec"><h4>Screens</h4>
          <p>Each plan plays films and shows on a set number of devices at the same time (music doesn't count). New members get an extra screen for their first three months. When every screen is taken, SaveState shows which devices are watching and lets you stop one of them from where you are.</p></div>
        <div className="nxg-sec"><h4>Games</h4>
          <p>Every plan plays the retro systems (NES, SNES, Game Boy, Mega Drive, PlayStation 1 and more) right in the browser, on any device. PS2, GameCube, PS3, Switch and PSP need the desktop app or the host PC, which come with the paid plans.</p></div>
        <p className="nxg-sec">The host's own films and games library is shared person by person by an admin; ask for access from the page that tells you it's private.</p>
        <Go tab="plans">Open Plans &amp; Pricing</Go>
      </>
    ),
  },
  {
    id: "trouble", group: "Help", title: "Troubleshooting", icon: "info",
    words: "help problem not working error broken slow launcher not running chrome permission blocked bios missing buffering",
    body: (
      <>
        <div className="nxg-sec"><h4>"Needs the SaveState desktop app" on a PC that has it</h4>
          <ul>
            <li>Make sure you chose <b>Allow</b> when the browser asked about connecting to apps on this device. To check, click the lock icon by the address &gt; Site settings &gt; Local network access: Allow.</li>
            <li>Run the Windows installer again; it repairs and updates the launcher.</li>
          </ul></div>
        <div className="nxg-sec"><h4>A game says a BIOS or keys are missing</h4>
          <p>Some systems need files from your own console (PS1, PS2, Neo Geo, Switch keys). The game page says exactly which file and where it goes; <b>Emulation Setup</b> explains each system.</p></div>
        <div className="nxg-sec"><h4>"This game loaded but isn't running"</h4>
          <p>That copy of the game doesn't work in a browser. Press <b>Back — play it another way</b> and choose <b>Stream from the host PC</b> or <b>Play on this PC</b>.</p></div>
        <div className="nxg-sec"><h4>Video buffers</h4>
          <p>Move closer to the Wi-Fi, or pause other big downloads on the same line. Playing several things at once on a slow line also slows each one.</p></div>
        <div className="nxg-sec"><h4>Still stuck</h4>
          <p>Note what you pressed and what it said, and send it to the host. The <b>Activity log</b> often already shows what happened.</p></div>
      </>
    ),
  },
  // ── Admins: running the host ──────────────────────────────────────────
  {
    id: "host-games", group: "Running the host", admin: true, title: "Emulators, BIOS and firmware", icon: "chip",
    words: "host admin emulator bios firmware pcsx2 rpcs3 ryujinx dolphin retroarch neo geo neogeo keys ps3 switch setup",
    body: (
      <>
        <p className="lead">What each system needs on the host PC, and where it goes. The launch check on every game's page says what is still missing.</p>
        <ul className="nxg-sec">
          <li><b>Older systems, PSP, GameCube:</b> RetroArch at <C>C:\RetroArch-Win64</C>, with its cores (Core Forge installs missing ones). GameCube uses standalone Dolphin when installed, else RetroArch's Dolphin core.</li>
          <li><b>PS2:</b> PCSX2 at <C>E:\PCSX2</C>; its BIOS (<C>.bin</C>, 4 MB) in <C>E:\PCSX2\bios</C>.</li>
          <li><b>PS3:</b> RPCS3 at <C>E:\RPCS3</C> with Sony's firmware installed (done). Extracted games (folder with <C>PS3_GAME</C>) go in <C>E:\ROMS\PS3</C>.</li>
          <li><b>Switch:</b> unzip Ryujinx from <C>ryujinx.app</C> into <C>E:\Ryujinx</C> (or leave it in Downloads). Open it once, then <b>File &gt; Open Ryujinx Folder</b>: put <C>prod.keys</C> from your Switch in <C>system</C>, and install your firmware with <b>Tools &gt; Install Firmware</b>.</li>
          <li><b>Neo Geo:</b> a current <C>neogeo.zip</C> (with <C>sm1.sm1</C>, <C>sfix.sfix</C>, <C>000-lo.lo</C> and a system BIOS) in the BIOS folder <C>%APPDATA%\NexusEmuHost\bios</C> and <C>C:\RetroArch-Win64\system</C>.</li>
          <li><b>In-browser play</b> uses BIOS files from the BIOS folder too (PS1 <C>scph5501.bin</C>, Sega CD, Neo Geo).</li>
        </ul>
        <div className="nxg-tip">Only use BIOS files, keys and games dumped from consoles and discs you own.</div>
        <Go tab="emulation">Open Emulation Setup</Go>
      </>
    ),
  },
  {
    id: "host-addgames", group: "Running the host", admin: true, title: "Adding games to the library", icon: "plus",
    words: "add games roms upload library import folder drop restore rebuild systems detect",
    body: (
      <>
        <p className="lead">Put your games into the library from any PC or phone. They're playable for everyone with library access the moment each one finishes.</p>
        <ol className="nxg-sec">
          <li>Open <b>Add games</b> (under Games in the menu).</li>
          <li>Drop ROM files or whole folders, or press <b>Choose files</b> / <b>Choose a folder</b>. On a phone, choose files.</li>
          <li>Each game's system is recognised from the file and its folder name. Anything it can't be sure of is marked: pick the system on that row, or for all of them at once. Games already in the library are left out.</li>
          <li>Press <b>Add</b>. Uploads run several at a time and carry on through dropped connections. The Activity log gets a receipt.</li>
        </ol>
        <div className="nxg-tip">Keep a disc game's files together (a <C>.cue</C> with its <C>.bin</C> files). Arcade and Neo Geo sets stay zipped with their MAME names, like <C>mslug.zip</C>.</div>
        <Go tab="addgames">Open Add games</Go>
      </>
    ),
  },
  {
    id: "host-sunshine", group: "Running the host", admin: true, title: "Streaming with Sunshine", icon: "chip",
    words: "sunshine moonlight stream pair pin remote port forwarding tailscale anywhere",
    body: (
      <>
        <p className="lead">Sunshine on the host PC is what Moonlight connects to. It is installed on this PC already.</p>
        <div className="nxg-sec"><h4>Add SaveState to Sunshine (once)</h4>
          <p>Double-click <C>scripts\windows\Add SaveState to Sunshine.cmd</C> in the SaveState folder and allow the Windows prompt. Moonlight then lists <b>SaveState</b>, which opens Big Picture on this PC in host mode. The first time, sign in to SaveState in the window that opens.</p></div>
        <div className="nxg-sec"><h4>Pair a device</h4>
          <p>When someone's Moonlight shows a PIN, open Sunshine at <C>https://localhost:47990</C> &gt; <b>PIN</b> and enter it.</p></div>
        <div className="nxg-sec"><h4>Play from outside the home</h4>
          <ul>
            <li><b>Easiest:</b> install Tailscale on the host and on each player's device and sign in to the same Tailscale network; Moonlight then finds the host anywhere.</li>
            <li><b>Or:</b> forward TCP 47984, 47989, 47990, 48010 and UDP 47998–48000, 48010 on the router to this PC, and add the home's public address in Moonlight.</li>
          </ul></div>
      </>
    ),
  },
  {
    id: "host-minigames", group: "Running the host", admin: true, title: "Publishing Mini Games & the Agent Builder", icon: "bolt",
    words: "mini games publish key agent builder jarvis upload zip html curl",
    body: (
      <>
        <ul className="nxg-sec">
          <li><b>By hand:</b> Mini Games &gt; <b>Add a game</b>: drop a <C>.html</C> file or a <C>.zip</C> with <C>index.html</C>. Edit, cover, replace and remove from each game's <b>Edit</b>.</li>
          <li><b>From the Agent Builder:</b> games in its <C>games</C> folder and builds that pass every check appear by themselves (checked every 10 minutes, or press <b>Check now</b>). A newer build updates the game in place. Other build attempts are listed with <b>Add</b>. Games Jarvis asks the Agent Builder for arrive the same way.</li>
          <li><b>From any other tool:</b> create a <b>publish key</b> and post the file; the page shows the exact command.</li>
        </ul>
        <div className="nxg-tip">Games run in a sealed sandbox: they can't see anyone's sign-in or account.</div>
        <Go tab="minigames">Open Mini Games</Go>
      </>
    ),
  },
  {
    id: "host-drive", group: "Running the host", admin: true, title: "Google Drive, upload speed & the local cache", icon: "cloud",
    words: "cloud drives google drive upload backup offload free space speed bandwidth limit verify cache local ssd nas linux install",
    body: (
      <>
        <ol className="nxg-sec">
          <li><b>Cloud Drives</b> shows the connected Drive accounts and their space.</li>
          <li>Choose a folder on the PC to copy to Drive. Each copy is checked file by file; the result is in Activity log &gt; Completed.</li>
          <li>Files are removed from the PC only after the check matched, and only if you choose so (or switch on <b>free automatically</b> for that folder).</li>
        </ol>
        <div className="nxg-sec"><h4>Upload speed</h4>
          <p>Uploads go flat out when nobody is using the site and from 01:00 to 07:00. While someone browses they use 70% of the line (learned from its real speed); while someone watches or listens they use 40%, leaving the rest for the stream; during a game on the host, almost paused. Activity log &gt; Happening now shows the current limit and an honest time left.</p></div>
        <div className="nxg-sec"><h4>Local cache</h4>
          <p>Films and games on Google Drive are fetched from Google the first time, which can take a few seconds to start. <b>Local cache</b> (at the bottom of Cloud Drives) keeps a copy of each film, episode and game someone plays on a fast disk of this PC, copies the next episode ahead, and keeps games added through Add games. The next play starts at once. Choose its folder (an SSD is best) and size there; the oldest copies make room when it's full, and it always leaves 10 GB free on its disk.</p></div>
        <div className="nxg-sec"><h4>Hosting on a NAS</h4>
          <p>SaveState also runs on a NAS or Linux box: run <C>curl -fsSL https://savestate.co.za/install.sh | bash</C> on it and follow the prompts. Point the library at the NAS's own folders (they're local there, so they need no cache). Games that need the host PC's screen (Stream from the host, Sunshine) still need a Windows PC; everything in the browser works from the NAS.</p></div>
        <Go tab="cloud">Open Cloud Drives</Go>
      </>
    ),
  },
  {
    id: "host-people", group: "Running the host", admin: true, title: "Members, access & plans", icon: "users",
    words: "users members access grant library invite plans tiers prices payfast keys service",
    body: (
      <>
        <ul className="nxg-sec">
          <li><b>Users</b> and <b>Access</b>: invite people, and grant the host's media or games library person by person. Libraries are never sold through plans.</li>
          <li><b>Plans &amp; Pricing &gt; Tiers</b>: set prices and what each plan includes. PayFast takes the payments.</li>
          <li><b>Plans &gt; Setup checklist</b> shows anything still to configure (email, payments, keys).</li>
        </ul>
        <Go tab="plans">Open Plans</Go>
      </>
    ),
  },
  {
    id: "host-downloads", group: "Running the host", admin: true, title: "Downloader (films & shows)", icon: "down",
    words: "downloads downloader sonarr radarr prowlarr qbittorrent requests stalled",
    body: (
      <>
        <p className="lead">Requests from Discover go to Sonarr (shows) and Radarr (films), which find releases through Prowlarr and download them with qBittorrent.</p>
        <p className="nxg-sec"><b>Downloads &gt; Downloader setup</b> checks each part and says why downloads stall. If qBittorrent isn't running, start it again on the host PC.</p>
        <Go tab="torrent">Open Downloads</Go>
      </>
    ),
  },
];

export function Guides() {
  useStyles();
  const [admin, setAdmin] = useState(false);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(() => new URLSearchParams(location.search).get("guide") || "start");
  useEffect(() => { api("/api/plans/me").then((m) => setAdmin(!!m.isAdmin)).catch(() => {}); }, []);
  const guides = useMemo(() => GUIDES.filter((g) => !g.admin || admin), [admin]);
  const hits = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return guides;
    return guides.filter((g) => `${g.title} ${g.words} ${g.group}`.toLowerCase().includes(t));
  }, [q, guides]);
  const current = guides.find((g) => g.id === open) ?? hits[0] ?? guides[0];
  const groups = [...new Set(hits.map((g) => g.group))];
  const pick = (id) => { setOpen(id); window.scrollTo?.({ top: 0, behavior: "smooth" }); };

  return (
    <div className="nxa nxa-page">
      <style>{CSS}</style>
      <div className="nxa-card">
        <div className="nxa-card-head" style={{ alignItems: "center" }}>
          <div><h3 style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 20 }}><Icon name="info" /> Help &amp; guides</h3>
            <p className="nxa-sub" style={{ margin: 0 }}>How to set up and use everything in SaveState.</p></div>
          <input className="nxa-input sm" style={{ maxWidth: 260 }} placeholder="Search the guides" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="nxg-chips">{hits.map((g) => <button key={g.id} className={`nxa-btn sm${g.id === current?.id ? " primary" : ""}`} onClick={() => pick(g.id)}>{g.title}</button>)}</div>
        <div className="nxg">
          <nav className="nxg-nav" aria-label="Guides">
            {groups.map((grp) => (
              <React.Fragment key={grp}>
                <div className="nxg-group">{grp}</div>
                {hits.filter((g) => g.group === grp).map((g) => (
                  <button key={g.id} className={g.id === current?.id ? "on" : ""} onClick={() => pick(g.id)}><Icon name={g.icon} size={14} /> {g.title}</button>
                ))}
              </React.Fragment>
            ))}
            {hits.length === 0 && <p className="nxa-faint" style={{ fontSize: 13, padding: "0 12px" }}>No guide matches that.</p>}
          </nav>
          {current && (
            <article className="nxg-guide" key={current.id}>
              <div className="nxa-faint" style={{ fontSize: 11, fontWeight: 800, letterSpacing: ".12em", textTransform: "uppercase" }}>{current.group}</div>
              <h2>{current.title}</h2>
              {current.body}
            </article>
          )}
        </div>
      </div>
    </div>
  );
}
