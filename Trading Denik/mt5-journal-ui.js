/* AT Trading — MT5 deník (UI + data + kontext pro AI Coach). Plain JS, žádný build.
   Načítá se po journal-stats.js a sync.js. Používá React.createElement přes `self.h` z FXApp (index.html).
   Data čte přes Supabase klient (RLS: uživatel vidí jen své účty). Nic nezapisuje do brokera. */
(function(root){
  const DEF={loaded:false,loading:false,err:'',needLogin:false,accounts:[],positions:[],snaps:{},mods:[],equity:{},eqKey:'',
    selAcc:'ALL',per:'all',tab:'trades',sel:null,events:{},addOpen:false,form:{label:'',broker:'',server:'',currency:'USD'},
    newToken:null,busy:false,msg:'',confirmRotate:null};
  const get=self=>Object.assign({},DEF,self.state.mt5||{});
  const set=(self,p)=>self.setState(s=>({mt5:Object.assign({},DEF,s.mt5||{},p)}));
  const J=()=>root.JournalStats;
  const fm=(n,d)=>n==null||isNaN(n)?'—':Number(n).toLocaleString('cs-CZ',{minimumFractionDigits:d||0,maximumFractionDigits:d||0});
  const money=(n,cur,d)=>n==null?'—':(n>0?'+':n<0?'−':'')+fm(Math.abs(n),d==null?2:d)+(cur?' '+cur:'');
  const pct=n=>n==null?'—':fm(n*100,1)+' %';
  const dtf=s=>{if(!s)return '—';const d=new Date(s);return d.toLocaleDateString('cs-CZ',{day:'numeric',month:'numeric'})+' '+d.toISOString().slice(11,16);};
  const WD=['Ne','Po','Út','St','Čt','Pá','So'];
  const PER_DAYS={'7':7,'30':30,'90':90,all:null};

  async function pageAll(q){let out=[],from=0;for(;;){const r=await q(from,from+999);if(r.error)throw r.error;out=out.concat(r.data||[]);if(!r.data||r.data.length<1000)break;from+=1000;if(from>30000)break;}return out;}

  async function load(self){
    if(get(self).loading) return;
    const Sy=root.Sync; if(!Sy||!Sy.ready||!Sy.client){set(self,{loaded:true,needLogin:true});return;}
    let sess=null; try{sess=await Sy.session();}catch(e){}
    if(!sess){set(self,{loaded:true,needLogin:true,accounts:[],positions:[]});return;}
    set(self,{loading:true,err:'',needLogin:false});
    try{
      const sb=Sy.client();
      const acc=await sb.from('mt5_accounts').select('id,label,broker,server,currency,margin_mode,login_hint,sync_enabled,balance,equity,created_at,last_seen_at,last_ingest_status').order('created_at'); if(acc.error)throw acc.error;
      const pos=await pageAll((a,b)=>sb.from('mt5_positions').select('*').order('opened_at',{ascending:false,nullsFirst:false}).range(a,b));
      const sn=await pageAll((a,b)=>sb.from('mt5_entry_snapshots').select('account_id,position_key,available,stale,lag_seconds,state_asof,summary').range(a,b));
      const snaps={}; sn.forEach(x=>{snaps[x.account_id+'|'+x.position_key]=x;});
      const mods=await sb.from('mt5_position_events').select('account_id,position_key,event_time,payload').eq('kind','modify_sl_tp').order('event_time',{ascending:false}).limit(500);
      set(self,{loading:false,loaded:true,accounts:acc.data||[],positions:pos,snaps,mods:mods.data||[]});
      loadEquity(self,true,acc.data||[]);
    }catch(e){set(self,{loading:false,loaded:true,err:String(e&&e.message||e)});}
  }
  async function loadEquity(self,force,accs){
    const st=get(self),Sy=root.Sync,accounts=accs||st.accounts; if(!Sy||!accounts.length) return;
    const key=st.per+'|'+accounts.length; if(!force&&st.eqKey===key) return;
    const days=PER_DAYS[st.per], since=days?new Date(Date.now()-days*86400000).toISOString():'2000-01-01T00:00:00Z';
    const bucket=days&&days<=7?15:days&&days<=30?60:days&&days<=90?180:360;
    try{
      const sb=Sy.client(),eq={};
      for(const a of accounts){const r=await sb.rpc('mt5_equity_series',{p_account:a.id,p_since:since,p_bucket_minutes:bucket}); if(!r.error) eq[a.id]=(r.data||[]).map(p=>({t:p.ts,balance:+p.balance,equity:+p.equity})).sort((x,y)=>Date.parse(x.t)-Date.parse(y.t));}
      set(self,{equity:eq,eqKey:key});
    }catch(e){}
  }
  async function loadEvents(self,t){
    const st=get(self); if(st.events[t.id]) return;
    try{const r=await root.Sync.client().from('mt5_position_events').select('event_time,kind,payload').eq('account_id',t.account).eq('position_key',t.position_key).order('event_time');
      if(!r.error){const ev=Object.assign({},get(self).events);ev[t.id]=r.data||[];set(self,{events:ev});}}catch(e){}
  }

  // --- převod pozic na obchody pro JournalStats -------------------------------------------------
  function trades(st){
    const am={}; st.accounts.forEach(a=>{am[a.id]=a;});
    return st.positions.filter(p=>am[p.account_id]).map(p=>{
      const open=p.status==='open', fl=open&&p.flags&&p.flags.floating!=null?+p.flags.floating:0;
      const sn=st.snaps[p.account_id+'|'+p.position_key]||null;
      return {id:p.account_id+'|'+p.position_key,position_key:p.position_key,position_id:p.position_id,account:p.account_id,currency:am[p.account_id].currency,
        symbol:p.symbol,side:p.side,openTime:p.opened_at,closeTime:open?null:(p.closed_at||p.opened_at),volume:+p.volume_in,openPrice:p.open_price,closePrice:p.close_price,
        profit:(+p.profit||0)+fl,commission:+p.commission||0,swap:+p.swap||0,fee:+p.fee||0,riskMoney:p.risk_money==null?null:+p.risk_money,
        initialSL:p.initial_sl,initialSLSource:p.initial_sl_source,currentSL:p.current_sl,currentTP:p.current_tp,initialTP:p.initial_tp,
        status:p.status,flags:p.flags||{},snap:sn,summary:sn&&sn.summary||null};
    });
  }
  function selected(st){
    const accs=st.selAcc==='ALL'?null:[st.selAcc], days=PER_DAYS[st.per];
    return J().filter(trades(st),{accounts:accs,from:days?new Date(Date.now()-days*86400000).toISOString():null});
  }
  function factorKey(t){
    const s=t.summary; if(!t.snap) return 'Bez snapshotu (zatím neuložen)'; if(!s) return 'Snapshot nedostupný (před zahájením ukládání stavu Analyzeru)';
    const c=s.cot_agrees==null?'COT neznámý':s.cot_agrees?'COT souhlasí':'COT proti';
    const r=s.retail_contra==null?'retail neznámý':s.retail_contra?'retail proti davu':'retail s davem';
    return c+' · '+r;
  }
  const bucketBy={
    'Podle instrumentu':t=>t.symbol||'?','Podle směru':t=>t.side,
    'Podle dne v týdnu (zavření)':t=>WD[new Date(t.closeTime).getUTCDay()],'Podle měsíce (zavření)':t=>t.closeTime.slice(0,7),
    'Podle kombinace COT a retailu při vstupu':factorKey,
    'Podle shody s biasem Analyzeru':t=>!t.summary||t.summary.with_bias==null?'Bias neznámý':t.summary.with_bias?'Obchod po biasu':'Obchod proti biasu',
    'Podle aktivního reverzního signálu':t=>!t.summary?'Neznámé':t.summary.reversal?'Reverzní signál aktivní':'Bez reverzního signálu'};

  // --- akce -------------------------------------------------------------------------------------
  async function createAccount(self){
    const st=get(self),f=st.form; if(!f.label.trim()){set(self,{msg:'⚠ Zadej název účtu.'});return;}
    set(self,{busy:true,msg:''});
    try{
      const r=await root.Sync.client().rpc('mt5_create_account',{p_label:f.label.trim(),p_broker:f.broker.trim()||null,p_server:f.server.trim()||null,p_currency:(f.currency||'USD').trim().toUpperCase()});
      if(r.error)throw r.error; const row=Array.isArray(r.data)?r.data[0]:r.data;
      set(self,{busy:false,addOpen:false,form:{label:'',broker:'',server:'',currency:'USD'},newToken:{account:f.label.trim(),token:row.token}});
      load(self);
    }catch(e){set(self,{busy:false,msg:'⚠ '+String(e&&e.message||e)});}
  }
  async function rotate(self,a){
    set(self,{busy:true,confirmRotate:null});
    try{const r=await root.Sync.client().rpc('mt5_rotate_token',{p_account:a.id}); if(r.error)throw r.error; set(self,{busy:false,newToken:{account:a.label,token:r.data}});}
    catch(e){set(self,{busy:false,msg:'⚠ '+String(e&&e.message||e)});}
  }
  async function toggleSync(self,a){
    try{const r=await root.Sync.client().from('mt5_accounts').update({sync_enabled:!a.sync_enabled}).eq('id',a.id); if(r.error)throw r.error; load(self);}
    catch(e){set(self,{msg:'⚠ '+String(e&&e.message||e)});}
  }

  // --- UI ---------------------------------------------------------------------------------------
  function render(self){
    const h=self.h,T=self.tok,st=get(self),mono=x=>self.mono(x),card=x=>self.card(x);
    const inp={background:'#0a0d13',border:'1px solid #1b2130',borderRadius:9,color:T.text,padding:'9px 11px',fontSize:12.5,fontFamily:"'Manrope',sans-serif",outline:'none',width:'100%'};
    const btn=(label,on,o)=>h('button',Object.assign({type:'button',onClick:on,disabled:st.busy,style:Object.assign({border:'1px solid '+T.accent,background:'linear-gradient(180deg,#5e7cfb,#4c63d9)',color:'#fff',borderRadius:10,padding:'9px 16px',fontFamily:'inherit',fontSize:12.5,fontWeight:700,cursor:'pointer'},(o&&o.style)||{})},{}),label);
    const ghost=(label,on,active)=>h('button',{type:'button',onClick:on,style:{border:'1px solid '+(active?T.accent:'#1b2130'),background:active?'rgba(94,124,251,.14)':'#0a0d13',color:active?T.text:T.dim,borderRadius:8,padding:'7px 12px',fontFamily:'inherit',fontSize:12,fontWeight:700,cursor:'pointer'}},label);
    const head=h('div',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',gap:12,flexWrap:'wrap',marginBottom:12}},
      self.ptitle('MT5 deník (automatický)','Obchody z MT5 se zapisují samy · jen čtení, konektor nikdy neobchoduje'),
      h('div',{style:{display:'flex',gap:8,flexWrap:'wrap'}},ghost(st.loading?'⏳ Načítám…':'⟳ Obnovit',()=>load(self)),ghost('+ Přidat MT5 účet',()=>set(self,{addOpen:!st.addOpen,msg:''}),st.addOpen)));

    // token (zobrazí se jednou)
    const tokenBox=st.newToken&&h('div',{style:{border:'1px solid '+T.amber,borderRadius:10,padding:'12px 14px',marginBottom:12,background:'rgba(232,171,63,.06)'}},
      h('div',{style:{fontSize:12.5,fontWeight:800,color:T.amber,marginBottom:6}},'Token konektoru pro účet „'+st.newToken.account+'“ — zobrazí se jen TEĎ'),
      h('div',{style:mono({fontSize:11.5,wordBreak:'break-all',padding:'8px 10px',background:'#0a0d13',borderRadius:8,border:'1px solid #1b2130',userSelect:'all'})},st.newToken.token),
      h('div',{style:{fontSize:11.5,color:T.dim,marginTop:8,lineHeight:1.5}},'Ulož ho do proměnné prostředí MT5_JOURNAL_TOKEN na počítači s MT5 (návod: složka Trading Denik/connector/README.md). Nikam ho nevkládej do webu ani do chatu. Když ho ztratíš, vygeneruješ nový (starý přestane platit).'),
      h('div',{style:{display:'flex',gap:8,marginTop:10}},ghost('Kopírovat',()=>{try{navigator.clipboard.writeText(st.newToken.token);set(self,{msg:'Token zkopírován.'});}catch(e){set(self,{msg:'Označ token a zkopíruj ručně.'});}}),ghost('Uložil jsem ho, skrýt',()=>set(self,{newToken:null,msg:''}))));
    const addBox=st.addOpen&&h('div',{style:{border:'1px solid #1b2130',borderRadius:10,padding:'12px 14px',marginBottom:12}},
      h('div',{style:{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(150px,1fr))',gap:10}},
        [['label','Název účtu (např. FundingPips 100k)'],['broker','Broker / prop firma'],['server','Server (volitelné)'],['currency','Měna účtu']].map(([k,ph])=>h('input',{key:k,value:st.form[k],placeholder:ph,onChange:e=>set(self,{form:Object.assign({},st.form,{[k]:e.target.value})}),style:inp}))),
      h('div',{style:{marginTop:10,display:'flex',gap:10,alignItems:'center',flexWrap:'wrap'}},btn('Vytvořit účet a token',()=>createAccount(self)),h('span',{style:{fontSize:11,color:T.faint}},'Měna a režim (hedging/netting) se potom doplní automaticky z MT5.')));
    const msg=st.msg&&h('div',{style:{fontSize:11.5,marginBottom:10,color:st.msg[0]==='⚠'?T.red:T.green}},st.msg);

    if(st.needLogin) return h('div',{style:card({padding:'18px 20px'})},head,h('div',{style:{fontSize:12.5,color:T.dim,lineHeight:1.6}},'Pro MT5 deník se přihlas v Nastavení ⚙ (Cloud sync). Bez přihlášení se data neukládají a nejsou k dispozici.'));
    if(st.err) return h('div',{style:card({padding:'18px 20px'})},head,h('div',{style:{fontSize:12.5,color:T.red}},'Načtení selhalo: '+st.err));
    if(!st.loaded) return h('div',{style:card({padding:'18px 20px'})},head,h('div',{style:{fontSize:12.5,color:T.dim}},'Načítám…'));

    const accStatus=a=>{const age=a.last_seen_at?(Date.now()-Date.parse(a.last_seen_at))/1000:null;
      if(!a.sync_enabled) return ['synchronizace vypnuta',T.faint]; if(age==null) return ['čeká na první spojení konektoru',T.amber];
      if(a.last_ingest_status&&a.last_ingest_status!=='ok') return ['chyba: '+a.last_ingest_status,T.red];
      if(age<180) return ['konektor běží',T.green]; if(age<86400) return ['konektor neodpovídá '+Math.round(age/60)+' min',T.amber]; return ['konektor neodpovídá >1 den',T.red];};
    const accPanel=h('div',{style:{display:'flex',flexDirection:'column',gap:8,marginBottom:14}},st.accounts.map(a=>{const[tx,col]=accStatus(a);
      return h('div',{key:a.id,style:{display:'flex',alignItems:'center',gap:12,flexWrap:'wrap',padding:'9px 12px',border:'1px solid #1b2130',borderRadius:9}},
        h('span',{style:{fontWeight:800,fontSize:13}},a.label),h('span',{style:mono({fontSize:11,color:T.faint})},[a.broker,a.server,a.margin_mode,a.currency,a.login_hint?'…'+a.login_hint:null].filter(Boolean).join(' · ')),
        h('span',{style:{fontSize:11.5,fontWeight:700,color:col}},'● '+tx),
        h('span',{style:mono({fontSize:11,color:T.dim,marginLeft:'auto'})},a.balance!=null?'balance '+fm(a.balance,2)+' · equity '+fm(a.equity,2)+' '+a.currency:''),
        ghost(a.sync_enabled?'Vypnout sync':'Zapnout sync',()=>toggleSync(self,a)),
        st.confirmRotate===a.id?h('span',{style:{display:'flex',gap:6}},ghost('Opravdu nový token (starý přestane platit)',()=>rotate(self,a),true),ghost('Zrušit',()=>set(self,{confirmRotate:null}))):ghost('Nový token',()=>set(self,{confirmRotate:a.id})));}));

    if(!st.accounts.length) return h('div',{style:card({padding:'18px 20px'})},head,tokenBox,addBox,msg,
      h('div',{style:{fontSize:12.5,color:T.dim,lineHeight:1.7,maxWidth:760}},'Zatím tu není žádný MT5 účet. Klikni na „+ Přidat MT5 účet“, dostaneš token, ten vložíš do konektoru na počítači s MT5 (Trading Denik/connector/README.md) a obchody se začnou zapisovat samy. Konektor MT5 jen čte, nikdy neobchoduje ani nemění SL/TP.'));

    const list=selected(st),S=J(),sum=S.summarize(list),cur=sum.currency||'';
    const k=(l,v,s,c)=>h('div',{key:l,style:card({padding:'14px 16px',flex:'1 1 150px',minWidth:150})},h('div',{style:{fontSize:10.5,color:T.faint,marginBottom:7}},l),h('div',{style:mono({fontSize:19,fontWeight:700,color:c||T.text,overflowWrap:'anywhere'})},v),s&&h('div',{style:{fontSize:10.5,color:T.faint,marginTop:5,lineHeight:1.4}},s));
    const col=n=>n==null?T.text:n>0?T.green:n<0?T.red:T.text;
    // equity křivka
    const ids=st.selAcc==='ALL'?st.accounts.map(a=>a.id):[st.selAcc];
    const mixed=new Set(ids.map(i=>(st.accounts.find(a=>a.id===i)||{}).currency)).size>1;
    let series=[];
    if(!mixed){
      const ser=ids.map(i=>st.equity[i]||[]).filter(s=>s.length);
      if(ser.length){const start=Math.max(...ser.map(s=>Date.parse(s[0].t))),ts=[...new Set(ser.flatMap(s=>s.map(p=>Date.parse(p.t))))].filter(t=>t>=start).sort((a,b)=>a-b);
        series=ts.map(t=>{let e=0,b=0;ser.forEach(s=>{let last=s[0];for(const p of s){if(Date.parse(p.t)<=t)last=p;else break;}e+=last.equity;b+=last.balance;});return{t:new Date(t).toISOString(),equity:e,balance:b};});}
    }
    const dd=S.drawdown(series.map(p=>({t:p.t,equity:p.equity})));
    const kpis=h('div',{style:{display:'flex',gap:12,flexWrap:'wrap',marginBottom:14}},
      sum.mixedCurrencies?k('Peněžní metriky','—','Účty mají různé měny; peníze se nesčítají. Vyber jeden účet. Níže zůstává win rate a R.'):k('Zavřený výsledek',money(sum.netProfit,cur,0),sum.n+' zavřených obchodů (po poplatcích a swapu)',col(sum.netProfit)),
      k('Otevřený (floating)',sum.mixedCurrencies?'—':money(sum.floating,cur,0),sum.nOpen+' otevřených · není ve statistikách',col(sum.floating)),
      k('Win rate',pct(sum.winRate),sum.wins+' výher / '+sum.losses+' ztrát / '+sum.breakeven+' BE (BE je ve jmenovateli)'),
      k('Profit factor',sum.profitFactor==null?'—':fm(sum.profitFactor,2),'výhry ÷ |ztráty|, v penězích'),
      k('Expectancy',money(sum.expectancy,cur),'průměrný net na obchod',col(sum.expectancy)),
      k('Průměr v R',sum.avgR==null?'—':fm(sum.avgR,2)+' R','z '+sum.nWithR+' obchodů'+(sum.nWithoutR?' · '+sum.nWithoutR+' bez SL se nepočítá':'')),
      k('Ø výhra / ztráta',sum.mixedCurrencies?'—':fm(sum.avgWin,0)+' / '+fm(sum.avgLoss,0),'po nákladech'),
      k('Max drawdown',dd.abs?'−'+fm(dd.abs,0)+' '+cur:'—',dd.abs&&dd.pct!=null?'−'+fm(dd.pct*100,1)+' % z maxima equity (z equity vzorků)':'z equity vzorků konektoru'));
    const chart=(()=>{
      if(mixed) return h('div',{style:{fontSize:12,color:T.faint,padding:'10px 0'}},'Souhrnná křivka se nesčítá pro účty s různou měnou — vyber jeden účet.');
      if(series.length<2) return h('div',{style:{fontSize:12,color:T.faint,padding:'10px 0'}},'Equity křivka se zobrazí, jakmile konektor pošle aspoň dva vzorky.');
      const W=900,H=240,L=64,R=14,Tp=12,B=26,all=series.flatMap(p=>[p.equity,p.balance]),lo=Math.min(...all),hi=Math.max(...all),pad=(hi-lo)*0.08||1,y0=lo-pad,y1=hi+pad;
      const X=i=>L+i*(W-L-R)/(series.length-1),Y=v=>Tp+(y1-v)*(H-Tp-B)/(y1-y0),line=kk=>series.map((p,i)=>(i?'L':'M')+X(i).toFixed(1)+' '+Y(p[kk]).toFixed(1)).join('');
      const g=[];for(let i=0;i<=4;i++){const v=y0+(y1-y0)*i/4,y=Y(v);g.push(h('line',{key:'l'+i,x1:L,x2:W-R,y1:y,y2:y,stroke:'#1b2130'}),h('text',{key:'t'+i,x:L-8,y:y+4,textAnchor:'end',fontSize:11,fontFamily:"'JetBrains Mono',monospace",fill:T.faint},fm(v/1000,1)+'k'));}
      for(let i=0;i<=3;i++){const ix=Math.round(i*(series.length-1)/3);g.push(h('text',{key:'x'+i,x:X(ix),y:H-6,textAnchor:i===0?'start':i===3?'end':'middle',fontSize:11,fontFamily:"'JetBrains Mono',monospace",fill:T.faint},new Date(series[ix].t).toLocaleDateString('cs-CZ',{day:'numeric',month:'numeric'})));}
      const li=series.length-1;
      return h('svg',{viewBox:'0 0 '+W+' '+H,style:{width:'100%',height:'auto',display:'block'},role:'img','aria-label':'Equity a balance'},g,h('path',{d:line('balance'),fill:'none',stroke:T.dim,strokeWidth:1.5,strokeDasharray:'5 4'}),h('path',{d:line('equity'),fill:'none',stroke:T.accent,strokeWidth:2}),h('circle',{cx:X(li),cy:Y(series[li].equity),r:4,fill:T.accent}));
    })();
    const accTabs=h('div',{style:{display:'flex',gap:8,flexWrap:'wrap',marginBottom:12}},
      ghost('Souhrn všech účtů',()=>{set(self,{selAcc:'ALL',sel:null});},st.selAcc==='ALL'),
      st.accounts.map(a=>h('span',{key:a.id},ghost(a.label,()=>set(self,{selAcc:a.id,sel:null}),st.selAcc===a.id))),
      h('span',{style:{width:12}}),
      [['7','7 dní'],['30','30 dní'],['90','90 dní'],['all','Vše']].map(([v,l])=>h('span',{key:v},ghost(l,()=>{set(self,{per:v,sel:null});setTimeout(()=>loadEquity(self,true),0);},st.per===v))));
    const tabs=h('div',{style:{display:'flex',gap:8,margin:'14px 0 10px'}},ghost('Obchody',()=>set(self,{tab:'trades'}),st.tab==='trades'),ghost('Rozbory',()=>set(self,{tab:'break'}),st.tab==='break'));
    const am={}; st.accounts.forEach(a=>{am[a.id]=a;});
    const tradeRows=()=>{
      const rows=list.slice().sort((a,b)=>(Date.parse(b.openTime||b.closeTime)||0)-(Date.parse(a.openTime||a.closeTime)||0)),cols='84px 104px 74px 52px 52px 74px 100px 74px 96px 60px 90px';
      const hd=['ÚČET','OTEVŘENO','PÁR','SMĚR','LOT','VSTUP','SL (poč./nyní)','TP','NET','R','STAV'];
      return h('div',{style:{overflowX:'auto'}},h('div',{style:{minWidth:980}},
        h('div',{style:{display:'grid',gridTemplateColumns:cols,gap:8,padding:'8px 0',borderBottom:'1px solid #1b2130',fontSize:9.5,color:T.faint,letterSpacing:'.06em',fontWeight:700}},hd.map(x=>h('span',{key:x},x))),
        h('div',{style:{maxHeight:520,overflowY:'auto'}},rows.length?rows.map(t=>{const n=S.netOf(t),r=S.rOf(t),open=!t.closeTime,sl=t.initialSL!=null||t.currentSL!=null?(t.initialSL??'—')+' / '+(open?(t.currentSL??'—'):'—'):'—';
          return h('div',{key:t.id,onClick:()=>{set(self,{sel:t.id});loadEvents(self,t);},style:{display:'grid',gridTemplateColumns:cols,gap:8,alignItems:'center',padding:'9px 0',cursor:'pointer',background:st.sel===t.id?'rgba(94,124,251,.08)':'transparent',boxShadow:'0 1px 0 #14182333'}},
            h('span',{style:{fontSize:11,color:T.dim,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}},(am[t.account]||{}).label||'?'),
            h('span',{style:mono({fontSize:11,color:T.dim})},dtf(t.openTime)),h('span',{style:mono({fontSize:12,fontWeight:700})},t.symbol),
            h('span',{style:{fontSize:11,fontWeight:700,color:t.side==='BUY'?T.green:T.red}},t.side),h('span',{style:mono({fontSize:11,color:T.dim})},fm(t.volume,2)),
            h('span',{style:mono({fontSize:11,color:T.dim})},t.openPrice==null?'—':String(t.openPrice)),h('span',{style:mono({fontSize:10.5,color:T.dim})},sl),h('span',{style:mono({fontSize:11,color:T.dim})},(open?t.currentTP:t.initialTP)??'—'),
            h('span',{style:mono({fontSize:12,fontWeight:700,color:col(n)})},money(n)+(open?' ◦':'')),
            h('span',{style:mono({fontSize:11.5,color:T.dim})},open?'—':(r==null?'bez SL':fm(r,2))),
            h('span',{style:{fontSize:11,fontWeight:700,color:open?T.amber:T.faint}},open?'OTEVŘENO':'zavřeno'));}):h('div',{style:{fontSize:12,color:T.faint,padding:'14px 0'}},'Žádné obchody v tomto výběru.'))),
        h('div',{style:{fontSize:10.5,color:T.faint,marginTop:6}},'◦ = floating (neuzavřený) výsledek, není součástí statistik.'));};
    const breakdown=()=>{const closed=list.filter(t=>t.closeTime);
      return h('div',{style:{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(360px,1fr))',gap:14}},Object.entries(bucketBy).map(([title,fn])=>{
        let g=[];try{g=S.groupBy(closed.filter(t=>t.closeTime),fn).sort((a,b)=>a.key<b.key?-1:1);}catch(e){}
        if(title==='Podle instrumentu'||title.indexOf('kombinace')>=0) g.sort((a,b)=>b.n-a.n);
        return h('div',{key:title,style:{border:'1px solid #1b2130',borderRadius:10,padding:'12px 14px',minWidth:0}},h('div',{style:{fontSize:12,fontWeight:800,marginBottom:8}},title),
          h('div',{style:{overflowX:'auto'}},h('table',{style:{width:'100%',borderCollapse:'collapse',fontSize:11.5}},
            h('thead',null,h('tr',null,['','n','Win','PF','Net','Ø R'].map((x,i)=>h('th',{key:i,style:{textAlign:i?'right':'left',color:T.faint,fontSize:9.5,fontWeight:700,padding:'4px 6px'}},x)))),
            h('tbody',null,g.map(x=>h('tr',{key:x.key},h('td',{style:{padding:'5px 6px'}},x.key,x.n<10&&h('span',{style:{color:T.amber,fontSize:10,marginLeft:6}},'malý vzorek')),
              h('td',{style:mono({textAlign:'right',padding:'5px 6px'})},x.n),h('td',{style:mono({textAlign:'right',padding:'5px 6px'})},pct(x.winRate)),h('td',{style:mono({textAlign:'right',padding:'5px 6px'})},x.profitFactor==null?'—':fm(x.profitFactor,2)),
              h('td',{style:mono({textAlign:'right',padding:'5px 6px',color:col(x.netProfit)})},x.netProfit==null?'—':fm(x.netProfit,0)),h('td',{style:mono({textAlign:'right',padding:'5px 6px'})},x.avgR==null?'—':fm(x.avgR,2))))))));}),
        h('div',{style:{gridColumn:'1/-1',fontSize:11,color:T.amber,lineHeight:1.5}},'Korelace není příčina: rozbory ukazují, co se v tvých obchodech historicky stalo, ne že to výsledek způsobilo. Skupiny pod 10 obchodů jsou statisticky nespolehlivé. Obchody bez snapshotu zůstávají zvlášť, nic se nedopočítává.'));};
    return h('div',{style:card({padding:'18px 20px'})},head,tokenBox,addBox,msg,accPanel,accTabs,kpis,
      h('div',{style:{marginBottom:6,fontSize:11,color:T.faint}},'Equity (plná čára) včetně otevřených obchodů · balance (čárkovaně) jen uzavřené'),chart,tabs,
      st.tab==='trades'?tradeRows():breakdown(),detail(self,st,list));
  }

  function detail(self,st,list){
    const h=self.h,T=self.tok,mono=x=>self.mono(x),S=J(),t=trades(st).find(x=>x.id===st.sel); if(!t) return null;
    const ev=st.events[t.id]||[],n=S.netOf(t),r=S.rOf(t),s=t.summary,sn=t.snap,acc=st.accounts.find(a=>a.id===t.account)||{};
    const kv=(a,b)=>h('div',{key:a,style:{display:'grid',gridTemplateColumns:'150px 1fr',gap:10,fontSize:12.5,padding:'3px 0'}},h('span',{style:{color:T.faint}},a),h('span',{style:mono({fontSize:12,overflowWrap:'anywhere'})},b));
    const nul=v=>v==null?h('span',{style:{color:T.faint,border:'1px dashed #3a4256',borderRadius:6,padding:'0 6px',fontSize:11}},'NULL · nedostupné'):String(v);
    const evText=e=>e.kind==='open'?'Otevřeno '+fm(e.payload.volume,2)+' lot @ '+e.payload.price:e.kind==='add'?'Přidáno '+fm(e.payload.volume,2)+' lot @ '+e.payload.price:e.kind==='partial'?'Částečné zavření '+fm(e.payload.volume,2)+' lot @ '+e.payload.price+' (zbývá '+fm(e.payload.remaining,2)+')':e.kind==='close'?'Zavřeno @ '+e.payload.price+(e.payload.reversal?' (reverzace pozice)':''):'SL '+(e.payload.sl_from??'—')+' → '+(e.payload.sl_to??'—')+' · TP '+(e.payload.tp_from??'—')+' → '+(e.payload.tp_to??'—');
    let snapBox;
    if(!sn) snapBox=h('div',{style:{fontSize:12,color:T.dim,lineHeight:1.6}},t.openTime?'Snapshot se ještě neuložil: čeká na další stav Analyzeru po vstupu (do ~20 min po otevření).':'Čas vstupu neznáme (obchod otevřen před začátkem historie konektoru), snapshot nelze určit.');
    else if(!sn.available||!s) snapBox=h('div',{style:{fontSize:12,color:T.dim,lineHeight:1.6}},h('span',{style:{color:T.faint,border:'1px dashed #3a4256',borderRadius:6,padding:'0 6px'}},'NULL · nedostupné'),' V okamžiku vstupu Analyzer ještě neukládal historii svého stavu. Zpětně se nic nedoplňuje.');
    else snapBox=h('div',null,
      sn.stale&&h('div',{style:{color:T.amber,fontSize:11.5,marginBottom:6}},'⚠ Poslední uložený stav byl starší než 6 h před vstupem.'),
      kv('Stav z',dtf(sn.state_asof)+' (−'+Math.round(sn.lag_seconds/60)+' min před vstupem)'),
      kv('Bias / diff / conviction',nul(s.pair_dir)+' / '+fm(s.pair_diff,2)+' / '+(s.pair_conviction==null?'—':s.pair_conviction)),
      kv('Skóre '+s.base+' / '+s.quote,fm(s.score_base,2)+' / '+fm(s.score_quote,2)),
      kv('COT lev. fondy net (báze / kot.)',fm(s.cot_lev_net_base)+' / '+fm(s.cot_lev_net_quote)),kv('COT asset mgr net',fm(s.cot_am_net_base)+' / '+fm(s.cot_am_net_quote)),
      kv('COT percentil báze',s.cot_pct_base==null?nul(null):fm(s.cot_pct_base)+' %'),kv('Retail long',s.retail_long_pct==null?nul(null):s.retail_long_pct+' %'),
      kv('Sezónnost (báze / kot.)',s.season_base==null?nul(null):fm(s.season_base,2)+' / '+fm(s.season_quote,2)),kv('Reverzní signál',s.reversal||'žádný'),
      kv('COT souhlasí se směrem',s.cot_agrees==null?nul(null):s.cot_agrees?'ano':'ne'),kv('Retail proti davu',s.retail_contra==null?nul(null):s.retail_contra?'ano':'ne'),
      s.sources&&kv('Stáří zdrojů','COT report '+(s.sources.cot&&s.sources.cot.report_week||'—')+' · retail '+dtf(s.sources.retail&&s.sources.retail.point_time)+' · kalendář '+dtf(s.sources.calendar&&s.sources.calendar.updated)),
      kv('Technické info',nul(null)));
    return h('div',{style:{marginTop:16,border:'1px solid #1b2130',borderRadius:12,padding:'14px 16px'}},
      h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10,gap:10,flexWrap:'wrap'}},h('div',{style:{fontSize:13.5,fontWeight:800}},'Detail obchodu · '+t.symbol+' '+t.side+' · '+(acc.label||'')),
        h('button',{type:'button',onClick:()=>set(self,{sel:null}),style:{border:'none',background:'none',color:T.faint,cursor:'pointer',fontSize:13}},'✕ Zavřít')),
      h('div',{style:{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(300px,1fr))',gap:18}},
        h('div',{style:{minWidth:0}},kv('Stav',t.closeTime?'zavřeno':'otevřeno'),kv('Objem',fm(t.volume,2)+' lot'),kv('Vstup / výstup',(t.openPrice??'—')+' → '+(t.closePrice??'—')),kv('Původní SL',t.initialSL==null?nul(null):t.initialSL+(t.initialSLSource==='first_observed'?' (první pozorovaný)':' (z objednávky)')),
          kv('Aktuální SL / TP',(t.currentSL??'—')+' / '+(t.currentTP??'—')),kv('Hrubý výsledek',money(t.profit)),kv('Komise / swap / poplatek',fm(t.commission,2)+' / '+fm(t.swap,2)+' / '+fm(t.fee,2)),kv('Net',h('span',{style:{color:n>0?T.green:n<0?T.red:T.text}},money(n,acc.currency))),
          kv('Riziko (dle původního SL)',t.riskMoney==null?nul(null):fm(t.riskMoney,2)+' '+(acc.currency||'')),kv('Výsledek v R',t.closeTime?(r==null?'bez SL → R se nepočítá':fm(r,2)+' R'):'—'),
          kv('MT5 ID','pozice '+t.position_id+(t.position_key!==String(t.position_id)?' ('+t.position_key+')':'')),t.flags.incomplete_history&&h('div',{style:{color:T.amber,fontSize:11.5,marginTop:6}},'⚠ Chybí část historie dealů (otevření před začátkem sběru).')),
        h('div',{style:{minWidth:0}},h('div',{style:{fontSize:12,fontWeight:800,marginBottom:6}},'Historie pozice'),ev.length?ev.map((e,i)=>h('div',{key:i,style:{display:'grid',gridTemplateColumns:'96px 1fr',gap:8,fontSize:12,padding:'3px 0'}},h('span',{style:mono({color:T.faint,fontSize:11})},dtf(e.event_time)),h('span',null,evText(e)))):h('div',{style:{fontSize:12,color:T.faint}},'Načítám…'),
          h('div',{style:{fontSize:10.5,color:T.faint,marginTop:8,lineHeight:1.5}},'Změny SL/TP jsou zaznamenané jen v době, kdy konektor běžel (MT5 je v historii neuchovává).')),
        h('div',{style:{minWidth:0}},h('div',{style:{fontSize:12,fontWeight:800,marginBottom:6}},'Analyzer při otevření'),snapBox)));
  }

  // --- AI Coach ---------------------------------------------------------------------------------
  const COACH_MT5_RULES=`MT5 DENÍK (objekt "mt5Journal" v datech výše): reálné obchody z MT5 účtů uživatele, zapisované automaticky konektorem jen pro čtení.
PRAVIDLA: (1) Každé číslo uváděj spolu s počtem obchodů (n) a obdobím, ze kterého vychází; při n<10 výslovně upozorni, že vzorek je malý a závěr nespolehlivý. (2) Rozlišuj korelaci od příčiny: "obchody s COT shodou měly lepší výsledek" NENÍ "COT shoda způsobila zisk". (3) Používej jen data z mt5Journal; co v něm není (null, "nedostupné"), řekni, že není k dispozici, a nic nedomýšlej. Snapshot Analyzeru u obchodu je stav v okamžiku vstupu, nikdy ne dnešní. (4) Účty nesměšuj: pokud je u účtů různá měna, peněžní výsledky nesčítej. (5) Neradíš obchodovat, hodnotíš historii a postupy. (6) Když se uživatel ptá na konkrétní obchod, použij pole "focusTrades"; když není nalezen, řekni to. (7) Zavřený a otevřený (floating) výsledek vždy rozlišuj.`;

  async function prepareForCoach(self,text){
    const st=get(self); if(!st.loaded&&!st.loading) await load(self);
    const m=String(text||'').match(/\b\d{5,}\b/g)||[];
    const st2=get(self);
    for(const id of m){const p=st2.positions.find(x=>String(x.position_id)===id); if(p){const t=trades(st2).find(x=>x.position_key===p.position_key&&x.account===p.account_id); if(t) await loadEvents(self,t);}}
  }
  function coachContext(self,text){
    const st=get(self); if(!st.loaded||!st.accounts.length) return {available:false,note:'MT5 deník není připojený nebo ještě neobsahuje data.'};
    const S=J(),all=trades(st),q=String(text||''),qU=q.toUpperCase();
    const am={}; st.accounts.forEach(a=>{am[a.id]=a;});
    const stat=x=>{const s=S.summarize(x);return {n:s.n,nOpen:s.nOpen,currency:s.currency,wins:s.wins,losses:s.losses,breakeven:s.breakeven,winRate:s.winRate==null?null:+s.winRate.toFixed(3),netProfit:s.netProfit==null?null:+s.netProfit.toFixed(2),profitFactor:s.profitFactor==null?null:+s.profitFactor.toFixed(2),expectancy:s.expectancy==null?null:+s.expectancy.toFixed(2),avgR:s.avgR==null?null:+s.avgR.toFixed(2),nWithR:s.nWithR,avgWin:s.avgWin==null?null:+s.avgWin.toFixed(2),avgLoss:s.avgLoss==null?null:+s.avgLoss.toFixed(2),floating:s.floating==null?null:+s.floating.toFixed(2)};};
    const closedTs=x=>x.filter(t=>t.closeTime);
    const oldest=closedTs(all).map(t=>t.closeTime).sort()[0]||null;
    let days=null; const dm=q.match(/(\d+)\s*(dn|den|dní|dny)/i); if(dm) days=+dm[1]; else if(/týden|tyden/i.test(q)) days=7; else if(/měsíc|mesic/i.test(q)) days=30; else if(/čtvrtlet|ctvrtlet/i.test(q)) days=90; else if(/rok/i.test(q)) days=365;
    const pairs=[...new Set(all.map(t=>(t.symbol||'').toUpperCase()))].filter(s=>s&&qU.includes(s.slice(0,6)));
    const accHit=st.accounts.filter(a=>q.toLowerCase().includes(String(a.label).toLowerCase()));
    const win=days?J().filter(all,{from:new Date(Date.now()-days*86400000).toISOString()}):all;
    const out={available:true,period:{requestedDays:days,oldestClosedTrade:oldest,note:days?'Statistiky "focus" jsou za posledních '+days+' dní.':'Statistiky jsou za celou dostupnou historii.'},
      accounts:st.accounts.map(a=>({label:a.label,currency:a.currency,mode:a.margin_mode,lastSeen:a.last_seen_at,balance:a.balance,equity:a.equity,allTime:stat(all.filter(t=>t.account===a.id)),inRequestedPeriod:days?stat(win.filter(t=>t.account===a.id)):null})),
      overall:stat(all),mixedCurrencies:new Set(st.accounts.map(a=>a.currency)).size>1,
      bySymbol:S.groupBy(closedTs(win),t=>t.symbol).sort((a,b)=>b.n-a.n).slice(0,15).map(x=>({symbol:x.key,n:x.n,winRate:x.winRate==null?null:+x.winRate.toFixed(3),netProfit:x.netProfit==null?null:+x.netProfit.toFixed(2),avgR:x.avgR==null?null:+x.avgR.toFixed(2),profitFactor:x.profitFactor==null?null:+x.profitFactor.toFixed(2)})),
      bySide:S.groupBy(closedTs(win),t=>t.side).map(x=>({side:x.key,n:x.n,winRate:x.winRate==null?null:+x.winRate.toFixed(3),avgR:x.avgR==null?null:+x.avgR.toFixed(2)})),
      byFactorCombo:S.groupBy(closedTs(win),factorKey).sort((a,b)=>b.n-a.n).map(x=>({combo:x.key,n:x.n,winRate:x.winRate==null?null:+x.winRate.toFixed(3),avgR:x.avgR==null?null:+x.avgR.toFixed(2),netProfit:x.netProfit==null?null:+x.netProfit.toFixed(2)})),
      byBiasAlignment:S.groupBy(closedTs(win),bucketBy['Podle shody s biasem Analyzeru']).map(x=>({bias:x.key,n:x.n,winRate:x.winRate==null?null:+x.winRate.toFixed(3),avgR:x.avgR==null?null:+x.avgR.toFixed(2)})),
      openPositions:all.filter(t=>!t.closeTime).slice(0,20).map(t=>({account:(am[t.account]||{}).label,symbol:t.symbol,side:t.side,lots:t.volume,entry:t.openPrice,openedAt:t.openTime,initialSL:t.initialSL,currentSL:t.currentSL,currentTP:t.currentTP,floating:t.flags.floating==null?null:+t.flags.floating,slTpChanges:st.mods.filter(m=>m.account_id===t.account&&m.position_key===t.position_key).slice(0,5).map(m=>({at:m.event_time,change:m.payload})),analyzerAtEntry:t.summary?{pairBias:t.summary.pair_dir,cotAgrees:t.summary.cot_agrees,retailLongPct:t.summary.retail_long_pct,reversal:t.summary.reversal}:null})),
      recentClosed:closedTs(all).sort((a,b)=>Date.parse(b.closeTime)-Date.parse(a.closeTime)).slice(0,10).map(t=>({account:(am[t.account]||{}).label,symbol:t.symbol,side:t.side,closedAt:t.closeTime,net:+S.netOf(t).toFixed(2),r:S.rOf(t)==null?null:+S.rOf(t).toFixed(2),positionId:t.position_id})),
      dataLimits:['Změny SL/TP jsou jen z doby běhu konektoru.','Snapshot Analyzeru existuje jen u obchodů otevřených po zahájení ukládání stavu; jinak je null.','R se počítá jen u obchodů s původním SL.']};
    const best=closedTs(win).filter(t=>S.rOf(t)!=null).sort((a,b)=>S.rOf(b)-S.rOf(a));
    out.bestAndWorstByR={best:best.slice(0,5).map(t=>({symbol:t.symbol,side:t.side,r:+S.rOf(t).toFixed(2),closedAt:t.closeTime,positionId:t.position_id})),worst:best.slice(-5).reverse().map(t=>({symbol:t.symbol,side:t.side,r:+S.rOf(t).toFixed(2),closedAt:t.closeTime,positionId:t.position_id}))};
    if(pairs.length) out.focusPair=pairs.map(p=>({symbol:p,period:days?days+' dní':'celá historie',stats:stat(closedTs(win).filter(t=>(t.symbol||'').toUpperCase()===p))}));
    if(accHit.length) out.focusAccounts=accHit.map(a=>({label:a.label,stats:stat(win.filter(t=>t.account===a.id))}));
    const ids=q.match(/\b\d{5,}\b/g)||[];
    if(ids.length) out.focusTrades=ids.map(id=>{const t=all.find(x=>String(x.position_id)===id); if(!t) return {positionId:id,found:false};
      return {positionId:id,found:true,account:(am[t.account]||{}).label,symbol:t.symbol,side:t.side,status:t.status,openedAt:t.openTime,closedAt:t.closeTime,lots:t.volume,entry:t.openPrice,exit:t.closePrice,initialSL:t.initialSL,currentSL:t.currentSL,currentTP:t.currentTP,net:+S.netOf(t).toFixed(2),r:S.rOf(t),
        events:(st.events[t.id]||[]).map(e=>({at:e.event_time,kind:e.kind,detail:e.payload})),analyzerAtEntry:t.snap?{stateAsOf:t.snap.state_asof,minutesBeforeEntry:t.snap.lag_seconds==null?null:Math.round(t.snap.lag_seconds/60),stale:t.snap.stale,summary:t.summary}:'nedostupný (null)'};});
    return out;
  }

  root.MT5JournalUI={render,load,loadEquity,prepareForCoach,coachContext,COACH_MT5_RULES,_trades:trades,_factorKey:factorKey};
})(typeof window!=='undefined'?window:globalThis);
