// Styles for Discover and What to Watch. Shipped with the module because the
// app's compiled Tailwind only contains the classes the lost sources used.
// Everything is scoped under .nxw.
export const CSS = `
.nxw{--bg:#07070d;--panel:#0f0f19;--panel2:#161624;--line:rgba(255,255,255,.08);--text:#f4f5fb;--dim:rgba(244,245,251,.55);
  --faint:rgba(244,245,251,.35);--acc:#22d3ee;--acc2:#4d7cff;--hot:#a855f7;--ok:#34d399;--warn:#fbbf24;
  color:var(--text);font-size:14px;line-height:1.4;-webkit-font-smoothing:antialiased}
.nxw *{box-sizing:border-box}
.nxw button{font:inherit;color:inherit;cursor:pointer}
.nxw button:disabled{cursor:default;opacity:.55}
.nxw :focus-visible{outline:3px solid var(--acc);outline-offset:2px;border-radius:12px}
.nxw-page{padding:4px 0 48px;max-width:1800px;margin:0 auto}
.nxw-muted{color:var(--dim);font-size:13px;margin:4px 0 0}
.nxw-dim{color:var(--faint)}
.nxw-center{text-align:center;padding:24px}
.nxw-h3{font-size:16px;font-weight:800;margin:18px 0 10px}

.nxw-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:16px}
.nxw-head h1{font-size:clamp(22px,3vw,32px);font-weight:900;letter-spacing:-.02em;margin:0}

.nxw-btn{display:inline-flex;align-items:center;gap:7px;padding:9px 16px;border-radius:999px;border:1px solid var(--line);
  background:rgba(255,255,255,.07);font-weight:700;font-size:13px;white-space:nowrap;transition:background .15s,transform .15s,border-color .15s}
.nxw-btn:hover:not(:disabled){background:rgba(255,255,255,.13);border-color:rgba(255,255,255,.18)}
.nxw-btn:active:not(:disabled){transform:scale(.97)}
.nxw-btn.primary{background:#fff;color:#08080f;border-color:#fff}
.nxw-btn.primary:hover:not(:disabled){background:#e6f7fb}
.nxw-btn.big{padding:12px 22px;font-size:15px}
.nxw-btn.ghost{background:transparent}
.nxw-btn.sm{padding:6px 11px;font-size:12px}
.nxw-btn.get{background:linear-gradient(135deg,var(--acc),var(--acc2));color:#04121a;border-color:transparent}
.nxw-btn.done{background:rgba(52,211,153,.14);color:var(--ok);border-color:rgba(52,211,153,.3)}
.nxw-btn.surprise{background:linear-gradient(135deg,#f472b6,var(--hot),var(--acc2));border:0;color:#fff;padding:12px 20px;font-size:15px;
  box-shadow:0 8px 30px rgba(168,85,247,.35)}
.nxw-link{background:none;border:0;color:var(--acc);font-weight:700;font-size:12px;padding:4px 6px}
.nxw-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:16px}

.nxw-filters{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:10px}
.nxw-seg{display:inline-flex;align-items:center;gap:2px;padding:3px;border-radius:999px;background:var(--panel);border:1px solid var(--line);color:var(--dim)}
.nxw-seg>svg{margin:0 6px}
.nxw-seg button{border:0;background:transparent;padding:7px 13px;border-radius:999px;font-weight:700;font-size:12.5px;color:var(--dim)}
.nxw-seg button.on{background:rgba(255,255,255,.12);color:var(--text)}
.nxw-chips{display:flex;flex-wrap:wrap;gap:8px}
.nxw-chips.moods{margin-bottom:18px}
.nxw-chip{border:1px solid var(--line);background:var(--panel);padding:7px 13px;border-radius:999px;font-weight:600;font-size:12.5px;color:var(--dim);transition:all .15s}
.nxw-chip:hover{color:var(--text);border-color:rgba(255,255,255,.2)}
.nxw-chip.on{background:linear-gradient(135deg,rgba(168,85,247,.3),rgba(77,124,255,.3));border-color:rgba(168,85,247,.6);color:#fff}
.nxw-chip.has-files{border-color:rgba(52,211,153,.5);color:#34d399;background:rgba(52,211,153,.1)}
.nxw-chip.has-files.on{background:linear-gradient(135deg,rgba(52,211,153,.3),rgba(168,85,247,.3));border-color:rgba(52,211,153,.7);color:#fff}

.nxw-tabs{display:flex;gap:4px;border-bottom:1px solid var(--line);margin-bottom:18px;overflow-x:auto}
.nxw-tabs button{background:none;border:0;padding:10px 14px;font-weight:800;font-size:14px;color:var(--dim);border-bottom:2px solid transparent;white-space:nowrap}
.nxw-tabs button.on{color:var(--text);border-bottom-color:var(--acc)}
.nxw-search{display:flex;align-items:center;gap:8px;min-width:min(420px,100%);flex:0 1 420px;padding:10px 14px;border-radius:14px;
  background:var(--panel);border:1px solid var(--line);color:var(--dim)}
.nxw-search:focus-within{border-color:var(--acc)}
.nxw-search input{flex:1;background:none;border:0;outline:0;color:var(--text);font:inherit;font-size:14px;min-width:0}
.nxw-search button{background:none;border:0;color:var(--dim);padding:2px}

/* hero */
.nxw-hero{position:relative;border-radius:22px;overflow:hidden;min-height:360px;margin-bottom:26px;background:#10101c center/cover no-repeat;
  display:flex;align-items:flex-end;border:1px solid var(--line);animation:nxwFade .5s ease}
.nxw-hero.skel{animation:nxwPulse 1.4s ease-in-out infinite}
.nxw-hero-shade{position:absolute;inset:0;background:linear-gradient(90deg,rgba(7,7,13,.97) 0%,rgba(7,7,13,.82) 38%,rgba(7,7,13,.25) 75%),
  linear-gradient(0deg,rgba(7,7,13,.9),transparent 55%)}
.nxw-hero-body{position:relative;display:flex;gap:26px;padding:34px;align-items:flex-end;width:100%}
.nxw-hero-poster{width:150px;flex:0 0 150px;aspect-ratio:2/3;border-radius:14px;overflow:hidden;box-shadow:0 20px 50px rgba(0,0,0,.6);background:var(--panel2)}
.nxw-hero-text{max-width:640px}
.nxw-hero h2{font-size:clamp(26px,3.6vw,44px);font-weight:900;letter-spacing:-.025em;margin:6px 0 10px;line-height:1.05}
.nxw-eyebrow{display:inline-block;font-size:11px;font-weight:900;letter-spacing:.12em;text-transform:uppercase;color:var(--acc)}
.nxw-hero-overview{color:rgba(244,245,251,.8);font-size:14.5px;margin:12px 0 0;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.nxw-hero-progress{height:4px;border-radius:4px;background:rgba(255,255,255,.15);margin-top:14px;max-width:360px;overflow:hidden}
.nxw-hero-progress i{display:block;height:100%;background:var(--acc)}
.nxw-hero.spinning{filter:blur(2px)}
.nxw-hero.discover{min-height:420px}
.nxw-dots{position:absolute;right:22px;bottom:18px;display:flex;gap:6px}
.nxw-dots button{width:8px;height:8px;border-radius:99px;border:0;background:rgba(255,255,255,.3);padding:0;transition:all .2s}
.nxw-dots button.on{width:22px;background:#fff}
.nxw-facts{display:flex;flex-wrap:wrap;gap:6px 12px;color:var(--dim);font-size:13px;font-weight:600;align-items:center}
.nxw-star{display:inline-flex;align-items:center;gap:4px;color:var(--warn);font-weight:800}

/* reel */
.nxw-reel{display:flex;justify-content:center;align-items:center;gap:18px;padding:30px 0;min-height:360px;margin-bottom:26px;
  border-radius:22px;background:radial-gradient(circle at center,rgba(168,85,247,.25),transparent 70%);border:1px solid var(--line)}
.nxw-reel-cell{width:130px;aspect-ratio:2/3;border-radius:14px;overflow:hidden;opacity:.35;transform:scale(.85);background:var(--panel2)}
.nxw-reel-cell.mid{opacity:1;transform:scale(1.15);box-shadow:0 0 0 3px var(--hot),0 20px 60px rgba(168,85,247,.5)}

/* rows and cards */
.nxw-row{margin-bottom:26px}
.nxw-row-head{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;margin-bottom:10px}
.nxw-row-head h3{font-size:17px;font-weight:850;margin:0;letter-spacing:-.01em}
.nxw-row-head p{margin:2px 0 0;color:var(--faint);font-size:12px}
.nxw-row-tools{display:flex;align-items:center;gap:6px}
.nxw-arrow{width:30px;height:30px;border-radius:99px;border:1px solid var(--line);background:var(--panel);display:grid;place-items:center;color:var(--dim)}
.nxw-arrow:hover{color:var(--text);background:var(--panel2)}
.nxw-strip{display:flex;gap:12px;overflow-x:auto;scroll-snap-type:x proximity;padding:4px 2px 10px;scrollbar-width:none}
.nxw-strip::-webkit-scrollbar{display:none}
.nxw-card{flex:0 0 156px;width:156px;scroll-snap-align:start;background:none;border:0;padding:0;text-align:left;border-radius:14px}
.nxw-card.wide{flex-basis:300px;width:300px}
.nxw-card.wide .nxw-poster{aspect-ratio:16/9}
.nxw-poster{position:relative;aspect-ratio:2/3;border-radius:14px;overflow:hidden;background:var(--panel2);border:1px solid var(--line);
  transition:transform .2s,box-shadow .2s,border-color .2s}
.nxw-card:hover .nxw-poster,.nxw-card:focus-visible .nxw-poster{transform:translateY(-3px) scale(1.03);border-color:rgba(34,211,238,.5);box-shadow:0 14px 34px rgba(0,0,0,.5)}
.nxw-card.skel .nxw-poster{animation:nxwPulse 1.4s ease-in-out infinite}
.nxw-poster-img{width:100%;height:100%;object-fit:cover;display:block}
.nxw-poster-fallback{width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:10px;
  color:var(--faint);text-align:center;font-size:12px;font-weight:700;background:linear-gradient(160deg,#1b1b2e,#0d0d16)}
.nxw-rating{position:absolute;top:7px;left:7px;display:inline-flex;align-items:center;gap:3px;padding:3px 7px;border-radius:99px;
  background:rgba(0,0,0,.72);color:var(--warn);font-size:11px;font-weight:800;backdrop-filter:blur(4px)}
.nxw-badge{position:absolute;bottom:7px;left:7px;display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border-radius:99px;font-size:10.5px;font-weight:800}
.nxw-badge.lib{background:rgba(52,211,153,.92);color:#03140d}
.nxw-badge.req{background:rgba(251,191,36,.92);color:#1a1200}
.nxw-progress{position:absolute;left:0;right:0;bottom:0;height:4px;background:rgba(255,255,255,.18)}
.nxw-progress i{display:block;height:100%;background:var(--acc)}
.nxw-hover{position:absolute;inset:0;display:grid;place-items:center;background:rgba(0,0,0,.35);opacity:0;transition:opacity .2s;color:#fff}
.nxw-card:hover .nxw-hover,.nxw-card:focus-visible .nxw-hover{opacity:1}
.nxw-card-title{margin-top:8px;font-weight:750;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nxw-card-sub{color:var(--faint);font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px}
.nxw-skel-line{width:180px;height:16px;border-radius:6px;background:var(--panel2);animation:nxwPulse 1.4s ease-in-out infinite}
.nxw-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:18px 14px}
.nxw-grid .nxw-card{width:auto}

.nxw-browse-filters{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px;padding:12px;border-radius:16px;background:var(--panel);border:1px solid var(--line)}
.nxw-browse-filters select{background:var(--panel2);color:var(--text);border:1px solid var(--line);border-radius:10px;padding:8px 10px;font:inherit;font-size:12.5px;font-weight:600}
.nxw-empty{padding:40px 16px;text-align:center;color:var(--dim);border:1px dashed var(--line);border-radius:18px;margin:10px 0 26px}
.nxw-empty .nxw-btn{margin-top:10px}

/* title sheet */
.nxw-sheet-wrap{position:fixed;inset:0;z-index:200;background:rgba(3,3,8,.78);backdrop-filter:blur(6px);display:flex;justify-content:center;
  align-items:flex-start;overflow-y:auto;padding:4vh 16px;animation:nxwFade .2s ease}
.nxw-sheet{position:relative;width:min(980px,100%);border-radius:24px;overflow:hidden;background:var(--bg);border:1px solid var(--line);
  box-shadow:0 30px 120px rgba(0,0,0,.7);color:var(--text);font-size:14px;animation:nxwRise .25s ease}
.nxw-sheet-hero{position:relative;aspect-ratio:21/9;background:#10101c center/cover no-repeat}
.nxw-sheet-hero::after{content:"";position:absolute;inset:0;background:linear-gradient(0deg,var(--bg),transparent 60%);pointer-events:none}
.nxw-trailer{position:absolute;inset:0;width:100%;height:100%;border:0;z-index:2}
.nxw-sheet-top{position:absolute;top:12px;left:12px;right:12px;display:flex;z-index:3}
.nxw-round{width:38px;height:38px;border-radius:99px;border:1px solid rgba(255,255,255,.2);background:rgba(0,0,0,.6);color:#fff;display:grid;place-items:center}
.nxw-sheet-body{padding:0 28px 28px;margin-top:-90px;position:relative;z-index:1}
.nxw-sheet-main{display:flex;gap:22px;align-items:flex-end}
.nxw-sheet-poster{width:160px;flex:0 0 160px;aspect-ratio:2/3;border-radius:14px;overflow:hidden;box-shadow:0 18px 50px rgba(0,0,0,.6);background:var(--panel2)}
.nxw-sheet-info h2{font-size:clamp(24px,3vw,36px);font-weight:900;margin:0 0 6px;letter-spacing:-.02em;line-height:1.1}
.nxw-tagline{color:var(--dim);font-style:italic;margin:0 0 8px}
.nxw-genres{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.nxw-genres span{padding:3px 10px;border-radius:99px;background:rgba(255,255,255,.07);border:1px solid var(--line);font-size:11.5px;font-weight:700;color:var(--dim)}
.nxw-providers{display:flex;align-items:center;gap:8px;margin-top:14px;color:var(--dim);font-size:12px;font-weight:700;flex-wrap:wrap}
.nxw-providers img{width:30px;height:30px;border-radius:8px}
.nxw-overview{color:rgba(244,245,251,.85);font-size:15px;line-height:1.6;margin:22px 0 8px;max-width:760px}
.nxw-cast{display:flex;gap:14px;overflow-x:auto;padding:12px 0 18px;scrollbar-width:none}
.nxw-person{flex:0 0 86px;text-align:center;font-size:11px}
.nxw-person img,.nxw-person-blank{width:72px;height:72px;border-radius:99px;object-fit:cover;display:grid;place-items:center;margin:0 auto 6px;background:var(--panel2);font-size:22px;font-weight:800;color:var(--faint)}
.nxw-person b{display:block;font-weight:750;line-height:1.2}
.nxw-person span{color:var(--faint);display:block;line-height:1.2;margin-top:2px}

/* season picker, popovers, toasts */
.nxw-pop{position:fixed;inset:0;z-index:260;background:rgba(0,0,0,.6);display:grid;place-items:center;padding:16px}
.nxw-pop-card{width:min(460px,100%);background:var(--panel);border:1px solid var(--line);border-radius:20px;padding:20px;color:var(--text);font-size:14px;box-shadow:0 30px 90px rgba(0,0,0,.6)}
.nxw-seasons-head{font-weight:850;font-size:16px;margin-bottom:12px}
.nxw-toasts{position:fixed;bottom:22px;left:50%;transform:translateX(-50%);z-index:300;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none}
.nxw-toast{padding:11px 18px;border-radius:14px;background:#11131f;border:1px solid rgba(52,211,153,.35);color:var(--text);font-weight:650;font-size:13px;
  box-shadow:0 14px 40px rgba(0,0,0,.5);animation:nxwRise .25s ease;max-width:90vw}
.nxw-toast.err{border-color:rgba(248,113,113,.5)}

@keyframes nxwPulse{0%,100%{opacity:.55}50%{opacity:.25}}
@keyframes nxwFade{from{opacity:0}to{opacity:1}}
@keyframes nxwRise{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}

@media (max-width:720px){
  .nxw-hero{min-height:0;border-radius:18px}
  .nxw-hero-body{flex-direction:column;align-items:flex-start;padding:22px 18px;gap:16px}
  .nxw-hero-poster{display:none}
  .nxw-hero-shade{background:linear-gradient(0deg,rgba(7,7,13,.98) 20%,rgba(7,7,13,.55) 70%,rgba(7,7,13,.3))}
  .nxw-hero.discover{min-height:380px}
  .nxw-card{flex-basis:124px;width:124px}
  .nxw-card.wide{flex-basis:240px;width:240px}
  .nxw-arrow{display:none}
  .nxw-grid{grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:14px 10px}
  .nxw-sheet-wrap{padding:0}
  .nxw-sheet{border-radius:0;min-height:100%}
  .nxw-sheet-body{padding:0 16px 24px;margin-top:-50px}
  .nxw-sheet-main{flex-direction:column;align-items:flex-start}
  .nxw-sheet-poster{width:110px;flex-basis:auto}
  .nxw-search{flex-basis:100%}
  .nxw-btn.surprise{width:100%;justify-content:center}
  .nxw-reel-cell{width:90px}
}
@media (prefers-reduced-motion:reduce){.nxw *{animation:none!important;transition:none!important}}
`;
