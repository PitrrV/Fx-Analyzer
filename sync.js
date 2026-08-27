/* ============================================================================
   AT Trading FX Analyzer — CLOUD SYNC (Supabase)
   Plain skript, načítá se PO supabase-js UMD. Vystaví window.Sync.
   Bezpečné slévání: historie (kalendář/COT/deník) se VŽDY sloučí (nikdy se
   neztratí), skaláry (klíče, nastavení) — lokální vyhrává, cloud doplní mezery.
   ============================================================================ */
(function(){
  const SUPABASE_URL="https://wdcvxfbhauwvwzbatkfh.supabase.co";
  const SUPABASE_KEY="sb_publishable_6kPU3onoNNavH-sonUPR6w_HIITHVbv";
  let sb=null;
  try{ if(window.supabase&&window.supabase.createClient) sb=window.supabase.createClient(SUPABASE_URL,SUPABASE_KEY,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}}); }
  catch(e){ console.warn("Supabase init selhal:",e); }

  // localStorage klíče k synchronizaci
  const KEYS_SCALAR=["fh","av","fmp","or_key","or_model","or_coach_model","openai_key","openai_coach_model","oanda_token","oanda_env","cot_data","cot_meta","sent_data","positions_ts","v5_fav_pairs_ts"];
  const KEYS_ARR=["v5_ff_hist","journal","v5_fav_pairs","us100_retail_hist"];           // pole → sloučit (v5_fav_pairs viz výjimka ve smartMerge)
  const KEYS_OBJ=["cot_hist","retail_hist","score_hist","ai_analyses_v1","pair_notes","pair_notes_ts","positions","bias_state","engine_log","forecast_log","v5_cb_rates","us100_cot_hist","us100_score_hist"]; // objekty → sloučit
  // TRANSIENT klíče se NIKDY nesynchronizují — a stripTransient() je navíc aktivně
  // odstraňuje ze slitých dat (applyLocal by jinak zapsal i staré kopie z cloudu
  // zpátky do zařízení a při push by se vracely do cloudu donekonečna):
  // - v5_risk_sent/_manual: auto-počítané z živých cen per zařízení
  // - v5_regime: mrtvý klíč bez zapisovače, ale čtený ve scoringu (mění váhy)
  const TRANSIENT=["v5_ff_cache","fmp_cal_block","fh_cal_block","score_delta_buffer","v5_risk_sent","v5_risk_sent_manual","v5_regime"];
  function stripTransient(d){
    if(!d) return d;
    TRANSIENT.forEach(k=>{ if(d._scalar)delete d._scalar[k]; if(d._arr)delete d._arr[k]; if(d._obj)delete d._obj[k]; });
    return d;
  }

  const rdStr=k=>{try{const v=localStorage.getItem(k);return v==null?null:v;}catch(e){return null;}};
  const rdJSON=k=>{try{return JSON.parse(localStorage.getItem(k)||"null");}catch(e){return null;}};

  function collectLocal(){
    const d={_scalar:{},_arr:{},_obj:{}};
    KEYS_SCALAR.forEach(k=>{const v=rdStr(k); if(v!=null&&v!=="") d._scalar[k]=v;});
    KEYS_ARR.forEach(k=>{const v=rdJSON(k); if(Array.isArray(v)&&v.length) d._arr[k]=v;});
    KEYS_OBJ.forEach(k=>{const v=rdJSON(k); if(v&&typeof v==="object"&&Object.keys(v).length) d._obj[k]=v;});
    return d;
  }
  const ffKey=e=>`${(e.country||"").toUpperCase()}|${e.event||""}|${e.time||""}`;
  function mergeArr(key,a,b){
    a=Array.isArray(a)?a:[]; b=Array.isArray(b)?b:[];
    if(key==="journal"){
      // Slévat podle updatedAt, ne "kdo přišel druhý" — jinak starší cloud kopie
      // trvale přepisovala čerstvou lokální úpravu (např. změnu výsledku obchodu)
      // při každém syncu, protože b (cloud) byl v poli vždy za a (lokál).
      const m={};
      [...a,...b].forEach(t=>{
        if(!t||!t.id) return;
        const prev=m[t.id];
        if(!prev){ m[t.id]=t; return; }
        const tu=+(t.updatedAt?Date.parse(t.updatedAt):0)||0, pu=+(prev.updatedAt?Date.parse(prev.updatedAt):0)||0;
        if(tu>pu) m[t.id]=t; // jen prokazatelně novější (dle updatedAt) přepíše; jinak zůstává dřív viděný (lokál)
      });
      return Object.values(m);
    }
    const m=new Map();[...a,...b].forEach(e=>{const k=ffKey(e);const p=m.get(k);if(!p||(!p.actual&&e.actual))m.set(k,e);});return [...m.values()]; // v5_ff_hist: dedupe, preferuj s actual
  }
  function mergeObj(key,a,b){
    a=a||{}; b=b||{}; let out={...b,...a}; // lokál (a) přepíše cloud (b)
    if(key==="ai_analyses_v1"){ Object.keys(b).forEach(k=>{ if(b[k]&&(!a[k]||(b[k].savedAt||0)>(a[k].savedAt||0))) out[k]=b[k]; }); } // novější savedAt
    if(key==="cot_hist"&&typeof cotWeekKey==="function"){
      // Starší cloud kopie mohla mít fantomový klíč z opraveného cotDateKey bugu
      // (CFTC report je vždy úterý — klíč na pondělí je vždy chyba). Bez týhle
      // opravy by ho merge pořád dokola tahal zpátky i po lokálním úklidu
      // (viz migrateCOTHistoryKeys v engine.js — tenhle merge běží dřív než ona).
      //
      // Server (src:"server", z fetchActionCOTHistory) MUSÍ vyhrát nad live-fetchnutou
      // kopií (src:"live"/chybí) bez ohledu na updatedAt — jinak starší/odlišná živá
      // hodnota z jednoho zařízení přežije v cloudu a přes sync přepíše správná
      // serverová data na druhém zařízení (viz reálný nález: PC ukazoval EUR/JPY COT
      // long/short 100/0, server měl 40/60 a 33/67 — cloud merge tehdy řešil jen
      // "kdo má novější updatedAt", ne odkud data jsou). updatedAt rozhoduje jen mezi
      // dvěma záznamy STEJNÉ třídy (oba server, nebo oba live/neoznačené).
      // POZOR: musí se iterovat přes a i b ZVLÁŠŤ, ne přes už sloučený `out` výše —
      // ten pro shodné raw klíče v a i b už zahodil b (řádek "let out={...b,...a}"),
      // takže by server hodnota z cloudu nikdy nedostala šanci se vůbec porovnat.
      const fixed={};
      [...Object.entries(b),...Object.entries(a)].forEach(([k,v])=>{
        if(!v) return;
        const nk=cotWeekKey(k), prev=fixed[nk];
        // CFTC report je vždy úterý — ne-úterní klíč je fantom (viz
        // isValidCOTWeekKey v engine.js); z cloudu se nesmí vracet.
        if(typeof isValidCOTWeekKey==="function"&&!isValidCOTWeekKey(nk)) return;
        if(!prev){ fixed[nk]=v; return; }
        const prevSrv=prev.src==="server", vSrv=v.src==="server";
        if(vSrv&&!prevSrv){ fixed[nk]=v; return; }
        if(prevSrv&&!vSrv){ return; }
        if(String(v.updatedAt||"")>=String(prev.updatedAt||"")) fixed[nk]=v;
      });
      out=fixed;
    }
    return out;
  }
  // local = toto zařízení, cloud = z DB. Bezpečné slévání bez ztráty historie.
  function smartMerge(local,cloud){
    if(!cloud) return local;
    const out={_scalar:{},_arr:{},_obj:{}};
    out._scalar={...(cloud._scalar||{}),...(local._scalar||{})}; // lokál vyhrává, cloud doplní chybějící
    // v5_fav_pairs: NEslévat (odebrání z oblíbených musí propagovat, ne se vracet
    // union-em ze starší cloud kopie) → celá novější verze dle v5_fav_pairs_ts vyhrává,
    // stejný princip jako u "positions" níže.
    const lft=+((local._scalar||{}).v5_fav_pairs_ts||0), cft=+((cloud._scalar||{}).v5_fav_pairs_ts||0);
    new Set([...Object.keys(local._arr||{}),...Object.keys(cloud._arr||{})]).forEach(k=>{
      if(k==="v5_fav_pairs"){ out._arr[k]= lft>=cft ? ((local._arr||{})[k]||[]) : ((cloud._arr||{})[k]||[]); }
      else out._arr[k]=mergeArr(k,(local._arr||{})[k],(cloud._arr||{})[k]);
    });
    // positions: NEslévat (zavření = smazání musí propagovat) → celá novější verze dle positions_ts vyhrává
    const lpt=+((local._scalar||{}).positions_ts||0), cpt=+((cloud._scalar||{}).positions_ts||0);
    new Set([...Object.keys(local._obj||{}),...Object.keys(cloud._obj||{})]).forEach(k=>{
      if(k==="positions"){ out._obj[k]= lpt>=cpt ? ((local._obj||{})[k]||{}) : ((cloud._obj||{})[k]||{}); }
      else out._obj[k]=mergeObj(k,(local._obj||{})[k],(cloud._obj||{})[k]);
    });
    return out;
  }
  function applyLocal(d){
    if(!d) return;
    Object.entries(d._scalar||{}).forEach(([k,v])=>{try{localStorage.setItem(k,v);}catch(e){}});
    Object.entries(d._arr||{}).forEach(([k,v])=>{try{localStorage.setItem(k,JSON.stringify(v));}catch(e){}});
    Object.entries(d._obj||{}).forEach(([k,v])=>{try{localStorage.setItem(k,JSON.stringify(v));}catch(e){}});
  }

  async function session(){ if(!sb) return null; try{const{data}=await sb.auth.getSession();return data.session||null;}catch(e){return null;} }
  async function signIn(email){ if(!sb) throw new Error("Supabase není načtený (internet/CDN?)"); const{error}=await sb.auth.signInWithOtp({email:String(email).trim(),options:{emailRedirectTo:location.href.split("#")[0]}}); if(error) throw error; return true; }
  async function verifyCode(email,token){ if(!sb) throw new Error("Supabase není načtený"); const{error}=await sb.auth.verifyOtp({email:String(email).trim(),token:String(token).trim().replace(/\s/g,""),type:"email"}); if(error) throw error; return true; }
  async function signInPassword(email,password){ if(!sb) throw new Error("Supabase není načtený"); const{error}=await sb.auth.signInWithPassword({email:String(email).trim(),password}); if(error) throw error; return true; }
  async function signUpPassword(email,password){ if(!sb) throw new Error("Supabase není načtený"); const{data,error}=await sb.auth.signUp({email:String(email).trim(),password}); if(error) throw error; return data; }
  async function resetPassword(email){ if(!sb) throw new Error("Supabase není načtený"); const{error}=await sb.auth.resetPasswordForEmail(String(email).trim(),{redirectTo:location.href.split("#")[0]}); if(error) throw error; return true; }
  async function signOut(){ if(sb) try{await sb.auth.signOut();}catch(e){} }
  async function pull(uid){ const{data,error}=await sb.from("app_state").select("data,updated_at").eq("user_id",uid).maybeSingle(); if(error) throw error; return data; }
  async function push(uid,data){ const{error}=await sb.from("app_state").upsert({user_id:uid,data,updated_at:new Date().toISOString()}); if(error) throw error; }

  // Stáhni cloud → bezpečně sluč s lokálem → zapiš lokálně → nahraj zpět.
  async function syncNow(){
    const s=await session(); if(!s) throw new Error("Nepřihlášen");
    const uid=s.user.id;
    const local=collectLocal();
    let remote=null; try{ remote=await pull(uid); }catch(e){ throw new Error("Stažení selhalo: "+(e.message||e)); }
    const merged=stripTransient(smartMerge(local, remote?remote.data:null));
    applyLocal(merged);
    await push(uid,merged); // push očištěných dat → cloud se starých TRANSIENT kopií zbaví natrvalo
    const stats={
      events:(merged._arr&&merged._arr.v5_ff_hist?merged._arr.v5_ff_hist.length:0),
      cotWeeks:(merged._obj&&merged._obj.cot_hist?Object.keys(merged._obj.cot_hist).length:0),
      trades:(merged._arr&&merged._arr.journal?merged._arr.journal.length:0),
      keys:Object.keys(merged._scalar||{}).filter(k=>["fh","av","fmp","or_key"].includes(k)).length,
    };
    return stats;
  }

  window.Sync={ ready:!!sb, session, signIn, verifyCode, signInPassword, signUpPassword, resetPassword, signOut, syncNow,
    onAuth:(cb)=>{ if(sb) sb.auth.onAuthStateChange((event,sess)=>cb(sess,event)); } };
})();
