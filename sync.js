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
  const KEYS_SCALAR=["fh","av","fmp","or_key","or_model","oanda_token","oanda_env","v5_risk_sent","v5_regime","cot_data","cot_meta","sent_data","positions_ts"];
  const KEYS_ARR=["v5_ff_hist","journal"];                                              // pole → sloučit
  const KEYS_OBJ=["cot_hist","retail_hist","score_hist","ai_analyses_v1","pair_notes","positions","bias_state"]; // objekty → sloučit
  const TRANSIENT=["v5_ff_cache","fmp_cal_block","fh_cal_block","score_delta_buffer"];   // NIKDY nesynchronizovat

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
    if(key==="journal"){const m={};[...a,...b].forEach(t=>{if(t&&t.id)m[t.id]=t;});return Object.values(m);}
    const m=new Map();[...a,...b].forEach(e=>{const k=ffKey(e);const p=m.get(k);if(!p||(!p.actual&&e.actual))m.set(k,e);});return [...m.values()]; // v5_ff_hist: dedupe, preferuj s actual
  }
  function mergeObj(key,a,b){
    a=a||{}; b=b||{}; const out={...b,...a}; // lokál (a) přepíše cloud (b)
    if(key==="ai_analyses_v1"){ Object.keys(b).forEach(k=>{ if(b[k]&&(!a[k]||(b[k].savedAt||0)>(a[k].savedAt||0))) out[k]=b[k]; }); } // novější savedAt
    return out;
  }
  // local = toto zařízení, cloud = z DB. Bezpečné slévání bez ztráty historie.
  function smartMerge(local,cloud){
    if(!cloud) return local;
    const out={_scalar:{},_arr:{},_obj:{}};
    out._scalar={...(cloud._scalar||{}),...(local._scalar||{})}; // lokál vyhrává, cloud doplní chybějící
    new Set([...Object.keys(local._arr||{}),...Object.keys(cloud._arr||{})]).forEach(k=>{ out._arr[k]=mergeArr(k,(local._arr||{})[k],(cloud._arr||{})[k]); });
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
    const merged=smartMerge(local, remote?remote.data:null);
    applyLocal(merged);
    await push(uid,merged);
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
