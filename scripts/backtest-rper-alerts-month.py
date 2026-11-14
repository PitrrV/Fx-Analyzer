"""Backtest RP+ER signálů, které šly na Telegram (rekonstrukce z historie data/bias_alert_state.json v gitu).

Použití (z kořene repa, potřeba dostatečně hluboký git clone: git fetch --shallow-since=<datum> origin main):
    python3 scripts/backtest-rper-alerts-month.py [OD_DATUM]
Epizoda = od prvního výskytu signálu v rpEr do jeho zmizení (RP opustil zónu). Hodnocení: směrová změna ceny
(denní close z data/fx_daily) od vzniku do konce signálu (práh šumu 0,05 %) + pevné horizonty +1/+3/+5 obchodních dní.
Limity: jen denní close (žádné high/low), cena při vzniku = živá cena z alertu, jinak close D-1; vzorek je malý a korelovaný.
"""
import sys
import json,subprocess,datetime as dt
import os
R=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
def sh(*a): return subprocess.run(a,cwd=R,capture_output=True,text=True).stdout
log=[l.split(' ',1) for l in sh('git','log','origin/main','--reverse','--format=%H %cI','--','data/bias_alert_state.json').splitlines()]
print('commitů se změnou stavu:',len(log), log[0][1], log[-1][1])
active={}; eps=[]
for h,ts in log:
    try: st=json.loads(sh('git','show',f'{h}:data/bias_alert_state.json'))
    except Exception: continue
    cur=st.get('rpEr') or {}
    for pair in set(list(cur)+list(active)):
        v=cur.get(pair)
        if isinstance(v,str): v={'type':v,'since':None,'onsetPrice':None}
        a=active.get(pair)
        if v and (not a or a['since']!=v.get('since') or a['type']!=v.get('type')):
            if a: a['ended']=ts; eps.append(a)  # nahrazeno novým
            active[pair]={'pair':pair,'type':v['type'],'since':v.get('since'),'onsetPrice':v.get('onsetPrice'),'seen':ts,'ended':None}
        elif not v and a:
            a['ended']=ts; eps.append(a); del active[pair]
eps+= list(active.values())

print(len(eps),'epizod celkem;', sum(1 for e in eps if e['ended'] is None),'stále aktivních')

import statistics as st,bisect,datetime as dt
px={}
for p in os.listdir(R+'/data/fx_daily'):
    d=json.load(open(f'{R}/data/fx_daily/{p}')); px[d['pair']]=(d['dates'],d['closes'])
print('poslední denní close:',{k:v[0][-1] for k,v in list(px.items())[:2]})
MIN=0.05; FROM=sys.argv[1] if len(sys.argv)>1 else '2026-10-14'
out=[]
for e in eps:
    if not e['since'] or e['since'][:10]<FROM or e['pair'] not in px: continue
    dates,cl=px[e['pair']]; s=1 if e['type']=='LONG' else -1
    D=e['since'][:10]; i0=bisect.bisect_left(dates,D)-1   # poslední close PŘED dnem vzniku
    if i0<0: continue
    onset=e['onsetPrice'] or cl[i0]
    ret=lambda p:(p/onset-1)*100*s
    rec={'pair':e['pair'],'type':e['type'],'onset':e['since'],'onsetPrice':round(onset,5),'priceSource':'live' if e['onsetPrice'] else 'close D-1','ended':e['ended']}
    for n in (1,3,5):
        j=i0+n; rec[f'ret{n}d']=round(ret(cl[j]),3) if j<len(cl) else None
    if e['ended']:
        E=e['ended'][:10]; ie=bisect.bisect_left(dates,E)-1   # close před koncem signálu
        rec['resultAtEnd']=round(ret(cl[ie]),3); rec['days']=max(1,ie-i0)
        r=rec['resultAtEnd']; rec['outcome']='CORRECT' if r>MIN else 'WRONG' if r<-MIN else 'CHOP'
        path=[ret(c) for c in cl[i0+1:ie+1]]
    else:
        rec['resultAtEnd']=round(ret(cl[-1]),3); rec['outcome']='ACTIVE'; rec['days']=len(cl)-1-i0
        path=[ret(c) for c in cl[i0+1:]]
    rec['worstClose']=round(min(path),3) if path else None; rec['bestClose']=round(max(path),3) if path else None
    rec['weekend']=dt.date.fromisoformat(e['since'][:10]).weekday()>=5  # víkendové vznik: trh zavřený, počítat zvlášť
    out.append(rec)
json.dump(out,open(R+'/data/backtest_rper_lastmonth.json','w'),ensure_ascii=False,indent=0)
res=[r for r in out if r['outcome']!='ACTIVE']
print('signálů od',FROM,':',len(out),'| ukončených',len(res),'| aktivních',len(out)-len(res))
def summ(x,lab):
    if not x: return
    c=sum(r['outcome']=='CORRECT' for r in x); w=sum(r['outcome']=='WRONG' for r in x); ch=len(x)-c-w
    g=sum(r['resultAtEnd'] for r in x if r['resultAtEnd']>0); l=-sum(r['resultAtEnd'] for r in x if r['resultAtEnd']<0)
    print(f"{lab}: n={len(x)} correct={c} wrong={w} chop={ch} winRate(bez chop)={100*c/max(1,c+w):.0f}% PF={g/l if l else float('inf'):.2f} avg={st.mean(r['resultAtEnd'] for r in x):+.3f}% dny={st.mean(r['days'] for r in x):.1f}")
summ(res,'UKONČENÉ vše'); summ([r for r in res if r['type']=='LONG'],'  LONG'); summ([r for r in res if r['type']=='SHORT'],'  SHORT')
for n in (1,3,5):
    v=[r[f'ret{n}d'] for r in out if r[f'ret{n}d'] is not None]
    print(f'pevný horizont +{n}d: n={len(v)} avg={st.mean(v):+.3f}% kladných={100*sum(x>0 for x in v)/len(v):.0f}%')
    for t in ('LONG','SHORT'):
        vv=[r[f'ret{n}d'] for r in out if r['type']==t and r[f'ret{n}d'] is not None]
        if vv: print(f'   {t}: n={len(vv)} avg={st.mean(vv):+.3f}% kladných={100*sum(x>0 for x in vv)/len(vv):.0f}%')
dur={}
for r in res: dur.setdefault('1d' if r['days']<=1 else '2-3d' if r['days']<=3 else '4d+',[]).append(r)
for k,v in dur.items(): print('doba',k,'n',len(v),'correct',sum(x['outcome']=='CORRECT' for x in v),'wrong',sum(x['outcome']=='WRONG' for x in v))
print('MAE (nejhorší close) ukončené: medián',round(st.median([r['worstClose'] for r in res if r['worstClose'] is not None]),2),'%')
print('--- aktivní:'); [print(' ',r['pair'],r['type'],r['onset'][:16],'dnes',r['resultAtEnd'],'%') for r in out if r['outcome']=='ACTIVE']
print('--- nejhorší 5 ukončených:',[(r['pair'],r['type'],r['resultAtEnd']) for r in sorted(res,key=lambda r:r['resultAtEnd'])[:5]])
print('--- nejlepší 5:',[(r['pair'],r['type'],r['resultAtEnd']) for r in sorted(res,key=lambda r:-r['resultAtEnd'])[:5]])
import collections
c=collections.Counter(r['onset'][:10] for r in out); print('signálů podle dne vzniku:',dict(sorted(c.items())))
