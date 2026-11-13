const assert=require('assert'); const S=require('../journal-stats.js');
const T=(id,p,o)=>Object.assign({id,account:'A',currency:'USD',symbol:'EURUSD',side:'BUY',openTime:'2026-01-01T10:00:00Z',closeTime:'2026-01-01T12:00:00Z',volume:1,profit:p,commission:0,swap:0,fee:0,riskMoney:100},o||{});
const near=(a,b)=>assert(Math.abs(a-b)<1e-9,a+' != '+b);
// 3 výhry 200,100,50; 2 ztráty -100,-100; 1 BE; 1 otevřený +999 (nesmí do uzavřených)
const trades=[T(1,200),T(2,100),T(3,50),T(4,-100),T(5,-100),T(6,0),T(7,999,{closeTime:null})];
const s=S.summarize(trades);
assert.strictEqual(s.n,6); assert.strictEqual(s.nOpen,1); assert.strictEqual(s.wins,3); assert.strictEqual(s.losses,2); assert.strictEqual(s.breakeven,1);
near(s.winRate,3/6); near(s.netProfit,150); near(s.profitFactor,350/200); near(s.expectancy,25);
near(s.avgWin,350/3); near(s.avgLoss,-100); near(s.avgR,0.25); near(s.floating,999);
// náklady se počítají do net; obchod bez SL nemá R (a nezkresluje průměr)
const c=S.summarize([T(1,100,{commission:-7,swap:-3}),T(2,50,{riskMoney:null})]);
near(c.netProfit,90+50); near(c.avgR,0.9); assert.strictEqual(c.nWithR,1); assert.strictEqual(c.nWithoutR,1);
// více měn => žádné peníze dohromady
const m=S.summarize([T(1,100),T(2,100,{currency:'EUR',account:'B'})]);
assert.strictEqual(m.netProfit,null); assert.strictEqual(m.mixedCurrencies,true); near(m.winRate,1);
// ztráty bez výher: PF = 0; výhry bez ztrát: PF null
near(S.summarize([T(1,-10)]).profitFactor,0); assert.strictEqual(S.summarize([T(1,10)]).profitFactor,null);
// filtr účtu a období
const f=S.filter([T(1,1,{account:'A'}),T(2,1,{account:'B'}),T(3,1,{closeTime:'2026-03-01T00:00:00Z'})],{accounts:['A'],to:'2026-02-01T00:00:00Z'});
assert.deepStrictEqual(f.map(t=>t.id),[1]);
// drawdown: 100,120,90,110,80,130 => max pokles 120->80 = 40 (33.3 %)
const d=S.drawdown([100,120,90,110,80,130].map((e,i)=>({t:i,equity:e})));
near(d.abs,40); near(d.pct,40/120); assert.strictEqual(d.from,1); assert.strictEqual(d.to,4);
console.log('journal-stats: všechny testy OK');
