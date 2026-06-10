//+------------------------------------------------------------------+
//| ZoneBot_V25_US100_3STEP_ALERTS_RSI.mq5                           |
//|                                                                  |
//| STRATEGIE:                                                       |
//|  1. H4 struktura určuje hlavní směr (HH+HL = bull, LH+LL = bear)|
//|  V24: + CHOCH, + D1 bias, + 3-step push alerts                  |
//|  V25: + spread guard, TP kvalita, kratší kontext,               |
//|       FVG vázané na zónu, breakeven (vše zapínatelné)           |
//|  2. H4 Supply/Demand zóny jako hlavní kontext                   |
//|  3. M15 Supply/Demand zóna jako setup oblast                    |
//|  4. RSI M15 jako konfluence (byl nad 70 / pod 30)               |
//|  5. M5 FVG jako entry trigger (market entry při vstupu do FVG)  |
//|  6. Score systém pro výpočet rizika (0.25% až 1%)               |
//|  7. TP na nejbližší opačné zóně / FVG / fallback RR             |
//+------------------------------------------------------------------+
#property strict

#include <Trade/Trade.mqh>
CTrade trade;

// ===== INPUTS =====
input int    MagicNumber  = 2029130;

// Risk podle score
input double Risk_Score2  = 0.35;   // % účtu při score 2
input double Risk_Score3  = 0.5;    // % účtu při score 3
input double Risk_Score45 = 0.75;   // % účtu při score 4-5

// Sessions
input int TradingStartHour = 8;
input int TradingEndHour   = 22;

// H4 struktura
input int SwingStrength_H4 = 2;     // svíčky vlevo/vpravo pro swing bod
input int StructureLookback_H4 = 30; // kolik H4 svíček zpět

// H4 Supply/Demand zóny
input double H4Impulse_MinPts  = 150.0;  // bodů NQ
input int    H4ZoneLookback    = 50;
input double H4ZoneTol_Pts     = 40.0;   // tolerance přiblížení k H4 zóně

// M15 Supply/Demand zóny
input double M15Impulse_MinPts = 60.0;   // bodů NQ
input int    M15ZoneLookback   = 80;
input double M15ZoneTol_Pts    = 20.0;   // tolerance přiblížení k M15 zóně

// RSI M15 konfluence
input int    RSI_Period       = 14;
input double RSI_Overbought   = 70.0;
input double RSI_Oversold     = 30.0;
input int    RSI_LookbackBars = 15;    // kolik M15 svíček zpět hledáme extrém

// M5 FVG entry
input double MinFVG_Pts         = 5.0;
input double MinImpulseBody_Pts = 5.0;
input int    FVGValidBars       = 25;  // jak dlouho FVG platí

// SL
input double SL_Buffer_Pts = 8.0;
input double MinSL_Pts     = 15.0;
input double MaxSL_Pts     = 250.0;

// TP
input double FallbackTP_RR = 1.5;    // fallback RR pokud není zóna
input double TP_PreZone_Pts = 5.0;   // kolik bodů před zónou dát TP

// Profit protection
input double ProfitProtection_R        = 2.0;
input double OppImpulse_MinPts         = 12.0;
input int    OppStructureLookback      = 8;

input bool MaxOnePosition = true;
input bool ShowPanel      = true;
input bool DebugLog       = true;

// V14 — CHOCH
input bool   UseChoch         = true;   // CHOCH jako +1 do score
input int    ChochSwingN      = 3;      // Bary okolo swing pointu pro CHOCH

// V14 — D1 Bias
input bool   UseD1Bias        = true;   // Blokuj obchod contra D1 trendu

// V24 — Push notifikace 3 kroky
input bool   PushOnSetup      = true;   // Alert 1/3: setup detekovan + preview Entry/SL/TP
input bool   PushOnNearEntry  = true;   // Alert 2/3: cena se blizi k FVG entry zone
input bool   PushOnEntry      = true;   // Alert 3/3: vstup otevren
input double PushNearEntry_Pts = 15.0;  // kolik bodu od FVG zony = "entry se blizi"

// RSI alerts (jen upozorneni)
input bool   PushOnRSIAlerts  = true;
input double RSI_Alert_High   = 70.0;
input double RSI_Alert_Low    = 30.0;

// ========================================================================
// V25 — VYLEPŠENÍ (vše zapínatelné, ať jdou A/B testovat po jednom)
// ========================================================================
// (1) Spread guard — neotvírej tržní vstup při širokém spreadu
input bool   UseSpreadGuard   = true;   // zapnout spread guard
input double MaxSpread_Pts    = 12.0;   // max spread (US100 body) pro vstup

// (2) TP kvalita — nepřijímej zónovou TP horší než N×R, jinak fallback
input double MinZoneTP_RR     = 1.3;    // min RR aby se akceptovala zónová TP (1.0 = původní chování)

// (3) Platnost kontextu (M15 svíčky). Bylo natvrdo 36 (=9h) → pozdní vstupy
input int    Context_ValidBars = 12;    // kolik M15 svíček platí kontext

// (4) FVG musí ležet u příslušné M15 zóny (proti chop/daleko od zóny)
input bool   UseFVGNearZone   = true;   // FVG akceptuj jen poblíž M15 zóny

// (5) Breakeven — posuň SL na entry po dosažení X×R
input bool   UseBreakeven     = true;   // zapnout breakeven
input double Breakeven_At_R   = 1.0;    // po kolika R posunout na BE
input double Breakeven_Offset = 2.0;    // body nad/pod entry (pokryje náklady)


// ===== GLOBALS =====
double pipSize;
int    rsiHandle  = INVALID_HANDLE;

datetime lastM5BarTime  = 0;
datetime lastM15BarTime = 0;

// H4 struktura
int    h4Structure  = 0;   // 1=bullish, -1=bearish, 0=chop
string h4StructText = "---";
double h4SwingHigh1 = 0, h4SwingHigh2 = 0;
double h4SwingLow1  = 0, h4SwingLow2  = 0;

// H4 zóny
double h4DemandLow=0, h4DemandHigh=0;
double h4SupplyLow=0, h4SupplyHigh=0;

// M15 zóny
double m15DemandLow=0, m15DemandHigh=0;
double m15SupplyLow=0, m15SupplyHigh=0;

// Kontext
int    contextDir      = 0;   // 1=long, -1=short
int    contextBarsLeft = 0;
int    setupScore      = 0;
string scoreDetail     = "";

// M5 FVG
double activeFvgLow=0, activeFvgHigh=0;
int    activeFvgDir=0, activeFvgBarsLeft=0;

// Panel info
string panelInfo    = "---";
string panelSLSrc   = "---";

// V14 — CHOCH stav
int      v14Choch      = 0;    // 1=bullish choch, -1=bearish choch, 0=zadny
double   v14ChochLevel = 0;    // Level ktery byl prorazen
int      v14PrevH4     = 999;  // Pro detekci zmeny H4 trendu

// V14 — D1 trend
int      v14TrendD1    = 0;    // 1=UP -1=DOWN 0=CHOP

// V24 — Push throttle
datetime v14LastPushSetup = 0;
int      v14LastContextDir = 0;
datetime v24LastPushNearEntry = 0;
string   v24LastNearKey = "";

// RSI alert throttle
datetime v24LastRSIAlertBar = 0;
int      v24LastRSIState = 0;


string RiskKey(ulong t){ return "ZB13_"+IntegerToString((int)t); }

void Log(string msg){ if(DebugLog) Print("[V25] ",msg); }

//+------------------------------------------------------------------+
ENUM_ORDER_TYPE_FILLING GetFillingMode()
{
   uint f=(uint)SymbolInfoInteger(_Symbol,SYMBOL_FILLING_MODE);
   if((f&SYMBOL_FILLING_FOK)!=0) return ORDER_FILLING_FOK;
   if((f&SYMBOL_FILLING_IOC)!=0) return ORDER_FILLING_IOC;
   return ORDER_FILLING_RETURN;
}

//+------------------------------------------------------------------+
int OnInit()
{
   if(_Digits==2)                  pipSize=1.0;
   else if(_Digits==3||_Digits==5) pipSize=_Point*10.0;
   else                            pipSize=_Point;

   rsiHandle=iRSI(_Symbol,PERIOD_M15,RSI_Period,PRICE_CLOSE);
   if(rsiHandle==INVALID_HANDLE){ Print("RSI error"); return INIT_FAILED; }

   trade.SetExpertMagicNumber(MagicNumber);
   trade.SetDeviationInPoints(100);
   trade.SetTypeFilling(GetFillingMode());

   PrintFormat("ZoneBot V25 | %s | pipSize=%.2f | Filling=%d",_Symbol,pipSize,(int)GetFillingMode());
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{ if(rsiHandle!=INVALID_HANDLE) IndicatorRelease(rsiHandle); Comment(""); }

//+------------------------------------------------------------------+
bool IsNewM5Bar()
{ datetime t=iTime(_Symbol,PERIOD_M5,0); if(t!=lastM5BarTime){lastM5BarTime=t;return true;} return false; }

bool IsNewM15Bar()
{ datetime t=iTime(_Symbol,PERIOD_M15,0); if(t!=lastM15BarTime){lastM15BarTime=t;return true;} return false; }

bool IsTradingTime()
{ MqlDateTime t; TimeToStruct(TimeCurrent(),t); return(t.hour>=TradingStartHour&&t.hour<TradingEndHour); }

double GetRSI(int shift=1)
{ double buf[]; ArraySetAsSeries(buf,true);
  if(CopyBuffer(rsiHandle,0,0,shift+2,buf)<shift+1) return 50.0; return buf[shift]; }

double NormalizeVolume(double v)
{ double mn=SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_MIN),mx=SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_MAX),st=SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_STEP);
  v=MathFloor(v/st)*st; if(v<mn)v=0; if(v>mx)v=mx; return v; }

double CalcLots(double entry,double sl,double riskPct)
{ double bal=AccountInfoDouble(ACCOUNT_BALANCE),rm=bal*riskPct/100.0;
  double ts=SymbolInfoDouble(_Symbol,SYMBOL_TRADE_TICK_SIZE),tv=SymbolInfoDouble(_Symbol,SYMBOL_TRADE_TICK_VALUE);
  double d=MathAbs(entry-sl); if(d<=0||ts<=0||tv<=0) return 0;
  double lpl=(d/ts)*tv; if(lpl<=0) return 0; return NormalizeVolume(rm/lpl); }

bool HasOpenPosition()
{
   for(int i=PositionsTotal()-1;i>=0;i--)
   { ulong t=PositionGetTicket(i); if(PositionSelectByTicket(t))
     if(PositionGetString(POSITION_SYMBOL)==_Symbol&&PositionGetInteger(POSITION_MAGIC)==MagicNumber) return true; }
   return false;
}

//+------------------------------------------------------------------+
// SPREAD (V25)
//+------------------------------------------------------------------+
double CurrentSpreadPts()
{ return (SymbolInfoDouble(_Symbol,SYMBOL_ASK)-SymbolInfoDouble(_Symbol,SYMBOL_BID))/pipSize; }

//+------------------------------------------------------------------+
// H4 SWING DETEKCE
//+------------------------------------------------------------------+
bool IsSwingHigh_H4(int bar)
{
   double h=iHigh(_Symbol,PERIOD_H4,bar);
   for(int i=1;i<=SwingStrength_H4;i++)
   { if(bar+i>StructureLookback_H4) return false;
     if(iHigh(_Symbol,PERIOD_H4,bar+i)>=h) return false; }
   for(int i=1;i<=SwingStrength_H4;i++)
   { if(bar-i<1) return false;
     if(iHigh(_Symbol,PERIOD_H4,bar-i)>=h) return false; }
   return true;
}

bool IsSwingLow_H4(int bar)
{
   double l=iLow(_Symbol,PERIOD_H4,bar);
   for(int i=1;i<=SwingStrength_H4;i++)
   { if(bar+i>StructureLookback_H4) return false;
     if(iLow(_Symbol,PERIOD_H4,bar+i)<=l) return false; }
   for(int i=1;i<=SwingStrength_H4;i++)
   { if(bar-i<1) return false;
     if(iLow(_Symbol,PERIOD_H4,bar-i)<=l) return false; }
   return true;
}

//+------------------------------------------------------------------+
// H4 STRUKTURA — HH+HL = bullish, LH+LL = bearish
//+------------------------------------------------------------------+
void AnalyzeH4Structure()
{
   double highs[4]; int hc=0;
   double lows[4];  int lc=0;

   for(int i=SwingStrength_H4+1; i<=StructureLookback_H4-SwingStrength_H4 && (hc<4||lc<4); i++)
   {
      if(hc<4 && IsSwingHigh_H4(i)){ highs[hc]=iHigh(_Symbol,PERIOD_H4,i); hc++; }
      if(lc<4 && IsSwingLow_H4(i)) { lows[lc] =iLow(_Symbol, PERIOD_H4,i); lc++; }
   }

   if(hc<2||lc<2){ h4Structure=0; h4StructText="NEDOSTATEK DAT"; return; }

   h4SwingHigh1=highs[0]; h4SwingHigh2=highs[1];
   h4SwingLow1 =lows[0];  h4SwingLow2 =lows[1];

   bool HH=(h4SwingHigh1>h4SwingHigh2);
   bool HL=(h4SwingLow1 >h4SwingLow2);
   bool LH=(h4SwingHigh1<h4SwingHigh2);
   bool LL=(h4SwingLow1 <h4SwingLow2);

   if(HH&&HL){ h4Structure=1;  h4StructText=StringFormat("BULLISH HH=%.0f>%.0f HL=%.0f>%.0f",h4SwingHigh1,h4SwingHigh2,h4SwingLow1,h4SwingLow2); }
   else if(LH&&LL){ h4Structure=-1; h4StructText=StringFormat("BEARISH LH=%.0f<%.0f LL=%.0f<%.0f",h4SwingHigh1,h4SwingHigh2,h4SwingLow1,h4SwingLow2); }
   else { h4Structure=0; h4StructText=StringFormat("CHOP SH:%.0f/%.0f SL:%.0f/%.0f",h4SwingHigh1,h4SwingHigh2,h4SwingLow1,h4SwingLow2); }

   Log("H4 struktura: "+h4StructText);
}

//+------------------------------------------------------------------+
// HLEDÁNÍ ZÓN (demand/supply) — obecná funkce
// Vrátí nejčerstvější zónu s dostatečným impulzem
//+------------------------------------------------------------------+
bool FindDemandZone(ENUM_TIMEFRAMES tf, double minImpulse, int lookback,
                    double &zoneLow, double &zoneHigh)
{
   zoneLow=zoneHigh=0;
   for(int i=2;i<=lookback;i++)
   {
      double o=iOpen(_Symbol,tf,i), c=iClose(_Symbol,tf,i);
      if(c>=o) continue;   // bearish svíčka (base demand)
      double lo=iLow(_Symbol,tf,i), hi=iHigh(_Symbol,tf,i);
      double best=hi;
      for(int j=i-1;j>=1;j--) best=MathMax(best,iHigh(_Symbol,tf,j));
      if((best-hi)/pipSize>=minImpulse){ zoneLow=lo; zoneHigh=hi; return true; }
   }
   return false;
}

bool FindSupplyZone(ENUM_TIMEFRAMES tf, double minImpulse, int lookback,
                    double &zoneLow, double &zoneHigh)
{
   zoneLow=zoneHigh=0;
   for(int i=2;i<=lookback;i++)
   {
      double o=iOpen(_Symbol,tf,i), c=iClose(_Symbol,tf,i);
      if(c<=o) continue;   // bullish svíčka (base supply)
      double lo=iLow(_Symbol,tf,i), hi=iHigh(_Symbol,tf,i);
      double best=lo;
      for(int j=i-1;j>=1;j--) best=MathMin(best,iLow(_Symbol,tf,j));
      if((lo-best)/pipSize>=minImpulse){ zoneLow=lo; zoneHigh=hi; return true; }
   }
   return false;
}

void UpdateAllZones()
{
   // H4 zóny
   FindDemandZone(PERIOD_H4,H4Impulse_MinPts,H4ZoneLookback,h4DemandLow,h4DemandHigh);
   FindSupplyZone(PERIOD_H4,H4Impulse_MinPts,H4ZoneLookback,h4SupplyLow,h4SupplyHigh);

   // M15 zóny
   FindDemandZone(PERIOD_M15,M15Impulse_MinPts,M15ZoneLookback,m15DemandLow,m15DemandHigh);
   FindSupplyZone(PERIOD_M15,M15Impulse_MinPts,M15ZoneLookback,m15SupplyLow,m15SupplyHigh);

   Log(StringFormat("Zóny | H4 Demand: %.0f-%.0f | H4 Supply: %.0f-%.0f",h4DemandLow,h4DemandHigh,h4SupplyLow,h4SupplyHigh));
   Log(StringFormat("Zóny | M15 Demand: %.0f-%.0f | M15 Supply: %.0f-%.0f",m15DemandLow,m15DemandHigh,m15SupplyLow,m15SupplyHigh));
}

//+------------------------------------------------------------------+
// RSI KONFLUENCE
// Byl RSI v extrému v posledních RSI_LookbackBars svíčkách?
//+------------------------------------------------------------------+
bool RSIWasOversold()
{
   double buf[]; ArraySetAsSeries(buf,true);
   if(CopyBuffer(rsiHandle,0,0,RSI_LookbackBars+2,buf)<RSI_LookbackBars+1) return false;
   for(int i=1;i<=RSI_LookbackBars;i++)
      if(buf[i]<=RSI_Oversold) return true;
   return false;
}

bool RSIWasOverbought()
{
   double buf[]; ArraySetAsSeries(buf,true);
   if(CopyBuffer(rsiHandle,0,0,RSI_LookbackBars+2,buf)<RSI_LookbackBars+1) return false;
   for(int i=1;i<=RSI_LookbackBars;i++)
      if(buf[i]>=RSI_Overbought) return true;
   return false;
}

//+------------------------------------------------------------------+
// POMOCNÉ — je zóna A uvnitř zóny B?
//+------------------------------------------------------------------+
bool ZoneInsideZone(double aLow,double aHigh,double bLow,double bHigh)
{
   if(bLow<=0||bHigh<=0) return false;
   return (aLow>=bLow && aHigh<=bHigh);
}

bool ZoneOverlap(double aLow,double aHigh,double bLow,double bHigh)
{
   if(bLow<=0||bHigh<=0||aLow<=0||aHigh<=0) return false;
   return (aLow<=bHigh && aHigh>=bLow);
}

//+------------------------------------------------------------------+
// SCORE VÝPOČET A DETEKCE KONTEXTU
//
// score:
//  +1 M15 zóna nalezena a cena ji testuje
//  +1 M15 zóna leží uvnitř / překrývá H4 zónu stejného směru
//  +1 RSI extrém byl v posledních N svíčkách
//  +1 H4 struktura souhlasí se směrem
//  +1 (rezerva pro čistou reakci + FVG — přidá se při detekci FVG)
//+------------------------------------------------------------------+
bool PriceNearZone(double price,double lo,double hi,double tolPts)
{ double tol=tolPts*pipSize; return(lo>0&&hi>0&&price>=lo-tol&&price<=hi+tol); }

void EvaluateContext()
{
   double bid=SymbolInfoDouble(_Symbol,SYMBOL_BID);
   double ask=SymbolInfoDouble(_Symbol,SYMBOL_ASK);

   bool nearM15Demand=PriceNearZone(bid,m15DemandLow,m15DemandHigh,M15ZoneTol_Pts);
   bool nearM15Supply=PriceNearZone(ask,m15SupplyLow,m15SupplyHigh,M15ZoneTol_Pts);

   // Reset
   int newDir=0; int score=0; string detail="";

   // --- LONG setup ---
   if(nearM15Demand)
   {
      newDir=1; score=1; detail="M15 Demand";

      // H4 struktura
      if(h4Structure==1){ score++; detail+="+H4Bull"; }

      // M15 demand uvnitř H4 demand
      if(ZoneOverlap(m15DemandLow,m15DemandHigh,h4DemandLow,h4DemandHigh))
      { score++; detail+="+H4Demand"; }

      // RSI byl oversold
      if(RSIWasOversold()){ score++; detail+="+RSI<30"; }

      // V14: CHOCH souhlasi se smerem (bearish choch = kontrend, ale pridava score kdyz je kontext long a choch potvrzuje obrat)
      if(UseChoch && v14Choch==1){ score++; detail+="+CHOCH"; }
   }

   // --- SHORT setup ---
   // V25 FIX: short přebírá jen pokud long nebyl detekován, jinak by tichý
   // přepis zahodil long setup i s jeho D1 checkem (chop oblast s oběma zónami).
   if(nearM15Supply && newDir==0)
   {
      newDir=-1; score=1; detail="M15 Supply";

      if(h4Structure==-1){ score++; detail+="+H4Bear"; }

      if(ZoneOverlap(m15SupplyLow,m15SupplyHigh,h4SupplyLow,h4SupplyHigh))
      { score++; detail+="+H4Supply"; }

      if(RSIWasOverbought()){ score++; detail+="+RSI>70"; }

      // V14: CHOCH
      if(UseChoch && v14Choch==-1){ score++; detail+="+CHOCH"; }
   }

   // Pokud se nezměnil směr → odpočítej platnost
   if(newDir!=0)
   {
      // V14: D1 bias check — blokuj contra D1
      if(!D1BiasOK(newDir))
        { contextDir=0; contextBarsLeft=0; setupScore=0; scoreDetail=""; return; }

      contextDir=newDir;
      contextBarsLeft=Context_ValidBars;   // V25: bylo natvrdo 36
      setupScore=score;
      scoreDetail=detail;
      Log(StringFormat("Context %s | score=%d | %s",newDir==1?"LONG":"SHORT",score,detail));
      // V14: Push setup alert
      PushSetupAlert(newDir, score);
   }
   else
   {
      if(contextBarsLeft>0) contextBarsLeft--;
      if(contextBarsLeft<=0){ contextDir=0; setupScore=0; scoreDetail=""; }
   }
}

//+------------------------------------------------------------------+
// M5 FVG DETEKCE
//+------------------------------------------------------------------+
bool BullishImpulseM5()
{ double o=iOpen(_Symbol,PERIOD_M5,1),c=iClose(_Symbol,PERIOD_M5,1); return(c>o&&(c-o)/pipSize>=MinImpulseBody_Pts); }
bool BearishImpulseM5()
{ double o=iOpen(_Symbol,PERIOD_M5,1),c=iClose(_Symbol,PERIOD_M5,1); return(c<o&&(o-c)/pipSize>=MinImpulseBody_Pts); }

bool DetectBullFVG(double &lo,double &hi)
{
   double l1=iLow(_Symbol,PERIOD_M5,1),h3=iHigh(_Symbol,PERIOD_M5,3);
   double gap=(l1-h3)/pipSize;
   if(gap>=MinFVG_Pts&&BullishImpulseM5()){ lo=h3;hi=l1; return true; }
   return false;
}

bool DetectBearFVG(double &lo,double &hi)
{
   double h1=iHigh(_Symbol,PERIOD_M5,1),l3=iLow(_Symbol,PERIOD_M5,3);
   double gap=(l3-h1)/pipSize;
   if(gap>=MinFVG_Pts&&BearishImpulseM5()){ lo=h1;hi=l3; return true; }
   return false;
}

void UpdateFVG()
{
   if(contextDir==0) return;
   double lo,hi;

   if(contextDir==1&&DetectBullFVG(lo,hi))
   {
      // V25: FVG musí ležet u M15 demand zóny (proti vstupům daleko od zóny / do chopu)
      bool nearZone = !UseFVGNearZone ||
                      PriceNearZone((lo+hi)*0.5,m15DemandLow,m15DemandHigh,M15ZoneTol_Pts);
      if(nearZone)
      {
         activeFvgLow=lo;activeFvgHigh=hi;activeFvgDir=1;activeFvgBarsLeft=FVGValidBars;
         setupScore=MathMin(setupScore+1,5);   // +1 za čistou reakci + FVG
         scoreDetail+="+FVG";
         Log(StringFormat("Bull FVG %.0f-%.0f | score=%d",lo,hi,setupScore));
      }
      else
         Log(StringFormat("Bull FVG %.0f-%.0f IGNOR (daleko od M15 demand)",lo,hi));
   }
   if(contextDir==-1&&DetectBearFVG(lo,hi))
   {
      bool nearZone = !UseFVGNearZone ||
                      PriceNearZone((lo+hi)*0.5,m15SupplyLow,m15SupplyHigh,M15ZoneTol_Pts);
      if(nearZone)
      {
         activeFvgLow=lo;activeFvgHigh=hi;activeFvgDir=-1;activeFvgBarsLeft=FVGValidBars;
         setupScore=MathMin(setupScore+1,5);
         scoreDetail+="+FVG";
         Log(StringFormat("Bear FVG %.0f-%.0f | score=%d",lo,hi,setupScore));
      }
      else
         Log(StringFormat("Bear FVG %.0f-%.0f IGNOR (daleko od M15 supply)",lo,hi));
   }

   if(activeFvgBarsLeft>0) activeFvgBarsLeft--;
   if(activeFvgBarsLeft<=0&&activeFvgDir!=0)
   { Log("FVG expiroval"); activeFvgDir=0;activeFvgLow=0;activeFvgHigh=0; }
}

//+------------------------------------------------------------------+
// RISK PODLE SCORE
//+------------------------------------------------------------------+
double GetRiskPct()
{
   if(setupScore>=4) return Risk_Score45;
   if(setupScore==3) return Risk_Score3;
   return Risk_Score2;   // score 1-2
}

//+------------------------------------------------------------------+
// SL — hierarchie: M15 zóna → swing high/low → fallback MinSL
//+------------------------------------------------------------------+
double BuildLongSL(double entry)
{
   double minDist=MinSL_Pts*pipSize;
   double maxDist=MaxSL_Pts*pipSize;

   // 1. Pod M15 demand zónou
   if(m15DemandLow>0)
   { double sl=m15DemandLow-SL_Buffer_Pts*pipSize;
     double d=entry-sl;
     if(d>=minDist&&d<=maxDist){ panelSLSrc=StringFormat("M15 Demand (%.0f)",sl); return sl; } }

   // 2. Pod H4 demand zónou (pokud je blíže/lepší)
   if(h4DemandLow>0)
   { double sl=h4DemandLow-SL_Buffer_Pts*pipSize;
     double d=entry-sl;
     if(d>=minDist&&d<=maxDist){ panelSLSrc=StringFormat("H4 Demand (%.0f)",sl); return sl; } }

   // 3. Fallback — MinSL od entry
   panelSLSrc=StringFormat("Fallback (%.0f bodů)",MinSL_Pts);
   return entry-minDist;
}

double BuildShortSL(double entry)
{
   double minDist=MinSL_Pts*pipSize;
   double maxDist=MaxSL_Pts*pipSize;

   // 1. Nad M15 supply zónou
   if(m15SupplyHigh>0)
   { double sl=m15SupplyHigh+SL_Buffer_Pts*pipSize;
     double d=sl-entry;
     if(d>=minDist&&d<=maxDist){ panelSLSrc=StringFormat("M15 Supply (%.0f)",sl); return sl; } }

   // 2. Nad H4 supply zónou
   if(h4SupplyHigh>0)
   { double sl=h4SupplyHigh+SL_Buffer_Pts*pipSize;
     double d=sl-entry;
     if(d>=minDist&&d<=maxDist){ panelSLSrc=StringFormat("H4 Supply (%.0f)",sl); return sl; } }

   // 3. Fallback
   panelSLSrc=StringFormat("Fallback (%.0f bodů)",MinSL_Pts);
   return entry+minDist;
}

//+------------------------------------------------------------------+
// TP — nejbližší opačná zóna / FVG / fallback RR
//+------------------------------------------------------------------+
double BuildLongTP(double entry,double risk)
{
   double best=0;

   // Nejbližší supply nad entry
   if(m15SupplyLow>entry){ double t=m15SupplyLow-TP_PreZone_Pts*pipSize; if(t>entry&&(best==0||t<best)) best=t; }
   if(h4SupplyLow >entry){ double t=h4SupplyLow -TP_PreZone_Pts*pipSize; if(t>entry&&(best==0||t<best)) best=t; }

   // V25: zónová TP musí mít aspoň MinZoneTP_RR (jinak je 1:1 cíl sotva nad nulou)
   if(best>entry&&(best-entry)>=risk*MinZoneTP_RR) return best;

   return entry+risk*FallbackTP_RR;
}

double BuildShortTP(double entry,double risk)
{
   double best=0;

   if(m15DemandHigh>0&&m15DemandHigh<entry){ double t=m15DemandHigh+TP_PreZone_Pts*pipSize; if(t<entry&&(best==0||t>best)) best=t; }
   if(h4DemandHigh >0&&h4DemandHigh <entry){ double t=h4DemandHigh +TP_PreZone_Pts*pipSize; if(t<entry&&(best==0||t>best)) best=t; }

   // V25: zónová TP musí mít aspoň MinZoneTP_RR
   if(best>0&&best<entry&&(entry-best)>=risk*MinZoneTP_RR) return best;

   return entry-risk*FallbackTP_RR;
}

//+------------------------------------------------------------------+
// OVĚŘ SL PO OTEVŘENÍ — záchranná síť
//+------------------------------------------------------------------+
void VerifyAndFixSL()
{
   for(int i=PositionsTotal()-1;i>=0;i--)
   { ulong t=PositionGetTicket(i); if(!PositionSelectByTicket(t)) continue;
     if(PositionGetString(POSITION_SYMBOL)!=_Symbol||PositionGetInteger(POSITION_MAGIC)!=MagicNumber) continue;
     if(PositionGetDouble(POSITION_SL)!=0.0) continue;
     double open=PositionGetDouble(POSITION_PRICE_OPEN),tp=PositionGetDouble(POSITION_TP);
     long type=PositionGetInteger(POSITION_TYPE);
     double newSL=(type==POSITION_TYPE_BUY)?open-MinSL_Pts*pipSize:open+MinSL_Pts*pipSize;
     PrintFormat("[V25] NOUZOVÝ SL: #%I64u → %.2f",t,newSL);
     trade.PositionModify(t,newSL,tp); }
}

//+------------------------------------------------------------------+
// PLACE ENTRY
//+------------------------------------------------------------------+
void PlaceEntry()
{
   if(activeFvgDir==0){ panelInfo="Čekám na FVG"; return; }
   if(contextDir==0)  { panelInfo="Žádný kontext"; return; }
   if(activeFvgDir!=contextDir){ panelInfo="FVG vs kontext neshoda"; return; }
   if(setupScore<2)   { panelInfo=StringFormat("Score příliš nízký (%d)",setupScore); return; }
   if(MaxOnePosition&&HasOpenPosition()){ panelInfo="Pozice existuje"; return; }

   // V25: spread guard — neotvírej tržní vstup při širokém spreadu
   if(UseSpreadGuard)
   {
      double spreadPts=CurrentSpreadPts();
      if(spreadPts>MaxSpread_Pts){ panelInfo=StringFormat("BLOK: spread %.1f > %.1f",spreadPts,MaxSpread_Pts); return; }
   }

   double bid=SymbolInfoDouble(_Symbol,SYMBOL_BID);
   double ask=SymbolInfoDouble(_Symbol,SYMBOL_ASK);
   double riskPct=GetRiskPct();

   // Cena musí být v FVG (nebo těsně u něj)
   double tol=3.0*pipSize;

   // ---- LONG ----
   if(activeFvgDir==1)
   {
      bool priceInFVG=(bid>=activeFvgLow-tol&&bid<=activeFvgHigh+tol);
      if(!priceInFVG)
      {
         panelInfo=StringFormat("Čekám na retrace do FVG (%.0f-%.0f)",activeFvgLow,activeFvgHigh);

         double distToFVG=0.0;
         if(bid>activeFvgHigh) distToFVG=(bid-activeFvgHigh)/pipSize;
         else if(bid<activeFvgLow) distToFVG=(activeFvgLow-bid)/pipSize;

         if(distToFVG<=PushNearEntry_Pts)
            PushNearEntryAlert(1,activeFvgLow,activeFvgHigh,bid);

         return;
      }

      double entry=ask;
      double sl=BuildLongSL(entry);

      // Validace SL
      if(sl<=0||sl>=entry||entry-sl<MinSL_Pts*pipSize*0.5)
      { panelInfo=StringFormat("BLOK: SL neplatný %.2f",sl); return; }

      double risk=entry-sl;
      double tp=BuildLongTP(entry,risk);
      double lots=CalcLots(entry,sl,riskPct);
      if(lots<=0){ panelInfo="BLOK: Lot=0"; return; }

      PrintFormat("[V25] BUY | entry=%.2f SL=%.2f TP=%.2f lots=%.2f risk=%.1fb score=%d riskPct=%.2f%%",
                  entry,sl,tp,lots,risk/pipSize,setupScore,riskPct);

      if(trade.Buy(lots,_Symbol,0,sl,tp,"V25 LONG FVG"))
      { ulong t=trade.ResultOrder(); if(t>0) GlobalVariableSet(RiskKey(t),risk);
        panelInfo=StringFormat("BUY otevren | score=%d | risk=%.2f%%",setupScore,riskPct);
        PushEntryAlert(1,entry,sl,tp,lots,setupScore);
        activeFvgDir=0;activeFvgLow=0;activeFvgHigh=0;activeFvgBarsLeft=0; }
      else
         panelInfo=StringFormat("Buy selhal: %d %s",trade.ResultRetcode(),trade.ResultRetcodeDescription());
   }

   // ---- SHORT ----
   if(activeFvgDir==-1)
   {
      bool priceInFVG=(ask>=activeFvgLow-tol&&ask<=activeFvgHigh+tol);
      if(!priceInFVG)
      {
         panelInfo=StringFormat("Čekám na retrace do FVG (%.0f-%.0f)",activeFvgLow,activeFvgHigh);

         double distToFVG=0.0;
         if(ask>activeFvgHigh) distToFVG=(ask-activeFvgHigh)/pipSize;
         else if(ask<activeFvgLow) distToFVG=(activeFvgLow-ask)/pipSize;

         if(distToFVG<=PushNearEntry_Pts)
            PushNearEntryAlert(-1,activeFvgLow,activeFvgHigh,ask);

         return;
      }

      double entry=bid;
      double sl=BuildShortSL(entry);

      if(sl<=0||sl<=entry||sl-entry<MinSL_Pts*pipSize*0.5)
      { panelInfo=StringFormat("BLOK: SL neplatný %.2f",sl); return; }

      double risk=sl-entry;
      double tp=BuildShortTP(entry,risk);
      double lots=CalcLots(entry,sl,riskPct);
      if(lots<=0){ panelInfo="BLOK: Lot=0"; return; }

      PrintFormat("[V25] SELL | entry=%.2f SL=%.2f TP=%.2f lots=%.2f risk=%.1fb score=%d riskPct=%.2f%%",
                  entry,sl,tp,lots,risk/pipSize,setupScore,riskPct);

      if(trade.Sell(lots,_Symbol,0,sl,tp,"V25 SHORT FVG"))
      { ulong t=trade.ResultOrder(); if(t>0) GlobalVariableSet(RiskKey(t),risk);
        panelInfo=StringFormat("SELL otevren | score=%d | risk=%.2f%%",setupScore,riskPct);
        PushEntryAlert(-1,entry,sl,tp,lots,setupScore);
        activeFvgDir=0;activeFvgLow=0;activeFvgHigh=0;activeFvgBarsLeft=0; }
      else
         panelInfo=StringFormat("Sell selhal: %d %s",trade.ResultRetcode(),trade.ResultRetcodeDescription());
   }
}

//+------------------------------------------------------------------+
// MANAGEMENT
//+------------------------------------------------------------------+
void StoreRisk()
{
   for(int i=PositionsTotal()-1;i>=0;i--)
   { ulong t=PositionGetTicket(i); if(!PositionSelectByTicket(t)) continue;
     if(PositionGetString(POSITION_SYMBOL)!=_Symbol||PositionGetInteger(POSITION_MAGIC)!=MagicNumber) continue;
     if(GlobalVariableCheck(RiskKey(t))) continue;
     double risk=MathAbs(PositionGetDouble(POSITION_PRICE_OPEN)-PositionGetDouble(POSITION_SL));
     if(risk>0) GlobalVariableSet(RiskKey(t),risk); }
}

bool StrongBearish(){ double o=iOpen(_Symbol,PERIOD_M5,1),c=iClose(_Symbol,PERIOD_M5,1); return(c<o&&(o-c)/pipSize>=OppImpulse_MinPts); }
bool StrongBullish(){ double o=iOpen(_Symbol,PERIOD_M5,1),c=iClose(_Symbol,PERIOD_M5,1); return(c>o&&(c-o)/pipSize>=OppImpulse_MinPts); }
double OppLow() { double l=iLow(_Symbol,PERIOD_M5,2); for(int i=2;i<=OppStructureLookback;i++) l=MathMin(l,iLow(_Symbol,PERIOD_M5,i));  return l; }
double OppHigh(){ double h=iHigh(_Symbol,PERIOD_M5,2); for(int i=2;i<=OppStructureLookback;i++) h=MathMax(h,iHigh(_Symbol,PERIOD_M5,i)); return h; }

void ManagePositions()
{
   StoreRisk();
   double bid=SymbolInfoDouble(_Symbol,SYMBOL_BID),ask=SymbolInfoDouble(_Symbol,SYMBOL_ASK);
   for(int i=PositionsTotal()-1;i>=0;i--)
   { ulong t=PositionGetTicket(i); if(!PositionSelectByTicket(t)) continue;
     if(PositionGetString(POSITION_SYMBOL)!=_Symbol||PositionGetInteger(POSITION_MAGIC)!=MagicNumber) continue;
     if(!GlobalVariableCheck(RiskKey(t))) continue;
     double open=PositionGetDouble(POSITION_PRICE_OPEN),risk=GlobalVariableGet(RiskKey(t));
     long type=PositionGetInteger(POSITION_TYPE);
     double price=(type==POSITION_TYPE_BUY)?bid:ask;
     double pd=(type==POSITION_TYPE_BUY)?price-open:open-price;

     // V25: BREAKEVEN — po dosažení X×R posuň SL na entry (+offset)
     if(UseBreakeven && risk>0 && pd>=risk*Breakeven_At_R)
     {
        double curSL=PositionGetDouble(POSITION_SL);
        double beSL =(type==POSITION_TYPE_BUY)?open+Breakeven_Offset*pipSize
                                              :open-Breakeven_Offset*pipSize;
        bool improve=(type==POSITION_TYPE_BUY)?(curSL<beSL||curSL==0.0)
                                              :(curSL>beSL||curSL==0.0);
        if(improve)
        {
           trade.PositionModify(t,beSL,PositionGetDouble(POSITION_TP));
           Log(StringFormat("Breakeven #%I64u -> SL %.2f",t,beSL));
        }
     }

     if(pd>=risk*ProfitProtection_R)
     { if(type==POSITION_TYPE_BUY &&(StrongBearish()||iClose(_Symbol,PERIOD_M5,1)<OppLow()))  trade.PositionClose(t);
       if(type==POSITION_TYPE_SELL&&(StrongBullish()||iClose(_Symbol,PERIOD_M5,1)>OppHigh())) trade.PositionClose(t); } }
}

//+------------------------------------------------------------------+
void DrawPanel()
{
   double rsi=GetRSI();
   bool rsiOS=RSIWasOversold(), rsiOB=RSIWasOverbought();
   string ctxTxt=contextDir==1?"LONG":contextDir==-1?"SHORT":"---";
   string fvgTxt=activeFvgDir==1?"BULL":activeFvgDir==-1?"BEAR":"---";

   // SL check
   string slCheck="OK";
   for(int i=PositionsTotal()-1;i>=0;i--)
   { ulong t=PositionGetTicket(i); if(!PositionSelectByTicket(t)) continue;
     if(PositionGetString(POSITION_SYMBOL)==_Symbol&&PositionGetInteger(POSITION_MAGIC)==MagicNumber)
     if(PositionGetDouble(POSITION_SL)==0) slCheck="!!! SL CHYBÍ !!!"; }

   string chochTxt = v14Choch==1?"BULL":v14Choch==-1?"BEAR":"---";
   string d1Txt    = v14TrendD1==1?"UP":v14TrendD1==-1?"DOWN":"CHOP";
   Comment(StringFormat(
      "=== ZoneBot V25 | US100 ===\n"
      "H4 Struktura: %s | D1: %s | CHOCH: %s\n"
      "H4 Demand: %.0f-%.0f | H4 Supply: %.0f-%.0f\n"
      "M15 Demand: %.0f-%.0f | M15 Supply: %.0f-%.0f\n"
      "RSI M15: %.1f | Byl OS: %s | OB: %s\n"
      "Context: %s | Bars: %d | Score: %d/5\n"
      "Score detail: %s\n"
      "Risk %%: %.2f%% | Spread: %.1f\n"
      "FVG: %s | %.0f-%.0f | Bars: %d\n"
      "SL source: %s\n"
      "SL check: %s\n"
      "Info: %s\n"
      "Trading: %s | Position: %s",
      h4StructText, d1Txt, chochTxt,
      h4DemandLow,h4DemandHigh,h4SupplyLow,h4SupplyHigh,
      m15DemandLow,m15DemandHigh,m15SupplyLow,m15SupplyHigh,
      rsi,rsiOS?"ANO":"NE",rsiOB?"ANO":"NE",
      ctxTxt,contextBarsLeft,setupScore,
      scoreDetail!=""?scoreDetail:"---",
      GetRiskPct(),CurrentSpreadPts(),
      fvgTxt,activeFvgLow,activeFvgHigh,activeFvgBarsLeft,
      panelSLSrc,slCheck,panelInfo,
      IsTradingTime()?"ANO":"NE",
      HasOpenPosition()?"ANO":"NE"
   ));
}

//+------------------------------------------------------------------+

//+------------------------------------------------------------------+
// V14: D1 TREND (HH+HL = UP, LH+LL = DOWN, jinak CHOP)
// Používá close hodnoty stejně jako H4 struktura
//+------------------------------------------------------------------+
int CalcD1Trend()
  {
   int look = 60;
   int bars = iBars(_Symbol, PERIOD_D1);
   if(bars < look) return 0;

   double h1=0,h2=0,l1=0,l2=0;
   int hc=0,lc=0;

   for(int i=2; i<look && (hc<2||lc<2); i++)
     {
      double c  = iClose(_Symbol,PERIOD_D1,i);
      bool isH=true, isL=true;
      for(int k=1;k<=2;k++)
        {
         if(i-k<1||i+k>=bars) {isH=false;isL=false;break;}
         if(iClose(_Symbol,PERIOD_D1,i-k)>=c) isH=false;
         if(iClose(_Symbol,PERIOD_D1,i+k)>=c) isH=false;
         if(iClose(_Symbol,PERIOD_D1,i-k)<=c) isL=false;
         if(iClose(_Symbol,PERIOD_D1,i+k)<=c) isL=false;
        }
      if(isH && hc<2) { if(hc==0) h1=c; else h2=c; hc++; }
      if(isL && lc<2) { if(lc==0) l1=c; else l2=c; lc++; }
     }

   if(hc<2||lc<2) return 0;
   if(h1>h2 && l1>l2) return  1;
   if(h1<h2 && l1<l2) return -1;
   return 0;
  }

//+------------------------------------------------------------------+
// V14: CHOCH DETEKCE na M15
// Uptrend H4:   close pod poslednim swing low (HL)  = bearish CHOCH
// Downtrend H4: close nad poslednim swing high (LH) = bullish CHOCH
// Drzi se dokud H4 trend nezmeni
//+------------------------------------------------------------------+
void UpdateChoch()
  {
   // Reset pokud H4 trend zmenil
   if(h4Structure != v14PrevH4)
     {
      v14Choch      = 0;
      v14ChochLevel = 0;
      v14PrevH4     = h4Structure;
      Log("H4 trend zmena -> CHOCH reset");
      return;
     }

   if(v14Choch != 0) return;  // Drz dokud H4 nezmeni
   if(h4Structure == 0) return;

   int bars = iBars(_Symbol,PERIOD_M15);
   if(bars < ChochSwingN*2+5) return;

   double closeM15 = iClose(_Symbol,PERIOD_M15,1);
   int look = MathMin(60, bars-ChochSwingN-1);

   if(h4Structure == 1)  // H4 UP -> hledame close pod HL
     {
      for(int i=ChochSwingN+1; i<look; i++)
        {
         double c=iClose(_Symbol,PERIOD_M15,i);
         bool swL=true;
         for(int k=1;k<=ChochSwingN;k++)
           {
            if(iClose(_Symbol,PERIOD_M15,i-k)<=c){swL=false;break;}
            if(iClose(_Symbol,PERIOD_M15,i+k)<=c){swL=false;break;}
           }
         if(swL)
           {
            v14ChochLevel=c;
            if(closeM15 < c)
              {
               v14Choch=-1;
               Log(StringFormat("CHOCH BEARISH | close=%.2f < HL=%.2f",closeM15,c));
              }
            break;
           }
        }
     }
   else if(h4Structure == -1)  // H4 DOWN -> hledame close nad LH
     {
      for(int i=ChochSwingN+1; i<look; i++)
        {
         double c=iClose(_Symbol,PERIOD_M15,i);
         bool swH=true;
         for(int k=1;k<=ChochSwingN;k++)
           {
            if(iClose(_Symbol,PERIOD_M15,i-k)>=c){swH=false;break;}
            if(iClose(_Symbol,PERIOD_M15,i+k)>=c){swH=false;break;}
           }
         if(swH)
           {
            v14ChochLevel=c;
            if(closeM15 > c)
              {
               v14Choch=1;
               Log(StringFormat("CHOCH BULLISH | close=%.2f > LH=%.2f",closeM15,c));
              }
            break;
           }
        }
     }
  }

//+------------------------------------------------------------------+
// V14: D1 BIAS CHECK
// Blokuje obchod ktery jde proti D1 trendu
// D1 CHOP = neblokuje (jen cisti contra blokuje)
//+------------------------------------------------------------------+
bool D1BiasOK(int direction)
  {
   if(!UseD1Bias) return true;
   if(v14TrendD1 == 0) return true;  // D1 CHOP -> OK
   if(direction ==  1 && v14TrendD1 == -1)
     { Log("D1 BIAS BLOCK: D1 DOWN vs LONG"); return false; }
   if(direction == -1 && v14TrendD1 ==  1)
     { Log("D1 BIAS BLOCK: D1 UP vs SHORT"); return false; }
   return true;
  }

//+------------------------------------------------------------------+
// V24: PUSH NOTIFIKACE — 3 KROKY
// 1/3 SETUP: mozny vstup + preview Entry/SL/TP
// 2/3 ENTRY BLIZKO: cena se blizi do FVG zony
// 3/3 ENTRY: obchod otevren
//+------------------------------------------------------------------+
string DirText(int dir)
  {
   return (dir==1) ? "LONG" : "SHORT";
  }

string D1Text()
  {
   return (v14TrendD1==1) ? "UP" : (v14TrendD1==-1) ? "DOWN" : "CHOP";
  }

string H4Text()
  {
   return (h4Structure==1) ? "UP" : (h4Structure==-1) ? "DOWN" : "CHOP";
  }

string ChochText()
  {
   if(v14Choch==1)  return " | CHOCH:BULL";
   if(v14Choch==-1) return " | CHOCH:BEAR";
   return "";
  }

bool BuildPreviewPlan(int dir,double &entry,double &sl,double &tp,double &riskPts,double &rr)
  {
   double bid=SymbolInfoDouble(_Symbol,SYMBOL_BID);
   double ask=SymbolInfoDouble(_Symbol,SYMBOL_ASK);

   if(dir==1)
     {
      entry=ask;
      sl=BuildLongSL(entry);
      if(sl<=0||sl>=entry) return false;

      double risk=entry-sl;
      if(risk<=0) return false;

      tp=BuildLongTP(entry,risk);
      riskPts=risk/pipSize;
      rr=(tp-entry)/risk;
      return true;
     }

   if(dir==-1)
     {
      entry=bid;
      sl=BuildShortSL(entry);
      if(sl<=0||sl<=entry) return false;

      double risk=sl-entry;
      if(risk<=0) return false;

      tp=BuildShortTP(entry,risk);
      riskPts=risk/pipSize;
      rr=(entry-tp)/risk;
      return true;
     }

   return false;
  }

void PushSetupAlert(int dir, int score)
  {
   if(!PushOnSetup) return;

   // Posli jen kdyz se smer zmenil nebo je to nova relace.
   if(dir==v14LastContextDir && TimeCurrent()-v14LastPushSetup < 3600) return;

   v14LastContextDir  = dir;
   v14LastPushSetup   = TimeCurrent();

   double entry=0,sl=0,tp=0,riskPts=0,rr=0;
   bool planOK=BuildPreviewPlan(dir,entry,sl,tp,riskPts,rr);

   string msg = "[1/3 SETUP] " + _Symbol + " | " + DirText(dir) +
                " | Score:" + IntegerToString(score) +
                " | H4:" + H4Text() +
                " | D1:" + D1Text() + ChochText();

   if(planOK)
     {
      msg +=
         "\nPlan preview:" +
         "\nEntry: " + DoubleToString(entry,_Digits) +
         "\nSL: "    + DoubleToString(sl,_Digits) +
         "\nTP: "    + DoubleToString(tp,_Digits) +
         "\nRisk: "  + DoubleToString(riskPts,1) + " bodu" +
         "\nRR: "    + DoubleToString(rr,2);
     }
   else
     {
      msg += "\nPlan preview: nelze spocitat SL/TP";
     }

   msg += "\nStav: cekam na FVG";

   SendNotification(msg);
   if(DebugLog) Print("PUSH 1/3 SETUP: ",msg);
  }

void PushNearEntryAlert(int dir,double fvgLow,double fvgHigh,double currentPrice)
  {
   if(!PushOnNearEntry) return;

   string key = _Symbol + "_" + IntegerToString(dir) + "_" +
                DoubleToString(fvgLow,_Digits) + "_" + DoubleToString(fvgHigh,_Digits);

   // anti-spam: stejnou FVG zonu neposilej porad dokola
   if(key==v24LastNearKey && TimeCurrent()-v24LastPushNearEntry < 1800) return;

   double entry=0,sl=0,tp=0,riskPts=0,rr=0;
   bool planOK=BuildPreviewPlan(dir,entry,sl,tp,riskPts,rr);

   string msg = "[2/3 ENTRY BLIZKO] " + _Symbol + " | " + DirText(dir) +
                "\nCena je blizko FVG entry zony" +
                "\nFVG zona: " + DoubleToString(fvgLow,_Digits) + " - " + DoubleToString(fvgHigh,_Digits) +
                "\nAktualni cena: " + DoubleToString(currentPrice,_Digits);

   if(planOK)
     {
      msg +=
         "\nPlan:" +
         "\nEntry preview: " + DoubleToString(entry,_Digits) +
         "\nSL: " + DoubleToString(sl,_Digits) +
         "\nTP: " + DoubleToString(tp,_Digits) +
         "\nRisk: " + DoubleToString(riskPts,1) + " bodu" +
         "\nRR: " + DoubleToString(rr,2);
     }

   msg += "\nStav: priprav se";

   v24LastNearKey = key;
   v24LastPushNearEntry = TimeCurrent();

   SendNotification(msg);
   if(DebugLog) Print("PUSH 2/3 ENTRY BLIZKO: ",msg);
  }

void PushEntryAlert(int dir, double entry, double sl, double tp, double lots, int score)
  {
   if(!PushOnEntry) return;

   double riskPts=0,rr=0;
   if(dir==1)
     {
      riskPts=(entry-sl)/pipSize;
      if(entry>sl) rr=(tp-entry)/(entry-sl);
     }
   else
     {
      riskPts=(sl-entry)/pipSize;
      if(sl>entry) rr=(entry-tp)/(sl-entry);
     }

   string msg = "[3/3 ENTRY] " + _Symbol + " | " + DirText(dir) +
                "\nEntry: " + DoubleToString(entry,_Digits) +
                "\nSL: "    + DoubleToString(sl,_Digits) +
                "\nTP: "    + DoubleToString(tp,_Digits) +
                "\nRisk: "  + DoubleToString(riskPts,1) + " bodu" +
                "\nRR: "    + DoubleToString(rr,2) +
                "\nLot: "   + DoubleToString(lots,2) +
                "\nScore: " + IntegerToString(score) +
                "\nH4:"     + H4Text() +
                " | D1:"    + D1Text() + ChochText();

   SendNotification(msg);
   if(DebugLog) Print("PUSH 3/3 ENTRY: ",msg);
  }


void CheckRSIAlerts()
{
   if(!PushOnRSIAlerts) return;

   datetime currentBar = iTime(_Symbol, PERIOD_M15, 0);

   double rsiBuff[];
   ArraySetAsSeries(rsiBuff,true);

   if(CopyBuffer(rsiHandle,0,0,2,rsiBuff) < 2)
      return;

   double rsi = rsiBuff[0];

   if(rsi >= RSI_Alert_High)
   {
      if(v24LastRSIAlertBar != currentBar || v24LastRSIState != 1)
      {
         string msg = "[RSI ALERT] " + _Symbol +
                      "\nRSI na hodnote 70" +
                      "\nRSI: " + DoubleToString(rsi,1);

         SendNotification(msg);

         if(DebugLog)
            Print("RSI ALERT HIGH: ",msg);

         v24LastRSIAlertBar = currentBar;
         v24LastRSIState = 1;
      }
   }
   else if(rsi <= RSI_Alert_Low)
   {
      if(v24LastRSIAlertBar != currentBar || v24LastRSIState != -1)
      {
         string msg = "[RSI ALERT] " + _Symbol +
                      "\nRSI na hodnote 30" +
                      "\nRSI: " + DoubleToString(rsi,1);

         SendNotification(msg);

         if(DebugLog)
            Print("RSI ALERT LOW: ",msg);

         v24LastRSIAlertBar = currentBar;
         v24LastRSIState = -1;
      }
   }
   else
   {
      v24LastRSIState = 0;
   }
}

void OnTick()
{
   // Záchranná síť SL — každý tick
   VerifyAndFixSL();

   bool newM15=IsNewM15Bar();
   bool newM5 =IsNewM5Bar();

   if(newM15)
   {
      AnalyzeH4Structure();
      v14TrendD1 = CalcD1Trend();   // V14: D1 bias
      UpdateChoch();                 // V14: CHOCH
      UpdateAllZones();
      EvaluateContext();

      // RSI alerts
      CheckRSIAlerts();
   }

   if(newM5)
      UpdateFVG();

   ManagePositions();

   if(IsTradingTime()) PlaceEntry();
   if(ShowPanel) DrawPanel();
}
//+------------------------------------------------------------------+
