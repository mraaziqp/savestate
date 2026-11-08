/**
 * Dedicated PS Vita Web Portal for SaveState / NexusEmu.
 *
 * Specially designed for NetFront / WebKit 537.73 on PlayStation Vita:
 * - 100% ES5 JavaScript (zero ES6/arrow functions/template literals/modules).
 * - Fixed 960x544 resolution optimization with high-contrast OLED/LCD dark theme.
 * - 1-Click native app installer download (SaveState-Vita-1.1.vpk).
 * - Real-time game search and console filtering across all Vita-supported platforms.
 * - Direct ROM download links for VitaShell (ux0:download/).
 */

export interface VitaGameItem {
  id: string;
  title: string;
  platform: string;
  size: number;
  filename: string;
}

export function renderVitaPortalHtml(games: VitaGameItem[], serverUrl: string = "", authToken: string = ""): string {
  // Serialize games array safely for ES5 inline consumption
  const safeGamesJson = JSON.stringify(games).replace(/</g, "\\u003c");

  function escapeHtml(text: string) {
    if (!text) return "";
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatBytes(bytes: number) {
    if (!bytes || bytes <= 0) return "";
    if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + " GB";
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + " MB";
    return Math.round(bytes / 1024) + " KB";
  }

  function getPlatClass(plat: string) {
    const p = (plat || "").toLowerCase();
    if (p === "gba") return "plat-gba";
    if (p === "snes") return "plat-snes";
    if (p === "genesis") return "plat-genesis";
    if (p === "n64") return "plat-n64";
    if (p === "ps1") return "plat-ps1";
    if (p === "psp") return "plat-psp";
    if (p === "neogeo") return "plat-neogeo";
    return "plat-retro";
  }

  let serverRowsHtml = "";
  const initialLimit = Math.min(games.length, 60);
  for (let i = 0; i < initialLimit; i++) {
    const g = games[i];
    const plat = (g.platform || "retro").toUpperCase();
    const sizeText = formatBytes(g.size);
    const platCls = getPlatClass(g.platform);
    let dlUrl = `/api/games/${encodeURIComponent(g.id)}/download`;
    if (authToken) {
      dlUrl += `?token=${encodeURIComponent(authToken)}`;
    }

    serverRowsHtml += `<div class="game-row">` +
      `<div class="game-cell cell-info">` +
        `<div class="game-title">${escapeHtml(g.title)}</div>` +
        `<div class="game-meta">${sizeText ? sizeText + " &bull; " : ""}${escapeHtml(g.filename)}</div>` +
      `</div>` +
      `<div class="game-cell cell-plat">` +
        `<span class="plat-badge ${platCls}">${plat}</span>` +
      `</div>` +
      `<div class="game-cell cell-dl">` +
        `<a href="${dlUrl}" class="btn-dl" download>Download</a>` +
      `</div>` +
    `</div>`;
  }
  if (games.length > initialLimit) {
    serverRowsHtml += `<div style="display:table-row;"><div style="display:table-cell;padding:12px;text-align:center;color:#64748b;font-size:12px;" colspan="3">` +
      `Showing first ${initialLimit} games. Use Search above to find specific titles.` +
    `</div></div>`;
  }

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=960, initial-scale=1.0, user-scalable=no">
  <title>SaveState | PS Vita Portal</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: #080912;
      color: #e2e8f0;
      font-family: -apple-system, Helvetica, Arial, sans-serif;
      padding: 12px 16px 40px;
      -webkit-text-size-adjust: none;
    }
    a { color: inherit; text-decoration: none; }

    /* Top Navigation */
    .header {
      display: table;
      width: 100%;
      border-bottom: 2px solid #1e2238;
      padding-bottom: 12px;
      margin-bottom: 14px;
    }
    .header-left { display: table-cell; vertical-align: middle; }
    .header-right { display: table-cell; vertical-align: middle; text-align: right; }
    .logo {
      font-size: 24px;
      font-weight: bold;
      color: #00f0ff;
      letter-spacing: 0.05em;
    }
    .badge-handheld {
      display: inline-block;
      background: #7928ca;
      color: #fff;
      font-size: 11px;
      font-weight: bold;
      padding: 3px 8px;
      border-radius: 6px;
      text-transform: uppercase;
      margin-left: 8px;
    }

    /* VPK Banner */
    .vpk-card {
      background: #111427;
      border: 2px solid #00f0ff;
      border-radius: 12px;
      padding: 14px 18px;
      margin-bottom: 16px;
      display: table;
      width: 100%;
    }
    .vpk-text { display: table-cell; vertical-align: middle; }
    .vpk-action { display: table-cell; vertical-align: middle; text-align: right; width: 220px; }
    .vpk-title { font-size: 17px; font-weight: bold; color: #fff; margin-bottom: 4px; }
    .vpk-sub { font-size: 12px; color: #94a3b8; line-height: 1.4; }
    .btn-download-vpk {
      display: inline-block;
      background: #00f0ff;
      color: #000;
      font-size: 14px;
      font-weight: bold;
      padding: 10px 18px;
      border-radius: 8px;
      border: none;
      cursor: pointer;
    }
    .btn-download-vpk:hover { background: #5df7ff; }

    /* Search & Filter Toolbar */
    .toolbar {
      margin-bottom: 14px;
    }
    .search-box {
      width: 100%;
      background: #14182e;
      border: 1px solid #2d3748;
      color: #fff;
      font-size: 15px;
      padding: 10px 14px;
      border-radius: 8px;
      margin-bottom: 10px;
      outline: none;
    }
    .search-box:focus { border-color: #00f0ff; }
    .filters {
      white-space: nowrap;
      overflow-x: auto;
      padding-bottom: 6px;
    }
    .filter-btn {
      display: inline-block;
      background: #15192c;
      color: #cbd5e1;
      border: 1px solid #282f4c;
      font-size: 12px;
      font-weight: bold;
      padding: 6px 14px;
      border-radius: 20px;
      margin-right: 6px;
      cursor: pointer;
    }
    .filter-btn.active {
      background: #00f0ff;
      color: #05070f;
      border-color: #00f0ff;
    }

    /* Game List */
    .stats-bar {
      font-size: 12px;
      color: #64748b;
      margin-bottom: 8px;
    }
    .game-list {
      display: table;
      width: 100%;
      border-collapse: separate;
      border-spacing: 0 6px;
    }
    .game-row {
      background: #101323;
      border: 1px solid #1f253d;
      display: table-row;
    }
    .game-cell {
      display: table-cell;
      vertical-align: middle;
      padding: 10px 14px;
    }
    .cell-info { width: 70%; }
    .cell-plat { width: 15%; text-align: center; }
    .cell-dl { width: 15%; text-align: right; }
    .game-title {
      font-size: 15px;
      font-weight: bold;
      color: #f1f5f9;
      margin-bottom: 2px;
    }
    .game-meta { font-size: 11px; color: #64748b; }
    .plat-badge {
      display: inline-block;
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: bold;
      text-transform: uppercase;
      background: #1e293b;
      color: #38bdf8;
      border: 1px solid #0284c7;
    }
    .plat-gba { color: #f472b6; border-color: #db2777; }
    .plat-snes { color: #a78bfa; border-color: #7c3aed; }
    .plat-genesis { color: #fb923c; border-color: #ea580c; }
    .plat-n64 { color: #4ade80; border-color: #16a34a; }
    .plat-ps1 { color: #93c5fd; border-color: #2563eb; }
    .plat-psp { color: #facc15; border-color: #ca8a04; }
    .plat-neogeo { color: #f87171; border-color: #dc2626; }

    .btn-dl {
      display: inline-block;
      background: #2563eb;
      color: #fff;
      font-size: 12px;
      font-weight: bold;
      padding: 6px 12px;
      border-radius: 6px;
      text-align: center;
    }
    .btn-dl:hover { background: #3b82f6; }

    .instructions {
      background: #0f1322;
      border-left: 4px solid #00f0ff;
      padding: 12px 14px;
      font-size: 12px;
      color: #94a3b8;
      line-height: 1.5;
      margin-top: 24px;
      border-radius: 0 8px 8px 0;
    }
    .instructions b { color: #fff; }
  </style>
</head>
<body>

  <div class="header">
    <div class="header-left">
      <span class="logo">SAVESTATE</span>
      <span class="badge-handheld">PS VITA PORTAL</span>
    </div>
    <div class="header-right">
      <span style="font-size:12px;color:#94a3b8;">Firmware 3.60 - 3.74 OK</span>
    </div>
  </div>

  <div class="vpk-card">
    <div class="vpk-text">
      <div class="vpk-title">SaveState for PS Vita (Native VPK v1.1)</div>
      <div class="vpk-sub">Install the official homebrew client for direct controller play, full speed RetroArch cores, and Adrenaline integration.</div>
    </div>
    <div class="vpk-action">
      <a href="/api/downloads/vita" class="btn-download-vpk" download>DOWNLOAD .VPK</a>
    </div>
  </div>

  <div class="toolbar">
    <input type="text" id="searchInput" class="search-box" placeholder="Search games by title..." onkeyup="filterGames()" onsearch="filterGames()">
    <div class="filters" id="platformFilters">
      <span class="filter-btn active" onclick="setPlatform('all')">All Games</span>
      <span class="filter-btn" onclick="setPlatform('gba')">GBA</span>
      <span class="filter-btn" onclick="setPlatform('snes')">SNES</span>
      <span class="filter-btn" onclick="setPlatform('genesis')">Genesis</span>
      <span class="filter-btn" onclick="setPlatform('n64')">N64</span>
      <span class="filter-btn" onclick="setPlatform('gb')">Game Boy</span>
      <span class="filter-btn" onclick="setPlatform('neogeo')">NeoGeo</span>
      <span class="filter-btn" onclick="setPlatform('ps1')">PlayStation</span>
      <span class="filter-btn" onclick="setPlatform('psp')">PSP</span>
      <span class="filter-btn" onclick="setPlatform('mame')">Arcade</span>
    </div>
  </div>

  <div class="stats-bar" id="statsBar">Showing all games</div>

  <div class="game-list" id="gamesContainer">
    ${serverRowsHtml}
  </div>

  <div class="instructions">
    <b>Vita Direct Download Instructions:</b><br>
    1. Tap <b>DOWNLOAD .VPK</b> to save <code>SaveState-Vita-1.1.vpk</code> to <code>ux0:download/</code>.<br>
    2. Open <b>VitaShell</b>, go to <code>ux0:download/</code>, and press <b>X</b> to install the app.<br>
    3. Tap <b>Download ROM</b> on any game above to save the ROM file directly to your memory card.
  </div>

  <script>
    // Pure ES5 JavaScript for 100% WebKit 537.73 / PS Vita Compatibility
    var allGames = ${safeGamesJson};
    var currentPlatform = 'all';
    var authToken = ${JSON.stringify(authToken)};

    function formatBytes(bytes) {
      if (!bytes || bytes <= 0) return '';
      if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + ' GB';
      if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
      return Math.round(bytes / 1024) + ' KB';
    }

    function getPlatClass(plat) {
      var p = (plat || '').toLowerCase();
      if (p === 'gba') return 'plat-gba';
      if (p === 'snes') return 'plat-snes';
      if (p === 'genesis') return 'plat-genesis';
      if (p === 'n64') return 'plat-n64';
      if (p === 'ps1' || p === 'psx') return 'plat-ps1';
      if (p === 'psp') return 'plat-psp';
      if (p === 'neogeo') return 'plat-neogeo';
      return '';
    }

    function renderGames(list) {
      var container = document.getElementById('gamesContainer');
      var stats = document.getElementById('statsBar');
      stats.innerHTML = 'Displaying <b>' + list.length + '</b> of ' + allGames.length + ' available games';

      // Render top 150 items to keep Vita DOM lightning fast
      var maxRender = Math.min(list.length, 150);
      var html = '';

      for (var i = 0; i < maxRender; i++) {
        var g = list[i];
        var plat = (g.platform || 'retro').toUpperCase();
        var sizeText = formatBytes(g.size);
        var platCls = getPlatClass(g.platform);
        var dlUrl = '/api/games/' + encodeURIComponent(g.id) + '/download';
        if (authToken) {
          dlUrl += '?token=' + encodeURIComponent(authToken);
        }

        html += '<div class="game-row">' +
          '<div class="game-cell cell-info">' +
            '<div class="game-title">' + escapeHtml(g.title) + '</div>' +
            '<div class="game-meta">' + (sizeText ? sizeText + ' &bull; ' : '') + escapeHtml(g.filename) + '</div>' +
          '</div>' +
          '<div class="game-cell cell-plat">' +
            '<span class="plat-badge ' + platCls + '">' + plat + '</span>' +
          '</div>' +
          '<div class="game-cell cell-dl">' +
            '<a href="' + dlUrl + '" class="btn-dl" download>Download</a>' +
          '</div>' +
        '</div>';
      }

      if (list.length > maxRender) {
        html += '<div style="display:table-row;"><div style="display:table-cell;padding:12px;text-align:center;color:#64748b;font-size:12px;" colspan="3">' +
          'Showing first ' + maxRender + ' games. Use Search above to find specific titles.' +
        '</div></div>';
      }

      if (list.length === 0) {
        html = '<div style="display:table-row;"><div style="display:table-cell;padding:30px;text-align:center;color:#64748b;font-size:14px;" colspan="3">' +
          'No games found matching your search.' +
        '</div></div>';
      }

      container.innerHTML = html;
    }

    function escapeHtml(text) {
      if (!text) return '';
      return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function setPlatform(plat) {
      currentPlatform = plat;
      var buttons = document.getElementById('platformFilters').getElementsByTagName('span');
      for (var i = 0; i < buttons.length; i++) {
        buttons[i].className = 'filter-btn';
      }
      if (window.event && window.event.target) {
        window.event.target.className = 'filter-btn active';
      }
      filterGames();
    }

    function filterGames() {
      var query = (document.getElementById('searchInput').value || '').toLowerCase().trim();
      var filtered = [];

      for (var i = 0; i < allGames.length; i++) {
        var g = allGames[i];
        var matchPlat = (currentPlatform === 'all') || (String(g.platform).toLowerCase() === currentPlatform);
        if (currentPlatform === 'gb') {
          matchPlat = (g.platform === 'gb' || g.platform === 'gbc');
        }
        var matchQuery = (!query) || (g.title.toLowerCase().indexOf(query) !== -1) || (g.filename.toLowerCase().indexOf(query) !== -1);

        if (matchPlat && matchQuery) {
          filtered.push(g);
        }
      }

      renderGames(filtered);
    }

    // Initial render
    renderGames(allGames);
  </script>
</body>
</html>
`;
}
