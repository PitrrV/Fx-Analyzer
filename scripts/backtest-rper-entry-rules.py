"""RP+ER: co by se stalo při vstupu hned po alertu (R0), po potvrzení 1. dne (R1), na 60denním extrému (R3).
Zdroj: epizody z data/backtest_rper_yahoo.json + denní close z data/fx_daily (stejný zdroj => konzistentní). Jen close, bez nákladů.
Použití: python3 scripts/backtest-rper-entry-rules.py
"""
import json,os,bisect,statistics as st,math
R=__import__('os').path.dirname(__import__('os').path.dirname(__import__('os').path.abspath(__file__)))
a=json.load(open(R+'/data/backtest_rper_yahoo.json'))
px={}
for f in os.listdir(R+'/data/fx_daily'):
    d=json.load(open(f'{R}/data/fx_daily/{f}')); px[d['pair']]=(d['dates'],d['closes'])
eps=[dict(e,pair=p) for p,v in a['episodes'].items() for e in v['episodes'] if p in px]
print('epizod s cenami:',len(eps),'z',sum(len(v['episodes']) for v in a['episodes'].values()))
H=(1,3,5,10)
rows=[]
for e in eps:
    dates,cl=px[e['pair']]; s=1 if e['type']=='LONG' else -1
    if e['onsetDate'] not in dates: continue
    i0=dates.index(e['onsetDate'])
    if i0<61 or i0+11>=len(cl): continue
    ref=cl[i0]; r=lambda j:(cl[j]/ref-1)*100*s
    rets=[cl[k]/cl[k-1]-1 for k in range(i0-19,i0+1)]; vol=st.pstdev(rets)*100   # denní vol v %
    w=cl[i0-60:i0+1]; lo,hi=min(w),max(w)
    pos=(ref-lo)/(hi-lo) if hi>lo else .5          # 0 = 60denní minimum, 1 = maximum
    atlevel=(pos<=0.10) if s==1 else (pos>=0.90)    # signál přímo na 60denním extrému (proxy "důležité úrovně")
    d1=r(i0+1)                                      # první den po alertu (směrově)
    conf=d1>0
    rows.append(dict(pair=e['pair'],s=s,date=e['onsetDate'],vol=vol,atlevel=atlevel,conf=conf,d1=d1,
        fwd={h:r(i0+h) for h in H},fwdConf={h:(cl[i0+1+h]/cl[i0+1]-1)*100*s for h in (1,3,5) if i0+1+h<len(cl)},
        worst5=min(r(i0+k) for k in range(1,6)),best5=max(r(i0+k) for k in range(1,6))))
print('použito',len(rows))
def line(lab,x,key):
    v=[key(r) for r in x if key(r) is not None]
    if len(v)<8: print(f'{lab}: n={len(v)} (málo)'); return
    sd=st.pstdev(v); print(f'{lab}: n={len(v)} avg={st.mean(v):+.3f}% medián={st.median(v):+.3f}% kladných={100*sum(x>0 for x in v)/len(v):.0f}% t={st.mean(v)/(sd/math.sqrt(len(v))):.1f}')
for h in (3,5,10): line(f'R0 vstup hned při alertu, +{h}d',rows,lambda r,h=h:r['fwd'][h])
print()
C=[r for r in rows if r['conf']]; N=[r for r in rows if not r['conf']]
print('potvrzení (1. den po alertu zavřel ve směru):',len(C),'z',len(rows))
for h in (3,5): line(f'R1 vstup až na close 1. dne jen když potvrzeno, +{h}d od vstupu',C,lambda r,h=h:r['fwdConf'].get(h))
for h in (5,): line(f'   nepotvrzené (přeskočit), +{h}d od alertu',N,lambda r,h=h:r['fwd'][h])
print()
L=[r for r in rows if r['atlevel']]; NL=[r for r in rows if not r['atlevel']]
print('signál na 60denním extrému:',len(L),'z',len(rows))
for h in (3,5,10): line(f'R3 na úrovni (60d extrém), +{h}d',L,lambda r,h=h:r['fwd'][h]); line(f'   mimo úroveň, +{h}d',NL,lambda r,h=h:r['fwd'][h])
print()
LC=[r for r in L if r['conf']]
for h in (3,5): line(f'R2 na úrovni + potvrzeno, vstup close 1. dne, +{h}d',LC,lambda r,h=h:r['fwdConf'].get(h))
line('   R2 n',LC,lambda r:r['fwd'][5])
print()
for t,lab in ((1,'LONG'),(-1,'SHORT')):
    x=[r for r in rows if r['s']==t]; line(f'{lab} R0 +5d',x,lambda r:r['fwd'][5]); line(f'{lab} R1 potvrzené +5d',[r for r in x if r['conf']],lambda r:r['fwdConf'].get(5))
# stabilita R1 v čase
rows.sort(key=lambda r:r['date']); h=len(rows)//2
for nm,x in (('1. polovina',rows[:h]),('2. polovina',rows[h:])):
    line(f'{nm} R1 +5d',[r for r in x if r['conf']],lambda r:r['fwdConf'].get(5)); line(f'{nm} R0 +5d',x,lambda r:r['fwd'][5])
# nepříznivý pohyb za 5 dní (close-based) v násobcích denní vol, pro návrh stopu
wv=[-r['worst5']/r['vol'] for r in rows]; bv=[r['best5']/r['vol'] for r in rows]
q=lambda v,p:sorted(v)[int(p*(len(v)-1))]
print('\nnejhorší close do 5d proti směru v násobcích denní vol: P50 %.2f P75 %.2f P90 %.2f'%(q(wv,.5),q(wv,.75),q(wv,.9)))
print('nejlepší close do 5d ve směru v násobcích denní vol:   P50 %.2f P75 %.2f P90 %.2f'%(q(bv,.5),q(bv,.75),q(bv,.9)))
print('medián denní vol % :',round(st.median([r['vol'] for r in rows]),3))
# pipy
print('\nCENA / 0,5 % v pipech:')
for p in ('EURUSD','GBPUSD','USDJPY','AUDUSD','USDCAD','USDCHF','NZDUSD','EURJPY','GBPJPY','AUDJPY','XAUUSD'):
    if p in px:
        c=px[p][1][-1]; pip=0.01 if 'JPY' in p else 0.0001
        if p=='XAUUSD': print(f'  {p}: cena {c:.0f}, 0,5 % = {c*0.005:.1f} USD/oz'); continue
        print(f'  {p}: cena {c:.4f}, 0,5 % = {c*0.005/pip:.0f} pipů')
