// AI Market Radar — server-side collector (GitHub Action, běží ~každých 15 min).
// Nahrazuje klientský pipeline v radar.html: 1 sdílená AI analýza pro všechny
// návštěvníky (místo N klientů = N analýz stejné zprávy), žádný rss2json
// (server nemá CORS, čte RSS přímo), klíče nikdy neopouští repo secrets.
// Výstup: data/radar_feed.json (aktuální feed), data/radar_hist.json (historie
// pro heat mapu měn, 30 dní), data/radar_cache.json (AI cache, 14 dní),
// data/radar_reports.json (automatické seanční reporty, 4× denně).
//
// Funkce v sekci „PORTOVÁNO Z radar.html" jsou úmyslně 1:1 kopie klientské
// logiky (scoring, clustering, credibility) — chování musí být identické,
// ať zprávu vidí kdokoli odkudkoli.
const fs = require("fs");

/* ============================================================
   KONSTANTY — portováno z radar.html
   ============================================================ */
const INSTRUMENTS = ['USD','EUR','GBP','JPY','AUD','CAD','CHF','NZD','Gold','Silver','Oil','US100','US500','US30'];
const CATEGORIES  = ['MAKRO','CENTRÁLNÍ BANKA','POLITIKA','KOMODITY','TRH'];
const SESSIONS = [['asia','🌅','Asijská / ranní',0,8],['europe','🇪🇺','Evropská',8,13],['us','🇺🇸','Americká',13,18],['evening','🌙','Večerní',18,24]];
// Měnové páry, na které se Radar (jako pomůcka pro FX analyzer) zaměřuje — portováno z radar.html
const PAIRS = ['EURUSD','GBPUSD','USDJPY','USDCHF','USDCAD','AUDUSD','NZDUSD','EURGBP','EURJPY','GBPJPY','AUDJPY','CADJPY','NZDJPY','EURCHF','GBPCHF','AUDCHF','EURAUD','GBPAUD','EURCAD','AUDNZD'];
const CRYPTO_RE = /\b(bitcoin|btc|ethereum|ether|\beth\b|crypto|krypto|altcoin|coinbase|binance|solana|\bxrp\b|ripple|dogecoin|shiba|\bnft\b|blockchain|stablecoin|defi|memecoin|tether)\b/i;
const FX_RE = /\b(usd|dollar|dolar|eur|euro|gbp|pound|sterling|jpy|yen|aud|cad|chf|franc|frank|nzd|kiwi|fed|fomc|ecb|boj|boe|snb|rate|rates|inflation|inflac|cpi|gdp|hdp|nfp|payroll|jobless|unemploy|gold|zlat|oil|ropa|treasury|bond|yield|forex|currenc|měn)\b/i;
function isCryptoOnly(h){ h=h||''; return CRYPTO_RE.test(h) && !FX_RE.test(h); }
const DEFAULT_RSS = [
  // zprávy na všechny měny
  'https://www.forexlive.com/feed/',
  'https://www.fxstreet.com/rss/news',
  'https://www.investing.com/rss/news.rss',
  'http://feeds.marketwatch.com/marketwatch/topstories/',
  // ANALÝZY / výhledy známých analytiků (přehledy nad grafem)
  'https://www.fxstreet.com/rss/analysis',
  'https://www.dailyforex.com/rss/technicalanalysis.xml',
  'https://www.dailyforex.com/rss/fundamentalanalysis.xml',
  // geopolitika, co hýbe měnami
  'https://www.aljazeera.com/xml/rss/all.xml'
];
// Oficiální zdroje centrálních bank — portováno z radar.html. Server je stahuje VŽDY (sdílený feed
// nemá per-uživatele nastavení); vypínatelné jsou jen v klientském fallbacku v radar.html.
const CB_FEEDS = [
  {name:'Federal Reserve (Fed)', url:'https://www.federalreserve.gov/feeds/press_all.xml'},
  {name:'ECB', url:'https://www.ecb.europa.eu/rss/press.html'},
  {name:'Bank of England', url:'https://www.bankofengland.co.uk/rss/news'}
];
// Feedy, jejichž URL značí ANALÝZU (analytické články, ne breaking) — portováno z radar.html,
// aby sdílený feed nesl stejný `isAnalysis` příznak jako klientský pipeline (badge „📈 Analýza").
const ANALYSIS_FEED_RE = /analysis|analytic|dailyfx|technicalanalysis|fundamentalanalysis|outlook|forecast/i;
const SCORE_RULES = [
  [/\b(FOMC|rate decision|interest rate|úrokov\w*|sazb\w*|rate cut|rate hike)\b/i, 9],
  [/\b(CPI|inflation|inflac\w*|PCE)\b/i, 8],
  [/\b(NFP|non-?farm|payrolls|unemployment|nezaměstnan\w*)\b/i, 8],
  [/\b(Powell|Lagarde|Fed|FED|ECB|BoJ|BOE|central bank|centráln\w* bank\w*)\b/i, 7],
  [/\b(GDP|HDP|PMI|retail sales|maloobchod\w*)\b/i, 6],
  [/\b(war|válk\w*|sanction\w*|sankc\w*|tariff\w*|invasion|útok)\b/i, 6]
];
const SOURCE_TIERS = {
  'reuters':1,'bloomberg':1,'associated press':1,'apnews':1,' ap ':1,'wall street journal':1,'wsj':1,'financial times':1,'ft.com':1,
  'federal reserve':1,'european central bank':1,'ecb':1,'bank of england':1,'cnbc':1,
  'marketwatch':2,'investing':2,'fxstreet':2,'forexlive':2,'forex factory':2,'forexfactory':2,'yahoo':2,'business insider':2,'barron':2,'the economist':2,'guardian':2,'dailyfx':2,'kitco':2,'tradingview':2,
  'twitter':3,'x (twitter)':3,'reddit':3,'seeking alpha':3,'seekingalpha':3,'zerohedge':3,'telegram':3,'blog':3
};
const RUMOR_RE = /\b(reportedly|sources say|according to sources|people familiar|rumou?r\w*|speculat\w*|unconfirmed|allegedly|mulls?|weighs?|in talks|could|denies|denied|údajně|podle zdroj\w*|spekul\w*|nepotvrzen\w*|zvažuj\w*|jedná o|popír\w*)\b/i;
const STOP = new Set('the a an of to in on for and or is are be as at by with from that this it its has have had will would after over into amid said says say report reports reported update updates live new news today after near amid sees set'.split(' '));
const ENTITY_RULES = [
  ['USD',/\b(usd|dollar|dolar|greenback)\b/],['EUR',/\b(eur|euro|eurozone|eurozón\w*)\b/],['GBP',/\b(gbp|pound|sterling|cable|libr\w*)\b/],
  ['JPY',/\b(jpy|yen|jen)\b/],['AUD',/\b(aud|aussie)\b/],['CAD',/\b(cad|loonie|canad\w*)\b/],['CHF',/\b(chf|franc|frank|swiss\w*|švýc\w*)\b/],['NZD',/\b(nzd|kiwi)\b/],
  ['GOLD',/\b(gold|xau|bullion|zlat\w*)\b/],['SILVER',/\b(silver|xag|stříbr\w*)\b/],['OIL',/\b(oil|crude|wti|brent|ropa|ropy)\b/],
  ['FED',/\b(fed|fomc|powell|federal reserve)\b/],['ECB',/\b(ecb|lagarde)\b/],['BOJ',/\b(boj|ueda)\b/],['BOE',/\b(boe|bailey)\b/],
  ['RATES',/\b(rate|rates|hike|hikes|cut|cuts|sazb\w*|úrok\w*)\b/],['CPI',/\b(cpi|inflation|inflac\w*|pce)\b/],['JOBS',/\b(nfp|payroll\w*|jobs|jobless|unemploy\w*|nezaměstn\w*)\b/],
  ['GDP',/\b(gdp|hdp|growth)\b/],['PMI',/\b(pmi)\b/],['NASDAQ',/\b(nasdaq|us100)\b/],['SP500',/\b(sp500|us500)\b/],['DOW',/\b(dow|us30)\b/],['TARIFF',/\b(tariff\w*|sanction\w*|clo|cla|sankc\w*)\b/]
];
const SYSTEM_ANALYST = 'Jsi finanční analytik aplikace AI Market Radar. NIKDY nedáváš obchodní doporučení, BUY/SELL signály, vstupy, výstupy, supporty ani rezistence. Pouze interpretuješ zprávy a souvislosti. Odpovídáš česky, stručně a věcně. Vždy vrať POUZE validní JSON bez markdownu.';
const HIST_DAYS = 30;
const CACHE_DAYS = 14;
const MAX_ITEMS = 18; // víc než klientských 14 — server platí AI jen jednou pro všechny

/* ============================================================
   PORTOVÁNO Z radar.html — musí se chovat identicky jako klient
   ============================================================ */
function hashStr(s){ let h=0; for(let i=0;i<s.length;i++){ h=(h<<5)-h+s.charCodeAt(i); h|=0; } return 'h'+(h>>>0).toString(36); }
function normHeadline(s){ return (s||'').toLowerCase().replace(/[^a-z0-9á-ž ]/gi,'').replace(/\s+/g,' ').trim(); }
function scoreFloor(h){ let f=0; for(const r of SCORE_RULES){ if(r[0].test(h)&&r[1]>f) f=r[1]; } return f; }
function clampScore(s){ s=Math.round(Number(s)||0); return Math.max(1,Math.min(10,s)); }
function quickCat(h){
  h=h||'';
  if(/\b(fed|ecb|boj|boe|powell|lagarde|rate|sazb|central bank|interest rate|monetary)\b/i.test(h)) return ['CENTRÁLNÍ BANKA',true];
  if(/\b(oil|ropa|crude|wti|brent|gold|zlat|silver|stříbr|gas|copper|commodit|komodit)\b/i.test(h)) return ['KOMODITY',false];
  if(/\b(elect|war|válk|tariff|sanction|sankc|geopolit|trade war|trump|china|čín|politi)\b/i.test(h)) return ['POLITIKA',false];
  if(/\b(cpi|gdp|hdp|pmi|payroll|nfp|jobs|inflation|inflac|unemployment|nezaměstn|retail|sentiment|data)\b/i.test(h)) return ['MAKRO',false];
  return ['TRH',false];
}
function quickAffects(h){
  h=h||'';
  const map={USD:/\b(usd|dollar|dolar|fed|wall street|treasury)\b/i,EUR:/\b(eur|euro|ecb|eurozone|eurozón)\b/i,GBP:/\b(gbp|pound|sterling|libra|boe)\b/i,JPY:/\b(jpy|yen|jen|boj)\b/i,AUD:/\b(aud|aussie)\b/i,CAD:/\b(cad|loonie|canada|kanad)\b/i,CHF:/\b(chf|franc|frank|swiss|švýc)\b/i,NZD:/\b(nzd|kiwi)\b/i,Gold:/\b(gold|zlat|xau)\b/i,Oil:/\b(oil|ropa|crude|wti|brent)\b/i,US100:/\b(nasdaq|us100)\b/i,US500:/\b(s&p|sp500|us500)\b/i};
  const out=[]; Object.keys(map).forEach(k=>{ if(map[k].test(h)) out.push([k]); }); return out.slice(0,5);
}
// "Milníkové" zprávy — portováno z radar.html (musí zůstat stejné hodnoty, badge se řídí podle nich).
const MILESTONE_TYPES = ['record_high','record_low','since_year','streak','psych_level'];
const MILESTONE_RE = [
  [/\b(record high|all-time high|historick[éý] maxim|nejvýš\w* v historii|nejvyšší v historii)\b/i, 'record_high'],
  [/\b(record low|all-time low|historick[éý] minim|nejníž\w* v historii|nejnižší v historii)\b/i, 'record_low'],
  [/\b(highest since|nejvyšší od (roku )?\d{4}|nejvíc od (roku )?\d{4})\b/i, 'record_high'],
  [/\b(lowest since|nejnižší od (roku )?\d{4}|nejmíň od (roku )?\d{4})\b/i, 'record_low'],
  [/\b(\d+(st|nd|rd|th)|[a-zá-ž]+[íý])\s+(consecutive|straight|in a row|měsíc[e]? v řadě|za sebou)\b/i, 'streak'],
  [/\b(third|fourth|fifth|třetí|čtvrtý|pátý|šestý)\s+\w*\s*(month|week|quarter|měsíc|týden|čtvrtlet\w*)\s*(in a row|straight|v řadě|po sobě)?\b/i, 'streak'],
  [/\b(breaks?|breaches?|crosses?|prolomil\w*|překonal\w*|proráží)\s*(above|below|přes|pod)?\s*\$?\d[\d,.]*\s*(k|mark|level|hranic\w*|úrove\w*)?\b/i, 'psych_level']
];
function quickMilestone(h){
  h=h||'';
  for(const r of MILESTONE_RE){ if(r[0].test(h)) return r[1]; }
  return '';
}
function topItems(items,n){ return items.slice().sort((a,b)=> (b.score||0)-(a.score||0) || new Date(b.publishedAt||0)-new Date(a.publishedAt||0)).slice(0,n); }
function dominantTheme(items){
  const catCount={}, instCount={};
  items.forEach(n=>{ catCount[n.cat]=(catCount[n.cat]||0)+1; (n.affects||[]).forEach(a=>instCount[a[0]]=(instCount[a[0]]||0)+1); });
  const topCat=Object.keys(catCount).sort((a,b)=>catCount[b]-catCount[a])[0]||'TRH';
  const insts=Object.keys(instCount).sort((a,b)=>instCount[b]-instCount[a]);
  return {topCat,insts,catCount,instCount};
}
function buildDeskFromNews(items){
  const top=topItems(items,5), th=dominantTheme(items), lead=top[0];
  const insts=th.insts.slice(0,3);
  const summary=[
    'Dnešní zpravodajství vede téma „'+(th.topCat||'TRH')+'".',
    lead? 'Nejsledovanější zpráva právě teď: „'+lead.headline+'" ('+lead.source+').':'',
    insts.length? 'Nejčastěji zmiňované trhy dnes: '+insts.join(', ')+'.':'',
    'Zpracováno '+items.length+' reálných zpráv — u každé karty je odkaz na originál a čas publikace, takže si ověříš aktuálnost.',
    'Toto je automatické shrnutí podle četnosti témat.'
  ].filter(Boolean).join(' ');
  return { updatedAt:new Date().toISOString(), title: lead? lead.headline : 'Přehled dne', summary,
    points:[['Hlavní téma',th.topCat||'—'],['Nejvíc zmiňováno',insts.join(', ')||'—'],['Počet zpráv',String(items.length)]],
    sources: top.map(n=>({headline:n.headline,url:n.url,source:n.source})) };
}
function buildConnectionsFromNews(items){
  const map={}; items.forEach(n=>(n.affects||[]).forEach(a=>{ (map[a[0]]=map[a[0]]||[]).push(n); }));
  const out=[];
  Object.keys(map).sort((a,b)=>map[b].length-map[a].length).slice(0,3).forEach(sym=>{
    const arr=map[sym]; if(arr.length<2) return;
    out.push({ tag:sym+' · '+arr.length+' zpráv dnes', text:'Dnešní zprávy opakovaně zmiňují '+sym+'. Například: '+arr.slice(0,3).map(n=>'„'+n.headline+'"').join('; ')+'.', pairs:[sym] });
  });
  if(!out.length) out.push({tag:'PŘEHLED',text:'Zatím není dost překrývajících se témat pro propojení.',pairs:[]});
  return out;
}
function hostFromUrl(u){ try{ return new URL(u).hostname.replace(/^www\./,''); }catch(e){ return ''; } }
function sourceTier(name,url){
  let t=null; const s=' '+(name||'').toLowerCase()+' ';
  for(const k in SOURCE_TIERS){ if(s.indexOf(k.trim())>=0) t=Math.min(t==null?9:t,SOURCE_TIERS[k]); }
  const h=hostFromUrl(url);
  if(h) for(const k in SOURCE_TIERS){ if(h.indexOf(k.trim())>=0) t=Math.min(t==null?9:t,SOURCE_TIERS[k]); }
  return t==null?2:t;
}
function clTokens(h){ return Array.from(new Set(normHeadline(h).split(' ').filter(w=>w.length>=4 && !STOP.has(w)))); }
function jaccard(a,b){ if(!a.length||!b.length) return 0; const B=new Set(b); let inter=0; for(const x of a){ if(B.has(x)) inter++; } return inter/(a.length+b.length-inter); }
function entities(h){
  const s=' '+(h||'').toLowerCase().replace(/[^a-z0-9á-ž]+/gi,' ').replace(/\s+/g,' ').trim()+' ', out=new Set();
  for(const r of ENTITY_RULES){ if(r[1].test(s)) out.add(r[0]); }
  const FX=['usd','eur','gbp','jpy','aud','cad','chf','nzd'];
  FX.forEach(a=>FX.forEach(b=>{ if(a!==b && s.indexOf(' '+a+b)>=0){ out.add(a.toUpperCase()); out.add(b.toUpperCase()); } }));
  return out;
}
function sharedCount(a,b){ let n=0; a.forEach(x=>{ if(b.has(x)) n++; }); return n; }
function clMerge(tkA,enA,tkB,enB){ const jac=jaccard(tkA,tkB); const sh=sharedCount(enA,enB); return (sh>=2 && jac>=0.18) || jac>=0.35; }
function buildCluster(members){
  const withTier=members.map(m=>Object.assign({_tier:sourceTier(m.source,m.url)},m));
  const rep=withTier.slice().sort((a,b)=> a._tier-b._tier || (b.score||0)-(a.score||0) || (b.image?1:0)-(a.image?1:0) || new Date(b.publishedAt||0)-new Date(a.publishedAt||0))[0];
  const seen=new Set(), srcs=[];
  withTier.forEach(m=>{ const key=(m.source||'').toLowerCase(); if(key&&!seen.has(key)){ seen.add(key); srcs.push({source:m.source,url:m.url,tier:m._tier,publishedAt:m.publishedAt}); } });
  const first=srcs.slice().sort((a,b)=> new Date(a.publishedAt||0)-new Date(b.publishedAt||0))[0];
  return Object.assign({},rep,{
    srcCount:srcs.length, sources:srcs, bestTier:Math.min.apply(null,srcs.map(s=>s.tier)),
    firstSource:first?first.source:rep.source, firstAt:first?first.publishedAt:rep.publishedAt,
    isAnalysis: members.some(m=>m.isAnalysis)
  });
}
function clusterize(items){
  const clusters=[];
  for(const it of items){
    const tk=clTokens(it.headline), en=entities(it.headline); let best=null,bestJac=-1;
    for(const c of clusters){ if(clMerge(tk,en,c._tk,c._en)){ const j=jaccard(tk,c._tk); if(j>bestJac){ bestJac=j; best=c; } } }
    if(best) best.members.push(it);
    else clusters.push({_tk:tk,_en:en,members:[it]});
  }
  return clusters.map(c=>buildCluster(c.members));
}
function parseJSON(raw){
  let s=(raw||'').replace(/```json|```/g,'').trim();
  const a=s.indexOf('{'), b=s.indexOf('[');
  let start=(a>=0&&b>=0)?Math.min(a,b):Math.max(a,b);
  if(start>=0){ const end=Math.max(s.lastIndexOf('}'),s.lastIndexOf(']')); if(end>start) s=s.slice(start,end+1); }
  return JSON.parse(s);
}

/* ============================================================
   AI — Gemini přímo (server drží klíč v repo secretu, ne v localStorage)
   ============================================================ */
async function callGemini(messages, geminiKey){
  const sys = (messages.find(m=>m.role==='system')||{}).content||'';
  const usr = messages.filter(m=>m.role!=='system').map(m=>m.content).join('\n\n');
  const models = ['gemini-2.5-flash','gemini-2.0-flash','gemini-2.5-flash-lite','gemini-1.5-flash'];
  const body = { contents:[{role:'user',parts:[{text:usr}]}], generationConfig:{temperature:0.3} };
  if(sys) body.system_instruction = {parts:[{text:sys}]};
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  let lastStatus=0;
  for(let i=0;i<models.length;i++){
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/'+encodeURIComponent(models[i])+':generateContent',{
      method:'POST', headers:{'Content-Type':'application/json','x-goog-api-key':geminiKey}, body:JSON.stringify(body)
    });
    if(r.ok){ const d=await r.json(); const parts=d&&d.candidates&&d.candidates[0]&&d.candidates[0].content&&d.candidates[0].content.parts; return (parts?parts.map(p=>p.text||'').join(''):''); }
    lastStatus=r.status;
    if(r.status!==503 && r.status!==500 && r.status!==429) break;
    await sleep(700*(i+1));
  }
  throw new Error('API '+lastStatus);
}
async function analyzeBatch(items, geminiKey){
  const list = items.map((it,i)=>(i+1)+'. "'+it.headline+'" (zdroj: '+(it.source||'?')+')').join('\n');
  const prompt =
'Analyzuj těchto '+items.length+' finančních zpráv. Vrať POUZE JSON pole stejné délky a pořadí:\n'+
'[{"i":1,"cs":"český překlad titulku","cat":"MAKRO|CENTRÁLNÍ BANKA|POLITIKA|KOMODITY|TRH","cb":true,'+
'"ai":"1-2 věty interpretace dopadu, bez doporučení",'+
'"story":"1 věta: do jakého širšího příběhu zpráva zapadá",'+
'"affects":[["SYMBOL","pos"]],"score":5,"milestone":""}]\n'+
'"cs" = výstižný český překlad titulku (zachovej čísla a názvy). '+
'SYMBOL jen z: '+INSTRUMENTS.join(',')+'. score 1-10: 10=Fed sazby/CPI/NFP, 7-8=důležitý projev/data, 3-4=běžná zpráva. '+
'"milestone" = POUZE pokud titulek JEDNOZNAČNĚ popisuje mimořádnou/rekordní událost, jinak prázdný string "". Hodnoty: '+
'"record_high" (nové historické/víceleté maximum), "record_low" (nové historické/víceleté minimum), '+
'"since_year" (nejvyšší/nejnižší od konkrétního roku), "streak" (vícenásobné opakování trendu, např. "třetí měsíc v řadě"), '+
'"psych_level" (překročení kulaté/psychologické cenové hranice). NEVYMÝŠLEJ SI milestone, pokud to titulek jasně netvrdí. '+
'Pokud samotný titulek na spolehlivou interpretaci nestačí (chybí kontext), vrať "ai":"" a "story":"" a "affects":[] — NEVYMÝŠLEJ si dopad ani souvislosti, které z titulku neplynou.\nZprávy:\n'+list;
  const arr = parseJSON(await callGemini([{role:'system',content:SYSTEM_ANALYST},{role:'user',content:prompt}],geminiKey));
  if(!Array.isArray(arr)) throw new Error('BAD_BATCH');
  return arr;
}
async function generateConnections(analyzed, geminiKey){
  const ctx = topItems(analyzed,12).map((n,i)=>(i+1)+'. '+n.headline+' ('+n.source+', skóre '+n.score+')').join('\n');
  const prompt='Najdi 2-3 hlavní souvislosti/vyprávění napříč VÍCE zprávami (ne jednotlivé titulky). U každé uveď, KTERÉ zprávy se spojují a PROČ to spolu souvisí. Bez obchodních doporučení. Vrať POUZE JSON pole: [{"tag":"KRÁTKÝ NADPIS","text":"2-3 věty: které zprávy a proč souvisí","pairs":["EURUSD","USD"]}]\nDnešní zprávy:\n'+ctx;
  const arr = parseJSON(await callGemini([{role:'system',content:SYSTEM_ANALYST},{role:'user',content:prompt}],geminiKey));
  return Array.isArray(arr)?arr:[];
}
async function generateDesk(analyzed, geminiKey){
  const top = topItems(analyzed,8);
  const ctx = top.map((n,i)=>(i+1)+'. '+n.headline+' ('+n.source+', skóre '+n.score+')').join('\n');
  const prompt='Jsi AI šéfredaktor finančního deníku. Z dnešních zpráv napiš HLAVNÍ příběh dne jako krátký souvislý článek (PŘESNĚ 4-5 vět) v poli summary: (1) hlavní téma, (2) PROČ trh řeší právě tohle, (3) ODKUD to pramení — odkaž na konkrétní dnešní události/data ze seznamu, (4) co je v protisměru, (5) co sledovat dál. Bez obchodních doporučení (žádné vstupy/cíle). Vrať POUZE JSON: {"title":"výstižný titulek příběhu dne","summary":"4-5 vět souvislého textu","points":[["Co se změnilo","..."],["Protiargument","..."],["Co sledovat dál","..."]]}\nDnešní zprávy:\n'+ctx;
  const o = parseJSON(await callGemini([{role:'system',content:SYSTEM_ANALYST},{role:'user',content:prompt}],geminiKey));
  o.updatedAt = new Date().toISOString();
  o.sources = top.slice(0,5).map(n=>({headline:n.headline,url:n.url,source:n.source}));
  return o;
}
async function generateSessionReport(items, sessionLabel, geminiKey){
  const ctx = items.map((n,i)=>(i+1)+'. '+n.headline+' ('+n.source+', skóre '+(n.score||'?')+')').join('\n');
  const prompt='Jsi FX analytik. Tento nástroj je POMŮCKA k forex analyzeru — zaměř se VÝHRADNĚ na MĚNY a měnové páry (ŽÁDNÉ krypto). '+
    'Ze zpráv seance „'+sessionLabel+'" napiš ČESKY: '+
    '(1) summary = 3–5 vět: hlavní měnové téma seance, co hýbalo měnami a PROČ (konkrétní zprávy/data), a co z toho plyne. '+
    '(2) pairs = 1–3 měnové páry, které dnes v této seanci udělaly něco VÝZNAMNÉHO, s krátkým „proč" (která zpráva/data). Páry vybírej JEN z: '+PAIRS.join(', ')+'. Když data na konkrétní pár nestačí, vrať prázdné pole. '+
    'Bez obchodních doporučení (žádné vstupy/cíle/SL/TP). Vrať POUZE JSON: {"summary":"…","pairs":[{"pair":"AUDCHF","note":"co udělal a proč"}]}\nZprávy seance:\n'+ctx;
  const o = parseJSON(await callGemini([{role:'system',content:SYSTEM_ANALYST},{role:'user',content:prompt}],geminiKey));
  return { summary:(o&&o.summary)?String(o.summary):'', pairs:(o&&Array.isArray(o.pairs))?o.pairs.filter(p=>p&&p.pair).slice(0,3):[] };
}

/* ============================================================
   ZDROJE — přímo (server nemá CORS, rss2json navíc není potřeba)
   ============================================================ */
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' };

function decodeEntities(s){ return (s||'').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&amp;/g,'&'); }
function xmlTag(block,tag){
  const m = block.match(new RegExp('<'+tag+'[^>]*>([\\s\\S]*?)<\\/'+tag+'>','i'));
  if(!m) return '';
  let v = m[1].trim();
  const cdata = v.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if(cdata) v = cdata[1];
  return decodeEntities(v.replace(/<[^>]+>/g,'').trim());
}
function xmlAttr(block,tag,attr){
  const m = block.match(new RegExp('<'+tag+'[^>]*'+attr+'=["\']([^"\']*)["\']','i'));
  return m ? decodeEntities(m[1]) : '';
}
function xmlImage(block){
  // enclosure/media:content/media:thumbnail cover most feeds; fall back to first <img> in the body HTML
  let u = xmlAttr(block,'enclosure','url');
  if(!u || !/^https?:\/\//i.test(u)) u = xmlAttr(block,'media:content','url');
  if(!u || !/^https?:\/\//i.test(u)) u = xmlAttr(block,'media:thumbnail','url');
  if(!u || !/^https?:\/\//i.test(u)){
    const m = block.match(/<img[^>]+src=["']([^"']+)["']/i);
    if(m) u = m[1];
  }
  return /^https?:\/\//i.test(u||'') ? u : '';
}
function parseFeedXml(xml, sourceNameFallback){
  const out=[];
  const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  const chanTitle = xmlTag(xml, isAtom?'title':'title') || sourceNameFallback;
  const blocks = xml.match(isAtom ? /<entry[\s\S]*?<\/entry>/gi : /<item[\s\S]*?<\/item>/gi) || [];
  for(const b of blocks){
    const title = xmlTag(b,'title');
    if(!title) continue;
    let link = isAtom ? (xmlAttr(b,'link','href') || xmlTag(b,'link')) : xmlTag(b,'link');
    const pub = xmlTag(b, isAtom?'updated':'pubDate') || xmlTag(b,'pubDate') || xmlTag(b,'published') || '';
    const d = pub ? new Date(pub) : new Date();
    out.push({ headline: title, url: link, publishedAt: isNaN(d.getTime())? new Date().toISOString() : d.toISOString(), source: chanTitle||sourceNameFallback, image: xmlImage(b) });
  }
  return out;
}
async function fetchRSS(feeds){
  const out=[];
  for(const f of feeds.slice(0,8)){
    const ana = ANALYSIS_FEED_RE.test(f); // analytický feed?
    try{
      const r = await fetch(f, { headers: UA, signal: AbortSignal.timeout(15000) });
      if(!r.ok) continue;
      const xml = await r.text();
      const items = parseFeedXml(xml, hostFromUrl(f));
      items.slice(0,10).forEach(it=>out.push({
        id:'r'+hashStr(it.url||it.headline), provider:'rss', source:it.source, headline:it.headline, url:it.url, isAnalysis:ana, publishedAt:it.publishedAt, image:it.image||''
      }));
    }catch(e){ console.log('RSS fail', f, e.message); }
  }
  return out;
}
async function fetchFinnhub(finnhubKey){
  if(!finnhubKey) return [];
  const cats=['general','forex'], out=[];
  await Promise.all(cats.map(async c=>{
    try{
      const r = await fetch('https://finnhub.io/api/v1/news?category='+c, { headers: Object.assign({'X-Finnhub-Token':finnhubKey}, UA), signal: AbortSignal.timeout(15000) });
      if(!r.ok) return;
      const arr = await r.json();
      (Array.isArray(arr)?arr:[]).slice(0,25).forEach(n=>out.push({
        id:'f'+n.id, provider:'finnhub', source:n.source||'Finnhub', headline:n.headline, url:n.url,
        image: /^https?:\/\//i.test(n.image||'') ? n.image : '',
        publishedAt: n.datetime? new Date(n.datetime*1000).toISOString() : new Date().toISOString()
      }));
    }catch(e){ console.log('Finnhub fail', c, e.message); }
  }));
  return out;
}
// Oficiální tiskové zprávy Fedu/ECB/BoE — DOPLŇKOVĚ vedle Finnhubu/RSS výše. `source` se vynucuje
// na jméno instituce (ne na název kanálu z feedu), aby SOURCE_TIERS spolehlivě zařadil Tier 1.
async function fetchCBFeeds(){
  const out=[];
  for(const f of CB_FEEDS){
    try{
      const r = await fetch(f.url, { headers: UA, signal: AbortSignal.timeout(15000) });
      if(!r.ok) continue;
      const xml = await r.text();
      const items = parseFeedXml(xml, f.name);
      items.slice(0,10).forEach(it=>out.push({
        id:'cb'+hashStr(it.url||it.headline), provider:'cb', source:f.name, headline:it.headline, url:it.url, publishedAt:it.publishedAt, image:it.image||''
      }));
    }catch(e){ console.log('CB feed fail', f.name, e.message); }
  }
  return out;
}
async function fetchRawNews(finnhubKey){
  const [fh, rss, cb] = await Promise.all([fetchFinnhub(finnhubKey), fetchRSS(DEFAULT_RSS), fetchCBFeeds()]);
  let all = fh.concat(rss).concat(cb).filter(n=>n.headline && !isCryptoOnly(n.headline)); // krypto-only zprávy ven (zaměření na měny)
  all = clusterize(all);
  all.sort((a,b)=> new Date(b.publishedAt||0)-new Date(a.publishedAt||0));
  return all.slice(0,28);
}

/* ============================================================
   Soubory (cache / historie / feed / reporty)
   ============================================================ */
function readJSON(path, fallback){ try{ return JSON.parse(fs.readFileSync(path,'utf8')); }catch(e){ return fallback; } }
function writeJSON(path, obj){ fs.mkdirSync('data',{recursive:true}); fs.writeFileSync(path, JSON.stringify(obj)); }

function pruneCache(c){
  const cut = Date.now()-CACHE_DAYS*24*3600*1000, out={};
  Object.keys(c||{}).forEach(k=>{ const rec=c[k]; const t=rec&&rec.analyzedAt?new Date(rec.analyzedAt).getTime():0; if(t>=cut) out[k]=rec; });
  return out;
}
function mergeHistory(hist, items){
  const byId = new Map((hist||[]).map(n=>[n.hid,n]));
  for(const n of items){ if(n.hid && !byId.has(n.hid)) byId.set(n.hid, n); }
  const cut = Date.now()-HIST_DAYS*24*3600*1000;
  return Array.from(byId.values())
    .filter(n=> new Date(n.analyzedAt||n.publishedAt||Date.now()).getTime() >= cut)
    .sort((a,b)=> new Date(b.publishedAt||0)-new Date(a.publishedAt||0));
}

/* ============================================================
   Automatické seanční reporty (4× denně, Europe/Prague čas)
   ============================================================ */
function pragueParts(iso){
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Prague',year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
  const hour = parseInt(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Prague',hour:'2-digit',hour12:false}).format(d),10);
  return { date, hour };
}
function addDays(dateStr, n){ const d=new Date(dateStr+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()+n); return d.toISOString().slice(0,10); }
// Pozn. ke klíčům: klient (radar.html repKey()) datum bere z toISOString() = UTC.
// Tady používáme Prague-lokální datum (kvůli hodinám seancí, které dávají smysl jen
// v místním čase). V ~2h okně kolem UTC půlnoci (kdy je v Praze už další den) se proto
// klíč serveru a klienta může na chvíli rozejít — report se pak objeví o pár hodin
// později, ne okamžitě. Neškodné, jen dočasná mezera pro ranní obchodníky.
async function updateSessionReports(hist, geminiKey){
  const reports = readJSON('data/radar_reports.json', {});
  const now = pragueParts(new Date().toISOString());
  // Sessions, jejichž konec (Prague čas) už nastal pro "dnešek", + včerejší večerní
  // seance (18-24), jakmile jsme se přehoupli do rána — cron se sám dožene i po výpadku.
  const candidates = [];
  for(const s of SESSIONS){ if(s[4]<24 && now.hour>=s[4]) candidates.push({s, date: now.date}); }
  if(now.hour < SESSIONS[0][4]) candidates.push({s: SESSIONS[3], date: addDays(now.date,-1)});
  let changed = false;
  for(const {s, date} of candidates){
    const key = date+'|'+s[0];
    if(reports[key]) continue; // už hotovo
    const items = hist.filter(n=>{ const p = pragueParts(n.publishedAt||n.analyzedAt); return p.date===date && p.hour>=s[3] && p.hour<s[4]; });
    if(!items.length) continue; // žádná data pro tuto seanci zatím — zkusí se příští běh
    if(!geminiKey) continue; // bez AI klíče reporty negenerujeme (klient si zobrazí titulky sám)
    try{
      const rep = await generateSessionReport(items, s[2], geminiKey);
      if(rep && rep.summary){ reports[key] = Object.assign({generatedAt: new Date().toISOString(), count: items.length}, rep); changed = true; }
    }catch(e){ console.log('session report fail', key, e.message); }
  }
  if(changed) writeJSON('data/radar_reports.json', reports);
  return reports;
}

/* ============================================================
   MAIN
   ============================================================ */
(async () => {
  const geminiKey = (process.env.GEMINI_KEY||'').trim();
  const finnhubKey = (process.env.FINNHUB_KEY||'').trim();

  let raw;
  try{ raw = await fetchRawNews(finnhubKey); }catch(e){ raw = []; }
  if(!raw.length){ console.error('Žádné zprávy nenačteny — nepřepisuju feed.'); process.exit(1); }
  raw = raw.slice(0, MAX_ITEMS);

  const prevFeed = readJSON('data/radar_feed.json', null);
  const cache = pruneCache(readJSON('data/radar_cache.json', {}));
  const toAnalyze = [], analyzed = [];
  for(const it of raw){
    const key = hashStr(normHeadline(it.headline));
    if(cache[key]) analyzed.push(Object.assign({},it,{hid:key},cache[key]));
    else toAnalyze.push(Object.assign({},it,{hid:key}));
  }

  let status = 'headlines', error = '';
  if(!geminiKey){
    // Bez AI klíče: reálné, čerstvé, clusterované a skórované titulky (heuristika) — pořád obrovské
    // zlepšení proti klientskému rss2json pipeline, jen bez AI komentáře. Top-level `error` tu jde
    // operátorovi repa, ne jednotlivému návštěvníkovi (ten svým klíčem sdílený feed neovlivní).
    error = 'Sdílený feed běží bez AI (repo secret RADAR_GEMINI_KEY není nastavený) — zprávy jsou reálné, čerstvé, clusterované a skórované heuristikou, jen bez AI komentáře/překladu.';
    toAnalyze.forEach(it=>{
      const qc = quickCat(it.headline);
      analyzed.push(Object.assign({}, it, { cat:qc[0], cb:qc[1], cs:'', ai:'', story:'', affects:quickAffects(it.headline), score: clampScore(scoreFloor(it.headline)||3), milestone: quickMilestone(it.headline) }));
    });
  } else if(toAnalyze.length){
    try{
      const res = await analyzeBatch(toAnalyze, geminiKey);
      toAnalyze.forEach((it,idx)=>{
        const a = res.find(x=>x&&x.i===idx+1) || res[idx] || {};
        const rec = {
          cat: CATEGORIES.indexOf(a.cat)>=0 ? a.cat : 'TRH',
          cb: !!a.cb,
          cs: (a.cs && String(a.cs).trim()) ? String(a.cs).trim() : '',
          ai: a.ai || 'Bez interpretace.',
          story: a.story || '',
          affects: Array.isArray(a.affects) ? a.affects.filter(p=>Array.isArray(p)&&INSTRUMENTS.indexOf(p[0])>=0) : [],
          score: clampScore(Math.max(Number(a.score)||0, scoreFloor(it.headline))),
          milestone: MILESTONE_TYPES.indexOf(a.milestone)>=0 ? a.milestone : quickMilestone(it.headline),
          analyzedAt: new Date().toISOString()
        };
        cache[it.hid] = rec;
        analyzed.push(Object.assign({}, it, rec));
      });
      status = 'live';
    }catch(e){
      error = 'AI dočasně nedostupná (' + (e.message||e) + ') — použity heuristické titulky bez AI komentáře.';
      toAnalyze.forEach(it=>{
        const qc = quickCat(it.headline);
        analyzed.push(Object.assign({}, it, { cat:qc[0], cb:qc[1], cs:'', ai:'', story:'', affects:quickAffects(it.headline), score: clampScore(scoreFloor(it.headline)||3), milestone: quickMilestone(it.headline) }));
      });
    }
  } else {
    status = 'live'; // vše z cache (už dřív analyzováno)
  }
  writeJSON('data/radar_cache.json', cache);
  analyzed.sort((a,b)=> (b.score||0)-(a.score||0) || new Date(b.publishedAt||0)-new Date(a.publishedAt||0));

  // Desk + souvislosti stojí AI volání navíc → generuj jen když přibyly nové zprávy,
  // jinak drž předchozí (server běží 1×, ne N-klientů, takže i toto je levné, ale zbytečné volání šetříme).
  let desk, conns;
  const haveNewAI = geminiKey && toAnalyze.length>0 && status==='live';
  if(haveNewAI){
    try{ conns = await generateConnections(analyzed, geminiKey); }catch(e){ conns = (prevFeed&&prevFeed.conns) || buildConnectionsFromNews(analyzed); }
    try{ desk = await generateDesk(analyzed, geminiKey); }catch(e){ desk = (prevFeed&&prevFeed.desk) || buildDeskFromNews(analyzed); }
  } else if(prevFeed && prevFeed.desk && prevFeed.conns && prevFeed.conns.length){
    desk = prevFeed.desk; conns = prevFeed.conns;
  } else {
    desk = buildDeskFromNews(analyzed); conns = buildConnectionsFromNews(analyzed);
  }

  const feed = { updatedAt: new Date().toISOString(), status, error, news: analyzed, conns, desk, hasAI: !!geminiKey };
  writeJSON('data/radar_feed.json', feed);

  const hist = mergeHistory(readJSON('data/radar_hist.json', []), analyzed);
  writeJSON('data/radar_hist.json', hist);

  await updateSessionReports(hist, geminiKey);

  console.log('OK · status='+status+' · zpráv='+analyzed.length+' · nové analýzy='+toAnalyze.length+' · AI='+(!!geminiKey));
})().catch(e => { console.error('FATAL', e); process.exit(1); });
