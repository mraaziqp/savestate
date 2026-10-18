import{o as de}from"./rolldown-runtime-CfSZB2vO-r114.js";
import{C as oe,Ct as xe,Er as me,H as he,I as O,N as pe,Nt as ue,Rn as fe,Tr as T,Z as be,f as ge,i as F,ln as je,nt as G,on as Ne,pt as we,rr as ve}from"./vendor-icons-Btsoypng-r114.js";
import{t as ye}from"./vendor-react-C_B4NnYc-r114.js";
import{t as ke}from"./AuthForm-DkTnlyN8-r114.js";

var l=de(me(),1),e=ye();

function z(s){
  if(!s||isNaN(s))return"0 B";
  return s>=1e9?`${(s/1e9).toFixed(2)} GB`:s>=1e6?`${(s/1e6).toFixed(1)} MB`:s>=1e3?`${(s/1e3).toFixed(0)} KB`:`${s} B`;
}

// Preset avatars for quick 1-click selection
var PRESET_AVATARS=[
  {label:"Cyberpunk",url:"https://images.unsplash.com/photo-1578632767115-351597cf2477?w=150&auto=format&fit=crop&q=80"},
  {label:"Pixel Retro",url:"https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=150&auto=format&fit=crop&q=80"},
  {label:"Arcade Neon",url:"https://images.unsplash.com/photo-1511512578047-dfb367046420?w=150&auto=format&fit=crop&q=80"},
  {label:"Synthwave",url:"https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=150&auto=format&fit=crop&q=80"},
  {label:"Game Master",url:"https://images.unsplash.com/photo-1563089145-599997674d42?w=150&auto=format&fit=crop&q=80"},
  {label:"Mecha",url:"https://images.unsplash.com/photo-1607604276583-eef5d076aa5f?w=150&auto=format&fit=crop&q=80"}
];

var Be=({user:s,onLogin:Q,onRegister:H,onLogout:W,onUpdateProfile:m,onLoginSuccess:J})=>{
  const[d,K]=(0,l.useState)(null),
       [X,u]=(0,l.useState)(!1),
       [i,Z]=(0,l.useState)(null),
       [f,V]=(0,l.useState)([]),
       [Y,h]=(0,l.useState)(!1),
       [b,g]=(0,l.useState)(""),
       [j,N]=(0,l.useState)(""),
       [w,v]=(0,l.useState)(""),
       [y,k]=(0,l.useState)(""),
       [S,C]=(0,l.useState)(!1),
       [A,p]=(0,l.useState)(""),
       [L,ee]=(0,l.useState)([]),
       [B,_]=(0,l.useState)(!1),
       [r,te]=(0,l.useState)([]),
       [E,P]=(0,l.useState)(!1),
       [D,I]=(0,l.useState)(""),
       [c,o]=(0,l.useState)(null),
       [U,$]=(0,l.useState)(!1),
       [x,se]=(0,l.useState)([]),
       [R,q]=(0,l.useState)(!1),
       [activeTab,setActiveTab]=(0,l.useState)("overview");

  const ae=s?.username==="mraaziqp"||s?.role==="admin"||s?.role==="ultra_admin";

  (0,l.useEffect)(()=>{
    if(s){
      fetch("/api/network/info").then(a=>a.json()).then(K).catch(()=>{});
      const t=localStorage.getItem("nexus_token"),n=t?{Authorization:`Bearer ${t}`}:void 0;
      fetch(`/api/profiles/${encodeURIComponent(s.id)}/dashboard`,{headers:n})
        .then(a=>a.ok?a.json():null).then(a=>{a&&Z(a);}).catch(()=>{});
      fetch(`/api/profiles/${encodeURIComponent(s.id)}/saves`,{headers:n})
        .then(a=>a.ok?a.json():null).then(a=>{V(Array.isArray(a?.saves)?a.saves:[]);}).catch(()=>{});
      _(!0);
      fetch(`/api/profiles/${encodeURIComponent(s.id)}/activity-log`,{headers:n})
        .then(a=>a.ok?a.json():null).then(a=>{ee(Array.isArray(a?.log)?a.log:[]);}).catch(()=>{}).finally(()=>_(!1));
    }
  },[s]);

  const le=async()=>{
    const t=d?.urls?.[0];
    if(t){
      await navigator.clipboard.writeText(t);
      u(!0);
      setTimeout(()=>u(!1),2000);
    }
  };

  const M=(0,l.useCallback)(async()=>{
    const t=localStorage.getItem("nexus_token");
    if(t){
      P(!0);I("");
      try{
        const n=await fetch("/api/admin/users",{headers:{Authorization:`Bearer ${t}`}}),
              a=await n.json();
        if(!n.ok)throw new Error(a.error??"Failed to load users");
        te(a.users??[]);
      }catch(n){
        I(n.message);
      }finally{
        P(!1);
      }
    }
  },[]);

  const ne=(0,l.useCallback)(async()=>{
    const t=localStorage.getItem("nexus_token");
    if(t){
      q(!0);
      try{
        const n=await fetch("/api/admin/activity-logs",{headers:{Authorization:`Bearer ${t}`}}),
              a=await n.json();
        if(!n.ok)throw new Error(a.error??"Failed to load logs");
        se(a.logs??[]);
      }catch{}finally{
        q(!1);
      }
    }
  },[]);

  const ie=async()=>{
    if(!c)return;
    const t=localStorage.getItem("nexus_token");
    if(t){
      $(!0);
      try{
        const n=await fetch(`/api/admin/users/${encodeURIComponent(c.userId)}/quota`,{
          method:"PUT",
          headers:{"Content-Type":"application/json",Authorization:`Bearer ${t}`},
          body:JSON.stringify({quotaBytes:c.bytes})
        });
        if(n.ok){
          te(a=>a.map(u=>u.id===c.userId?{...u,quotaBytes:c.bytes}:u));
          o(null);
        }
      }catch{}finally{
        $(!1);
      }
    }
  };

  // Unauthenticated Portal View
  if(!s){
    return (0,e.jsxs)("div",{
      className:"max-w-xl mx-auto py-6 sm:py-10 space-y-8 animate-[nxwFade_0.3s_ease]",
      children:[
        // Portal Header
        (0,e.jsxs)("div",{
          className:"text-center space-y-3",
          children:[
            (0,e.jsxs)("div",{
              className:"inline-flex items-center gap-2 px-3 py-1 rounded-full bg-cyan-500/10 border border-cyan-400/30 text-[10px] font-black uppercase tracking-widest text-cyan-300 shadow-[0_0_16px_rgba(34,211,238,0.2)]",
              children:[(0,e.jsx)("span",{className:"w-1.5 h-1.5 rounded-full bg-cyan-400 animate-ping"})," SaveState Cloud Gateway"]
            }),
            (0,e.jsx)("h2",{
              className:"text-3xl sm:text-4xl font-black italic uppercase tracking-tight text-white",
              children:"Player Identification"
            }),
            (0,e.jsx)("p",{
              className:"text-xs sm:text-sm text-white/50 max-w-md mx-auto leading-relaxed",
              children:"Authenticate to roam save states across devices, access your host PC's lossless audio, and unlock remote netplay."
            })
          ]
        }),

        // AuthForm component
        (0,e.jsx)(ke,{onLogin:Q,onRegister:H,onSuccess:J,variant:"full"}),

        // Feature highlights cards
        (0,e.jsxs)("div",{
          className:"grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2",
          children:[
            (0,e.jsxs)("div",{
              className:"p-3.5 rounded-2xl bg-white/[0.02] border border-white/5 space-y-1 text-center sm:text-left",
              children:[
                (0,e.jsx)("p",{className:"text-xs font-bold text-white flex items-center justify-center sm:justify-start gap-1.5",children:["🕹️"," Roaming Saves"]}),
                (0,e.jsx)("p",{className:"text-[10px] text-white/40 leading-relaxed",children:"Slot states sync automatically across PC, TV and mobile."})
              ]
            }),
            (0,e.jsxs)("div",{
              className:"p-3.5 rounded-2xl bg-white/[0.02] border border-white/5 space-y-1 text-center sm:text-left",
              children:[
                (0,e.jsx)("p",{className:"text-xs font-bold text-white flex items-center justify-center sm:justify-start gap-1.5",children:["🎵"," Lossless Music"]}),
                (0,e.jsx)("p",{className:"text-[10px] text-white/40 leading-relaxed",children:"Stream 1,900+ tracks paired with high-res Deezer artwork."})
              ]
            }),
            (0,e.jsxs)("div",{
              className:"p-3.5 rounded-2xl bg-white/[0.02] border border-white/5 space-y-1 text-center sm:text-left",
              children:[
                (0,e.jsx)("p",{className:"text-xs font-bold text-white flex items-center justify-center sm:justify-start gap-1.5",children:["⚡"," Zero-Config"]}),
                (0,e.jsx)("p",{className:"text-[10px] text-white/40 leading-relaxed",children:"Instant local and tunnel connection with zero port forwarding."})
              ]
            })
          ]
        }),

        // Guest info
        (0,e.jsxs)("p",{
          className:"text-center text-[10px] text-white/35 leading-relaxed pt-2",
          children:[
            "Local library and gameplay are available offline without an account.",
            (0,e.jsx)("br",{}),
            "Sign in when you want multi-device synchronization."
          ]
        })
      ]
    });
  }

  // Edit profile toggle
  const re=()=>{
    g(s.display_name??"");
    N(s.bio??"");
    v(s.avatar??"");
    k(s.favorite_platform??"");
    p("");
    h(!Y);
  };

  const ce=async()=>{
    if(m){
      C(!0);p("");
      try{
        await m({
          display_name:b||void 0,
          bio:j||void 0,
          avatar:w||void 0,
          favorite_platform:y||void 0
        });
        h(!1);
      }catch(t){
        p(t.message);
      }finally{
        C(!1);
      }
    }
  };

  const roleBadgeStyle=s?.role==="ultra_admin"
    ?"bg-gradient-to-r from-amber-500/20 to-yellow-500/20 text-yellow-300 border-yellow-500/40 shadow-[0_0_12px_rgba(234,179,8,0.2)]"
    :s?.role==="admin"
    ?"bg-gradient-to-r from-rose-500/20 to-red-500/20 text-rose-300 border-rose-500/40 shadow-[0_0_12px_rgba(244,63,94,0.2)]"
    :"bg-white/10 text-cyan-300 border-cyan-500/30";

  // Authenticated Profile View
  return (0,e.jsxs)("div",{
    className:"max-w-4xl mx-auto space-y-6 pb-16 animate-[nxwFade_0.25s_ease]",
    children:[
      // Hero Profile Card
      (0,e.jsxs)("div",{
        className:"relative overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-b from-white/[0.08] via-white/[0.03] to-transparent p-6 sm:p-8 backdrop-blur-2xl shadow-[0_20px_50px_rgba(0,0,0,0.4)]",
        children:[
          // Ambient background glow
          (0,e.jsx)("div",{
            className:"absolute -top-20 -right-20 w-64 h-64 bg-cyan-500/15 rounded-full blur-3xl pointer-events-none"
          }),
          (0,e.jsx)("div",{
            className:"absolute -bottom-20 -left-20 w-64 h-64 bg-purple-500/15 rounded-full blur-3xl pointer-events-none"
          }),

          (0,e.jsxs)("div",{
            className:"relative z-10 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6",
            children:[
              // Avatar & User Stack
              (0,e.jsxs)("div",{
                className:"flex items-center gap-5",
                children:[
                  (0,e.jsxs)("div",{
                    className:"relative w-20 h-20 rounded-2xl overflow-hidden border-2 border-cyan-400/50 shadow-[0_0_24px_rgba(34,211,238,0.35)] flex-shrink-0 bg-black/40 flex items-center justify-center group",
                    children:[
                      s.avatar
                        ?(0,e.jsx)("img",{src:s.avatar,alt:"avatar",className:"w-full h-full object-cover transition-transform duration-300 group-hover:scale-110"})
                        :(0,e.jsx)("span",{className:"text-3xl font-black bg-gradient-to-br from-cyan-300 to-purple-400 bg-clip-text text-transparent",children:(s.display_name||s.username)[0].toUpperCase()}),
                      (0,e.jsx)("span",{
                        className:"absolute bottom-1 right-1 w-3.5 h-3.5 rounded-full bg-emerald-400 border-2 border-black shadow-[0_0_8px_rgba(52,211,153,0.8)]",
                        title:"Online & Synced"
                      })
                    ]
                  }),

                  (0,e.jsxs)("div",{
                    className:"space-y-1 min-w-0",
                    children:[
                      (0,e.jsxs)("div",{
                        className:"flex items-center gap-2.5 flex-wrap",
                        children:[
                          (0,e.jsx)("h3",{
                            className:"font-black text-xl sm:text-2xl text-white tracking-tight truncate",
                            children:s.display_name||s.username
                          }),
                          (0,e.jsx)("span",{
                            className:`text-[9px] font-black uppercase px-2.5 py-0.5 rounded-full border tracking-widest ${roleBadgeStyle}`,
                            children:s.role==="ultra_admin"?"Ultra Admin":s.role==="admin"?"Administrator":"Verified Player"
                          })
                        ]
                      }),
                      (0,e.jsxs)("p",{
                        className:"text-xs font-mono text-cyan-400/80 flex items-center gap-1",
                        children:["@",s.username]
                      }),
                      s.bio&&(0,e.jsx)("p",{
                        className:"text-xs text-white/60 line-clamp-2 italic pt-0.5 max-w-md",
                        children:s.bio
                      }),
                      s.favorite_platform&&(0,e.jsxs)("div",{
                        className:"inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-lg bg-white/[0.04] border border-white/10 text-[10px] text-white/70 font-bold",
                        children:[
                          (0,e.jsx)(pe,{className:"w-3 h-3 text-amber-400"}),
                          (0,e.jsx)("span",{children:s.favorite_platform})
                        ]
                      })
                    ]
                  })
                ]
              }),

              // Action Buttons
              (0,e.jsxs)("div",{
                className:"flex sm:flex-col gap-2 w-full sm:w-auto flex-shrink-0 pt-2 sm:pt-0",
                children:[
                  m&&(0,e.jsxs)("button",{
                    onClick:re,
                    className:`flex-1 sm:flex-initial flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold border transition-all duration-200 ${
                      Y
                        ?"bg-cyan-500/20 border-cyan-400 text-cyan-300 shadow-[0_0_16px_rgba(34,211,238,0.3)]"
                        :"bg-white/5 hover:bg-white/10 border-white/10 text-white"
                    }`,
                    children:[(0,e.jsx)(we,{className:"w-3.5 h-3.5"}),Y?"Close Editor":"Edit Profile"]
                  }),
                  (0,e.jsxs)("button",{
                    onClick:W,
                    className:"flex-1 sm:flex-initial flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 border border-rose-500/20 hover:border-rose-500/40 transition-all duration-200",
                    children:[(0,e.jsx)(ue,{className:"w-3.5 h-3.5"}),"Sign Out"]
                  })
                ]
              })
            ]
          }),

          // Expandable Edit Profile Panel
          Y&&(0,e.jsxs)("div",{
            className:"mt-6 pt-6 border-t border-white/10 space-y-4 animate-[nxwRise_0.2s_ease]",
            children:[
              (0,e.jsxs)("div",{
                className:"flex items-center justify-between",
                children:[
                  (0,e.jsx)("p",{className:"text-[10px] font-black uppercase tracking-widest text-cyan-400",children:"Profile Customization"}),
                  (0,e.jsx)("span",{className:"text-[10px] text-white/40",children:"Click a preset avatar or paste your own URL"})
                ]
              }),

              // Preset Avatars Selector
              (0,e.jsxs)("div",{
                className:"space-y-1.5",
                children:[
                  (0,e.jsx)("label",{className:"text-[10px] text-white/50 font-bold uppercase",children:"Instant Avatar Presets"}),
                  (0,e.jsx)("div",{
                    className:"flex gap-2.5 overflow-x-auto pb-1 scrollbar-none",
                    children:PRESET_AVATARS.map((p,idx)=>(0,e.jsxs)("button",{
                      key:idx,
                      type:"button",
                      onClick:()=>v(p.url),
                      className:`flex flex-col items-center gap-1 flex-shrink-0 p-1.5 rounded-xl border transition-all ${
                        w===p.url
                          ?"border-cyan-400 bg-cyan-500/20 scale-105 shadow-[0_0_12px_rgba(34,211,238,0.4)]"
                          :"border-white/10 bg-white/5 hover:border-white/25"
                      }`,
                      children:[
                        (0,e.jsx)("img",{src:p.url,alt:p.label,className:"w-10 h-10 rounded-lg object-cover"}),
                        (0,e.jsx)("span",{className:"text-[9px] text-white/60 font-semibold",children:p.label})
                      ]
                    }))
                  })
                ]
              }),

              (0,e.jsxs)("div",{
                className:"grid grid-cols-1 sm:grid-cols-2 gap-3",
                children:[
                  (0,e.jsxs)("div",{
                    children:[
                      (0,e.jsx)("label",{className:"text-[10px] text-white/50 font-bold uppercase",children:"Display Name"}),
                      (0,e.jsx)("input",{
                        value:b,
                        onChange:t=>g(t.target.value),
                        placeholder:"e.g. Master Chief",
                        className:"mt-1 w-full bg-black/40 border border-white/10 rounded-xl px-3.5 py-2.5 text-sm text-white placeholder-white/20 focus:outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400/30 transition-all"
                      })
                    ]
                  }),
                  (0,e.jsxs)("div",{
                    children:[
                      (0,e.jsx)("label",{className:"text-[10px] text-white/50 font-bold uppercase",children:"Favourite Platform"}),
                      (0,e.jsx)("input",{
                        value:y,
                        onChange:t=>k(t.target.value),
                        placeholder:"e.g. SNES, PS1, GBA, PC",
                        className:"mt-1 w-full bg-black/40 border border-white/10 rounded-xl px-3.5 py-2.5 text-sm text-white placeholder-white/20 focus:outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400/30 transition-all"
                      })
                    ]
                  })
                ]
              }),

              (0,e.jsxs)("div",{
                children:[
                  (0,e.jsx)("label",{className:"text-[10px] text-white/50 font-bold uppercase",children:"Bio"}),
                  (0,e.jsx)("textarea",{
                    value:j,
                    onChange:t=>N(t.target.value),
                    rows:2,
                    placeholder:"Tell other players about your favorite titles or gaming setup...",
                    className:"mt-1 w-full bg-black/40 border border-white/10 rounded-xl px-3.5 py-2.5 text-sm text-white placeholder-white/20 focus:outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400/30 transition-all resize-none"
                  })
                ]
              }),

              (0,e.jsxs)("div",{
                children:[
                  (0,e.jsx)("label",{className:"text-[10px] text-white/50 font-bold uppercase",children:"Custom Avatar URL"}),
                  (0,e.jsx)("input",{
                    value:w,
                    onChange:t=>v(t.target.value),
                    placeholder:"https://... (Direct image link)",
                    className:"mt-1 w-full bg-black/40 border border-white/10 rounded-xl px-3.5 py-2.5 text-sm font-mono text-white placeholder-white/20 focus:outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400/30 transition-all"
                  })
                ]
              }),

              A&&(0,e.jsx)("p",{className:"text-xs text-rose-400 bg-rose-500/10 px-3 py-2 rounded-xl",children:A}),

              (0,e.jsxs)("div",{
                className:"flex gap-2.5 pt-1",
                children:[
                  (0,e.jsxs)("button",{
                    onClick:ce,
                    disabled:S,
                    className:"flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-nexus-accent to-cyan-400 text-black rounded-xl text-xs font-black hover:shadow-[0_0_20px_rgba(34,211,238,0.4)] disabled:opacity-50 transition-all",
                    children:[
                      S?(0,e.jsx)("span",{className:"w-3 h-3 border-2 border-black/30 border-t-black rounded-full animate-spin"}):(0,e.jsx)(be,{className:"w-3.5 h-3.5"}),
                      "Save Profile Changes"
                    ]
                  }),
                  (0,e.jsxs)("button",{
                    onClick:()=>h(!1),
                    className:"flex items-center gap-1.5 px-4 py-2.5 bg-white/5 hover:bg-white/10 text-white rounded-xl text-xs font-bold transition-all",
                    children:[(0,e.jsx)(F,{className:"w-3 h-3"})," Cancel"]
                  })
                ]
              })
            ]
          })
        ]
      }),

      // Holographic Stat Tiles
      (0,e.jsxs)("div",{
        className:"grid grid-cols-2 sm:grid-cols-4 gap-3",
        children:[
          (0,e.jsxs)("div",{
            className:"p-4 rounded-2xl border border-white/10 bg-gradient-to-b from-white/[0.05] to-transparent backdrop-blur-xl relative overflow-hidden group hover:border-cyan-400/40 transition-colors",
            children:[
              (0,e.jsx)("p",{className:"text-[10px] uppercase font-black tracking-widest text-white/40",children:"Games Played"}),
              (0,e.jsx)("p",{className:"text-2xl font-black text-white mt-1 group-hover:text-cyan-400 transition-colors",children:i?.summary?.gamesPlayed??0}),
              (0,e.jsx)("div",{className:"absolute -right-4 -bottom-4 w-14 h-14 bg-cyan-500/10 rounded-full blur-xl group-hover:bg-cyan-500/20 transition-all"})
            ]
          }),
          (0,e.jsxs)("div",{
            className:"p-4 rounded-2xl border border-white/10 bg-gradient-to-b from-white/[0.05] to-transparent backdrop-blur-xl relative overflow-hidden group hover:border-purple-400/40 transition-colors",
            children:[
              (0,e.jsx)("p",{className:"text-[10px] uppercase font-black tracking-widest text-white/40",children:"Playtime"}),
              (0,e.jsxs)("p",{className:"text-2xl font-black text-white mt-1 group-hover:text-purple-400 transition-colors",children:[Math.round((i?.summary?.totalPlaytimeSeconds??0)/3600)," hrs"]}),
              (0,e.jsx)("div",{className:"absolute -right-4 -bottom-4 w-14 h-14 bg-purple-500/10 rounded-full blur-xl group-hover:bg-purple-500/20 transition-all"})
            ]
          }),
          (0,e.jsxs)("div",{
            className:"p-4 rounded-2xl border border-white/10 bg-gradient-to-b from-white/[0.05] to-transparent backdrop-blur-xl relative overflow-hidden group hover:border-amber-400/40 transition-colors",
            children:[
              (0,e.jsx)("p",{className:"text-[10px] uppercase font-black tracking-widest text-white/40",children:"Achievements"}),
              (0,e.jsx)("p",{className:"text-2xl font-black text-white mt-1 group-hover:text-amber-400 transition-colors",children:i?.achievements?.length??0}),
              (0,e.jsx)("div",{className:"absolute -right-4 -bottom-4 w-14 h-14 bg-amber-500/10 rounded-full blur-xl group-hover:bg-amber-500/20 transition-all"})
            ]
          }),
          (0,e.jsxs)("div",{
            className:"p-4 rounded-2xl border border-white/10 bg-gradient-to-b from-white/[0.05] to-transparent backdrop-blur-xl relative overflow-hidden group hover:border-emerald-400/40 transition-colors",
            children:[
              (0,e.jsx)("p",{className:"text-[10px] uppercase font-black tracking-widest text-white/40",children:"Cloud Saves"}),
              (0,e.jsx)("p",{className:"text-2xl font-black text-white mt-1 group-hover:text-emerald-400 transition-colors",children:f.length}),
              (0,e.jsx)("div",{className:"absolute -right-4 -bottom-4 w-14 h-14 bg-emerald-500/10 rounded-full blur-xl group-hover:bg-emerald-500/20 transition-all"})
            ]
          })
        ]
      }),

      // Profile Content Tabs
      (0,e.jsxs)("div",{
        className:"space-y-4",
        children:[
          (0,e.jsx)("div",{
            className:"flex gap-2 border-b border-white/10 pb-3 overflow-x-auto scrollbar-none",
            children:[
              ["overview","Dashboard"],
              ["saves","Cloud Saves ("+f.length+")"],
              ["devices","Pairing & Access"],
              ["activity","Timeline"],
              ...(ae?[["admin","Admin Console"]]:[])
            ].map(([tabKey,tabLabel])=>(0,e.jsx)("button",{
              key:tabKey,
              onClick:()=>setActiveTab(tabKey),
              className:`px-4 py-2 rounded-xl text-xs font-black uppercase tracking-wider transition-all duration-200 whitespace-nowrap ${
                activeTab===tabKey
                  ?"bg-gradient-to-r from-cyan-500/20 to-purple-500/20 text-cyan-300 border border-cyan-400/40 shadow-[0_0_16px_rgba(34,211,238,0.2)]"
                  :"text-white/40 hover:text-white hover:bg-white/[0.04]"
              }`,
              children:tabLabel
            }))
          }),

          // Tab 1: Overview
          activeTab==="overview"&&(0,e.jsxs)("div",{
            className:"grid grid-cols-1 md:grid-cols-2 gap-4 animate-[nxwFade_0.2s_ease]",
            children:[
              // Recent Games
              (0,e.jsxs)("div",{
                className:"p-5 rounded-3xl border border-white/10 bg-white/[0.02] space-y-3",
                children:[
                  (0,e.jsx)("p",{className:"text-[10px] font-black uppercase tracking-widest text-cyan-400",children:"Recent Games Played"}),
                  (0,e.jsxs)("div",{
                    className:"space-y-2.5 max-h-64 overflow-y-auto pr-1",
                    children:[
                      (i?.recentGames??[]).slice(0,8).map(t=>(0,e.jsxs)("div",{
                        key:t.gameId,
                        className:"flex items-center justify-between p-2.5 rounded-xl bg-white/[0.02] border border-white/5 hover:bg-white/[0.05] transition-colors",
                        children:[
                          (0,e.jsxs)("div",{
                            className:"min-w-0",
                            children:[
                              (0,e.jsx)("p",{className:"font-bold text-xs text-white truncate",children:t.title}),
                              (0,e.jsx)("p",{className:"text-[10px] text-white/40 uppercase font-mono",children:t.platform})
                            ]
                          }),
                          (0,e.jsxs)("span",{
                            className:"text-[10px] font-bold text-cyan-300 bg-cyan-500/10 px-2 py-0.5 rounded-md border border-cyan-400/20",
                            children:[Math.round(t.completionPercent),"%"]
                          })
                        ]
                      })),
                      !i?.recentGames?.length&&(0,e.jsx)("p",{className:"text-xs text-white/30 py-4 text-center",children:"No game activity yet. Launch games from Emulation Hub to track playtime."})
                    ]
                  })
                ]
              }),

              // Quick Saves Preview
              (0,e.jsxs)("div",{
                className:"p-5 rounded-3xl border border-white/10 bg-white/[0.02] space-y-3",
                children:[
                  (0,e.jsx)("p",{className:"text-[10px] font-black uppercase tracking-widest text-purple-400",children:"Recent Cloud Saves"}),
                  (0,e.jsxs)("div",{
                    className:"space-y-2.5 max-h-64 overflow-y-auto pr-1",
                    children:[
                      f.slice(0,6).map(t=>(0,e.jsxs)("div",{
                        key:t.gameId,
                        className:"flex items-center justify-between p-2.5 rounded-xl bg-white/[0.02] border border-white/5 hover:bg-white/[0.05] transition-colors",
                        children:[
                          (0,e.jsxs)("div",{
                            className:"min-w-0",
                            children:[
                              (0,e.jsx)("p",{className:"font-bold text-xs text-white truncate",children:t.title}),
                              (0,e.jsxs)("p",{className:"text-[10px] text-white/40 uppercase font-mono",children:[t.platform," · ",new Date(t.updatedAt).toLocaleDateString()]})
                            ]
                          }),
                          (0,e.jsx)("span",{className:"text-[9px] font-bold text-emerald-300 bg-emerald-500/10 px-2 py-0.5 rounded-md border border-emerald-400/20",children:"Synced"})
                        ]
                      })),
                      !f.length&&(0,e.jsx)("p",{className:"text-xs text-white/30 py-4 text-center",children:"No saves synced yet. Saves are created automatically while playing."})
                    ]
                  })
                ]
              })
            ]
          }),

          // Tab 2: Saves Full View
          activeTab==="saves"&&(0,e.jsx)("div",{
            className:"p-6 rounded-3xl border border-white/10 bg-white/[0.02] space-y-4 animate-[nxwFade_0.2s_ease]",
            children:[
              (0,e.jsxs)("div",{
                className:"flex items-center justify-between",
                children:[
                  (0,e.jsx)("h4",{className:"text-xs font-black uppercase tracking-wider text-cyan-400",children:"Synced Save State Repository"}),
                  (0,e.jsxs)("span",{className:"text-[10px] text-white/40 font-mono",children:[f.length," total saves"]})
                ]
              }),
              f.length===0&&(0,e.jsx)("p",{className:"text-xs text-white/30 py-8 text-center",children:"Your save states will appear here once you play supported emulator games."}),
              (0,e.jsx)("div",{
                className:"grid grid-cols-1 sm:grid-cols-2 gap-3",
                children:f.map(t=>(0,e.jsxs)("div",{
                  key:t.gameId,
                  className:"p-3.5 rounded-2xl bg-white/[0.03] border border-white/5 hover:border-cyan-400/30 transition-all",
                  children:[
                    (0,e.jsx)("p",{className:"font-bold text-xs text-white truncate",children:t.title}),
                    (0,e.jsxs)("div",{
                      className:"flex items-center justify-between text-[10px] text-white/40 mt-1 font-mono",
                      children:[
                        (0,e.jsx)("span",{className:"uppercase text-cyan-300",children:t.platform}),
                        (0,e.jsx)("span",{children:new Date(t.updatedAt).toLocaleString()})
                      ]
                    })
                  ]
                }))
              })
            ]
          }),

          // Tab 3: Devices & Network
          activeTab==="devices"&&(0,e.jsxs)("div",{
            className:"p-6 rounded-3xl border border-white/10 bg-white/[0.02] space-y-6 animate-[nxwFade_0.2s_ease]",
            children:[
              (0,e.jsxs)("div",{
                className:"space-y-1",
                children:[
                  (0,e.jsx)("h4",{className:"text-xs font-black uppercase tracking-wider text-cyan-400",children:"Local & Remote Host Pairing"}),
                  (0,e.jsx)("p",{className:"text-xs text-white/50 leading-relaxed",children:"Connect your mobile, TV, or laptop to your host SaveState station. Sign in and your full library will sync immediately."})
                ]
              }),

              d?.qrDataUrl&&(0,e.jsxs)("div",{
                className:"flex flex-col sm:flex-row gap-6 items-center sm:items-start p-5 rounded-2xl bg-black/40 border border-white/10",
                children:[
                  (0,e.jsxs)("div",{
                    className:"flex-shrink-0 text-center",
                    children:[
                      (0,e.jsx)("img",{src:d.qrDataUrl,alt:"QR Code",className:"w-36 h-36 rounded-xl border border-white/20 p-1 bg-white shadow-lg"}),
                      (0,e.jsx)("p",{className:"text-[10px] text-white/50 mt-2 font-mono",children:"Scan with camera"})
                    ]
                  }),
                  (0,e.jsxs)("div",{
                    className:"flex-1 min-w-0 space-y-3 w-full",
                    children:[
                      (0,e.jsx)("p",{className:"text-xs font-bold text-white",children:"Direct Host URLs:"}),
                      d.urls.map(t=>(0,e.jsxs)("div",{
                        key:t,
                        className:"flex items-center gap-2",
                        children:[
                          (0,e.jsx)("code",{className:"flex-1 text-xs font-mono bg-black/50 px-3 py-2 rounded-xl text-cyan-300 border border-white/10 truncate",children:t}),
                          (0,e.jsx)("button",{
                            onClick:le,
                            className:"p-2 hover:bg-white/10 rounded-xl transition-all flex-shrink-0 text-white/60 hover:text-white border border-white/10",
                            title:"Copy URL",
                            children:X?(0,e.jsx)(ve,{className:"w-4 h-4 text-emerald-400"}):(0,e.jsx)(fe,{className:"w-4 h-4"})
                          })
                        ]
                      })),
                      (0,e.jsx)("p",{className:"text-[10px] text-white/40",children:"Open this address in Chrome, Safari, or Edge on your other devices."})
                    ]
                  })
                ]
              }),

              // Platform tips
              (0,e.jsxs)("div",{
                className:"grid grid-cols-1 sm:grid-cols-3 gap-3",
                children:[
                  (0,e.jsxs)("div",{
                    className:"p-4 bg-white/[0.03] rounded-2xl border border-white/5 space-y-1.5",
                    children:[
                      (0,e.jsx)(xe,{className:"w-4 h-4 text-cyan-400"}),
                      (0,e.jsx)("p",{className:"text-xs font-bold text-white",children:"PC / Desktop"}),
                      (0,e.jsx)("p",{className:"text-[10px] text-white/40 leading-relaxed",children:"Install as PWA for offline launch and full gamepad support."})
                    ]
                  }),
                  (0,e.jsxs)("div",{
                    className:"p-4 bg-white/[0.03] rounded-2xl border border-white/5 space-y-1.5",
                    children:[
                      (0,e.jsx)(O,{className:"w-4 h-4 text-purple-400"}),
                      (0,e.jsx)("p",{className:"text-xs font-bold text-white",children:"iOS / iPadOS"}),
                      (0,e.jsxs)("p",{className:"text-[10px] text-white/40 leading-relaxed",children:["Download ROMs directly or stream media seamlessly in Safari."]})
                    ]
                  }),
                  (0,e.jsxs)("div",{
                    className:"p-4 bg-white/[0.03] rounded-2xl border border-white/5 space-y-1.5",
                    children:[
                      (0,e.jsx)(O,{className:"w-4 h-4 text-emerald-400"}),
                      (0,e.jsx)("p",{className:"text-xs font-bold text-white",children:"Android"}),
                      (0,e.jsxs)("p",{className:"text-[10px] text-white/40 leading-relaxed",children:["Play in browser or sync to RetroArch and native emulators."]})
                    ]
                  })
                ]
              })
            ]
          }),

          // Tab 4: Activity Log
          activeTab==="activity"&&(0,e.jsxs)("div",{
            className:"p-6 rounded-3xl border border-white/10 bg-white/[0.02] space-y-4 animate-[nxwFade_0.2s_ease]",
            children:[
              (0,e.jsxs)("h4",{className:"text-xs font-black uppercase tracking-wider text-cyan-400 flex items-center gap-2",children:[(0,e.jsx)(T,{className:"w-3.5 h-3.5"})," Player Activity Timeline"]}),
              B&&(0,e.jsx)("div",{className:"flex justify-center py-6",children:(0,e.jsx)("span",{className:"w-5 h-5 border-2 border-cyan-400/30 border-t-cyan-400 rounded-full animate-spin"})}),
              !B&&L.length===0&&(0,e.jsx)("p",{className:"text-xs text-white/30 py-6 text-center",children:"No activity recorded yet."}),
              (0,e.jsx)("div",{
                className:"space-y-2",
                children:L.map((t,n)=>(0,e.jsxs)("div",{
                  key:n,
                  className:"flex items-start gap-3 p-3 rounded-xl bg-white/[0.02] border border-white/5",
                  children:[
                    (0,e.jsx)("div",{className:"w-2 h-2 rounded-full bg-cyan-400 mt-1.5 flex-shrink-0 shadow-[0_0_8px_rgba(34,211,238,0.6)]"}),
                    (0,e.jsxs)("div",{
                      className:"flex-1 min-w-0",
                      children:[
                        (0,e.jsxs)("div",{
                          className:"flex items-center justify-between gap-2",
                          children:[
                            (0,e.jsx)("span",{className:"text-[10px] font-black uppercase text-cyan-300 tracking-wider",children:t.action.replace(/_/g," ")}),
                            (0,e.jsx)("span",{className:"text-[9px] text-white/30 font-mono",children:new Date(t.created_at).toLocaleString()})
                          ]
                        }),
                        t.detail&&(0,e.jsx)("p",{className:"text-xs text-white/60 truncate mt-0.5",children:t.detail})
                      ]
                    })
                  ]
                }))
              })
            ]
          }),

          // Tab 5: Admin Console
          activeTab==="admin"&&ae&&(0,e.jsxs)("div",{
            className:"p-6 rounded-3xl border border-rose-500/20 bg-rose-950/10 space-y-6 animate-[nxwFade_0.2s_ease]",
            children:[
              (0,e.jsxs)("div",{
                className:"flex items-center justify-between",
                children:[
                  (0,e.jsxs)("h4",{className:"text-xs font-black uppercase tracking-wider text-rose-400 flex items-center gap-2",children:[(0,e.jsx)(he,{className:"w-4 h-4"})," Host Administration Panel"]}),
                  (0,e.jsxs)("button",{
                    onClick:M,
                    className:"flex items-center gap-1.5 px-3 py-1.5 bg-white/5 hover:bg-white/10 rounded-xl text-xs font-bold text-white transition-all",
                    children:[(0,e.jsx)(G,{className:`w-3 h-3 ${E?"animate-spin":""}`}),r.length?"Refresh Users":"Load Registered Users"]
                  })
                ]
              }),

              D&&(0,e.jsxs)("p",{className:"text-xs text-rose-300 bg-rose-500/20 px-4 py-2.5 rounded-xl flex items-center gap-2",children:[(0,e.jsx)(oe,{className:"w-4 h-4"})," ",D]}),

              r.length>0&&(0,e.jsx)("div",{
                className:"space-y-2",
                children:r.map(t=>(0,e.jsxs)("div",{
                  key:t.id,
                  className:"p-3.5 rounded-2xl bg-white/[0.03] border border-white/5 flex items-center justify-between gap-4 flex-wrap",
                  children:[
                    (0,e.jsxs)("div",{
                      className:"flex items-center gap-3",
                      children:[
                        (0,e.jsx)("div",{className:"w-8 h-8 rounded-full bg-cyan-500/20 text-cyan-300 font-black text-xs flex items-center justify-center",children:(t.displayName||t.username)[0].toUpperCase()}),
                        (0,e.jsxs)("div",{
                          children:[
                            (0,e.jsxs)("p",{className:"text-xs font-bold text-white",children:[t.displayName||t.username," ",(0,e.jsx)("span",{className:"text-white/40 font-mono text-[10px]",children:`(@${t.username})`})]}),
                            (0,e.jsxs)("span",{className:"text-[10px] text-white/40",children:[z(t.usedBytes)," / ",z(t.quotaBytes)]})
                          ]
                        })
                      ]
                    }),
                    c?.userId===t.id?(0,e.jsxs)("div",{
                      className:"flex items-center gap-2",
                      children:[
                        (0,e.jsx)("input",{type:"number",value:Math.round(c.bytes/1024**3),onChange:n=>o({userId:t.id,bytes:Number(n.target.value)*1024**3}),className:"w-16 bg-black/40 border border-white/10 rounded-lg px-2 py-1 text-xs font-mono text-white"}),
                        (0,e.jsx)("span",{className:"text-[10px] text-white/50",children:"GB"}),
                        (0,e.jsx)("button",{onClick:ie,disabled:U,className:"px-2.5 py-1 rounded-lg bg-cyan-400 text-black text-xs font-bold",children:U?"…":"Save"}),
                        (0,e.jsx)("button",{onClick:()=>o(null),className:"p-1 text-white/40 hover:text-white",children:(0,e.jsx)(F,{className:"w-3 h-3"})})
                      ]
                    }):(0,e.jsxs)("button",{
                      onClick:()=>o({userId:t.id,bytes:t.quotaBytes}),
                      className:"px-3 py-1.5 rounded-xl bg-white/5 hover:bg-white/10 text-[10px] font-bold text-white/60 hover:text-white transition-all",
                      children:[(0,e.jsx)(Ne,{className:"w-3 h-3 inline mr-1"}),"Edit Quota"]
                    })
                  ]
                }))
              }),

              // Audit Logs Section
              (0,e.jsxs)("div",{
                className:"space-y-3 pt-4 border-t border-white/10",
                children:[
                  (0,e.jsxs)("div",{
                    className:"flex items-center justify-between",
                    children:[
                      (0,e.jsx)("h5",{className:"text-xs font-bold text-purple-300",children:"System Security & Audit Stream"}),
                      (0,e.jsxs)("button",{onClick:ne,className:"text-xs font-bold text-white/50 hover:text-white flex items-center gap-1",children:[(0,e.jsx)(G,{className:`w-3 h-3 ${R?"animate-spin":""}`}),x.length?"Refresh Logs":"Load Audit Logs"]})
                    ]
                  }),
                  x.length>0&&(0,e.jsx)("div",{
                    className:"space-y-2 max-h-60 overflow-y-auto pr-1",
                    children:x.map((t,n)=>(0,e.jsxs)("div",{
                      key:n,
                      className:"p-2.5 rounded-xl bg-black/40 border border-white/5 text-xs text-white/70 flex items-center justify-between",
                      children:[
                        (0,e.jsxs)("span",{children:[(0,e.jsx)("b",{className:"text-cyan-300",children:t.username})," — ",t.action]}),
                        (0,e.jsx)("span",{className:"text-[10px] text-white/30 font-mono",children:new Date(t.created_at).toLocaleTimeString()})
                      ]
                    }))
                  })
                ]
              })
            ]
          })
        ]
      })
    ]
  });
};

export{Be as ProfileManager};
