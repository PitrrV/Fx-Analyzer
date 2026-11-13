/* AT Trading — statistiky MT5 deníku. Čisté funkce, bez DOM, testovatelné v Node.
   Obchod (uzavřený i otevřený):
   {id,account,currency,symbol,side:'BUY'|'SELL',openTime,closeTime|null,volume,
    profit,commission,swap,fee,   // peníze v měně účtu; u otevřeného obchodu je profit = floating
    riskMoney|null}               // riziko v penězích dle PŮVODNÍHO SL; null = SL nebyl nastaven => R se NEDOPOČÍTÁVÁ
   Definice (stejné všude, aby čísla šla ověřit ručně):
   - net = profit+commission+swap+fee
   - uzavřené statistiky jen z closeTime!=null; otevřený (floating) profit se počítá zvlášť
   - výhra net>0, ztráta net<0, BE net==0; winRate = výhry / všechny uzavřené (BE je ve jmenovateli)
   - profitFactor = součet výher / |součet ztrát| (null bez ztrát)
   - expectancy = průměrné net na obchod; R = net/riskMoney jen u obchodů s riskMoney>0
   - maxDrawdown z řady equity: největší pokles od dosavadního maxima (abs i % z maxima)
   - více měn účtů => peněžní metriky jsou null (měny se nesčítají), zůstává počet, winRate a R */
(function(root){
  const netOf=t=>(+t.profit||0)+(+t.commission||0)+(+t.swap||0)+(+t.fee||0);
  const rOf=t=>(t.riskMoney>0)?netOf(t)/t.riskMoney:null;
  const sum=a=>a.reduce((x,y)=>x+y,0);
  function filter(trades,o){o=o||{};
    return trades.filter(t=>{
      if(o.accounts&&o.accounts.length&&o.accounts.indexOf(t.account)<0) return false;
      const ref=Date.parse(t.closeTime||t.openTime);
      if(o.from&&ref<Date.parse(o.from)) return false;
      if(o.to&&ref>Date.parse(o.to)) return false;
      return true; }); }
  function summarize(trades){
    const closed=trades.filter(t=>t.closeTime), open=trades.filter(t=>!t.closeTime);
    const cur=Array.from(new Set(trades.map(t=>t.currency))); const money=cur.length<=1;
    const nets=closed.map(netOf), wins=nets.filter(x=>x>0), losses=nets.filter(x=>x<0);
    const rs=closed.map(rOf).filter(x=>x!=null);
    const gw=sum(wins), gl=Math.abs(sum(losses));
    return {
      n:closed.length, nOpen:open.length, currency:money?(cur[0]||null):null, mixedCurrencies:!money,
      wins:wins.length, losses:losses.length, breakeven:nets.length-wins.length-losses.length,
      winRate:closed.length?wins.length/closed.length:null,
      netProfit:money?sum(nets):null,
      grossWin:money?gw:null, grossLoss:money?-gl:null,
      profitFactor:money?(gl>0?gw/gl:null):null,
      expectancy:(money&&closed.length)?sum(nets)/closed.length:null,
      avgWin:(money&&wins.length)?gw/wins.length:null, avgLoss:(money&&losses.length)?-gl/losses.length:null,
      avgR:rs.length?sum(rs)/rs.length:null, nWithR:rs.length, nWithoutR:closed.length-rs.length,
      floating:money?sum(open.map(netOf)):null };
  }
  function groupBy(trades,keyFn){const m={};
    trades.forEach(t=>{const k=keyFn(t); (m[k]=m[k]||[]).push(t);});
    return Object.keys(m).map(k=>Object.assign({key:k},summarize(m[k]))); }
  // series: [{t,equity}] seřazené podle času
  function drawdown(series){
    let peak=-Infinity,peakT=null,best={abs:0,pct:0,from:null,to:null};
    series.forEach(p=>{
      if(p.equity>peak){peak=p.equity;peakT=p.t;}
      const abs=peak-p.equity; if(abs>best.abs) best={abs:abs,pct:peak>0?abs/peak:null,from:peakT,to:p.t}; });
    return best; }
  const api={netOf,rOf,filter,summarize,groupBy,drawdown};
  if(typeof module!=='undefined'&&module.exports) module.exports=api; else root.JournalStats=api;
})(typeof window!=='undefined'?window:this);
