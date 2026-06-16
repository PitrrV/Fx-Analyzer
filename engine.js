/* ============================================================================
   AT Trading FX Analyzer — SDÍLENÝ ENGINE (sync s index.html, lines 75-2060)
   ============================================================================ */
const CURRENCIES=["USD","EUR","GBP","JPY","AUD","CAD","CHF","NZD"];
const FLAGS={USD:"🇺🇸",EUR:"🇪🇺",GBP:"🇬🇧",JPY:"🇯🇵",AUD:"🇦🇺",CAD:"🇨🇦",CHF:"🇨🇭",NZD:"🇳🇿"};
const NAMES={USD:"US Dollar",EUR:"Euro",GBP:"British Pound",JPY:"Japanese Yen",AUD:"Aus Dollar",CAD:"Canadian Dollar",CHF:"Swiss Franc",NZD:"NZ Dollar"};
const COUNTRY_FLAGS={US:"🇺🇸",EU:"🇪🇺",DE:"🇩🇪",FR:"🇫🇷",IT:"🇮🇹",ES:"🇪🇸",GB:"🇬🇧",JP:"🇯🇵",AU:"🇦🇺",CA:"🇨🇦",CH:"🇨🇭",NZ:"🇳🇿",CN:"🇨🇳"};
const CURRENCY_COUNTRIES={USD:["US"],EUR:["EU","DE","FR","IT","ES"],GBP:["GB"],JPY:["JP"],AUD:["AU"],CAD:["CA"],CHF:["CH"],NZD:["NZ"]};
const INDIRECT_COUNTRIES={AUD:["CN"],NZD:["CN"],CAD:["US"],CHF:["EU","DE","FR","IT","ES","US"]};

const STANDARD_PAIRS=[
  {pair:"EURUSD",base:"EUR",quote:"USD"},{pair:"USDJPY",base:"USD",quote:"JPY"},
  {pair:"GBPUSD",base:"GBP",quote:"USD"},{pair:"AUDUSD",base:"AUD",quote:"USD"},
  {pair:"USDCAD",base:"USD",quote:"CAD"},{pair:"USDCHF",base:"USD",quote:"CHF"},
  {pair:"NZDUSD",base:"NZD",quote:"USD"},{pair:"EURGBP",base:"EUR",quote:"GBP"},
  {pair:"EURCHF",base:"EUR",quote:"CHF"},{pair:"EURAUD",base:"EUR",quote:"AUD"},
  {pair:"EURCAD",base:"EUR",quote:"CAD"},{pair:"EURJPY",base:"EUR",quote:"JPY"},
  {pair:"EURNZD",base:"EUR",quote:"NZD"},{pair:"GBPCHF",base:"GBP",quote:"CHF"},
  {pair:"GBPJPY",base:"GBP",quote:"JPY"},{pair:"GBPAUD",base:"GBP",quote:"AUD"},
  {pair:"GBPCAD",base:"GBP",quote:"CAD"},{pair:"GBPNZD",base:"GBP",quote:"NZD"},
  {pair:"AUDCAD",base:"AUD",quote:"CAD"},{pair:"AUDJPY",base:"AUD",quote:"JPY"},
  {pair:"AUDNZD",base:"AUD",quote:"NZD"},{pair:"AUDCHF",base:"AUD",quote:"CHF"},
  {pair:"NZDCAD",base:"NZD",quote:"CAD"},{pair:"NZDJPY",base:"NZD",quote:"JPY"},
  {pair:"NZDCHF",base:"NZD",quote:"CHF"},{pair:"CADJPY",base:"CAD",quote:"JPY"},
  {pair:"CADCHF",base:"CAD",quote:"CHF"},{pair:"CHFJPY",base:"CHF",quote:"JPY"},
];

const EVENT_RULES=[
  // direction: 1 = vyšší actual než forecast je bullish; -1 = nižší actual je bullish; "pmi" = kombinuje beat/miss + hranici 50
  {cat:"Interest Rates",keys:["interest rate","rate decision","funds rate","policy rate","deposit facility rate","refinancing rate","cash rate","overnight rate"],w:3.5,dir:1,cap:3},
  {cat:"Inflation",keys:["cpi","consumer price index","inflation rate","core inflation","hicp","pce","personal consumption","ppi","producer price"],w:3.0,dir:1,cap:3},
  {cat:"Labor +Jobs",keys:["non-farm","nonfarm","payroll","employment change","employment","adp","average hourly earnings","wage","earnings"],w:3.0,dir:1,cap:4},
  {cat:"Labor -Unemployment",keys:["unemployment rate","jobless claims","initial claims","continuing claims","claimant count"],w:3.0,dir:-1,cap:4},
  {cat:"GDP",keys:["gdp","gross domestic product"],w:2.2,dir:1,cap:2},
  {cat:"PMI",keys:["manufacturing pmi","services pmi","service pmi","composite pmi","pmi","purchasing managers","ism manufacturing","ism services"],w:1.8,dir:"pmi",cap:2},
  {cat:"Retail Sales",keys:["retail sales"],w:1.7,dir:1,cap:2},
  {cat:"External Balance",keys:["trade balance","current account"],w:1.0,dir:1,cap:1},
  {cat:"Confidence",keys:["consumer confidence","business confidence","sentiment","zew","ifo"],w:1.0,dir:1,cap:1},
];

function getEventMeta(name=""){
  const n=name.toLowerCase();
  for(const r of EVENT_RULES) if(r.keys.some(k=>n.includes(k))) return r;
  return null;
}
function getWeight(name=""){
  return getEventMeta(name)?.w||0;
}
function eventDirection(ev){
  const meta=getEventMeta(ev.event);if(!meta) return 0;
  const a=parseFloat(ev.actual),e=parseFloat(ev.estimate),prev=parseFloat(ev.prev||ev.previous);
  if(isNaN(a)||isNaN(e)) return 0;
  let dir=0;
  if(meta.dir==="pmi"){
    // PMI nad 50 = expanze, pod 50 = kontrakce. Beat/miss je hlavní impuls, hranice 50 upravuje sílu signálu.
    dir=a>e?1:a<e?-1:0;
    if(a>=50&&e<50) dir=1;
    if(a<50&&e>=50) dir=-1;
    if(dir===0&&!isNaN(prev)) dir=a>prev?1:a<prev?-1:0;
    return dir;
  }
  dir=a>e?1:a<e?-1:0;
  if(meta.dir===-1) dir*=-1; // unemployment/claims: nižší číslo je bullish
  return dir;
}
function surpriseStrength(ev){
  const a=parseFloat(ev.actual),e=parseFloat(ev.estimate);
  if(isNaN(a)||isNaN(e)) return 1;
  const denom=Math.max(Math.abs(e),1);
  const pct=Math.min(0.6,Math.abs(a-e)/denom*8); // jemné zvýraznění překvapení, ale bez převrácení celého skóre
  return 1+pct;
}

// Sezónní bias měn dle měsíce (Jan=0 ... Dec=11)
// Zdroj: historické průměrné výnosy za posledních 20 let
const SEASONALITY={
  USD:[ 0,-1,-1,-1,-1, 0, 0, 1, 2, 1, 0, 0],
  EUR:[ 1, 1, 1, 0, 1, 0,-1,-1,-1, 0, 0,-1],
  GBP:[ 0, 0, 1, 1, 0,-1,-1,-1, 1, 1, 0, 0],
  JPY:[ 2, 1, 0,-1,-1,-1, 0, 1, 1, 0,-1, 0],
  AUD:[ 1, 1, 1, 0,-1,-1,-1, 0, 0, 0, 1, 1],
  CAD:[-1, 0, 0,-1,-1, 0, 1, 1, 1, 1, 0,-1],
  CHF:[ 1, 0, 0, 0, 1, 1, 0,-1,-1,-1, 0, 1],
  NZD:[ 1, 1, 0, 0,-1,-1,-1, 0, 0, 0, 1, 1],
};


// ── V5 ENGINE: ÚROKOVÉ SAZBY CB ──────────────────────────────
let CENTRAL_BANK_RATES={USD:4.25,EUR:2.50,GBP:4.25,JPY:0.75,AUD:3.85,NZD:3.50,CAD:2.75,CHF:0.25};
try{const usr=localStorage.getItem("v5_cb_rates");if(usr)CENTRAL_BANK_RATES={...CENTRAL_BANK_RATES,...JSON.parse(usr)};}catch(e){}

// ── REAL CPI DATA (pro real yield = CB rate - CPI) ────────────
// Aktualizuj po CPI datech každý měsíc
let REAL_CPI_DATA={USD:3.2,EUR:2.3,GBP:2.8,JPY:2.8,AUD:3.5,NZD:3.8,CAD:2.4,CHF:0.9};
try{const u=localStorage.getItem("v5_real_cpi");if(u)REAL_CPI_DATA={...REAL_CPI_DATA,...JSON.parse(u)};}catch(e){}

// ── CB POLICY CYCLE — nejdůležitější makro faktor ─────────────
// stance: "aggressive_hike" +3 | "hike" +2 | "hold" 0 | "cut" -1 | "aggressive_cut" -2
// Aktualizuj po každém zasedání centrální banky
let CB_POLICY_DATA={
  USD:{score:0, label:"Fed — plateau, cuts pozastaveny"},
  EUR:{score:-2,label:"ECB — aktivní cyklus řezů"},
  GBP:{score:-1,label:"BoE — opatrné snižování"},
  JPY:{score:2, label:"BoJ — první zvyšování za 17 let"},
  AUD:{score:-1,label:"RBA — cyklus řezů"},
  NZD:{score:-2,label:"RBNZ — agresivní řezy"},
  CAD:{score:-2,label:"BoC — agresivní řezy"},
  CHF:{score:-1,label:"SNB — blízko nuly"},
};
try{const u=localStorage.getItem("v5_cb_policy");if(u){const p=JSON.parse(u);Object.keys(p).forEach(k=>{if(CB_POLICY_DATA[k])CB_POLICY_DATA[k]={...CB_POLICY_DATA[k],...p[k]};});}}catch(e){}

// ── GLOBAL RISK SENTIMENT: -1=risk-off, 0=neutral, +1=risk-on ─
let g_riskSentiment=0;
try{g_riskSentiment=parseInt(localStorage.getItem("v5_risk_sent")||"0");}catch(e){}
// Důvěra ve fundamentální data podle délky historie kalendáře.
// 1 = plná (Finnhub 15 měsíců, ladění s 65% WR). <1 = krátká záloha (ForexFactory
// ~3 týdny) → fundamentální tilt z dat se ztlumí, ať pár čerstvých čísel nerozhází
// celý žebříček a engine se víc opře o stabilní COT/yield/policy.
let g_fundConfidence=1;
const FF_FUND_DAMP=0.4;
// ── V5 ENGINE: KORELAČNÍ SKUPINY FX ──────────────────────────
const FX_CORRELATION_GROUPS=[
  ["EURUSD","GBPUSD","AUDUSD","NZDUSD"],
  ["USDCHF","USDJPY","USDCAD"],
  ["EURJPY","GBPJPY","AUDJPY","NZDJPY","CADJPY"],
  ["EURGBP","GBPCHF","GBPAUD"],
];
function getSeasonalScore(currency){
  const month=new Date().getMonth();
  return (SEASONALITY[currency]||[])[month]||0;
}

// Finnhub ekonomický kalendář vrací čas v UTC ("YYYY-MM-DD HH:MM:SS" bez TZ).
// Prohlížeč by takový string četl jako LOKÁLNÍ čas → zobrazené časy i denní
// tečky (🔴🟡🟢) by byly posunuté o offset uživatele. Vynutíme UTC a necháme
// toLocaleTimeString přepočítat do reálné lokální zóny uživatele.
function parseEventTime(t){
  if(t==null) return NaN;
  if(typeof t==="number") return t;
  const s=String(t).trim();
  if(/[zZ]$|[+\-]\d\d:?\d\d$/.test(s)) return Date.parse(s);            // už má TZ
  const m=s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/);  // datum+čas → UTC
  if(m) return Date.parse(m[1]+"T"+m[2]+"Z");
  if(/^\d{4}-\d{2}-\d{2}$/.test(s)) return Date.parse(s+"T00:00:00Z");  // jen datum
  return Date.parse(s);
}
function evDate(ev){return new Date(parseEventTime(ev&&ev.time));}
function recency(dateStr){
  const d=(Date.now()-new Date(dateStr))/86400000;
  return d<=90?1.8:d<=180?1.4:d<=365?1.0:0.7;
}
function eventRelevance(currency,ev){
  const country=(ev.country||"").toUpperCase();
  const direct=(CURRENCY_COUNTRIES[currency]||[]).some(c=>country.includes(c));
  const indirect=(INDIRECT_COUNTRIES[currency]||[]).some(c=>country.includes(c));
  if(direct) return{type:"direct",factor:1,label:"přímý"};
  if(indirect) return{type:"indirect",factor:0.45,label:"nepřímý"};
  return null;
}

// ── SCORE HISTORY ─────────────────────────────────────────
function saveScoreHistory(scores){
  const today=new Date().toISOString().split("T")[0];
  try{
    const raw=localStorage.getItem("score_hist")||"{}";
    const hist=JSON.parse(raw);
    hist[today]={};
    CURRENCIES.forEach(c=>{ hist[today][c]=scores[c]?.total_score||scores[c]?.score||0; });
    const dates=Object.keys(hist).sort().slice(-260);
    const trimmed={};dates.forEach(d=>trimmed[d]=hist[d]);
    localStorage.setItem("score_hist",JSON.stringify(trimmed));
  }catch(e){}
}
function getScoreChange(currency,days=7){
  try{
    const hist=JSON.parse(localStorage.getItem("score_hist")||"{}");
    const dates=Object.keys(hist).sort();
    if(dates.length<2) return 0;
    const cur=hist[dates[dates.length-1]]?.[currency]||0;
    const past=hist[dates[Math.max(0,dates.length-1-days)]]?.[currency]||0;
    return parseFloat((cur-past).toFixed(1));
  }catch(e){return 0;}
}

function loadScoreHistory(){try{return JSON.parse(localStorage.getItem("score_hist")||"{}");}catch(e){return{};}}
function backfillScoreHistoryFromCOTHistory(cotHist){
  // V4.1: okamžitě vytvoří historickou score křivku z COT historie.
  // Není to plný makro backtest; je to COT/smart-money historický proxy score,
  // které se potom dál přepisuje živým kompletním skóre při běžném používání.
  try{
    const existing=loadScoreHistory();
    const hist={...existing};
    const dates=Object.keys(cotHist||{}).sort();
    const maxAbsFlow={};
    for(const d of dates){
      for(const c of CURRENCIES){
        const f=Math.abs(cotHist[d]?.raw?.[c]?.flow||0);
        if(f>0) maxAbsFlow[c]=Math.max(maxAbsFlow[c]||0,f);
      }
    }
    for(const d of dates){
      hist[d]=hist[d]||{};
      for(const c of CURRENCIES){
        // OPRAVA: nepřepisuj existující reálná skóre proxy hodnotou
        if(typeof hist[d][c]==="number") continue;
        const cot=Number(cotHist[d]?.scores?.[c]??0);
        const flow=Number(cotHist[d]?.raw?.[c]?.flow??0);
        const denom=maxAbsFlow[c]||1;
        const flowScore=Math.max(-1.2,Math.min(1.2,(flow/denom)*1.2));
        const proxy=Math.max(-10,Math.min(10,cot*2.4+flowScore));
        hist[d][c]=parseFloat(proxy.toFixed(2));
      }
      hist[d]._source="COT historical proxy";
    }
    const keep=Object.keys(hist).sort().slice(-260);
    const trimmed={};keep.forEach(d=>trimmed[d]=hist[d]);
    localStorage.setItem("score_hist",JSON.stringify(trimmed));
    return keep.length;
  }catch(e){return 0;}
}
function svgPolyline(values,w=360,h=120,pad=16){
  if(!values.length) return "";
  const min=Math.min(-10,...values),max=Math.max(10,...values),span=max-min||1;
  return values.map((v,i)=>{
    const x=pad+(values.length===1?0:i*(w-2*pad)/(values.length-1));
    const y=h-pad-((v-min)/span)*(h-2*pad);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}
function pairBiasScore(p){return Math.round(Math.max(0,Math.min(100,50+(p.dir==="BUY"?p.diff:-p.diff)*3.5)));}

// ── COT & RETAIL SENTIMENT (auto + fallback localStorage) ─────────
const COT_DEFAULT=Object.fromEntries(CURRENCIES.map(c=>[c,0]));
const SENT_DEFAULT=Object.fromEntries(CURRENCIES.map(c=>[c,50]));
const COT_MARKETS={
  EUR:"EURO FX",GBP:"BRITISH POUND",JPY:"JAPANESE YEN",AUD:"AUSTRALIAN DOLLAR",
  CAD:"CANADIAN DOLLAR",CHF:"SWISS FRANC",NZD:"NZ DOLLAR"
};

function loadCOT(){
  try{return JSON.parse(localStorage.getItem("cot_data")||"null")||{...COT_DEFAULT};}catch(e){return{...COT_DEFAULT};}
}
function saveCOT(data){try{localStorage.setItem("cot_data",JSON.stringify(data));}catch(e){}}
function loadCOTMeta(){try{return JSON.parse(localStorage.getItem("cot_meta")||"null")||{};}catch(e){return{};}}
function saveCOTMeta(data){try{localStorage.setItem("cot_meta",JSON.stringify(data));}catch(e){}}
function loadSentiment(){
  try{return JSON.parse(localStorage.getItem("sent_data")||"null")||{...SENT_DEFAULT};}catch(e){return{...SENT_DEFAULT};}
}
function saveSentiment(data){try{localStorage.setItem("sent_data",JSON.stringify(data));}catch(e){}}

// ── RETAIL SENTIMENT HISTORY (pro grafy) ─────────────────────
function loadRetailHistory(){try{return JSON.parse(localStorage.getItem("retail_hist")||"{}");}catch(e){return{};}}
function saveRetailSnapshot(sentData){
  try{
    const key=new Date().toISOString().split("T")[0];
    const hist=loadRetailHistory();
    hist[key]={...sentData,_ts:Date.now()};
    const keys=Object.keys(hist).sort().slice(-60);
    const trimmed={};keys.forEach(k=>trimmed[k]=hist[k]);
    localStorage.setItem("retail_hist",JSON.stringify(trimmed));
  }catch(e){}
}
function getRetailSeries(pair,limit=52){
  // Vrátí RAW % long (0–100) z uložené historie snapshots
  // Neutrální = 50%, bearish signal = 70%+, bullish signal = 30%−
  const hist=loadRetailHistory();
  const dates=Object.keys(hist).sort().slice(-limit);
  if(!dates.length) return [];
  return dates.map(d=>{
    const snap=hist[d]||{};
    const bLong=Number(snap[pair.base]??50);
    const qLong=Number(snap[pair.quote]??50);
    // % long pro pár: base long + quote short (inverted) → průměr
    return Math.round((bLong+(100-qLong))/2);  // 0–100, neutral=50
  });
}

// abortTimeout polyfill — kompatibilní se starším Safari/Firefox
function abortTimeout(ms){
  const ctrl=new AbortController();
  setTimeout(()=>ctrl.abort(),ms);
  return ctrl.signal;
}
// OANDA v20 API — positionBook dává přesná % long/short
// Demo účet: api-fxpractice.oanda.com
// Live účet: api-fxtrade.oanda.com
// Potřebuješ: API token z OANDA (zdarma s demo účtem)

const OANDA_INSTRUMENTS=[
  {oanda:"EUR_USD",base:"EUR",quote:"USD"},
  {oanda:"USD_JPY",base:"USD",quote:"JPY"},
  {oanda:"GBP_USD",base:"GBP",quote:"USD"},
  {oanda:"AUD_USD",base:"AUD",quote:"USD"},
  {oanda:"NZD_USD",base:"NZD",quote:"USD"},
  {oanda:"USD_CAD",base:"USD",quote:"CAD"},
  {oanda:"USD_CHF",base:"USD",quote:"CHF"},
  {oanda:"EUR_GBP",base:"EUR",quote:"GBP"},
  {oanda:"EUR_JPY",base:"EUR",quote:"JPY"},
  {oanda:"GBP_JPY",base:"GBP",quote:"JPY"},
];

async function fetchOANDABook(instrument, token, isPractice){
  const base = isPractice
    ? "https://api-fxpractice.oanda.com"
    : "https://api-fxtrade.oanda.com";
  const url = `${base}/v3/instruments/${instrument}/positionBook`;
  const r = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept-Datetime-Format": "RFC3339",
    },
    signal: abortTimeout(10000),
  });
  if(!r.ok){
    if(r.status===401) throw new Error("OANDA: Neplatný API token. Zkontroluj klíč v Settings.");
    if(r.status===404) throw new Error(`OANDA: Instrument ${instrument} nenalezen.`);
    throw new Error(`OANDA HTTP ${r.status}`);
  }
  return r.json();
}

function parseOANDABookToLongPct(bookData){
  // bookData.positionBook.buckets → [{longCountPercent, shortCountPercent}]
  const buckets = bookData?.positionBook?.buckets || [];
  if(!buckets.length) return null;
  let totalLong=0, totalShort=0;
  for(const b of buckets){
    totalLong  += parseFloat(b.longCountPercent  || 0);
    totalShort += parseFloat(b.shortCountPercent || 0);
  }
  const total = totalLong + totalShort;
  if(total === 0) return null;
  return Math.round(totalLong / total * 100);
}

async function fetchOANDARetailSentiment(token, isPractice=true){
  if(!token) throw new Error("OANDA token není zadán. Přidej ho v Settings.");

  const results = {}; // pair → longPct
  const errors  = [];

  // Fetchneme páry paralelně (max 5 najednou pro OANDA rate limit)
  const chunks = [];
  for(let i=0; i<OANDA_INSTRUMENTS.length; i+=5){
    chunks.push(OANDA_INSTRUMENTS.slice(i, i+5));
  }
  for(const chunk of chunks){
    const settled = await Promise.allSettled(
      chunk.map(async ({oanda, base, quote}) => {
        const data = await fetchOANDABook(oanda, token, isPractice);
        const longPct = parseOANDABookToLongPct(data);
        if(longPct !== null) results[oanda] = {longPct, base, quote};
      })
    );
    settled.forEach((r,i) => {
      if(r.status==="rejected") errors.push(`${chunk[i].oanda}: ${r.reason?.message||r.reason}`);
    });
  }

  if(!Object.keys(results).length){
    throw new Error("OANDA: Žádná data. " + errors.slice(0,2).join("; "));
  }

  // Agregace na currency-level
  const contrib = {}; const cnt = {};
  for(const cur of CURRENCIES){ contrib[cur]=0; cnt[cur]=0; }

  for(const [pair, {longPct, base, quote}] of Object.entries(results)){
    // base: retail long% na páru → base je long
    if(CURRENCIES.includes(base)){ contrib[base]+=longPct;       cnt[base]++; }
    // quote: retail long% na páru → quote je short (invertováno)
    if(CURRENCIES.includes(quote)){ contrib[quote]+=(100-longPct); cnt[quote]++; }
  }
  const sentData = {};
  for(const cur of CURRENCIES){
    sentData[cur] = cnt[cur]>0 ? Math.round(contrib[cur]/cnt[cur]) : 50;
  }
  return {
    sentData,
    rawPairs: results,
    source: `OANDA ${isPractice?"Practice":"Live"}`,
    timestamp: new Date().toISOString(),
    method: "oanda_api",
    pairsLoaded: Object.keys(results).length,
    errors: errors.length ? errors : undefined,
  };
}
// 1. CFTC Non-reportable positions z CFTC TFF textu (stejný soubor co COT) → REÁLNÍ retailoví tradeři
// 2. MyFxBook přes Jina.ai AI reader (renderuje JS stránky)
// 3. Derivace z aktuálních COT dat — matematická aproximace

function parseNonReportableFromCOT(txt){
  // CFTC TFF format: pozice jsou řazeny:
  // [0-2]=Dealer, [3-5]=Asset Mgr, [6-8]=Lev.Funds, [9-11]=Other Rep., [12-13]=NonReportable
  // Non-reportable = malí spekulanti = retail tradeři
  const lines=txt.split(/\r?\n/); const out={};
  for(const [ccy,market] of Object.entries(COT_MARKETS)){
    const idx=lines.findIndex(l=>l.toUpperCase().includes(market)&&l.toUpperCase().includes("CHICAGO MERCANTILE EXCHANGE"));
    if(idx<0) continue;
    const posIdx=lines.findIndex((l,i)=>i>idx&&i<idx+14&&l.trim().toLowerCase()==="positions");
    if(posIdx<0) continue;
    // Hledáme první řádek s >= 14 čísly
    let n=[];
    for(let j=posIdx+1;j<Math.min(lines.length,posIdx+8);j++){
      const nums=parseNums(lines[j]);
      if(nums.length>=14){n=nums;break;}
    }
    if(n.length<14) continue;
    // n[12]=NonReport Long, n[13]=NonReport Short
    const nrLong=n[12],nrShort=n[13];
    if(nrLong>0||nrShort>0){
      const total=nrLong+nrShort;
      out[ccy]=total>0?Math.round(nrLong/total*100):50;
    }
  }
  // USD = inverse of average (retail má opačnou expozici vs non-USD měny)
  const vals=Object.values(out).filter(v=>typeof v==="number");
  if(vals.length>=3){
    out.USD=Math.round(100-vals.reduce((a,b)=>a+b,0)/vals.length);
  }
  return Object.keys(out).length>=4?out:null;
}

function deriveRetailFromCOTData(){
  // Záložní derivace retail sentimentu z institucionálních COT pozic.
  // Výzkum ukázal: retail typicky sleduje trend, ale na extrémech bývá na špatné straně.
  const stored=loadCOTMeta();
  const raw=stored?.raw||{};
  const cotData=loadCOT();
  const result={};
  for(const cur of CURRENCIES){
    const r=raw[cur]||{};
    const cotScore=cotData[cur]||0;
    const levRatio=r.levRatio||0;
    // Derivace: silně long instituce → retail se přidal → 60-75% long (contrarian bearish)
    // Silně short instituce → retail se přidal → 25-40% long (contrarian bullish)
    let retailLong;
    if(Math.abs(levRatio)>=0.5){
      // Extrem — retail obvykle opačná strana (contrarian)
      retailLong=levRatio>0?72:28;
    }else if(Math.abs(levRatio)>=0.25){
      retailLong=Math.round(50+levRatio*44);
    }else if(Math.abs(cotScore)>=2){
      retailLong=Math.round(50+cotScore*8);
    }else{
      retailLong=50;
    }
    result[cur]=Math.max(15,Math.min(85,Math.round(retailLong)));
  }
  return result;
}

async function fetchRetailSentiment(){
  // ── PŘÍSTUP 1: CFTC Non-reportable positions (reálná data, primární zdroj) ──
  // Malí spekulanti z CFTC TFF = reálný retail. Jde přes stejnou funkční proxy
  // infrastrukturu jako COT, takže funguje i bez OANDA účtu / mimo EU.
  try{
    const url="https://www.cftc.gov/dea/futures/financial_lf.htm";
    const txt=await fetchTextWithFallback(url);
    const parsed=parseNonReportableFromCOT(txt);
    if(parsed){
      return{sentData:parsed,rawPairs:{},source:"CFTC Non-reportable",timestamp:new Date().toISOString(),method:"cftc_nonreport"};
    }
  }catch(e){console.log("CFTC NonReport failed:",e?.message);}

  // ── PŘÍSTUP 2: OANDA v20 API — jen pokud má uživatel token (mimo EU) ──
  // Pozn.: OANDA neposílá CORS hlavičky pro prohlížeč a v EU není dostupné,
  // proto je až jako záloha za CFTC. Když token chybí/selže, jede se dál.
  const oandaToken   = localStorage.getItem("oanda_token")||"";
  const oandaPractice = (localStorage.getItem("oanda_env")||"practice") === "practice";
  if(oandaToken){
    try{
      const res = await fetchOANDARetailSentiment(oandaToken, oandaPractice);
      return res;
    }catch(e){ console.log("OANDA retail failed:", e?.message); }
  }

  // ── PŘÍSTUP 2: MyFxBook přes Jina.ai (renderuje JS stránky) ──
  const MYFXBOOK_URL="https://www.myfxbook.com/community/outlook";
  const htmlProxies=[
    "https://r.jina.ai/"+MYFXBOOK_URL,           // Jina.ai renderuje JS
    "https://api.allorigins.win/raw?url="+encodeURIComponent(MYFXBOOK_URL),
    "https://corsproxy.io/?"+encodeURIComponent(MYFXBOOK_URL),
  ];
  for(const proxy of htmlProxies){
    try{
      const r=await fetch(proxy,{cache:"no-store",signal:abortTimeout(15000)});
      if(!r.ok) continue;
      const html=await r.text();
      if(!html||html.length<1000) continue;

      const sentByPair={};
      // Vzor 1: JSON s longPercentage/shortPercentage
      const patterns=[
        /"symbol"\s*:\s*"([A-Z]{6})"[^}]*?"longPercentage"\s*:\s*([\d.]+)[^}]*?"shortPercentage"\s*:\s*([\d.]+)/g,
        /"symbol"\s*:\s*"([A-Z]{6})"[^}]*?"shortPercentage"\s*:\s*([\d.]+)[^}]*?"longPercentage"\s*:\s*([\d.]+)/g,
        /([A-Z]{6}).*?(\d{2,3}(?:\.\d{1,2})?)%.*?(\d{2,3}(?:\.\d{1,2})?)%/g,
      ];
      for(const [i,pat] of patterns.entries()){
        const matches=[...html.matchAll(pat)];
        for(const m of matches){
          const sym=m[1];
          let longPct=parseFloat(i===1?m[3]:m[2]);
          let shortPct=parseFloat(i===1?m[2]:m[3]);
          if(i===2&&(longPct+shortPct<90||longPct+shortPct>110)) continue;
          sentByPair[sym]={long:longPct,short:shortPct};
        }
        if(Object.keys(sentByPair).length>=4) break;
      }
      // __NEXT_DATA__ / window stav
      if(!Object.keys(sentByPair).length){
        const nextMatch=html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
        if(nextMatch){
          try{
            const nd=JSON.parse(nextMatch[1]);
            const str=JSON.stringify(nd);
            const nested=[...str.matchAll(/"symbol"\s*:\s*"([A-Z]{6})"[^}]*?"longPercentage"\s*:\s*([\d.]+)/g)];
            nested.forEach(m=>sentByPair[m[1]]={long:parseFloat(m[2]),short:100-parseFloat(m[2])});
          }catch(e){}
        }
      }
      if(Object.keys(sentByPair).length>=4){
        // Konverze na currency-level
        const result={};for(const cur of CURRENCIES) result[cur]=50;
        const contrib={};const cnt={};
        for(const [pair,data] of Object.entries(sentByPair)){
          const base=pair.slice(0,3),quote=pair.slice(3,6);
          if(CURRENCIES.includes(base)){contrib[base]=(contrib[base]||0)+data.long;cnt[base]=(cnt[base]||0)+1;}
          if(CURRENCIES.includes(quote)){contrib[quote]=(contrib[quote]||0)+(100-data.long);cnt[quote]=(cnt[quote]||0)+1;}
        }
        for(const cur of CURRENCIES) if(cnt[cur]>0) result[cur]=Math.round(contrib[cur]/cnt[cur]);
        return{sentData:result,rawPairs:sentByPair,source:"MyFxBook",timestamp:new Date().toISOString(),method:"myfxbook"};
      }
    }catch(e){continue;}
  }

  // ── PŘÍSTUP 3: Derivace z COT dat (záloha) ──
  const derived=deriveRetailFromCOTData();
  return{
    sentData:derived,rawPairs:{},
    source:"COT-derived",timestamp:new Date().toISOString(),
    method:"cot_derived",
    note:"Derivace z institucionálního COT positioning (CFTC Non-reportable nedostupný, MyFxBook blokovaný). Výsledky jsou orientační."
  };
}

function cotNet(longPos,shortPos){
  const l=Number(longPos)||0,s=Number(shortPos)||0;
  return{long:l,short:s,net:l-s,ratio:(l+s)>0?(l-s)/(l+s):0};
}
function cotNetScore(longPos,shortPos){
  const n=cotNet(longPos,shortPos);
  return parseFloat(Math.max(-3,Math.min(3,n.ratio*6)).toFixed(1));
}
function cotExtremeFromRatio(r){
  const abs=Math.abs(r);
  if(abs>=0.50) return{level:"EXTREME",label:r>0?"crowded long":"crowded short",color:r>0?"#3fb950":"#f85149"};
  if(abs>=0.32) return{level:"HIGH",label:r>0?"silně long":"silně short",color:r>0?"#3fb950":"#f85149"};
  return{level:"NORMAL",label:"bez extrému",color:"#8b949e"};
}
function parseNums(line){return (line.match(/-?\d[\d,]*/g)||[]).map(x=>parseInt(x.replace(/,/g,""),10));}
function firstNumericLine(lines,from,to){
  for(let j=from;j<Math.min(lines.length,to);j++) if(parseNums(lines[j]).length>=14) return lines[j];
  return "";
}
function parseCOTFinancialText(txt){
  const lines=txt.split(/\r?\n/);const out={};const raw={};
  for(const [ccy,market] of Object.entries(COT_MARKETS)){
    const idx=lines.findIndex(l=>l.toUpperCase().includes(market) && l.toUpperCase().includes("CHICAGO MERCANTILE EXCHANGE"));
    if(idx<0) continue;
    const posIdx=lines.findIndex((l,i)=>i>idx&&i<idx+14&&l.trim().toLowerCase()==="positions");
    if(posIdx<0) continue;
    const n=parseNums(firstNumericLine(lines,posIdx+1,posIdx+7));
    if(n.length<14) continue;
    const chIdx=lines.findIndex((l,i)=>i>posIdx&&i<posIdx+30&&l.toLowerCase().includes("changes from"));
    const ch=chIdx>0?parseNums(firstNumericLine(lines,chIdx+1,chIdx+7)):[];
    const assetLong=n[3],assetShort=n[4],levLong=n[6],levShort=n[7];
    const asset=cotNet(assetLong,assetShort),lev=cotNet(levLong,levShort);
    const assetScore=cotNetScore(assetLong,assetShort),levScore=cotNetScore(levLong,levShort);
    const score=parseFloat((levScore*0.70+assetScore*0.30).toFixed(1));
    const levChange=(ch.length>=9?((ch[6]||0)-(ch[7]||0)):0);
    const assetChange=(ch.length>=6?((ch[3]||0)-(ch[4]||0)):0);
    const flow=levChange*0.70+assetChange*0.30;
    out[ccy]=score;
    raw[ccy]={market,assetLong,assetShort,levLong,levShort,assetNet:asset.net,levNet:lev.net,levRatio:lev.ratio,assetRatio:asset.ratio,
      levScore,assetScore,score,levChange,assetChange,flow:Math.round(flow),extreme:cotExtremeFromRatio(lev.ratio)};
  }
  const vals=Object.values(out).filter(v=>typeof v==="number"&&!isNaN(v));
  out.USD=vals.length?parseFloat((-vals.reduce((a,b)=>a+b,0)/vals.length).toFixed(1)):0;
  const flows=Object.values(raw).map(r=>r.flow||0);
  raw.USD={market:"syntetický USD koš",note:"opačný průměr dostupných non-USD COT měn",score:out.USD,flow:flows.length?Math.round(-flows.reduce((a,b)=>a+b,0)/flows.length):0,extreme:{level:"SYNTH",label:"syntetický koš",color:"#8b949e"}};
  if(vals.length<5) throw new Error("COT parser našel jen "+vals.length+" měn. Zdroj změnil formát nebo proxy vrátila nekompletní text.");
  return{scores:{...COT_DEFAULT,...out},raw};
}
function loadCOTHistory(){try{return JSON.parse(localStorage.getItem("cot_hist")||"{}");}catch(e){return{};}}
function saveCOTSnapshot(scores,meta){
  try{
    const key=(meta?.asOf||new Date().toISOString().split("T")[0]).replace(/\s+/g," ");
    const hist=loadCOTHistory();hist[key]={scores,raw:meta?.raw||{},updatedAt:new Date().toISOString()};
    const keys=Object.keys(hist).sort().slice(-60);const trimmed={};keys.forEach(k=>trimmed[k]=hist[k]);
    localStorage.setItem("cot_hist",JSON.stringify(trimmed));
  }catch(e){}
}
async function fetchTextWithFallback(url){
  const urls=[url,"https://r.jina.ai/"+url,"https://api.allorigins.win/raw?url="+encodeURIComponent(url),"https://corsproxy.io/?"+encodeURIComponent(url)];
  let lastErr=null;
  for(const u of urls){
    try{
      const r=await fetch(u,{cache:"no-store"});
      if(r.ok){
        const t=await r.text();
        if(t && t.includes("Positions") && (t.includes("EURO FX")||t.includes("CANADIAN DOLLAR"))) return t;
        lastErr=new Error("Stažený COT text neobsahuje očekávaná data");
      }else{lastErr=new Error("HTTP "+r.status);}
    }catch(e){lastErr=e;}
  }
  throw lastErr||new Error("COT fetch failed");
}
// ── CFTC OFICIÁLNÍ API (Socrata, CORS-native) ───────────────────────
// Primární COT zdroj. Na rozdíl od .htm/.zip přes free proxy posílá
// publicreporting.cftc.gov správné CORS hlavičky → volá se přímo z
// prohlížeče bez proxy = spolehlivé a zdarma. Dataset TFF Futures-Only.
const CFTC_TFF_DATASET="gpe5-46if";
function cftcNum(row,names){
  for(const n of names){const v=row[n]; if(v!=null&&v!==""){const f=parseFloat(v); if(!isNaN(f))return f;}}
  return null;
}
async function fetchCOTViaAPI(){
  const base="https://publicreporting.cftc.gov/resource/"+CFTC_TFF_DATASET+".json";
  // Jeden požadavek: řádky za posledních ~70 dní, od nejnovějšího. Nejnovější
  // datum i párování trhů řešíme v JS → odolné vůči formátu timestampu/poli.
  const cutoff=new Date(Date.now()-70*86400000).toISOString().slice(0,10);
  const where=encodeURIComponent("report_date_as_yyyy_mm_dd > '"+cutoff+"T00:00:00.000'");
  const order=encodeURIComponent("report_date_as_yyyy_mm_dd DESC");
  const rows=await fetchJSONWithProxies(base+"?$where="+where+"&$order="+order+"&$limit=5000");
  if(!Array.isArray(rows)) throw new Error("CFTC API nevrátilo pole: "+String(JSON.stringify(rows)).slice(0,120));
  if(!rows.length) throw new Error("CFTC API: 0 řádků za 70 dní");
  let maxDate=""; for(const r of rows){const d=String(r.report_date_as_yyyy_mm_dd||"");if(d>maxDate)maxDate=d;}
  const asOf=maxDate.slice(0,10);
  const week=rows.filter(r=>String(r.report_date_as_yyyy_mm_dd||"")===maxDate);
  const out={},raw={};
  for(const [ccy,market] of Object.entries(COT_MARKETS)){
    const row=week.find(r=>{const nm=String(r.market_and_exchange_names||r.contract_market_name||"").toUpperCase();return nm.includes(market)&&nm.includes("CHICAGO MERCANTILE");});
    if(!row) continue;
    const assetLong=cftcNum(row,["asset_mgr_positions_long","asset_mgr_positions_long_all"]);
    const assetShort=cftcNum(row,["asset_mgr_positions_short","asset_mgr_positions_short_all"]);
    const levLong=cftcNum(row,["lev_money_positions_long","lev_money_positions_long_all"]);
    const levShort=cftcNum(row,["lev_money_positions_short","lev_money_positions_short_all"]);
    if([assetLong,assetShort,levLong,levShort].some(v=>v==null)) continue;
    const asset=cotNet(assetLong,assetShort),lev=cotNet(levLong,levShort);
    const assetScore=cotNetScore(assetLong,assetShort),levScore=cotNetScore(levLong,levShort);
    const score=parseFloat((levScore*0.70+assetScore*0.30).toFixed(1));
    const levChange=(cftcNum(row,["change_in_lev_money_long","change_in_lev_money_long_all"])||0)-(cftcNum(row,["change_in_lev_money_short","change_in_lev_money_short_all"])||0);
    const assetChange=(cftcNum(row,["change_in_asset_mgr_long","change_in_asset_mgr_long_all"])||0)-(cftcNum(row,["change_in_asset_mgr_short","change_in_asset_mgr_short_all"])||0);
    const flow=levChange*0.70+assetChange*0.30;
    out[ccy]=score;
    raw[ccy]={market,assetLong,assetShort,levLong,levShort,assetNet:asset.net,levNet:lev.net,levRatio:lev.ratio,assetRatio:asset.ratio,
      levScore,assetScore,score,levChange,assetChange,flow:Math.round(flow),extreme:cotExtremeFromRatio(lev.ratio)};
  }
  const vals=Object.values(out).filter(v=>typeof v==="number"&&!isNaN(v));
  if(vals.length<5) throw new Error("CFTC API: namapováno jen "+vals.length+" měn (změna schématu?)");
  out.USD=parseFloat((-vals.reduce((a,b)=>a+b,0)/vals.length).toFixed(1));
  const flows=Object.values(raw).map(r=>r.flow||0);
  raw.USD={market:"syntetický USD koš",note:"opačný průměr dostupných non-USD COT měn",score:out.USD,flow:flows.length?Math.round(-flows.reduce((a,b)=>a+b,0)/flows.length):0,extreme:{level:"SYNTH",label:"syntetický koš",color:"#8b949e"}};
  return{scores:{...COT_DEFAULT,...out},raw,asOf};
}
async function fetchCOTAuto(){
  try{
    const api=await fetchCOTViaAPI();
    const meta={source:"CFTC oficiální API (TFF Futures-Only)",asOf:api.asOf,updatedAt:new Date().toISOString(),raw:api.raw,via:"cftc_api"};
    saveCOT(api.scores);saveCOTMeta(meta);saveCOTSnapshot(api.scores,meta);
    return{scores:api.scores,meta};
  }catch(apiErr){
    // Fallback: původní .htm přes proxy (když API nedostupné / změní schéma)
    try{
      const url="https://www.cftc.gov/dea/futures/financial_lf.htm";
      const txt=await fetchTextWithFallback(url);
      const parsed=parseCOTFinancialText(txt);
      const asOf=(txt.match(/Positions as of\s+([^\n<]+)/i)||[])[1]?.trim()||new Date().toISOString().split("T")[0];
      const meta={source:url+" (fallback)",asOf,updatedAt:new Date().toISOString(),raw:parsed.raw,via:"proxy_text",apiError:String(apiErr?.message||apiErr)};
      saveCOT(parsed.scores);saveCOTMeta(meta);saveCOTSnapshot(parsed.scores,meta);
      return{scores:parsed.scores,meta};
    }catch(txtErr){
      throw new Error("COT: API i proxy fallback selhaly. API: "+(apiErr?.message||apiErr)+" · proxy: "+(txtErr?.message||txtErr));
    }
  }
}



// ── AI CHART ANALYZER ─────────────────────────────────────
function fileToBase64(file){
  return new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result.split(",")[1]);r.onerror=rej;r.readAsDataURL(file);});
}
const AI_SYSTEM_PROMPT=`You are a professional FX chart analyst with deep expertise in ICT (Inner Circle Trader) / Smart Money Concepts AND classical technical analysis. Analyze the provided forex/index chart image and return ONLY a single valid JSON object — no markdown, no explanation, no text outside the JSON.

Use this exact structure:
{
  "bias": "BULLISH"|"BEARISH"|"SIDEWAYS",
  "confidence": <0-100>,
  "timeframe_context": "<one sentence>",
  "market_structure": {
    "trend": "UPTREND"|"DOWNTREND"|"RANGING",
    "description": "<2-3 sentences>",
    "bos_choch": "<BOS/CHoCH description or None visible>",
    "swing_points": {"hh":<n>,"hl":<n>,"lh":<n>,"ll":<n>}
  },
  "key_levels": [{"type":"RESISTANCE"|"SUPPORT","zone":"<label>","strength":"STRONG"|"MEDIUM"|"WEAK","notes":"<why>"}],
  "ict_smc": {
    "order_blocks":[{"type":"BULLISH"|"BEARISH","location":"<desc>","status":"UNTESTED"|"TESTED"|"MITIGATED","significance":"HIGH"|"MEDIUM"|"LOW"}],
    "fvg":[{"type":"BULLISH"|"BEARISH","location":"<desc>","status":"OPEN"|"PARTIALLY_FILLED"|"FILLED"}],
    "liquidity":[{"type":"BSL"|"SSL","location":"<desc>","notes":"<equal highs/lows etc>"}],
    "premium_discount":"<price position in range>"
  },
  "classical_ta": {
    "trendlines":"<describe or None identified>",
    "patterns":"<patterns or None identified>",
    "ema_structure":"<EMA alignment or Not visible>",
    "momentum":"<momentum description>"
  },
  "entry_setup": {
    "direction":"BUY"|"SELL"|"WAIT",
    "entry_zone":"<where to enter>",
    "entry_trigger":"<confirmation signal>",
    "stop_loss":"<placement logic>",
    "tp1":"<first target>",
    "tp2":"<second target>",
    "rr_estimate":"<e.g. 1:2>",
    "confluence_factors":["<factor1>","<factor2>"],
    "invalidation":"<what invalidates>"
  },
  "risk_warnings":["<warning>"],
  "summary":"<3-4 sentence professional summary>"
}

LANGUAGE RULE (IMPORTANT):
Write ALL human-readable free text in CZECH (Czech language). This includes every descriptive/explanatory value: timeframe_context, market_structure.description, bos_choch, key_levels notes, ict_smc locations and notes, premium_discount, all classical_ta fields, entry_zone, entry_trigger, stop_loss, tp1, tp2, confluence_factors, invalidation, risk_warnings, and summary.
BUT keep these ENUM/KEYWORD values EXACTLY in English (do NOT translate them — the app compares them in code): bias (BULLISH/BEARISH/SIDEWAYS), market_structure.trend (UPTREND/DOWNTREND/RANGING), key_levels.type (RESISTANCE/SUPPORT), strength (STRONG/MEDIUM/WEAK), order_blocks.type & fvg.type (BULLISH/BEARISH), status (UNTESTED/TESTED/MITIGATED/OPEN/PARTIALLY_FILLED/FILLED), significance (HIGH/MEDIUM/LOW), liquidity.type (BSL/SSL), entry_setup.direction (BUY/SELL/WAIT). Numbers stay numbers. Return ONLY the JSON object.`;

// ── COT HISTORIE (CFTC Historical Compressed) ─────────────
function parseCSV(text){
  const rows=[];let row=[],cur="",q=false;
  for(let i=0;i<text.length;i++){
    const ch=text[i],nx=text[i+1];
    if(ch==='"'){
      if(q&&nx==='"'){cur+='"';i++;} else q=!q;
    }else if(ch===','&&!q){row.push(cur);cur="";}
    else if((ch==='\n'||ch==='\r')&&!q){
      if(ch==='\r'&&nx==='\n') i++;
      row.push(cur);cur="";
      if(row.some(x=>String(x).trim()!=="")) rows.push(row);
      row=[];
    }else cur+=ch;
  }
  if(cur||row.length){row.push(cur);if(row.some(x=>String(x).trim()!=="")) rows.push(row);}
  return rows;
}
function normHeader(x){return String(x||"").toLowerCase().replace(/[^a-z0-9]/g,"");}
function pickCol(headers,patterns){
  const hs=headers.map(normHeader);
  for(const pat of patterns){
    const p=normHeader(pat);
    const idx=hs.findIndex(h=>h===p||h.includes(p));
    if(idx>=0) return idx;
  }
  return -1;
}
function numCell(x){return parseFloat(String(x||"0").replace(/,/g,""))||0;}
function scoreFromHistoricalRow(row,idx){
  const al=numCell(row[idx.assetLong]),as=numCell(row[idx.assetShort]),ll=numCell(row[idx.levLong]),ls=numCell(row[idx.levShort]);
  const asset=cotNet(al,as),lev=cotNet(ll,ls);
  const assetScore=cotNetScore(al,as),levScore=cotNetScore(ll,ls);
  return {score:parseFloat((levScore*.70+assetScore*.30).toFixed(1)),assetNet:asset.net,levNet:lev.net,levRatio:lev.ratio,assetRatio:asset.ratio,extreme:cotExtremeFromRatio(lev.ratio)};
}
function parseCOTHistoricalText(text){
  const rows=parseCSV(text);
  if(rows.length<5) throw new Error("Historický COT soubor je prázdný nebo není CSV/TXT.");
  const h=rows[0];
  const idx={
    market:pickCol(h,["Market_and_Exchange_Names","Market and Exchange Names","Market_and_Exchange_Name"]),
    date:pickCol(h,["Report_Date_as_YYYY-MM-DD","As_of_Date_In_Form_YYMMDD","Report_Date_as_MM_DD_YYYY","As of Date"]),
    assetLong:pickCol(h,["Asset_Mgr_Positions_Long_All","Asset Manager Long All","Asset_Mgr_Long_All"]),
    assetShort:pickCol(h,["Asset_Mgr_Positions_Short_All","Asset Manager Short All","Asset_Mgr_Short_All"]),
    levLong:pickCol(h,["Lev_Money_Positions_Long_All","Leveraged Funds Long All","Lev_Money_Long_All"]),
    levShort:pickCol(h,["Lev_Money_Positions_Short_All","Leveraged Funds Short All","Lev_Money_Short_All"]),
  };
  if(Object.values(idx).some(v=>v<0)) throw new Error("Neznámý formát historického TFF souboru — chybí očekávané sloupce.");
  const byDate={};
  for(const row of rows.slice(1)){
    const market=String(row[idx.market]||"").toUpperCase();
    const ccy=Object.entries(COT_MARKETS).find(([,m])=>market.includes(m))?.[0];
    if(!ccy) continue;
    let date=String(row[idx.date]||"").trim();
    if(/^\d{6}$/.test(date)) date=`20${date.slice(0,2)}-${date.slice(2,4)}-${date.slice(4,6)}`;
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    byDate[date]=byDate[date]||{scores:{},raw:{}};
    const r=scoreFromHistoricalRow(row,idx);
    byDate[date].scores[ccy]=r.score;
    byDate[date].raw[ccy]={market:COT_MARKETS[ccy],score:r.score,levNet:r.levNet,assetNet:r.assetNet,levRatio:r.levRatio,assetRatio:r.assetRatio,flow:0,extreme:r.extreme};
  }
  const dates=Object.keys(byDate).sort();
  for(const date of dates){
    const vals=Object.values(byDate[date].scores).filter(v=>typeof v==="number"&&!isNaN(v));
    byDate[date].scores.USD=vals.length?parseFloat((-vals.reduce((a,b)=>a+b,0)/vals.length).toFixed(1)):0;
    byDate[date].raw.USD={market:"syntetický USD koš",score:byDate[date].scores.USD,flow:0,extreme:{level:"SYNTH",label:"syntetický koš",color:"#8b949e"}};
  }
  // dopočítat weekly flow z netu LF
  const prev={};
  for(const date of dates){
    for(const c of CURRENCIES){
      const r=byDate[date].raw[c]; if(!r) continue;
      const net=r.levNet??r.score;
      r.flow=prev[c]!==undefined?Math.round(net-prev[c]):0;
      prev[c]=net;
    }
  }
  return byDate;
}
async function fetchBlobAny(urls,validate){
  let last=null;
  for(const url of urls){
    try{
      const r=await fetch(url,{cache:"no-store"});
      if(!r.ok){last=new Error("HTTP "+r.status);continue;}
      const blob=await r.blob();
      if(validate){const ok=await validate(blob);if(!ok){last=new Error("neplatný obsah (proxy?)");continue;}}
      return blob;
    }catch(e){last=e;}
  }
  throw last||new Error("historical fetch failed");
}
// Ověření, že blob je opravdu ZIP (magic "PK"), ne HTML chybová stránka z proxy.
async function isZipBlob(blob){
  try{ if(blob.size<100) return false; const buf=await blob.slice(0,4).arrayBuffer(); const b=new Uint8Array(buf); return b[0]===0x50&&b[1]===0x4B; }catch(e){ return false; }
}
// Přímý CFTC odkaz + binární CORS proxy jako fallback (GitHub Pages nemá přímý CORS na cftc.gov).
function withBinaryProxies(url){
  const e=encodeURIComponent(url);
  return [url,
    "https://api.allorigins.win/raw?url="+e,
    "https://corsproxy.io/?url="+e,
    "https://api.codetabs.com/v1/proxy/?quest="+url,
    "https://thingproxy.freeboard.io/fetch/"+url];
}
async function fetchCOTHistoryYears(years){
  if(!window.JSZip) throw new Error("JSZip knihovna není načtená — zkontroluj internet/CDN.");
  const hist={};let loaded=0;let lastErr=null;
  for(const y of years){
    // Primární CFTC naming pro Traders in Financial Futures; když CFTC změní název, aplikace jen zahlásí konkrétní chybu.
    const base=`https://www.cftc.gov/files/dea/history/fut_fin_txt_${y}.zip`;
    const urls=withBinaryProxies(base);
    try{
      const blob=await fetchBlobAny(urls,isZipBlob);
      const zip=await JSZip.loadAsync(blob);
      const file=Object.values(zip.files).find(f=>!f.dir && /\.(txt|csv)$/i.test(f.name)) || Object.values(zip.files).find(f=>!f.dir);
      if(!file) throw new Error("ZIP neobsahuje textový soubor");
      const text=await file.async("string");
      const parsed=parseCOTHistoricalText(text);
      Object.assign(hist,parsed); loaded++;
    }catch(e){lastErr=e;}
  }
  if(!Object.keys(hist).length) throw new Error("Nepodařilo se načíst historický COT. Pravděpodobně CORS nebo změněný název CFTC ZIPu: "+(lastErr?.message||lastErr));
  const dates=Object.keys(hist).sort().slice(-260);const trimmed={};dates.forEach(d=>trimmed[d]=hist[d]);
  localStorage.setItem("cot_hist",JSON.stringify(trimmed));
  const scoreHistRecords=backfillScoreHistoryFromCOTHistory(trimmed);
  const last=dates.at(-1),lastRow=trimmed[last];
  if(lastRow){
    saveCOT(lastRow.scores);const meta={source:"CFTC Historical Compressed TFF",asOf:last,updatedAt:new Date().toISOString(),raw:lastRow.raw,historical:true,records:dates.length,scoreHistRecords};
    saveCOTMeta(meta);return{scores:lastRow.scores,meta,records:dates.length,yearsLoaded:loaded,scoreHistRecords};
  }
  return{scores:loadCOT(),meta:loadCOTMeta(),records:dates.length,yearsLoaded:loaded};
}

// V4.2 LOCAL COT: načtení historických COT souborů přímo z PC.
// Podporuje více souborů najednou: .zip z CFTC nebo rozbalené .txt/.csv.
async function readLocalCOTFile(file){
  const name=(file.name||"").toLowerCase();
  if(name.endsWith(".zip")){
    if(!window.JSZip) throw new Error("JSZip knihovna není načtená. Rozbal ZIP a nahraj TXT/CSV soubor, nebo zapni internet kvůli CDN.");
    const buf=await file.arrayBuffer();
    const zip=await JSZip.loadAsync(buf);
    const entry=Object.values(zip.files).find(f=>!f.dir && /\.(txt|csv)$/i.test(f.name)) || Object.values(zip.files).find(f=>!f.dir);
    if(!entry) throw new Error(file.name+": ZIP neobsahuje TXT/CSV soubor.");
    return await entry.async("string");
  }
  return await file.text();
}
async function loadCOTHistoryFromLocalFiles(fileList){
  const files=Array.from(fileList||[]);
  if(!files.length) throw new Error("Nevybral jsi žádný COT soubor.");
  const hist={};let loaded=0;const errors=[];
  for(const file of files){
    try{
      const text=await readLocalCOTFile(file);
      const parsed=parseCOTHistoricalText(text);
      Object.assign(hist,parsed);
      loaded++;
    }catch(e){errors.push((file.name||"soubor")+": "+(e?.message||e));}
  }
  if(!Object.keys(hist).length){
    throw new Error("Nepodařilo se načíst žádný lokální COT soubor. "+errors.slice(0,2).join(" | "));
  }
  const dates=Object.keys(hist).sort().slice(-260);
  const trimmed={};dates.forEach(d=>trimmed[d]=hist[d]);
  localStorage.setItem("cot_hist",JSON.stringify(trimmed));
  const scoreHistRecords=backfillScoreHistoryFromCOTHistory(trimmed);
  const last=dates.at(-1),lastRow=trimmed[last];
  const meta={source:"Lokální CFTC TFF soubory",asOf:last,updatedAt:new Date().toISOString(),raw:lastRow?.raw||{},historical:true,local:true,records:dates.length,scoreHistRecords,filesLoaded:loaded,errors};
  if(lastRow?.scores){saveCOT(lastRow.scores);saveCOTMeta(meta);}
  return{scores:lastRow?.scores||loadCOT(),meta,records:dates.length,filesLoaded:loaded,scoreHistRecords,errors};
}


// COT score: -3..+3, ideálně automaticky z CFTC TFF reportu, ruční slider zůstává jako fallback.
function getCOTScore(currency,cotData){
  return parseFloat((cotData[currency]||0).toFixed(1));
}
// Retail sentiment score: contrarian — 80%+ long = bearish, 20%- long = bullish. Rozsah držíme -1..+1 dle Trading Analyzer logiky.
function getSentimentScore(currency,sentData){
  const pct=sentData[currency]||50;
  if(pct>=80) return -1;
  if(pct>=70) return -0.5;
  if(pct<=20) return 1;
  if(pct<=30) return 0.5;
  return 0;
}

// ── FINNHUB API ───────────────────────────────────────────
const FH="https://finnhub.io/api/v1";
async function fetchCalendar(apiKey,months=15){
  const to=new Date(),from=new Date();
  from.setMonth(from.getMonth()-months);
  const f=from.toISOString().split("T")[0],t=to.toISOString().split("T")[0];
  const res=await fetch(`${FH}/calendar/economic?from=${f}&to=${t}&token=${apiKey}`);
  if(!res.ok) throw new Error(`Finnhub error ${res.status}`);
  return(await res.json()).economicCalendar||[];
}
async function fetchUpcoming14(apiKey){
  const from=new Date().toISOString().split("T")[0];
  const to=new Date(Date.now()+14*86400000).toISOString().split("T")[0];
  const res=await fetch(`${FH}/calendar/economic?from=${from}&to=${to}&token=${apiKey}`);
  if(!res.ok) return[];
  const allCodes=[...new Set([...Object.values(CURRENCY_COUNTRIES).flat(),...Object.values(INDIRECT_COUNTRIES).flat()])];
  return((await res.json()).economicCalendar||[])
    .filter(e=>allCodes.some(c=>(e.country||"").toUpperCase().includes(c))&&getWeight(e.event)>0)
    .sort((a,b)=>new Date(a.time)-new Date(b.time));
}

// ── HLAVNÍ KALENDÁŘ: Financial Modeling Prep (free klíč, plná historie) ──
// Náhrada za placený Finnhub. Free plán dovolí max 3měsíční okno na request,
// tak se 15 měsíců poskládá z 5 oken (+14 dní dopředu na upcoming). Mapuje se
// na stejný tvar jako Finnhub/FF, takže scoring nepozná rozdíl.
const FMP="https://financialmodelingprep.com/api/v3";
const FMP_STABLE="https://financialmodelingprep.com/stable/economic-calendar";
function mapFMPEvent(e){
  return {
    event:e.event||"",
    country:String(e.country||e.currency||"").toUpperCase(),
    time:e.date||"",
    impact:String(e.impact||"").toLowerCase(),
    actual:(e.actual!=null&&e.actual!=="")?String(e.actual):"",
    estimate:((e.estimate??e.consensus??e.forecast)!=null&&(e.estimate??e.consensus??e.forecast)!=="")?String(e.estimate??e.consensus??e.forecast):"",
    prev:(e.previous!=null&&e.previous!=="")?String(e.previous):"",
  };
}
// Vrátí JSON pole z FMP. Přímý fetch → při CORS/síti zkusí přes proxy.
// Chybový objekt {"Error Message":...} (paywall) převede na čitelnou výjimku.
async function fmpFetchArray(url){
  // Přímý pokus. Chyba klíče/plánu (HTTP 4xx nebo {"Error Message":...}) =
  // proxy NEPOMŮŽE → selži rychle. Proxy zkoušíme jen u skutečné síť/CORS chyby.
  try{
    const res=await fetch(url,{cache:"no-store",signal:abortTimeout(12000)});
    const body=await res.text().catch(()=>"");
    let data=null; try{data=JSON.parse(body);}catch(e){}
    if(res.ok&&Array.isArray(data)) return data;
    const msg=(data&&(data["Error Message"]||data.message||data.error))||("HTTP "+res.status);
    throw new Error(String(msg).slice(0,160));
  }catch(e){
    const m=String(e?.message||e);
    if(/Failed to fetch|NetworkError|CORS|aborted|abort|Load failed|TypeError/i.test(m)){
      try{ const data=await fetchJSONWithProxies(url); if(Array.isArray(data)) return data;
        const msg=data&&(data["Error Message"]||data.message); throw new Error(msg?String(msg).slice(0,160):"FMP nevrátil pole"); }
      catch(e2){ throw new Error(String(e2?.message||e2).slice(0,160)); }
    }
    throw e;
  }
}
async function fetchFMPCalendar(apiKey,months=15){
  const out=[];const now=new Date();const windows=Math.ceil(months/3);let lastErr=null;
  for(let i=0;i<windows;i++){
    const to=new Date(now); to.setMonth(to.getMonth()-i*3);
    if(i===0) to.setDate(to.getDate()+14);            // i upcoming události
    const from=new Date(to); from.setMonth(from.getMonth()-3); from.setDate(from.getDate()-(i===0?14:0));
    const f=from.toISOString().split("T")[0],t=to.toISOString().split("T")[0];
    const urls=[
      `${FMP}/economic_calendar?from=${f}&to=${t}&apikey=${apiKey}`,
      `${FMP_STABLE}?from=${f}&to=${t}&apikey=${apiKey}`,
    ];
    let arr=null;
    for(const u of urls){ try{ arr=await fmpFetchArray(u); break; }catch(e){ lastErr=e; } }
    if(!arr) throw lastErr||new Error("FMP request selhal");
    for(const e of arr) out.push(mapFMPEvent(e));
  }
  if(!out.length) throw new Error("FMP vrátil 0 událostí (free tier bez historie?)");
  return out;
}

// ── ZÁLOŽNÍ KALENDÁŘ: ForexFactory (zdarma, bez klíče) ───────────────
// Finnhub /calendar/economic je teď placený (free klíč → 403). Když selže,
// vezmeme volný ForexFactory feed (minulý+tento+příští týden) přes proxy.
const FF_CCY_COUNTRY={USD:"US",EUR:"EU",GBP:"GB",JPY:"JP",AUD:"AU",CAD:"CA",CHF:"CH",NZD:"NZ",CNY:"CN"};
async function fetchJSONWithProxies(url){
  const enc=encodeURIComponent(url);
  const tries=[url,
    "https://api.allorigins.win/raw?url="+enc,
    "https://corsproxy.io/?url="+enc,
    "https://api.codetabs.com/v1/proxy/?quest="+url];
  let last=null;
  for(const u of tries){
    try{
      const r=await fetch(u,{cache:"no-store",signal:abortTimeout(15000)});
      if(!r.ok){last=new Error("HTTP "+r.status);continue;}
      const t=await r.text();
      if(!t||t.length<10){last=new Error("prázdná odpověď");continue;}
      try{return JSON.parse(t);}catch(e){last=new Error("není JSON (proxy?)");}
    }catch(e){last=e;}
  }
  throw last||new Error("fetch selhal");
}
function mapFFEvent(e){
  const ccy=String(e.country||e.currency||"").toUpperCase();
  return {
    event:e.title||e.event||"",
    country:FF_CCY_COUNTRY[ccy]||ccy,
    time:e.date||e.time||"",
    impact:String(e.impact||"").toLowerCase(),
    actual:(e.actual!=null&&e.actual!=="")?String(e.actual):"",
    estimate:(e.forecast!=null&&e.forecast!=="")?String(e.forecast):"",
    prev:(e.previous!=null&&e.previous!=="")?String(e.previous):"",
  };
}
async function fetchFFEvents(){
  const feeds=["ff_calendar_lastweek.json","ff_calendar_thisweek.json","ff_calendar_nextweek.json"];
  const out=[];let ok=0;
  for(const f of feeds){
    try{
      const arr=await fetchJSONWithProxies("https://nfs.faireconomy.media/"+f);
      if(Array.isArray(arr)){arr.forEach(e=>{const m=mapFFEvent(e);if(m.event&&m.time)out.push(m);});ok++;}
    }catch(e){console.log("FF feed "+f+" selhal:",e?.message);}
  }
  if(!out.length) throw new Error("ForexFactory feed nedostupný (proxy/CORS).");
  return out;
}
// Cache FF feedu: appka se refreshuje po 5 min, ale FF povoluje max 2 stažení/5 min.
// Bez cache se nextweek (data dopředu) často nestáhne → výhled spadne na ~1 týden.
// Stahujeme tedy nejvýš 1× za FF_FETCH_TTL; ruční Aktualizovat vynutí čerstvá data.
const FF_CACHE_KEY="v5_ff_cache", FF_FETCH_TTL=45*60*1000;
async function fetchFFEventsCached(force){
  if(!force){
    try{const c=JSON.parse(localStorage.getItem(FF_CACHE_KEY)||"null");
      if(c&&Array.isArray(c.events)&&c.events.length&&(Date.now()-c.ts)<FF_FETCH_TTL) return c.events;
    }catch(e){}
  }
  const fresh=await fetchFFEvents();
  try{localStorage.setItem(FF_CACHE_KEY,JSON.stringify({ts:Date.now(),events:fresh}));}catch(e){}
  return fresh;
}
// ── BACKFILL: jednorázové dotažení nedávných týdnů z forexfactory.com ──
// FF feed dává jen 3 týdny; pro recent okno (2025–dnes) stáhneme týdenní
// stránky z webu FF přes proxy a vyparsujeme. Best-effort: FF/proxy může
// blokovat (Cloudflare) — co projde, slijeme do historie.
async function fetchTextWithProxies(url){
  const enc=encodeURIComponent(url);
  const tries=["https://api.allorigins.win/raw?url="+enc,"https://corsproxy.io/?url="+enc,"https://api.codetabs.com/v1/proxy/?quest="+url];
  let last=null;
  for(const u of tries){
    try{const r=await fetch(u,{cache:"no-store",signal:abortTimeout(20000)});
      if(!r.ok){last=new Error("HTTP "+r.status);continue;}
      const t=await r.text(); if(t&&t.length>800) return t; last=new Error("krátká odpověď");
    }catch(e){last=e;}
  }
  throw last||new Error("fetch selhal");
}
const FF_MONTHS_ABBR=["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
function ffWeekParam(d){return FF_MONTHS_ABBR[d.getMonth()]+d.getDate()+"."+d.getFullYear();}
function ffImpactFromEl(el){
  if(!el)return"";
  const t=(((el.getAttribute&&el.getAttribute("title"))||"")+" "+(el.className||"")+" "+(el.textContent||"")).toLowerCase();
  if(/high|red/.test(t))return"high"; if(/medium|orange|moderate/.test(t))return"medium";
  if(/low|yellow/.test(t))return"low"; return"";
}
function parseFFCalendarHTML(html,year){
  let doc; try{doc=new DOMParser().parseFromString(html,"text/html");}catch(e){return[];}
  const rows=doc.querySelectorAll(".calendar__row, tr.calendar_row, tr[data-event-id]");
  const out=[]; let cur=null;
  rows.forEach(row=>{ try{
    const q=s=>row.querySelector(s);
    const dEl=q(".calendar__date, .date"); const dTxt=dEl?dEl.textContent.trim():"";
    if(dTxt){const mm=dTxt.match(/([A-Za-z]{3,})\s+(\d{1,2})/); if(mm){const mi=FF_MONTHS_ABBR.indexOf(mm[1].slice(0,3).toLowerCase()); if(mi>=0)cur={mi,day:+mm[2]};}}
    const ccyEl=q(".calendar__currency, .currency"); const ccy=ccyEl?ccyEl.textContent.trim():"";
    const evEl=q(".calendar__event, .event, .calendar__event-title"); const ev=evEl?evEl.textContent.trim():"";
    if(!ev||!ccy||!cur)return;
    const timeEl=q(".calendar__time, .time"); let tt=timeEl?timeEl.textContent.trim().toLowerCase():"";
    let hh="00",mn="00"; const tm=tt.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/);
    if(tm){let h=+tm[1];mn=tm[2];if(tm[3]==="pm"&&h!==12)h+=12;if(tm[3]==="am"&&h===12)h=0;hh=String(h).padStart(2,"0");}
    const impEl=q(".calendar__impact span, .impact span, .calendar__impact");
    const actEl=q(".calendar__actual, .actual"),forEl=q(".calendar__forecast, .forecast"),prevEl=q(".calendar__previous, .previous");
    const iso=`${year}-${String(cur.mi+1).padStart(2,"0")}-${String(cur.day).padStart(2,"0")}T${hh}:${mn}:00Z`;
    out.push(normImportEvent({event:ev,currency:ccy,datetime:iso,impact:ffImpactFromEl(impEl),
      actual:actEl?actEl.textContent.trim():"",forecast:forEl?forEl.textContent.trim():"",previous:prevEl?prevEl.textContent.trim():""}));
  }catch(e){} });
  return out.filter(Boolean);
}
async function backfillFFWeeks(weeks,onProgress){
  const now=new Date(); let all=[],okWeeks=0,failWeeks=0;
  for(let i=1;i<=weeks;i++){
    const d=new Date(now.getTime()-i*7*86400000);
    try{
      const html=await fetchTextWithProxies("https://www.forexfactory.com/calendar?week="+ffWeekParam(d));
      const evs=parseFFCalendarHTML(html,d.getFullYear());
      if(evs.length){all=all.concat(evs);okWeeks++;} else failWeeks++;
    }catch(e){failWeeks++;}
    if(onProgress)onProgress({done:i,total:weeks,events:all.length,okWeeks,failWeeks});
    await new Promise(r=>setTimeout(r,1100)); // šetrné k FF rate-limitu
  }
  const merged=mergeFFHistory(all);
  return {events:all.length,okWeeks,failWeeks,total:merged.length,span:ffHistorySpanMonths(merged)};
}

// ── FF HISTORIE: sběrač do localStorage ─────────────────────────────
// FF feed dává jen ~3 týdny. Každý refresh slijeme nová data do trvalé
// zásoby, takže historie roste týden po týdnu. Podle rozpětí nasbíraných
// dat se postupně uvolňuje ztlumení fundamentů (0.4 → 1.0 za ~15 měsíců).
// FF_CONF_MONTHS = za kolik měsíců historie dosáhne důvěra 1.0 (engine víc nevyužije).
// FF_STORE_MONTHS = jak hluboko se historie drží v localStorage (margin nad rámec
// toho, co live skóre aktivně využívá). FF_HIST_CAP = tvrdý strop počtu událostí.
const FF_HIST_KEY="v5_ff_hist", FF_CONF_MONTHS=15, FF_STORE_MONTHS=36, FF_HIST_CAP=20000;
// Sledované kódy zemí (jen ty engine skóruje) — drží velikost zásoby pod kontrolou
// i při importu víceletého datasetu se stovkami zemí.
const FF_TRACKED_CC=[...new Set([...Object.values(CURRENCY_COUNTRIES).flat(),...Object.values(INDIRECT_COUNTRIES).flat()])];
function ffIsTracked(e){const c=(e.country||"").toUpperCase();return FF_TRACKED_CC.some(cc=>c.includes(cc));}
function ffHistKey(e){return `${(e.country||"").toUpperCase()}|${e.event||""}|${e.time||""}`;}
function loadFFHistory(){try{const a=JSON.parse(localStorage.getItem(FF_HIST_KEY)||"[]");return Array.isArray(a)?a:[];}catch(e){return[];}}
function mergeFFHistory(fresh){
  const map=new Map();
  for(const e of loadFFHistory()) map.set(ffHistKey(e),e);
  for(const e of (fresh||[])){
    if(!e||!e.event||!e.time||!ffIsTracked(e)) continue;   // jen sledované měny
    const k=ffHistKey(e),prev=map.get(k);
    if(!prev) map.set(k,e);
    else if((!prev.actual&&e.actual)||(!prev.estimate&&e.estimate)||(!prev.prev&&e.prev)) map.set(k,{...prev,...e});
  }
  let merged=[...map.values()];
  const cutoff=Date.now()-FF_STORE_MONTHS*30*86400000;
  merged=merged.filter(e=>{const t=new Date(e.time).getTime();return isNaN(t)||t>=cutoff;});
  merged.sort((a,b)=>new Date(a.time)-new Date(b.time));
  if(merged.length>FF_HIST_CAP) merged=merged.slice(merged.length-FF_HIST_CAP);
  // ulož s postupným ořezem nejstarších, když narazíme na localStorage kvótu
  let toSave=merged;
  for(let attempt=0;attempt<6;attempt++){
    try{localStorage.setItem(FF_HIST_KEY,JSON.stringify(toSave));break;}
    catch(e){toSave=toSave.slice(Math.floor(toSave.length*0.3));}  // zahoď nejstarších ~30 %
  }
  return merged;
}
// Rozpětí historie v měsících → důvěra ve fundamenty (FF_FUND_DAMP … 1.0).
function ffHistorySpanMonths(events){
  let min=Infinity,max=-Infinity;const now=Date.now();
  for(const e of (events||[])){const t=new Date(e.time).getTime();if(!isNaN(t)&&t<=now){if(t<min)min=t;if(t>max)max=t;}}
  return isFinite(min)?(max-min)/(30*86400000):0;
}
function ffConfidence(events){
  const months=ffHistorySpanMonths(events);
  const frac=Math.max(0,Math.min(1,months/FF_CONF_MONTHS));
  return parseFloat((FF_FUND_DAMP+(1-FF_FUND_DAMP)*frac).toFixed(2));
}

// ── IMPORT / EXPORT historie (CSV + JSON adaptéry) ──────────────────
// Normalizuje libovolný zdroj (Kaggle/HF/FF export, vlastní JSON) na interní
// tvar {event,country,time,impact,actual,estimate,prev} — score engine pak
// nepozná, odkud data jsou.
function normCountryCode(v){
  const s=String(v||"").toUpperCase().trim();
  return (typeof FF_CCY_COUNTRY!=="undefined"&&FF_CCY_COUNTRY[s])?FF_CCY_COUNTRY[s]:s;
}
function normImpact(v){
  const s=String(v||"").toLowerCase();
  if(/high|red|^3$/.test(s))return"high";
  if(/med|orange|^2$/.test(s))return"medium";
  if(/low|yellow|^1$/.test(s))return"low";
  return"";
}
function normTimeISO(dateStr,timeStr){
  let d=String(dateStr||"").trim(); if(!d)return"";
  const dt=d.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})/);          // datum už nese čas
  if(dt) return `${dt[1]}T${dt[2].padStart(2,"0")}:${dt[3]}:00Z`;
  let iso=d;
  const slash=d.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);               // MM/DD/YYYY
  if(slash){let yr=slash[3];if(yr.length===2)yr="20"+yr;iso=`${yr}-${slash[1].padStart(2,"0")}-${slash[2].padStart(2,"0")}`;}
  let hh="00",mm="00",t=String(timeStr||"").trim().toLowerCase();
  const m=t.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/);
  if(m){let h=+m[1];mm=m[2];if(m[3]==="pm"&&h!==12)h+=12;if(m[3]==="am"&&h===12)h=0;hh=String(h).padStart(2,"0");}
  return `${iso}T${hh}:${mm}:00Z`;
}
function normImportEvent(raw){
  if(!raw)return null;
  const event=raw.event||raw.title||raw.name||"";
  const country=normCountryCode(raw.country||raw.currency||raw.ccy||"");
  let time=raw.datetime||raw.time||"";
  if(raw.date) time=normTimeISO(raw.date,raw.time||raw.time);             // CSV: date+time → ISO
  else if(time&&!/T|\d{2}:\d{2}/.test(time)) time=normTimeISO(time,"");
  const val=v=>(v!=null&&v!=="")?String(v).trim():"";
  const ev={event:String(event).trim(),country,time:String(time),impact:normImpact(raw.impact||raw.importance||raw.volatility),
    actual:val(raw.actual),estimate:val(raw.estimate!=null?raw.estimate:(raw.forecast!=null?raw.forecast:raw.consensus)),
    prev:val(raw.prev!=null?raw.prev:raw.previous)};
  return (ev.event&&ev.time)?ev:null;
}
function parseCSVRows(text){
  const rows=[];let field="",row=[],inQ=false;
  for(let i=0;i<text.length;i++){const c=text[i];
    if(inQ){ if(c==='"'){ if(text[i+1]==='"'){field+='"';i++;} else inQ=false; } else field+=c; }
    else{ if(c==='"')inQ=true;
      else if(c===','){row.push(field);field="";}
      else if(c==='\n'||c==='\r'){ if(c==='\r'&&text[i+1]==='\n')i++; if(field!==""||row.length){row.push(field);rows.push(row);row=[];field="";} }
      else field+=c; }
  }
  if(field!==""||row.length){row.push(field);rows.push(row);}
  return rows;
}
function parseEconomicCSV(text){
  const rows=parseCSVRows(text); if(rows.length<2)return[];
  const hdr=rows[0].map(h=>String(h).toLowerCase().trim());
  const idx=(...names)=>{for(const n of names){const j=hdr.indexOf(n);if(j>=0)return j;}return -1;};
  const cDate=idx("date","datetime","dateutc"),cTime=idx("time"),cCcy=idx("currency","country","ccy"),
        cEv=idx("event","title","name","figures"),cImp=idx("impact","importance","volatility"),
        cAct=idx("actual"),cFor=idx("forecast","estimate","consensus"),cPrev=idx("previous","prev");
  const out=[];
  for(let r=1;r<rows.length;r++){const row=rows[r];if(!row||!row.length)continue;
    const g=j=>j>=0?String(row[j]||"").trim():"";
    const ev=normImportEvent({date:g(cDate),time:g(cTime),currency:g(cCcy),event:g(cEv),impact:g(cImp),actual:g(cAct),forecast:g(cFor),previous:g(cPrev)});
    if(ev)out.push(ev);
  }
  return out;
}
function eventsToCSV(events){
  const esc=v=>{const s=String(v==null?"":v);return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;};
  const lines=["date,time,datetime,country,event,impact,actual,forecast,previous"];
  for(const e of (events||[])){const dt=e.time||"";const dm=dt.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
    lines.push([dm?dm[1]:dt,dm?dm[2]:"",dt,e.country||"",e.event||"",e.impact||"",e.actual||"",e.estimate||"",e.prev||""].map(esc).join(","));}
  return lines.join("\n");
}
// rawEvents = pole z JSON/CSV → normalizace → merge do zásoby. Vrací statistiku.
function importEconomicEvents(rawEvents){
  const norm=(rawEvents||[]).map(normImportEvent).filter(Boolean);
  const before=loadFFHistory().length;
  const merged=mergeFFHistory(norm);
  return {parsed:(rawEvents||[]).length,normalized:norm.length,added:Math.max(0,merged.length-before),total:merged.length,span:ffHistorySpanMonths(merged)};
}
function downloadFile(name,text,mime){
  try{const blob=new Blob([text],{type:mime||"text/plain;charset=utf-8"});const url=URL.createObjectURL(blob);
    const a=document.createElement("a");a.href=url;a.download=name;document.body.appendChild(a);a.click();
    setTimeout(()=>{URL.revokeObjectURL(url);a.remove();},150);}catch(e){alert("Export selhal: "+(e?.message||e));}
}

function deriveUpcomingFromEvents(events){
  const now=Date.now(),to=now+14*86400000;
  const allCodes=[...new Set([...Object.values(CURRENCY_COUNTRIES).flat(),...Object.values(INDIRECT_COUNTRIES).flat()])];
  return (events||[]).filter(e=>{
    const t=parseEventTime(e.time);
    return t>=now&&t<=to&&allCodes.some(c=>(e.country||"").toUpperCase().includes(c))&&getWeight(e.event)>0;
  }).sort((a,b)=>parseEventTime(a.time)-parseEventTime(b.time));
}
// EVENT WATCH pro dashboard: dnešní den (00:00, vč. už proběhlých) + 14 dní dopředu.
// Drží dnešní události celý den s jejich výsledky (1:1 s ForexFactory pro daný den).
function buildEventWatch(calData,upcoming){
  const s=startOfTodayMs(),to=Date.now()+14*86400000;
  return mergeEvents(calData,upcoming).filter(e=>{const t=parseEventTime(e.time);return t>=s&&t<=to;}).sort((a,b)=>parseEventTime(a.time)-parseEventTime(b.time));
}
// ── SCORING ───────────────────────────────────────────────
// ═══════════════ V5 ENGINE HELPERS ═══════════════════════════
function getCOTPercentile(currency){
  try{
    const hist=loadCOTHistory();
    const entries=Object.entries(hist).sort(([a],[b])=>new Date(a)-new Date(b));
    // OPRAVA: hist[date].scores[currency] — ne hist[date][currency]
    const scores=entries.map(([,w])=>{
      const v=w.scores?.[currency];
      return typeof v==="number"?v:null;
    }).filter(s=>s!==null);
    if(scores.length<12) return null;
    const cur=scores[scores.length-1];
    const hist2=scores.slice(0,-1);
    return Math.round((hist2.filter(s=>s<=cur).length/hist2.length)*100);
  }catch(e){return null;}
}
function getCurrencyMomentum(currency){
  try{
    // OPRAVA: loadScoreHistory() vrací objekt klíčovaný datem, ne pole.
    // Sestavíme chronologickou řadu skóre a spočítáme průměrnou denní změnu.
    const hist=loadScoreHistory();
    const dates=Object.keys(hist).filter(d=>/^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
    if(dates.length<3) return 0;
    const recent=dates.slice(-5).map(d=>{const v=hist[d]?.[currency];return typeof v==="number"?v:0;});
    const diffs=recent.slice(1).map((v,i)=>v-recent[i]);
    if(!diffs.length) return 0;
    return parseFloat(Math.max(-1,Math.min(1,(diffs.reduce((a,b)=>a+b,0)/diffs.length)*0.35)).toFixed(2));
  }catch(e){return 0;}
}
// Momentum byl historicky kvůli bugu vždy 0 → backtest s 65% WR běžel BEZ něj.
// Necháváme momentum počítat (loguje se a vyhodnocuje v 🔬 Backtest tabu),
// ale do živého skóre nepřispívá, dokud ho backtest neověří. Zapneš = true.
const MOMENTUM_ENABLED=false;
// ══════════════════════════════════════════════════════════════
// AUTO-UPDATE SYSTÉM — extrahuje CB sazby, CPI a Policy stance
// z již načteného Finnhub kalendáře. Nulové extra API volání.
// ══════════════════════════════════════════════════════════════

// Pomocná funkce: měna z Finnhub eventu (reverse lookup)
function getCurrencyFromEvent(ev){
  const country=(ev.country||"").toUpperCase();
  for(const [cur,codes] of Object.entries(CURRENCY_COUNTRIES)){
    if(codes.some(c=>country.includes(c))) return cur;
  }
  // Fallback pro nepřímé země
  for(const [cur,codes] of Object.entries(INDIRECT_COUNTRIES)){
    if(codes.some(c=>country.includes(c))) return cur;
  }
  return null;
}

// Extrahuje CB sazby z Interest Rate Decision eventů
function extractCBRatesFromCalendar(calData){
  const rateEvents=calData.filter(ev=>{
    const meta=getEventMeta(ev.event);
    return meta?.cat==="Interest Rates"&&ev.actual&&evDate(ev)<=new Date();
  }).sort((a,b)=>new Date(b.time)-new Date(a.time));

  const rates={}; const histories={};
  for(const ev of rateEvents){
    const cur=getCurrencyFromEvent(ev);
    if(!cur) continue;
    const val=parseFloat(ev.actual);
    if(isNaN(val)||val<-1||val>25) continue;
    if(!histories[cur]) histories[cur]=[];
    histories[cur].push({date:ev.time,rate:val});
    if(!rates[cur]) rates[cur]=val; // nejnovější
  }
  // Seřadit historii chronologicky (starší → novější)
  for(const cur of Object.keys(histories)){
    histories[cur].sort((a,b)=>new Date(a.date)-new Date(b.date));
  }
  return{rates,histories};
}

// Extrahuje CPI z inflačních eventů — preferuje YoY roční číslo
function extractCPIFromCalendar(calData){
  const past=calData.filter(ev=>{
    const meta=getEventMeta(ev.event);
    return meta?.cat==="Inflation"&&ev.actual&&evDate(ev)<=new Date();
  });
  const cpi={};
  const sorted=past.sort((a,b)=>new Date(b.time)-new Date(a.time));
  // 1. průchod: preferuj YoY události
  for(const ev of sorted){
    const cur=getCurrencyFromEvent(ev); if(!cur||cpi[cur]) continue;
    const name=(ev.event||"").toLowerCase();
    const isYoY=name.includes("yoy")||name.includes("y/y")||name.includes("annual")||name.includes("year");
    if(!isYoY) continue;
    const val=parseFloat(ev.actual);
    if(!isNaN(val)&&val>=-2&&val<=20) cpi[cur]=parseFloat(val.toFixed(1));
  }
  // 2. průchod: doplň zbývající jakýmkoliv CPI
  for(const ev of sorted){
    const cur=getCurrencyFromEvent(ev); if(!cur||cpi[cur]) continue;
    const val=parseFloat(ev.actual);
    if(!isNaN(val)&&val>=-2&&val<=20) cpi[cur]=parseFloat(val.toFixed(1));
  }
  return cpi;
}

// Auto-detekuje CB Policy stance z histórie sazeb
// Vrátí {score: -2..+2, label, confidence}
function autoDetectCBPolicy(currency,rateHistory){
  if(!rateHistory||rateHistory.length<2){
    return{score:CB_POLICY_DATA[currency]?.score||0,label:CB_POLICY_DATA[currency]?.label||"nedostatek dat",auto:false};
  }
  const sorted=[...rateHistory].sort((a,b)=>new Date(a.date)-new Date(b.date));
  // Extrahuj jen skutečné změny (min 0.1 bps)
  const changes=[];
  for(let i=1;i<sorted.length;i++){
    const diff=sorted[i].rate-sorted[i-1].rate;
    if(Math.abs(diff)>=0.10) changes.push({date:sorted[i].date,change:diff,rate:sorted[i].rate});
  }
  const recent=changes.slice(-6); // posledních 6 skutečných rozhodnutí
  const hikCount=recent.filter(c=>c.change>0).length;
  const cutCount=recent.filter(c=>c.change<0).length;
  const last2=changes.slice(-2);
  const lastChange=changes[changes.length-1]?.change||0;

  // Roční změna celkové sazby
  const now=Date.now();
  const year12=sorted.filter(r=>new Date(r.date)>new Date(now-365*86400000));
  const yearChange=year12.length>=2?year12[year12.length-1].rate-year12[0].rate:0;

  // Počet hold rozhodnutí (méně než 0.1 změna)
  const allRecent6=sorted.slice(-6);
  const holdCount=allRecent6.filter((r,i)=>i>0&&Math.abs(r.rate-allRecent6[i-1].rate)<0.10).length;

  let score=0; let desc="";
  if(hikCount>=3||(hikCount>=2&&yearChange>1.0)){
    score=2; desc="agresivní hiking ("+yearChange.toFixed(2)+"% za rok)";
  }else if(hikCount>=2&&holdCount<=2){
    score=2; desc="aktivní cyklus hikování";
  }else if(hikCount>=1&&cutCount===0&&holdCount<=3){
    score=1; desc="cyklus hikování";
  }else if(cutCount>=3||(cutCount>=2&&yearChange<-1.0)){
    score=-2; desc="agresivní řezy ("+yearChange.toFixed(2)+"% za rok)";
  }else if(cutCount>=2&&hikCount===0){
    score=-2; desc="aktivní cyklus řezů";
  }else if(cutCount>=1&&hikCount===0&&holdCount<=3){
    score=-1; desc="cyklus snižování";
  }else if(holdCount>=4&&Math.abs(yearChange)<0.15){
    score=0; desc="plateau, hold "+sorted[sorted.length-1]?.rate?.toFixed(2)+"%";
  }else if(lastChange>0){
    score=1; desc="poslední hike, pozorujeme";
  }else if(lastChange<0){
    score=-1; desc="poslední cut, pozorujeme";
  }else{
    score=0; desc="hold";
  }
  const currentRate=sorted[sorted.length-1]?.rate;
  const label=`${currency} — ${desc}${currentRate!==undefined?" @ "+currentRate.toFixed(2)+"%":""}`;
  return{score,label,auto:true,confidence:changes.length>=4?"HIGH":changes.length>=2?"MEDIUM":"LOW"};
}

// Hlavní orchestrátor: aktualizuje CB sazby, CPI, CB Policy z kalendáře
// Volá se automaticky při každém načtení kalendáře (bez extra API)
function autoUpdateFromCalendar(calData){
  if(!calData||!calData.length) return{updated:[]};
  const updated=[];

  // 1. CB Sazby z Interest Rate Decision eventů
  const{rates:cbRates,histories:cbHistories}=extractCBRatesFromCalendar(calData);
  if(Object.keys(cbRates).length>0){
    let ratesChanged=false;
    for(const [cur,rate] of Object.entries(cbRates)){
      if(CENTRAL_BANK_RATES[cur]!==rate){
        CENTRAL_BANK_RATES[cur]=rate;
        ratesChanged=true;
      }
    }
    if(ratesChanged){
      // Persistovat aktualizaci (nemazat manuální override jiných měn)
      try{
        const stored=JSON.parse(localStorage.getItem("v5_cb_rates")||"{}");
        const merged={...stored,...cbRates};
        localStorage.setItem("v5_cb_rates",JSON.stringify(merged));
      }catch(e){}
      updated.push("CB Sazby ("+Object.keys(cbRates).join(", ")+")");
    }
  }

  // 2. CPI z inflačních eventů
  const cpiData=extractCPIFromCalendar(calData);
  if(Object.keys(cpiData).length>0){
    let cpiChanged=false;
    for(const [cur,val] of Object.entries(cpiData)){
      if(Math.abs((REAL_CPI_DATA[cur]||0)-val)>0.05){
        REAL_CPI_DATA[cur]=val;
        cpiChanged=true;
      }
    }
    if(cpiChanged){
      try{
        const stored=JSON.parse(localStorage.getItem("v5_real_cpi")||"{}");
        const merged={...stored,...cpiData};
        localStorage.setItem("v5_real_cpi",JSON.stringify(merged));
      }catch(e){}
      updated.push("CPI ("+Object.keys(cpiData).join(", ")+")");
    }
  }

  // 3. CB Policy stance z historie sazeb
  let policyChanged=false;
  for(const [cur,history] of Object.entries(cbHistories)){
    if(history.length>=2){
      const detected=autoDetectCBPolicy(cur,history);
      const current=CB_POLICY_DATA[cur]||{};
      if(current.score!==detected.score||detected.auto){
        CB_POLICY_DATA[cur]={...current,...detected};
        policyChanged=true;
      }
    }
  }
  if(policyChanged){
    try{
      const policyStore={};
      for(const c of CURRENCIES){
        policyStore[c]={score:CB_POLICY_DATA[c].score,label:CB_POLICY_DATA[c].label};
      }
      localStorage.setItem("v5_cb_policy",JSON.stringify(policyStore));
    }catch(e){}
    updated.push("CB Policy (auto-detected)");
  }

  // 4. Uložit timestamp posledního auto-update
  try{localStorage.setItem("auto_update_ts",new Date().toISOString());
      localStorage.setItem("auto_update_log",JSON.stringify(updated));}catch(e){}

  return{updated,cbRates,cpiData};
}

function getAutoUpdateStatus(){
  try{
    const ts=localStorage.getItem("auto_update_ts");
    const log=JSON.parse(localStorage.getItem("auto_update_log")||"[]");
    if(!ts) return null;
    const ago=Math.round((Date.now()-new Date(ts))/60000);
    return{ts,log,ago,agoLabel:ago<60?ago+"m":Math.round(ago/60)+"h"};
  }catch(e){return null;}
}
function getDynamicWeights(cotPct,regime){
  // Audit výsledek: sezónnost při váze 8% škodí výsledkům (+0.6% WR bez ní).
  // Redukováno na 2%. CB Policy zvýšena. Backtest 2022-2024: WR diff2-3=65.5% PF=2.039.
  const ext=cotPct!==null&&(cotPct>=85||cotPct<=15);
  if(regime==="BULLISH"||regime==="BEARISH") return{fund:0.55,cot:ext?0.70:0.35,sent:0.08,sea:0.02};
  return{fund:0.42,cot:ext?0.80:0.45,sent:0.11,sea:0.02};
}

// ── CB CYCLE STAGE — detektor tržního režimu ─────────────────
function getCBCycleStage(){
  const scores=Object.values(CB_POLICY_DATA).map(p=>p.score||0);
  const hiking=scores.filter(s=>s>0).length;
  const cutting=scores.filter(s=>s<0).length;
  const holding=scores.filter(s=>s===0).length;
  const avgScore=scores.reduce((a,b)=>a+b,0)/scores.length;
  const maxScore=Math.max(...scores);
  const minScore=Math.min(...scores);
  const spread=maxScore-minScore;
  // Detekce speciálního případu: BoJ jako jediný hikuje
  const hikingCurs=CURRENCIES.filter(c=>(CB_POLICY_DATA[c]?.score||0)>0);
  const cuttingCurs=CURRENCIES.filter(c=>(CB_POLICY_DATA[c]?.score||0)<0);
  const loneHiker=hikingCurs.length===1?hikingCurs[0]:null;
  const loneCutter=cuttingCurs.length===1?cuttingCurs[0]:null;
  if(loneHiker) return{stage:"LONE_HIKER",label:`${FLAGS[loneHiker]} ${loneHiker} sám hikuje`,color:"#78f236",quality:"HIGH",desc:"Nejsilnější podmínka pro engine"};
  if(loneCutter) return{stage:"LONE_CUTTER",label:`${FLAGS[loneCutter]} ${loneCutter} sám snižuje`,color:"#78f236",quality:"HIGH",desc:"Čistý divergence signál"};
  if(hiking>0&&cutting>0&&spread>=3) return{stage:"DIVERGENCE",label:`${hiking} hikuje / ${cutting} snižuje`,color:"#d29922",quality:"MEDIUM",desc:"Divergence — engine funguje"};
  if(hiking>=4&&cutting===0) return{stage:"ALL_HIKING",label:"Všichni hikují",color:"#d29922",quality:"MEDIUM",desc:"Snížená přesnost — všichni stejně"};
  if(cutting>=4&&hiking===0) return{stage:"ALL_CUTTING",label:"Všichni snižují",color:"#ff4d4d",quality:"LOW",desc:"Engine méně spolehlivý"};
  if(spread<1.5) return{stage:"PLATEAU",label:"Plateau — vše na hold",color:"#ff4d4d",quality:"LOW",desc:"Nízká divergence — neobc."};
  return{stage:"MIXED",label:`${hiking} hike / ${holding} hold / ${cutting} cut`,color:"#d29922",quality:"MEDIUM",desc:"Střední divergence"};
}

// ── CB DIVERGENCE INDEX (CBDI) — 0–100 ───────────────────────
function calcCBDI(){
  const rates=CURRENCIES.map(c=>CENTRAL_BANK_RATES[c]||0);
  const policies=CURRENCIES.map(c=>CB_POLICY_DATA[c]?.score||0);
  const cpis=CURRENCIES.map(c=>REAL_CPI_DATA[c]||2);
  const rateSpread=Math.max(...rates)-Math.min(...rates);
  const rateSTD=Math.sqrt(rates.map(r=>{const m=rates.reduce((a,b)=>a+b)/rates.length;return(r-m)**2;}).reduce((a,b)=>a+b)/rates.length);
  const hikingN=policies.filter(p=>p>0).length;
  const cuttingN=policies.filter(p=>p<0).length;
  const dirDiv=hikingN*cuttingN; // max=16 (4×4)
  const realYields=rates.map((r,i)=>r-cpis[i]);
  const rySpread=Math.max(...realYields)-Math.min(...realYields);
  // Normalizace na 0-100 (použijeme historické maxima z auditu)
  const n1=Math.min(100,rateSpread/6*100);   // max spread ~6%
  const n2=Math.min(100,rateSTD/2*100);      // max STD ~2
  const n3=Math.min(100,dirDiv/12*100);      // max dir div = 12
  const n4=Math.min(100,rySpread/8*100);     // max RY spread ~8%
  const cbdi=n1*0.30+n2*0.25+n3*0.25+n4*0.20;
  return Math.round(cbdi);
}
function getHoursToHighImpact(base,quote,upcoming){
  try{
    const now=Date.now();
    const rel=upcoming.filter(ev=>(eventRelevance(base,ev)||eventRelevance(quote,ev))&&(ev.impact==="high"||ev.impact===3||ev.impact==="3"));
    if(!rel.length) return 999;
    return Math.max(0,(parseEventTime(rel.sort((a,b)=>parseEventTime(a.time)-parseEventTime(b.time))[0].time)-now)/3600000);
  }catch(e){return 999;}
}
function buildForecastV5(pair,scores,calData,upcoming){
  const{base,quote}=pair;
  const upBase=upcoming.filter(e=>eventRelevance(base,e));
  const upQuote=upcoming.filter(e=>eventRelevance(quote,e));
  let fwdBase=0,fwdQuote=0;const baseItems=[],quoteItems=[];
  for(const ev of upBase){const rel=eventRelevance(base,ev);const w=getWeight(ev.event)*(rel?.factor||1);if(!w) continue;const hist=getEventHistoryTrend(ev.event,base,calData);fwdBase+=hist.score*w;baseItems.push({ev,hist,w,rel});}
  for(const ev of upQuote){const rel=eventRelevance(quote,ev);const w=getWeight(ev.event)*(rel?.factor||1);if(!w) continue;const hist=getEventHistoryTrend(ev.event,quote,calData);fwdQuote+=hist.score*w;quoteItems.push({ev,hist,w,rel});}
  const curDiff=(scores[base]?.score||0)-(scores[quote]?.score||0);
  const fwdDiff=fwdBase-fwdQuote;
  const combined=curDiff*0.70+fwdDiff*3.0*0.30;
  // Faktor 1: logistická funkce
  let prob=50+(1/(1+Math.exp(-combined*0.5))-0.5)*60;
  // Faktor 2: momentum
  const momAdj=MOMENTUM_ENABLED?(getCurrencyMomentum(base)-getCurrencyMomentum(quote))*5:0;
  prob+=momAdj;
  // Faktor 3: news risk discount
  const hoursToNews=getHoursToHighImpact(base,quote,upcoming);
  const newsDiscount=hoursToNews<12?-12:hoursToNews<24?-8:hoursToNews<48?-4:0;
  prob+=newsDiscount;
  // Faktor 4: COT extreme korekce
  const cotPctB=getCOTPercentile(base);const cotPctQ=getCOTPercentile(quote);
  let cotAdj=0;
  if(cotPctB!==null){const d=curDiff>0?1:-1;if(cotPctB>88&&d>0) cotAdj-=7;if(cotPctB<12&&d<0) cotAdj-=7;if(cotPctB>70&&d>0) cotAdj+=3;if(cotPctB<30&&d<0) cotAdj+=3;}
  if(cotPctQ!==null){const d=curDiff>0?-1:1;if(cotPctQ>88&&d>0) cotAdj-=5;if(cotPctQ<12&&d<0) cotAdj-=5;}
  prob+=cotAdj;
  prob=Math.round(Math.max(35,Math.min(75,prob)));
  const dir=combined>0?"BUY":"SELL";
  const bTrend=fwdBase>0.3?"posilovat":fwdBase<-0.3?"oslabovat":"být neutrální";
  const qTrend=fwdQuote>0.3?"posilovat":fwdQuote<-0.3?"oslabovat":"být neutrální";
  const desc=baseItems.length||quoteItems.length?`Nadcházející data naznačují, že ${base} může ${bTrend} a ${quote} může ${qTrend}.`:"Žádné klíčové eventy v příštích 14 dnech.";
  const newsLabel=hoursToNews<48?`⚠ ${Math.round(hoursToNews)}h do high-impact news`:"";
  const cotWarning=cotPctB!==null&&(cotPctB>88||cotPctB<12)?`🚨 COT ${base} na ${cotPctB}.perc. — crowded`:"";
  return{dir,prob,baseItems,quoteItems,curDiff,fwdDiff,desc,hasEvents:baseItems.length+quoteItems.length>0,newsDiscount,hoursToNews,cotAdj,momAdj,cotWarning,newsLabel};
}

// ── REAL YIELD = CB rate − CPI ────────────────────────────────
function getRealYieldScore(currency){
  const nom=CENTRAL_BANK_RATES[currency]||0;
  const cpi=REAL_CPI_DATA[currency]||2;
  const ry=nom-cpi;
  const n=Object.keys(REAL_CPI_DATA).length;
  const avgRY=CURRENCIES.reduce((s,cur)=>s+((CENTRAL_BANK_RATES[cur]||0)-(REAL_CPI_DATA[cur]||2)),0)/n;
  return parseFloat(Math.max(-2,Math.min(2,(ry-avgRY)*0.35)).toFixed(2));
}

// ── WTI ROPA — CAD korekce ────────────────────────────────────
// CAD má -0.7 korelaci s WTI. Ropa nahoru = CAD silnější = USDCAD dolů.
// Data: Alpha Vantage WTI endpoint (zdarma, ~5 req/den)
async function fetchOilPrice(avKey){
  if(!avKey) return null;
  const CK="oil_wti_v1";
  try{
    const c=localStorage.getItem(CK);
    if(c){const{data,ts}=JSON.parse(c);if(Date.now()-ts<6*3600000)return data;}
  }catch(e){}
  try{
    const url=`https://www.alphavantage.co/query?function=WTI&interval=weekly&apikey=${avKey}`;
    const r=await fetch(url);
    if(!r.ok) return null;
    const j=await r.json();
    const rows=(j.data||[]).filter(d=>d.value&&d.value!=="."&&!isNaN(parseFloat(d.value)));
    if(rows.length<5) return null;
    const data={
      current: parseFloat(rows[0].value),
      w4ago:   parseFloat(rows[4].value),
      w8ago:   parseFloat(rows[8]?.value||rows[4].value),
      w13ago:  parseFloat(rows[13]?.value||rows[4].value),
      date:    rows[0].date,
      series:  rows.slice(0,26).map(d=>parseFloat(d.value)).reverse(),
    };
    try{localStorage.setItem(CK,JSON.stringify({data,ts:Date.now()}));}catch(e){}
    return data;
  }catch(e){return null;}
}

function loadOilData(){
  try{
    const c=localStorage.getItem("oil_wti_v1");
    if(c){const{data}=JSON.parse(c);return data;}
  }catch(e){}
  return null;
}

function getOilMomentumScore(currency){
  // Pouze pro CAD (primárně) a malá korekce pro USD (petrodolar)
  if(currency!=="CAD"&&currency!=="USD") return 0;
  const oil=loadOilData();
  if(!oil||!oil.current||!oil.w4ago) return 0;
  // 4-týdenní momentum ropy v %
  const mom4w=(oil.current-oil.w4ago)/oil.w4ago*100;
  // 13-týdenní trend
  const trend13=(oil.current-oil.w13ago)/oil.w13ago*100;
  const combined=mom4w*0.65+trend13*0.35;
  if(currency==="CAD"){
    // CAD: ropa +10% = CAD silnější o ~2 body
    return parseFloat(Math.max(-2.0,Math.min(2.0,combined*0.18)).toFixed(2));
  }
  if(currency==="USD"){
    // USD: slabá negativní korelace s ropou (petrodolar efekt, menší)
    return parseFloat(Math.max(-0.5,Math.min(0.5,-combined*0.04)).toFixed(2));
  }
  return 0;
}

function getOilStatus(){
  const oil=loadOilData();
  if(!oil) return null;
  const mom=(oil.current-oil.w4ago)/oil.w4ago*100;
  const trend=(oil.current-oil.w13ago)/oil.w13ago*100;
  return{
    price: oil.current,
    date:  oil.date,
    mom4w: parseFloat(mom.toFixed(1)),
    trend13: parseFloat(trend.toFixed(1)),
    direction: mom>2?"BULLISH (CAD+)":mom<-2?"BEARISH (CAD-)":"NEUTRAL",
    color: mom>2?"#3fb950":mom<-2?"#f85149":"#d29922",
    cadAdj: getOilMomentumScore("CAD"),
  };
}

// ── CB POLICY CYCLE SCORE ─────────────────────────────────────
function getCBPolicyScore(currency){
  const pol=CB_POLICY_DATA[currency];if(!pol)return 0;
  const avgPol=CURRENCIES.reduce((s,cur)=>s+(CB_POLICY_DATA[cur]?.score||0),0)/CURRENCIES.length;
  return parseFloat(Math.max(-1.5,Math.min(1.5,(pol.score-avgPol)*0.4)).toFixed(2));
}

// ── RISK SENTIMENT ADJUSTMENT ─────────────────────────────────
function getRiskSentimentAdj(currency){
  if(g_riskSentiment===0)return 0;
  const riskOn={AUD:0.8,NZD:0.7,CAD:0.5,JPY:-0.5,CHF:-0.3};
  const riskOff={AUD:-1.0,NZD:-1.0,CAD:-0.6,JPY:1.2,CHF:1.0};
  const map=g_riskSentiment>0?riskOn:riskOff;
  return parseFloat((map[currency]||0).toFixed(2));
}

// ── CONVICTION SCORE: kolik nezávislých faktorů souhlasí (0–5) ─
function calcConvictionScore(pair,scores,aiAnalyses){
  const isBuy=pair.dir==="BUY";let stars=0;const reasons=[];
  // 1. CB Policy divergence
  const bPol=CB_POLICY_DATA[pair.base]?.score||0,qPol=CB_POLICY_DATA[pair.quote]?.score||0;
  if((isBuy&&bPol>qPol)||(!isBuy&&bPol<qPol)){stars++;reasons.push("CB: "+CB_POLICY_DATA[pair.base]?.label);}
  // 2. Real yield differential
  const bRY=(CENTRAL_BANK_RATES[pair.base]||0)-(REAL_CPI_DATA[pair.base]||2);
  const qRY=(CENTRAL_BANK_RATES[pair.quote]||0)-(REAL_CPI_DATA[pair.quote]||2);
  if((isBuy&&bRY>qRY+0.3)||(!isBuy&&bRY<qRY-0.3)){stars++;reasons.push("Real yield: "+pair.base+" "+bRY.toFixed(1)+"% vs "+pair.quote+" "+qRY.toFixed(1)+"%");}
  // 3. Fundamental score strength
  if(pair.diff>=2.0){stars++;reasons.push("Fundamenty: "+(isBuy?"+":"−")+pair.diff.toFixed(1));}
  // 4. COT not crowded against direction
  const cotB=scores[pair.base]?.cot_pct;
  const crowded=cotB!=null&&((isBuy&&cotB>=88)||(!isBuy&&cotB<=12));
  if(!crowded&&pair.diff>=1){stars++;reasons.push(cotB!=null?"COT "+pair.base+": "+cotB+"p":"COT ok");}
  // 5. AI Analysis confluence
  const ai=aiAnalyses?.[pair.pair];
  if(ai){const ab=ai.bias==="BULLISH"||ai.entry_setup?.direction==="BUY";if(ab===isBuy){stars++;reasons.push("AI "+ai.tf+": "+ai.bias+" "+ai.confidence+"%");}}
  // 6. Ropa — pouze USDCAD/CAD páry
  if(pair.base==="CAD"||pair.quote==="CAD"){
    const oilAdj=getOilMomentumScore("CAD");
    const oilSt=getOilStatus();
    if(Math.abs(oilAdj)>=0.5){
      const oilBullishCad=oilAdj>0; // ropa up = CAD silnější
      // OPRAVENO: oil souhlasí s obchodem když:
      // - SELL USDCAD (quote=CAD) + oil bullish pro CAD ✅
      // - BUY USDCAD (quote=CAD) + oil bearish pro CAD ✅
      // - BUY CADJPY (base=CAD) + oil bullish pro CAD ✅
      // - SELL CADJPY (base=CAD) + oil bearish pro CAD ✅
      const oilMatchesTrade=
        (!isBuy&&pair.quote==="CAD"&&oilBullishCad)||   // SELL USDCAD + ropa up
        (isBuy&&pair.quote==="CAD"&&!oilBullishCad)||   // BUY USDCAD + ropa down
        (isBuy&&pair.base==="CAD"&&oilBullishCad)||     // BUY CADJPY + ropa up
        (!isBuy&&pair.base==="CAD"&&!oilBullishCad);    // SELL CADJPY + ropa down
      if(oilMatchesTrade){stars++;reasons.push("WTI Ropa: "+(oilSt?.direction||"")+" ("+( oilSt?.mom4w?.toFixed(1)||"?")+"% 4t)");}
    }
  }
  return{stars,reasons};
}

function scoreCurrency(events,currency,cotData,sentData){
  const matched=events.filter(e=>eventRelevance(currency,e));
  let score=0,weight=0;const used=[];const cats={};
  for(const ev of matched){
    const rel=eventRelevance(currency,ev);if(!rel) continue;
    const meta=getEventMeta(ev.event);if(!meta) continue;
    const a=parseFloat(ev.actual),e2=parseFloat(ev.estimate);
    if(isNaN(a)||isNaN(e2)) continue;
    const baseW=meta.w, dir=eventDirection(ev);if(!dir) continue;
    const r=recency(ev.time), surprise=surpriseStrength(ev), w=baseW*rel.factor*surprise;
    const contribution=dir*w*r;
    score+=contribution;weight+=w*r;
    cats[meta.cat]=(cats[meta.cat]||0)+contribution;
    used.push({...ev,dir,w,r,relLabel:rel.label,category:meta.cat,interpretation:meta.dir===-1?"nižší = bullish":meta.dir==="pmi"?"PMI 50 + beat/miss":"vyšší = bullish"});
  }
  const fundScoreRaw=weight>0?Math.max(-10,Math.min(10,(score/weight)*10)):0;
  const yieldAdj=getRealYieldScore(currency);
  const policyAdj=getCBPolicyScore(currency);
  // Ztlum jen data-tilt z kalendáře (fundScoreRaw) dle důvěry v délku historie;
  // yield/policy (z CB sazeb, ne z kalendáře) zůstávají plné. Finnhub → g=1 = beze změny.
  const fundScore=parseFloat(Math.max(-10,Math.min(10,fundScoreRaw*g_fundConfidence+yieldAdj+policyAdj)).toFixed(2));
  const cotScore=getCOTScore(currency,cotData);
  const sentScore=getSentimentScore(currency,sentData);
  const seasonScore=getSeasonalScore(currency);
  const cotPct=getCOTPercentile(currency);
  const momentumAdj=getCurrencyMomentum(currency);
  const oilAdj=getOilMomentumScore(currency); // CAD/USD only
  let regime="NEUTRAL";
  try{const r=JSON.parse(localStorage.getItem("v5_regime")||"{}" );regime=r[currency]||"NEUTRAL";}catch(e){}
  const wt=getDynamicWeights(cotPct,regime);
  const riskAdj=getRiskSentimentAdj(currency);
  const rawTotal=fundScore*wt.fund+cotScore*wt.cot+sentScore*wt.sent+seasonScore*wt.sea+momentumAdj*(MOMENTUM_ENABLED?0.3:0)+riskAdj+oilAdj;
  const total=parseFloat(Math.max(-10,Math.min(10,rawTotal)).toFixed(2));
  return{
    score:total,
    fund_score:fundScore,fund_score_raw:parseFloat(fundScoreRaw.toFixed(2)),yield_adj:yieldAdj,policy_adj:policyAdj,risk_adj:riskAdj,oil_adj:oilAdj,
    cot_score:cotScore,sent_score:sentScore,season_score:seasonScore,
    cot_pct:cotPct,momentum_adj:momentumAdj,weights_used:wt,
    category_scores:Object.fromEntries(Object.entries(cats).map(([k,v])=>[k,parseFloat(v.toFixed(2))])),
    total:matched.length,counted:used.length,
    recentEvents:used.sort((a,b)=>new Date(b.time)-new Date(a.time)).slice(0,6),
  };
}

// ════════ DAILY BRIEF ENGINE — dnešní vrstva ════════
const DAY_WINDOW=1; // dny zpět pro "už vyšlo" (rolling — kryje AU/JP data v noci)
function localDayEnd(){const d=new Date();d.setHours(23,59,59,999);return d.getTime();}
// Sloučí 15-měsíční kalendář s upcoming. upcoming má čerstvé dnešní ACTUAL dřív než 15mo dotaz,
// proto bez tohoto merge "už vyšlo" výsledky chyběly. Dedup, preferuj záznam s actual.
let _mergeEventsCache={a:null,b:null,out:null};
function mergeEvents(calData,upcoming){
  // PERF: calData/upcoming mění referenci jen při loadData, ale mergeEvents se volá
  // desítky× za render (per pár). Cachujeme dle identity vstupních polí.
  if(_mergeEventsCache.out&&_mergeEventsCache.a===calData&&_mergeEventsCache.b===upcoming) return _mergeEventsCache.out;
  const map=new Map();
  [...(calData||[]),...(upcoming||[])].forEach(e=>{
    const k=(e.event||"")+"|"+(e.country||"")+"|"+(e.time||"");
    const prev=map.get(k);
    if(!prev||(!prev.actual&&e.actual)) map.set(k,e);
  });
  const out=[...map.values()];
  _mergeEventsCache={a:calData,b:upcoming,out};
  return out;
}
// Krátkodobé skóre — jen PŘÍMÉ eventy dané měny s actual za posledních 24h (ze sloučeného zdroje).
function getShortTermFundScore(currency,events,days=DAY_WINDOW){
  const cutoff=Date.now()-days*86400000,now=Date.now();
  let score=0,weight=0;const items=[];
  for(const ev of (events||[])){
    const t=parseEventTime(ev.time);
    if(!(t>=cutoff&&t<=now)||!ev.actual) continue;
    const rel=eventRelevance(currency,ev);if(!rel||rel.type!=="direct") continue; // jen přímé → CHF nepřebírá EUR
    const meta=getEventMeta(ev.event);if(!meta) continue;
    const a=parseFloat(ev.actual),e2=parseFloat(ev.estimate);
    if(isNaN(a)||isNaN(e2)) continue;
    const dir=eventDirection(ev);if(!dir) continue;
    const w=meta.w*surpriseStrength(ev);
    score+=dir*w;weight+=w;
    items.push({event:ev.event,cat:meta.cat,beat:dir>0,actual:ev.actual,estimate:ev.estimate,time:ev.time});
  }
  const norm=weight>0?Math.max(-10,Math.min(10,(score/weight)*10)):0;
  return{score:parseFloat(norm.toFixed(1)),count:items.length,items};
}
function detectFundamentalConflict(pair,scores,calData,upcoming,days=DAY_WINDOW){
  const ev=mergeEvents(calData,upcoming);
  const ltDiff=(scores[pair.base]?.score||0)-(scores[pair.quote]?.score||0);
  const ltDir=ltDiff>=0?"BUY":"SELL";
  const stB=getShortTermFundScore(pair.base,ev,days);
  const stQ=getShortTermFundScore(pair.quote,ev,days);
  const stDiff=stB.score-stQ.score;
  if(stB.count+stQ.count===0) return{hasData:false,ltDir};
  const stDir=stDiff>0.3?"BUY":stDiff<-0.3?"SELL":"FLAT";
  return{hasData:true,ltDir,stDir,conflict:stDir!=="FLAT"&&stDir!==ltDir,stB,stQ,stDiff:parseFloat(stDiff.toFixed(1))};
}
// Dnešní PŘÍMÉ HIGH/MED eventy, které teprve přijdou (do konce dneška, ještě bez actual).
function getUpcomingToday(currency,upcoming){
  const now=Date.now(),end=localDayEnd();
  return (upcoming||[]).filter(e=>{
    const t=parseEventTime(e.time);
    if(!(t>now&&t<=end)||e.actual) return false;           // jen budoucí dnešní, bez výsledku
    const rel=eventRelevance(currency,e);if(!rel||rel.type!=="direct") return false;
    if(!getEventMeta(e.event)) return false;
    const imp=(e.impact||"").toString().toLowerCase();
    return imp.includes("high")||imp==="3"||imp.includes("medium")||imp==="2";
  }).sort((a,b)=>new Date(a.time)-new Date(b.time));
}
function evIsHighImpact(ev){
  const raw=(ev.impact||ev.importance||"").toString().toLowerCase();
  return raw.includes("high")||raw==="3"||getWeight(ev.event||"")>=2.5;
}
function startOfTodayMs(){const d=new Date();d.setHours(0,0,0,0);return d.getTime();}
// PŘÍMÉ HIGH události měny v časovém okně [from..to]. Okno bere dnešek od 00:00
// + ~36h dopředu → pokryje i dvoudenní zasedání CB (BOJ/RBA) a posun časových pásem,
// a to i bez ohledu na to, zda engine zná název (centrobankovní statements).
function getImminentHigh(currency,events,from,to){
  return (events||[]).filter(ev=>{
    const t=parseEventTime(ev.time); if(isNaN(t)||t<from||t>to) return false;
    const rel=eventRelevance(currency,ev); if(!rel||rel.type!=="direct") return false;
    return evIsHighImpact(ev);
  }).sort((a,b)=>parseEventTime(a.time)-parseEventTime(b.time));
}
// Jednotný zdroj pro puntík i Daily Brief — velké přímé události páru.
// Rozdělené: dnes už proběhlo / dnes ještě přijde / zítra (do +36h) = podtext.
function getPairFundamentalDay(pair,calData,upcoming){
  const ev=mergeEvents(calData,upcoming);
  const dayStart=startOfTodayMs(), dayEnd=localDayEnd(), now=Date.now(), soon=now+36*3600000;
  const hi=getImminentHigh(pair.base,ev,dayStart,soon).concat(getImminentHigh(pair.quote,ev,dayStart,soon)).sort((a,b)=>parseEventTime(a.time)-parseEventTime(b.time));
  return {
    hi,
    todayPast:hi.filter(e=>{const t=parseEventTime(e.time);return t>=dayStart&&t<=now;}),
    todayUpcoming:hi.filter(e=>{const t=parseEventTime(e.time);return t>now&&t<=dayEnd&&!e.actual;}),
    tomorrow:hi.filter(e=>{const t=parseEventTime(e.time);return t>dayEnd&&!e.actual;}),
  };
}
function getPairDailyState(pair,scores,calData,upcoming){
  const c=detectFundamentalConflict(pair,scores,calData,upcoming,DAY_WINDOW);
  if(c.hasData&&c.conflict) return{level:"conflict",dot:"🔴",color:"#ff4d4d"};
  if(c.hasData&&c.stDir===c.ltDir) return{level:"confirm",dot:"🟢",color:"#3fb950"};
  const d=getPairFundamentalDay(pair,calData,upcoming);          // priorita: DNES > zítra
  if(d.todayUpcoming.length) return{level:"upcoming",dot:"🟡",color:"#d29922"};
  if(d.todayPast.length) return{level:"done",dot:"🔵",color:"#58a6ff"};
  if(d.tomorrow.length) return{level:"tomorrow",dot:"🟡",color:"#d29922"};
  return{level:"none",dot:"",color:null};
}
function getPosition(pair){try{return (JSON.parse(localStorage.getItem("positions")||"{}"))[pair]||"none";}catch(e){return"none";}}
function setPosition(pair,side){try{const p=JSON.parse(localStorage.getItem("positions")||"{}");side==="none"?delete p[pair]:p[pair]=side;localStorage.setItem("positions",JSON.stringify(p));}catch(e){}}
function getAllPositions(){try{return JSON.parse(localStorage.getItem("positions")||"{}");}catch(e){return{};}}
function loadNotes(){try{return JSON.parse(localStorage.getItem("pair_notes")||"{}");}catch(e){return{};}}

// ════════ BIAS FLIP DETECTION ════════
function loadBiasState(){try{return JSON.parse(localStorage.getItem("bias_state")||"{}");}catch(e){return{};}}
function saveBiasState(s){try{localStorage.setItem("bias_state",JSON.stringify(s));}catch(e){}}
function updateBiasFlips(pairs){
  const st=loadBiasState(),now=Date.now();
  (pairs||[]).forEach(p=>{
    if(typeof p.diff!=="number") return;
    const signed=p.dir==="BUY"?p.diff:-p.diff;
    const prev=st[p.pair];
    const clear=Math.abs(signed)>=0.5;
    const newDir=clear?(signed>0?"BUY":"SELL"):(prev?.dir||(signed>=0?"BUY":"SELL"));
    if(prev&&prev.dir&&newDir!==prev.dir&&Math.abs(signed)>=0.8){
      st[p.pair]={dir:newDir,from:prev.dir,flippedAt:now,diff:p.diff};
    }else{
      st[p.pair]={dir:newDir,from:prev?.from,flippedAt:prev?.flippedAt,diff:p.diff};
    }
  });
  saveBiasState(st);return st;
}
function getRecentFlips(pairs,calData,upcoming,hours=36){
  const ev=mergeEvents(calData,upcoming);
  const st=loadBiasState(),now=Date.now(),out=[];
  (pairs||[]).forEach(p=>{
    const s=st[p.pair];
    if(s&&s.flippedAt&&now-s.flippedAt<=hours*3600000){
      const b=getShortTermFundScore(p.base,ev,DAY_WINDOW);
      const q=getShortTermFundScore(p.quote,ev,DAY_WINDOW);
      const driver=(b.count>=q.count&&b.count>0)?p.base:(q.count>0?p.quote:null);
      out.push({pair:p.pair,from:s.from,to:s.dir,flippedAt:s.flippedAt,driver,
        driverItems:driver===p.base?b.items:driver===p.quote?q.items:[]});
    }
  });
  return out.sort((a,b)=>b.flippedAt-a.flippedAt);
}
function isPairFlipped(pair,hours=36){
  try{const s=loadBiasState()[pair];return !!(s&&s.flippedAt&&Date.now()-s.flippedAt<=hours*3600000);}catch(e){return false;}
}

// ── FORECAST ─────────────────────────────────────────────
function getEventHistoryTrend(eventName,currency,calData){
  const keyword=eventName.toLowerCase().split(" ")[0];
  const history=calData.filter(e=>{
    const rel=eventRelevance(currency,e);
    return rel&&(e.event||"").toLowerCase().includes(keyword)&&e.actual&&e.estimate;
  }).sort((a,b)=>new Date(b.time)-new Date(a.time)).slice(0,6);
  if(!history.length) return{trend:"neznámý",score:0};
  let wS=0,wT=0;
  history.forEach((ev,idx)=>{
    const rel=eventRelevance(currency,ev);
    const a=parseFloat(ev.actual),e2=parseFloat(ev.estimate);
    if(isNaN(a)||isNaN(e2)||!rel) return;
    const dir=eventDirection(ev),w=(history.length-idx)*rel.factor;
    wS+=dir*w;wT+=w;
  });
  const norm=wT>0?wS/wT:0;
  return{trend:norm>0.25?"pozitivní 📈":norm<-0.25?"negativní 📉":"neutrální ➡️",score:parseFloat(norm.toFixed(2))};
}

function rankPairs(scores,aiAnalyses){
  const ranked=STANDARD_PAIRS.map(({pair,base,quote})=>{
    const sB=scores[base]?.score||0,sQ=scores[quote]?.score||0,diff=sB-sQ;
    const corrGroup=FX_CORRELATION_GROUPS.find(g=>g.includes(pair));
    const cotPctB=scores[base]?.cot_pct,cotPctQ=scores[quote]?.cot_pct;
    const cotCrowded=(cotPctB!=null&&(cotPctB>=88||cotPctB<=12))||(cotPctQ!=null&&(cotPctQ>=88||cotPctQ<=12));
    const yieldDiffRaw=(CENTRAL_BANK_RATES[base]||0)-(CENTRAL_BANK_RATES[quote]||0);
    const yieldLabel=Math.abs(yieldDiffRaw)>=1.5?(yieldDiffRaw>0?`${base} +${yieldDiffRaw.toFixed(2)}%`:`${quote} +${Math.abs(yieldDiffRaw).toFixed(2)}%`):"";
    const pairObj={pair,base,quote,dir:diff>0?"BUY":"SELL",strong:diff>0?base:quote,weak:diff>0?quote:base,
      diff:parseFloat(Math.abs(diff).toFixed(2)),s1:sB,s2:sQ,
      corrGroup:corrGroup||null,cotCrowded,yieldLabel,cotPctBase:cotPctB,cotPctQuote:cotPctQ};
    const cv=calcConvictionScore(pairObj,scores,aiAnalyses||{});
    return{...pairObj,conviction:cv.stars,convictionReasons:cv.reasons};
  }).sort((a,b)=>b.diff-a.diff);
  const seen=new Set();
  return ranked.map((p,i)=>{
    if(i>=5) return{...p,corrDuplicate:false};
    const gKey=p.corrGroup?[...p.corrGroup].sort().join(","):null;
    if(gKey&&seen.has(gKey)) return{...p,corrDuplicate:true};
    if(gKey) seen.add(gKey);
    return{...p,corrDuplicate:false};
  });
}

