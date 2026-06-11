//+------------------------------------------------------------------+
//|                                                      ORB930.mq5   |
//|              Opening Range Breakout for US100 / NAS100 (M5/M15)   |
//|                                                                  |
//|  Strategy: ORB-930                                               |
//|  - Defines an Opening Range (OR) for the first X minutes after   |
//|    the US cash open and trades the first clean breakout.         |
//|  - Designed to be SIMPLE and TESTABLE: a minimal core plus a few |
//|    OPTIONAL filters (default OFF) so they can be validated       |
//|    incrementally in the Strategy Tester instead of all at once.  |
//|                                                                  |
//|  Hard constraints honoured:                                      |
//|   * Max 1 trade per day                                          |
//|   * Risk 0.5% per trade (configurable)                           |
//|   * No martingale / no grid / no averaging losers                |
//|   * Chop protection via ATR buffer + OR-range band               |
//+------------------------------------------------------------------+
#property copyright "Fx-Analyzer"
#property version   "1.00"
#property strict

#include <Trade/Trade.mqh>

//==================================================================
// INPUTS
//==================================================================

//--- General / risk ------------------------------------------------
input double   InpRiskPercent      = 0.5;        // Risk per trade (% of balance)
input long     InpMagic            = 930930;     // Magic number
input int      InpSlippage         = 20;         // Max slippage (points)

//--- Session timing (in BROKER SERVER time, 24h) -------------------
// NOTE: Set these so that OR start matches 15:30 CET on your broker.
// Many brokers run EET (UTC+2/+3). If server = CET, leave defaults.
input int      InpORStartHour      = 15;         // OR window start hour (server)
input int      InpORStartMinute    = 30;         // OR window start minute (server)
input int      InpORDurationMin    = 15;         // OR length in minutes (15 / 30)
input int      InpEntryCutoffHour  = 18;         // No new entries after this hour
input int      InpEntryCutoffMin   = 0;          // No new entries after this minute
input int      InpForceCloseHour   = 21;         // Force-close all positions (server)
input int      InpForceCloseMin    = 0;          // Force-close minute

//--- Core breakout parameters -------------------------------------
input int      InpATRPeriod        = 14;         // ATR period (M5)
input double   InpBufferATR        = 0.10;       // Breakout buffer = x * ATR
input double   InpORrangeMinATR     = 0.5;       // Min OR range as x * ATR (chop filter)
input double   InpORrangeMaxATR     = 2.5;       // Max OR range as x * ATR (over-extended filter)

//--- Stop loss / take profit --------------------------------------
input double   InpSLcapATR         = 1.5;        // Cap SL distance at x * ATR (0 = no cap)
input double   InpTP_R             = 2.0;        // Take profit in R multiples
input bool     InpUsePartialTP     = true;       // Take 50% off at 1R + move SL to BE
input double   InpPartialTP_R      = 1.0;        // Partial TP level in R

//--- OPTIONAL filters (default OFF - validate one at a time) ------
input bool     InpUseEMAfilter     = false;      // Require price on correct side of EMA
input int      InpEMAperiod        = 50;         // EMA period (M5)
input bool     InpUseTimeStop      = false;      // Exit if no progress after N bars
input int      InpTimeStopBars     = 12;         // Bars before time-stop (M5: 12 = 60min)

//--- News filter (deterministic, testable) ------------------------
// Comma-separated server-time windows to BLOCK, format: HH:MM-HH:MM
// Example: "14:28-14:33,15:58-16:03"  (empty = disabled)
input string   InpNewsBlocks       = "";         // Daily news block windows (server time)

//==================================================================
// GLOBALS
//==================================================================
CTrade   trade;

int      atrHandle = INVALID_HANDLE;
int      emaHandle = INVALID_HANDLE;

datetime g_currentDay     = 0;       // day of last reset
double   g_orHigh         = 0.0;
double   g_orLow          = 0.0;
bool     g_orLocked       = false;   // OR window finished
bool     g_orValid        = false;   // OR passed chop/range filter
bool     g_tradedToday    = false;   // 1-trade-per-day lock
datetime g_entryBarTime   = 0;       // bar time when we entered (for time-stop)
bool     g_beMoved        = false;   // break-even already moved

datetime g_lastBarTime    = 0;

//==================================================================
// INIT
//==================================================================
int OnInit()
{
   trade.SetExpertMagicNumber(InpMagic);
   trade.SetDeviationInPoints(InpSlippage);
   trade.SetTypeFillingBySymbol(_Symbol);

   atrHandle = iATR(_Symbol, PERIOD_CURRENT, InpATRPeriod);
   if(atrHandle == INVALID_HANDLE)
   {
      Print("Failed to create ATR handle");
      return(INIT_FAILED);
   }

   if(InpUseEMAfilter)
   {
      emaHandle = iMA(_Symbol, PERIOD_CURRENT, InpEMAperiod, 0, MODE_EMA, PRICE_CLOSE);
      if(emaHandle == INVALID_HANDLE)
      {
         Print("Failed to create EMA handle");
         return(INIT_FAILED);
      }
   }

   Print("ORB930 initialised. Risk=", InpRiskPercent, "%  OR=", InpORDurationMin, "min");
   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason)
{
   if(atrHandle != INVALID_HANDLE) IndicatorRelease(atrHandle);
   if(emaHandle != INVALID_HANDLE) IndicatorRelease(emaHandle);
}

//==================================================================
// MAIN TICK
//==================================================================
void OnTick()
{
   // --- run logic only on a new bar of the current timeframe -------
   datetime curBarTime = iTime(_Symbol, PERIOD_CURRENT, 0);
   bool newBar = (curBarTime != g_lastBarTime);
   if(newBar) g_lastBarTime = curBarTime;

   // --- manage open position on every tick (BE / time-stop) --------
   ManageOpenPosition();

   // --- force close at end of session ------------------------------
   if(TimeReachedOrPast(InpForceCloseHour, InpForceCloseMin))
   {
      CloseAllOurPositions("session end");
      return;
   }

   if(!newBar)
      return;

   // --- daily reset ------------------------------------------------
   HandleDailyReset();

   // --- build / lock the opening range -----------------------------
   UpdateOpeningRange();

   // --- entry logic ------------------------------------------------
   if(g_orLocked && g_orValid && !g_tradedToday && !HasOpenPosition())
      TryEnter();
}

//==================================================================
// DAILY RESET
//==================================================================
void HandleDailyReset()
{
   datetime now = TimeCurrent();
   MqlDateTime mt;
   TimeToStruct(now, mt);
   datetime dayStart = now - (mt.hour*3600 + mt.min*60 + mt.sec);

   if(dayStart != g_currentDay)
   {
      g_currentDay    = dayStart;
      g_orHigh        = 0.0;
      g_orLow         = 0.0;
      g_orLocked      = false;
      g_orValid       = false;
      g_tradedToday   = false;
      g_entryBarTime  = 0;
      g_beMoved       = false;
   }
}

//==================================================================
// OPENING RANGE CONSTRUCTION
//==================================================================
void UpdateOpeningRange()
{
   if(g_orLocked)
      return;

   int orStartSec = (InpORStartHour*60 + InpORStartMinute) * 60;
   int orEndSec   = orStartSec + InpORDurationMin*60;

   // Look at the just-closed bar (shift 1)
   datetime barTime = iTime(_Symbol, PERIOD_CURRENT, 1);
   if(barTime <= 0) return;

   int barSec = SecondsOfDay(barTime);

   // Accumulate high/low for bars whose OPEN falls within the OR window
   if(barSec >= orStartSec && barSec < orEndSec)
   {
      double h = iHigh(_Symbol, PERIOD_CURRENT, 1);
      double l = iLow(_Symbol, PERIOD_CURRENT, 1);
      if(g_orHigh == 0.0 || h > g_orHigh) g_orHigh = h;
      if(g_orLow  == 0.0 || l < g_orLow)  g_orLow  = l;
   }

   // Once we are at/after OR end, lock it and validate
   int nowSec = SecondsOfDay(iTime(_Symbol, PERIOD_CURRENT, 0));
   if(nowSec >= orEndSec && g_orHigh > 0.0 && g_orLow > 0.0)
   {
      g_orLocked = true;
      ValidateOpeningRange();
   }
}

void ValidateOpeningRange()
{
   double atr = GetATR();
   if(atr <= 0.0) { g_orValid = false; return; }

   double orRange = g_orHigh - g_orLow;
   double minR = InpORrangeMinATR * atr;
   double maxR = InpORrangeMaxATR * atr;

   g_orValid = (orRange >= minR && orRange <= maxR);

   if(!g_orValid)
      PrintFormat("OR rejected (chop/over-extended): range=%.1f pts  band=[%.1f, %.1f]",
                  orRange/_Point, minR/_Point, maxR/_Point);
}

//==================================================================
// ENTRY
//==================================================================
void TryEnter()
{
   // entry time window
   if(!TimeReachedOrPast(InpORStartHour, InpORStartMinute)) return;
   if(TimeReachedOrPast(InpEntryCutoffHour, InpEntryCutoffMin)) return;

   // news block
   if(InNewsBlock()) return;

   double atr = GetATR();
   if(atr <= 0.0) return;

   double buffer = InpBufferATR * atr;

   // evaluate on the just-closed bar
   double closePrice = iClose(_Symbol, PERIOD_CURRENT, 1);

   double emaVal = 0.0;
   bool emaOK_buy = true, emaOK_sell = true;
   if(InpUseEMAfilter)
   {
      emaVal = GetEMA();
      emaOK_buy  = (closePrice > emaVal);
      emaOK_sell = (closePrice < emaVal);
   }

   // BUY breakout: close above OR high + buffer
   if(closePrice > g_orHigh + buffer && emaOK_buy)
   {
      OpenTrade(ORDER_TYPE_BUY, atr);
      return;
   }

   // SELL breakout: close below OR low - buffer
   if(closePrice < g_orLow - buffer && emaOK_sell)
   {
      OpenTrade(ORDER_TYPE_SELL, atr);
      return;
   }
}

void OpenTrade(ENUM_ORDER_TYPE type, double atr)
{
   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double buffer = InpBufferATR * atr;

   double price, sl, tp;

   if(type == ORDER_TYPE_BUY)
   {
      price = ask;
      sl    = g_orLow - buffer;
      // cap SL distance
      if(InpSLcapATR > 0.0)
      {
         double maxDist = InpSLcapATR * atr;
         if(price - sl > maxDist) sl = price - maxDist;
      }
      double risk = price - sl;
      tp = price + InpTP_R * risk;
   }
   else
   {
      price = bid;
      sl    = g_orHigh + buffer;
      if(InpSLcapATR > 0.0)
      {
         double maxDist = InpSLcapATR * atr;
         if(sl - price > maxDist) sl = price + maxDist;
      }
      double risk = sl - price;
      tp = price - InpTP_R * risk;
   }

   double slDist = MathAbs(price - sl);
   if(slDist <= 0.0) return;

   double lots = CalcLots(slDist);
   if(lots <= 0.0) { Print("Lot size 0 - skip"); return; }

   bool ok;
   if(type == ORDER_TYPE_BUY)
      ok = trade.Buy(lots, _Symbol, price, sl, tp, "ORB930");
   else
      ok = trade.Sell(lots, _Symbol, price, sl, tp, "ORB930");

   if(ok)
   {
      g_tradedToday  = true;
      g_entryBarTime = iTime(_Symbol, PERIOD_CURRENT, 0);  // current forming bar
      g_beMoved      = false;
      PrintFormat("ENTRY %s  lots=%.2f  price=%.1f  sl=%.1f  tp=%.1f",
                  (type==ORDER_TYPE_BUY?"BUY":"SELL"), lots, price, sl, tp);
   }
   else
   {
      PrintFormat("Order failed: %d / %s", trade.ResultRetcode(), trade.ResultRetcodeDescription());
   }
}

//==================================================================
// POSITION MANAGEMENT (partial TP / break-even / time-stop)
//==================================================================
void ManageOpenPosition()
{
   if(!PositionSelect(_Symbol)) return;
   if(PositionGetInteger(POSITION_MAGIC) != InpMagic) return;

   long   type      = PositionGetInteger(POSITION_TYPE);
   double openPrice = PositionGetDouble(POSITION_PRICE_OPEN);
   double sl        = PositionGetDouble(POSITION_SL);
   double volume    = PositionGetDouble(POSITION_VOLUME);
   double bid       = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double ask       = SymbolInfoDouble(_Symbol, SYMBOL_ASK);

   double initialRisk = MathAbs(openPrice - sl);
   if(initialRisk <= 0.0) return;

   // --- Partial TP at 1R + move SL to break-even -------------------
   if(InpUsePartialTP && !g_beMoved)
   {
      bool hit = false;
      if(type == POSITION_TYPE_BUY  && bid >= openPrice + InpPartialTP_R*initialRisk) hit = true;
      if(type == POSITION_TYPE_SELL && ask <= openPrice - InpPartialTP_R*initialRisk) hit = true;

      if(hit)
      {
         double half = NormalizeVolume(volume * 0.5);
         if(half >= SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN))
            trade.PositionClosePartial(_Symbol, half);

         // move SL to break-even
         double newSL = openPrice;
         double tp    = PositionGetDouble(POSITION_TP);
         if(trade.PositionModify(_Symbol, newSL, tp))
            g_beMoved = true;
      }
   }

   // --- Time-stop (optional) ---------------------------------------
   if(InpUseTimeStop && g_entryBarTime > 0)
   {
      int barsSince = iBarShift(_Symbol, PERIOD_CURRENT, g_entryBarTime, false);
      if(barsSince >= InpTimeStopBars)
      {
         CloseAllOurPositions("time-stop");
         g_entryBarTime = 0;
      }
   }
}

//==================================================================
// HELPERS
//==================================================================
double GetATR()
{
   double buf[];
   if(CopyBuffer(atrHandle, 0, 1, 1, buf) <= 0) return 0.0;
   return buf[0];
}

double GetEMA()
{
   double buf[];
   if(emaHandle == INVALID_HANDLE) return 0.0;
   if(CopyBuffer(emaHandle, 0, 1, 1, buf) <= 0) return 0.0;
   return buf[0];
}

double CalcLots(double slDistancePrice)
{
   double balance   = AccountInfoDouble(ACCOUNT_BALANCE);
   double riskMoney = balance * InpRiskPercent / 100.0;

   double tickValue = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
   double tickSize  = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   if(tickSize <= 0.0 || tickValue <= 0.0) return 0.0;

   double valuePerPricePerLot = tickValue / tickSize;     // money per 1.0 price move per lot
   double riskPerLot          = slDistancePrice * valuePerPricePerLot;
   if(riskPerLot <= 0.0) return 0.0;

   double lots = riskMoney / riskPerLot;
   return NormalizeVolume(lots);
}

double NormalizeVolume(double lots)
{
   double minLot  = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double maxLot  = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);
   double lotStep = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);

   if(lotStep <= 0.0) lotStep = 0.01;
   lots = MathFloor(lots / lotStep) * lotStep;
   if(lots < minLot) lots = (lots <= 0.0 ? 0.0 : minLot);
   if(lots > maxLot) lots = maxLot;
   return lots;
}

bool HasOpenPosition()
{
   if(!PositionSelect(_Symbol)) return false;
   return (PositionGetInteger(POSITION_MAGIC) == InpMagic);
}

void CloseAllOurPositions(string reason)
{
   if(!PositionSelect(_Symbol)) return;
   if(PositionGetInteger(POSITION_MAGIC) != InpMagic) return;
   if(trade.PositionClose(_Symbol))
      PrintFormat("Closed position (%s)", reason);
}

int SecondsOfDay(datetime t)
{
   MqlDateTime mt;
   TimeToStruct(t, mt);
   return mt.hour*3600 + mt.min*60 + mt.sec;
}

bool TimeReachedOrPast(int hour, int minute)
{
   int nowSec = SecondsOfDay(TimeCurrent());
   return (nowSec >= hour*3600 + minute*60);
}

//--- News block parser: "HH:MM-HH:MM,HH:MM-HH:MM" ------------------
bool InNewsBlock()
{
   if(StringLen(InpNewsBlocks) == 0) return false;

   int nowSec = SecondsOfDay(TimeCurrent());

   string windows[];
   int n = StringSplit(InpNewsBlocks, ',', windows);
   for(int i = 0; i < n; i++)
   {
      string w = windows[i];
      StringTrimLeft(w); StringTrimRight(w);
      int dash = StringFind(w, "-");
      if(dash < 0) continue;

      string a = StringSubstr(w, 0, dash);
      string b = StringSubstr(w, dash+1);

      int aSec = ParseHHMM(a);
      int bSec = ParseHHMM(b);
      if(aSec < 0 || bSec < 0) continue;

      if(nowSec >= aSec && nowSec <= bSec)
         return true;
   }
   return false;
}

int ParseHHMM(string s)
{
   int colon = StringFind(s, ":");
   if(colon < 0) return -1;
   int h = (int)StringToInteger(StringSubstr(s, 0, colon));
   int m = (int)StringToInteger(StringSubstr(s, colon+1));
   if(h < 0 || h > 23 || m < 0 || m > 59) return -1;
   return h*3600 + m*60;
}
//+------------------------------------------------------------------+
