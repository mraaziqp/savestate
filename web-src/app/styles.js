// Styles for the screens in this module (sign-in, welcome, plans, setup
// guide). Shipped with the module because the app's compiled Tailwind only
// contains the classes the lost sources used. Everything is scoped under .nxa.
export const CSS = `
.nxa{--bg:#06061a;--panel:#0e0f1d;--panel2:#15172a;--line:rgba(255,255,255,.09);--text:#f4f5fb;--dim:rgba(244,245,251,.62);
  --faint:rgba(244,245,251,.38);--acc:#22d3ee;--acc2:#4d7cff;--hot:#a855f7;--ok:#34d399;--warn:#fbbf24;--bad:#fb7185;
  color:var(--text);font-size:14px;line-height:1.45;-webkit-font-smoothing:antialiased;text-align:left}
.nxa *{box-sizing:border-box}
.nxa h1,.nxa h2,.nxa h3,.nxa p{margin:0}
.nxa button{font:inherit;color:inherit;cursor:pointer}
.nxa button:disabled{cursor:default;opacity:.55}
.nxa a{color:var(--acc);text-decoration:none}
.nxa a:hover{text-decoration:underline}
.nxa :focus-visible{outline:2px solid var(--acc);outline-offset:2px}
.nxa-dim{color:var(--dim)}
.nxa-faint{color:var(--faint)}
.nxa-row{display:flex;align-items:center;gap:10px}
.nxa-wrap{flex-wrap:wrap}
.nxa-grow{flex:1;min-width:0}
.nxa-spin{animation:nxaSpin .8s linear infinite}
@keyframes nxaSpin{to{transform:rotate(360deg)}}
@keyframes nxaRise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}

.nxa-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:10px 16px;border-radius:12px;border:1px solid var(--line);
  background:rgba(255,255,255,.06);font-weight:700;font-size:13px;white-space:nowrap;transition:background .15s,border-color .15s,transform .1s}
.nxa-btn:hover:not(:disabled){background:rgba(255,255,255,.12);border-color:rgba(255,255,255,.2)}
.nxa-btn:active:not(:disabled){transform:scale(.98)}
.nxa-btn.primary{background:linear-gradient(135deg,var(--acc),var(--acc2));border-color:transparent;color:#03121a}
.nxa-btn.primary:hover:not(:disabled){filter:brightness(1.08);background:linear-gradient(135deg,var(--acc),var(--acc2))}
.nxa-btn.big{padding:13px 20px;font-size:15px;border-radius:14px;width:100%}
.nxa-btn.sm{padding:6px 11px;font-size:12px;border-radius:9px}
.nxa-btn.danger{color:var(--bad);border-color:rgba(251,113,133,.3)}
.nxa-btn.danger:hover:not(:disabled){background:rgba(251,113,133,.12)}
.nxa-btn.ok{color:var(--ok);border-color:rgba(52,211,153,.35);background:rgba(52,211,153,.1)}
.nxa-link{background:none;border:0;padding:0;color:var(--acc);font-weight:700;font-size:13px}
.nxa-link:hover{text-decoration:underline}

.nxa-field{display:flex;flex-direction:column;gap:6px}
.nxa-field>label,.nxa-label{font-size:12px;font-weight:700;color:var(--dim)}
.nxa-field>label i{font-style:normal;font-weight:500;color:var(--faint)}
.nxa-input{width:100%;padding:12px 14px;border-radius:12px;border:1px solid var(--line);background:rgba(0,0,0,.32);color:var(--text);
  font:inherit;font-size:15px;outline:0;transition:border-color .15s,box-shadow .15s}
.nxa-input::placeholder{color:var(--faint)}
.nxa-input:focus{border-color:var(--acc);box-shadow:0 0 0 3px rgba(34,211,238,.16)}
.nxa-input.bad{border-color:var(--bad)}
.nxa-input.sm{padding:8px 10px;font-size:13px;border-radius:9px}
select.nxa-input{appearance:none;padding-right:28px;background-image:linear-gradient(45deg,transparent 50%,var(--dim) 50%),linear-gradient(135deg,var(--dim) 50%,transparent 50%);
  background-position:calc(100% - 15px) 55%,calc(100% - 10px) 55%;background-size:5px 5px;background-repeat:no-repeat}
select.nxa-input option{background:#15172a;color:#f4f5fb}
.nxa-inwrap{position:relative}
.nxa-inwrap .nxa-input{padding-right:44px}
.nxa-eye{position:absolute;right:6px;top:50%;transform:translateY(-50%);background:none;border:0;padding:8px;color:var(--dim);border-radius:8px;display:flex}
.nxa-eye:hover{color:var(--text)}
.nxa-hint{font-size:12px;color:var(--faint);display:flex;align-items:center;gap:6px;min-height:16px}
.nxa-hint.ok{color:var(--ok)}
.nxa-hint.bad{color:var(--bad)}
.nxa-hint.warn{color:var(--warn)}
.nxa-meter{display:flex;gap:4px;margin-top:2px}
.nxa-meter i{flex:1;height:4px;border-radius:4px;background:rgba(255,255,255,.1);transition:background .2s}
.nxa-note{display:flex;gap:10px;align-items:flex-start;padding:11px 13px;border-radius:12px;font-size:13px;border:1px solid var(--line);background:rgba(255,255,255,.04)}
.nxa-note.bad{color:#fecdd3;background:rgba(251,113,133,.1);border-color:rgba(251,113,133,.3)}
.nxa-note.ok{color:#bbf7d0;background:rgba(52,211,153,.09);border-color:rgba(52,211,153,.3)}
.nxa-note.warn{color:#fde68a;background:rgba(251,191,36,.08);border-color:rgba(251,191,36,.28)}
.nxa-note svg{flex:none;margin-top:1px}

/* sign-in */
.nxa-auth{display:flex;flex-direction:column;gap:16px;animation:nxaRise .25s ease}
.nxa-auth.card{padding:28px;border-radius:22px;border:1px solid var(--line);background:linear-gradient(180deg,rgba(255,255,255,.06),rgba(255,255,255,.02));
  box-shadow:0 24px 64px rgba(0,0,0,.5);backdrop-filter:blur(18px)}
.nxa-auth h2{font-size:22px;font-weight:800;letter-spacing:-.01em}
.nxa-auth form{display:flex;flex-direction:column;gap:14px}
.nxa-tabs{display:flex;padding:4px;gap:4px;border-radius:13px;background:rgba(0,0,0,.35);border:1px solid var(--line)}
.nxa-tabs button{flex:1;padding:9px 10px;border:0;border-radius:10px;background:none;font-weight:700;font-size:13px;color:var(--dim)}
.nxa-tabs button.on{background:rgba(255,255,255,.12);color:var(--text)}
.nxa-auth-foot{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;font-size:13px}

/* welcome */
.nxa-welcome{position:fixed;inset:0;z-index:5000;overflow:auto;background:
  radial-gradient(ellipse 90% 60% at 12% 8%,rgba(77,124,255,.2),transparent 60%),
  radial-gradient(ellipse 70% 60% at 90% 95%,rgba(168,85,247,.16),transparent 60%),#06061a}
.nxa-welcome-in{min-height:100%;display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,.95fr);gap:56px;align-items:center;
  max-width:1120px;margin:0 auto;padding:48px 28px}
.nxa-brand{display:flex;align-items:center;gap:12px;font-weight:900;letter-spacing:.14em;font-size:13px;text-transform:uppercase}
.nxa-brand span{width:38px;height:38px;border-radius:12px;display:grid;place-items:center;background:linear-gradient(135deg,var(--acc2),var(--hot));letter-spacing:0}
.nxa-welcome h1{font-size:clamp(30px,4.4vw,50px);line-height:1.04;font-weight:900;letter-spacing:-.03em;margin:26px 0 14px;
  background:linear-gradient(135deg,#fff 0%,#c4d4ff 55%,#a78bfa 100%);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.nxa-welcome-lede{font-size:17px;color:var(--dim);max-width:460px}
.nxa-points{display:grid;gap:14px;margin-top:30px;max-width:460px}
.nxa-point{display:flex;gap:14px;align-items:flex-start}
.nxa-point>span{flex:none;width:38px;height:38px;border-radius:11px;display:grid;place-items:center;background:rgba(255,255,255,.06);border:1px solid var(--line);color:var(--acc)}
.nxa-point b{display:block;font-size:14.5px}
.nxa-point p{font-size:13px;color:var(--dim)}
.nxa-welcome-side{width:100%;max-width:430px;justify-self:end}
.nxa-welcome-links{display:flex;gap:18px;justify-content:center;margin-top:18px;font-size:13px;flex-wrap:wrap}
@media (max-width:860px){
  .nxa-welcome-in{grid-template-columns:1fr;gap:28px;padding:28px 18px 40px}
  .nxa-welcome-side{justify-self:stretch;max-width:none}
  .nxa-points{display:none}
  .nxa-welcome h1{margin-top:18px}
}

/* pages */
.nxa-page{width:100%;max-width:1180px;margin:0 auto;padding:0 0 56px;display:flex;flex-direction:column;gap:22px}
.nxa-card{border:1px solid var(--line);border-radius:18px;background:rgba(255,255,255,.03);padding:20px}
.nxa-card h3{font-size:16px;font-weight:800}
.nxa-card-head{display:flex;justify-content:space-between;align-items:flex-start;gap:14px;flex-wrap:wrap;margin-bottom:14px}
.nxa-sub{font-size:13px;color:var(--dim);margin-top:3px}
.nxa-seg{display:inline-flex;padding:4px;gap:4px;border-radius:12px;background:rgba(0,0,0,.35);border:1px solid var(--line);flex-wrap:wrap}
.nxa-seg button{padding:8px 14px;border:0;border-radius:9px;background:none;font-weight:700;font-size:13px;color:var(--dim);display:flex;align-items:center;gap:7px}
.nxa-seg button.on{background:rgba(255,255,255,.12);color:var(--text)}
.nxa-pill{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:999px;font-size:11px;font-weight:800;border:1px solid var(--line);color:var(--dim);white-space:nowrap}
.nxa-pill.ok{color:var(--ok);border-color:rgba(52,211,153,.35);background:rgba(52,211,153,.08)}
.nxa-pill.warn{color:var(--warn);border-color:rgba(251,191,36,.35);background:rgba(251,191,36,.08)}
.nxa-pill.acc{color:var(--acc);border-color:rgba(34,211,238,.35);background:rgba(34,211,238,.08)}
.nxa-pill.bad{color:var(--bad);border-color:rgba(251,113,133,.35);background:rgba(251,113,133,.08)}
.nxa-count{min-width:18px;height:18px;padding:0 5px;border-radius:99px;background:var(--bad);color:#fff;font-size:11px;font-weight:800;display:inline-grid;place-items:center}

/* plans */
.nxa-tiers{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px}
.nxa-tier{position:relative;border:1px solid var(--line);border-radius:20px;padding:22px;background:rgba(255,255,255,.03);display:flex;flex-direction:column;gap:14px}
.nxa-tier.current{border-color:var(--tc,var(--acc));box-shadow:0 0 0 1px var(--tc,var(--acc)) inset,0 18px 50px rgba(0,0,0,.35)}
.nxa-tier-name{font-size:18px;font-weight:900;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.nxa-tier-name i{width:10px;height:10px;border-radius:99px;background:var(--tc,var(--acc))}
.nxa-price{font-size:30px;font-weight:900;letter-spacing:-.02em}
.nxa-price small{font-size:13px;font-weight:600;color:var(--dim);letter-spacing:0}
.nxa-list{list-style:none;margin:0;padding:0;display:grid;gap:8px;font-size:13px}
.nxa-list li{display:flex;gap:8px;align-items:flex-start}
.nxa-list li svg{flex:none;margin-top:2px;color:var(--ok)}
.nxa-list li.off{color:var(--faint)}
.nxa-list li.off svg{color:var(--faint)}

/* tables */
.nxa-scroll{overflow-x:auto;margin:0 -4px;padding:0 4px}
.nxa-table{width:100%;border-collapse:collapse;font-size:13px}
.nxa-table th{font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--faint);padding:8px 10px;text-align:left;white-space:nowrap}
.nxa-table td{padding:10px;border-top:1px solid var(--line);vertical-align:middle}
.nxa-table th.c,.nxa-table td.c{text-align:center}
.nxa-table tr.group td{border-top:0;padding-top:16px;font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--acc)}
.nxa-check{width:20px;height:20px;accent-color:#22d3ee;cursor:pointer}
.nxa-check:disabled{opacity:.3;cursor:default}
.nxa-switch{position:relative;width:38px;height:22px;border-radius:99px;border:0;background:rgba(255,255,255,.16);padding:0;transition:background .15s;flex:none}
.nxa-switch::after{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:99px;background:#fff;transition:transform .15s}
.nxa-switch.on{background:var(--acc)}
.nxa-switch.on::after{transform:translateX(16px)}
.nxa-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}
.nxa-form .wide{grid-column:1/-1}
.nxa-user{display:flex;align-items:center;gap:10px;min-width:150px}
.nxa-avatar{width:30px;height:30px;border-radius:99px;display:grid;place-items:center;font-weight:800;font-size:12px;background:linear-gradient(135deg,var(--acc2),var(--hot));flex:none}

/* locked tab + setup guide */
.nxa-locked{display:flex;flex-direction:column;align-items:center;text-align:center;gap:14px;padding:56px 20px;max-width:520px;margin:0 auto;animation:nxaRise .25s ease}
.nxa-locked>span{width:64px;height:64px;border-radius:20px;display:grid;place-items:center;background:rgba(255,255,255,.06);border:1px solid var(--line);color:var(--warn)}
.nxa-locked h2{font-size:22px;font-weight:900}
.nxa-gate-on ~ *{display:none !important}
.nxa-steps{counter-reset:nxa;display:grid;gap:12px}
.nxa-step{counter-increment:nxa;display:flex;gap:14px;align-items:flex-start}
.nxa-step::before{content:counter(nxa);flex:none;width:28px;height:28px;border-radius:99px;display:grid;place-items:center;font-weight:900;font-size:13px;
  background:linear-gradient(135deg,var(--acc),var(--acc2));color:#03121a}
.nxa-step b{display:block}
.nxa-step p{font-size:13px;color:var(--dim);margin-top:2px}
.nxa-sys{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}
.nxa-sys button{display:flex;flex-direction:column;gap:3px;align-items:flex-start;padding:11px 13px;border-radius:13px;border:1px solid var(--line);background:rgba(255,255,255,.03);text-align:left}
.nxa-sys button:hover{background:rgba(255,255,255,.08)}
.nxa-sys button.on{border-color:var(--acc);background:rgba(34,211,238,.08)}
.nxa-sys button b{font-size:13.5px}
.nxa-sys button small{font-size:11px;color:var(--faint)}
.nxa-kv{display:grid;grid-template-columns:130px 1fr;gap:8px 14px;font-size:13px}
.nxa-kv dt{color:var(--faint);font-weight:700}
.nxa-kv dd{margin:0;min-width:0}
.nxa-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;padding:2px 6px;border-radius:6px;background:rgba(255,255,255,.08);word-break:break-all}
.nxa-files{display:grid;gap:8px}
.nxa-file{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border-radius:11px;border:1px solid var(--line);background:rgba(0,0,0,.2);font-size:13px}
.nxa-file small{display:block;color:var(--faint);font-size:11.5px;margin-top:2px;word-break:break-all}
@media (max-width:640px){.nxa-kv{grid-template-columns:1fr;gap:2px 0}.nxa-kv dd{margin-bottom:8px}.nxa-card{padding:16px}}
`;
