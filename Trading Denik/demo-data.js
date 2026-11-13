/* FALEŠNÁ DEMO DATA — jen pro ukázku vzhledu deníku. Deterministická (stejný seed = stejné obchody).
   Nic z toho nejsou skutečné obchody ani skutečná data Analyzeru. */
(function(root){
  let seed=20261113; const rnd=()=>{seed=(seed*1664525+1013904223)%4294967296;return seed/4294967296;};
  const pick=a=>a[Math.floor(rnd()*a.length)], between=(a,b)=>a+rnd()*(b-a);
  const ACCOUNTS=[
    {id:'A',label:'FundingPips 100k',broker:'FundingPips (demo)',server:'Demo-Server-1',currency:'USD',kind:'hedging',start:100000},
    {id:'B',label:'ForTraders 50k',broker:'ForTraders (demo)',server:'Demo-Server-2',currency:'USD',kind:'netting',start:50000}];
  const SYM={EURUSD:{pip:0.0001,base:1.0840},GBPUSD:{pip:0.0001,base:1.2910},USDJPY:{pip:0.01,base:151.2},AUDUSD:{pip:0.0001,base:0.6520},USDCAD:{pip:0.0001,base:1.3610},NZDUSD:{pip:0.0001,base:0.5980}};
  const NOW=Date.parse('2026-11-13T09:00:00Z'), DAY=86400000, HOUR=3600000;
  const trades=[], events=[];
  ACCOUNTS.forEach(acc=>{
    let bal=acc.start, t=NOW-62*DAY, n=0;
    while(t<NOW-2*HOUR){
      t+=between(0.6,2.2)*DAY; if(t>NOW-3*HOUR) break;
      const dow=new Date(t).getUTCDay(); if(dow===0||dow===6) continue;
      const open=t+between(7,19)*HOUR-12*HOUR; const symbol=pick(Object.keys(SYM)), s=SYM[symbol];
      const side=rnd()<0.5?'BUY':'SELL', volume=+between(0.2,1.5).toFixed(2);
      const slPips=Math.round(between(15,40)), risk=Math.round(bal*between(0.004,0.01));
      const noSL=rnd()<0.06;                                   // pár obchodů bez SL => R se nepočítá
      const u=rnd(); let r= u<0.46? between(0.8,3): u<0.54? 0 : u<0.9? -1 : -0.55;
      const hold=between(0.5,30)*HOUR, close=open+hold;
      const closed=close<NOW-HOUR && n<1000;
      const entry=+(s.base*(1+between(-0.02,0.02))).toFixed(s.pip===0.01?3:5), dir=side==='BUY'?1:-1;
      const slP=+(entry-dir*slPips*s.pip).toFixed(s.pip===0.01?3:5);
      const commission=-+(7*volume).toFixed(2), swap=+(hold>20*HOUR?-between(0,6):0).toFixed(2);
      const profit=+(r*risk).toFixed(2);
      const exit=+(entry+dir*r*slPips*s.pip).toFixed(s.pip===0.01?3:5);
      const id=acc.id+'-'+(100000+trades.length*7);
      // Snapshot Analyzeru v okamžiku vstupu. Nejstarších ~20 % obchodů: ukládání ještě nebylo => null.
      let snap=null;
      if(open>NOW-48*DAY){
        const lag=Math.round(between(3,14)), asof=new Date(open-lag*60000).toISOString();
        const cotBias=rnd()<0.55?'LONG':'SHORT', retailLong=Math.round(between(22,78));
        snap={asof,lagMinutes:lag,
          cotLevBias:cotBias, cotLevNetPctOI:+between(-18,18).toFixed(1), cotAssetMgrBias:rnd()<0.5?'LONG':'SHORT',
          cotReportDate:'2026-11-03', retailLongPct:open>NOW-45*DAY?retailLong:null,  // retail historie sahá jen 45 dní
          scoreDiff:+between(-7,7).toFixed(2), seasonality:pick(['bull','bear','neutral',null]), reverseSignal:rnd()<0.15,
          sources:{cot:'2026-11-06T20:46Z',retail:asof,calendar:asof}};
      }
      const tr={id,account:acc.id,currency:acc.currency,symbol,side,openTime:new Date(open).toISOString(),
        closeTime:closed?new Date(close).toISOString():null,volume,openPrice:entry,closePrice:closed?exit:null,
        initialSL:noSL?null:slP,riskMoney:noSL?null:risk,commission,swap,fee:0,
        profit:closed?profit:+(between(-0.6,1.4)*risk).toFixed(2),snapshot:snap,
        mt5:{position_id:String(5000000+trades.length*13),deal_in:String(9000000+trades.length*17),deal_out:closed?String(9000001+trades.length*17):null}};
      trades.push(tr);
      const ev=[{time:tr.openTime,kind:'open',text:'Otevřeno '+side+' '+volume+' lot @ '+entry+(noSL?' (bez SL)':' · SL '+slP)}];
      if(!noSL&&rnd()<0.3) ev.push({time:new Date(open+hold*0.4).toISOString(),kind:'modify',text:'SL posunut na vstup (break-even)'});
      if(rnd()<0.22&&closed) ev.push({time:new Date(open+hold*0.6).toISOString(),kind:'partial',text:'Částečné zavření '+(volume/2).toFixed(2)+' lot'});
      if(closed) ev.push({time:tr.closeTime,kind:'close',text:'Zavřeno @ '+exit+' · net '+(profit+commission+swap).toFixed(2)});
      events.push({trade:id,events:ev});
      if(closed) bal+=profit+commission+swap;
    }
  });
  // Řada equity po 6 hodinách (balance = uzavřené, equity = balance + floating otevřených)
  const equity={};
  ACCOUNTS.forEach(acc=>{
    const mine=trades.filter(x=>x.account===acc.id), pts=[];
    for(let ts=NOW-62*DAY;ts<=NOW;ts+=6*HOUR){
      let bal=acc.start, fl=0;
      mine.forEach(x=>{const o=Date.parse(x.openTime),c=x.closeTime?Date.parse(x.closeTime):null,net=x.profit+x.commission+x.swap;
        if(c&&c<=ts) bal+=net; else if(o<=ts) fl+=net*Math.min(1,(ts-o)/((c||NOW)-o||1))*(0.8+0.4*Math.sin(ts/HOUR+o%7)); });
      pts.push({t:new Date(ts).toISOString(),balance:+bal.toFixed(2),equity:+(bal+fl).toFixed(2)});
    }
    equity[acc.id]=pts;
  });
  root.DEMO={accounts:ACCOUNTS,trades,events:Object.fromEntries(events.map(e=>[e.trade,e.events])),equity,now:new Date(NOW).toISOString()};
})(typeof window!=='undefined'?window:globalThis);
