//+------------------------------------------------------------------+
//|                                                      ORB930.mq5   |
//|        Opening Range Breakout for US100 / NAS100 (M5/M15) - v2    |
//|                                                                  |
//|  Strategy: ORB-930                                               |
//|  - Builds an Opening Range (OR) for the first X minutes after    |
//|    the US cash open and trades the first clean breakout.         |
//|                                                                  |
//|  v2 focus = LONG-TERM SURVIVABILITY (not curve-fitting):         |
//|   * Account-level capital protection (equity drawdown guard)     |
//|   * Cooldown after N consecutive losing days                     |
//|   * Spread filter (real-world friction)                          |
//|   * Optional ATR trailing for the runner (let winners run)       |
//|   * Minimal core; advanced filters OPTIONAL (default OFF)        |
//|                                                                  |
//|  Hard constraints: max 1 trade/day, risk 0.5%/trade,            |
//|  no martingale / no grid / no averaging losers.                  |
//+------------------------------------------------------------------+
#property copyright "Fx-Analyzer"
#property version   "2.00"
#property strict

#include <Trade/Trade.mqh>

//==================================================================
// INPUTS
//==================================================================

//--- General / risk ------------------------------------------------
input double   InpRiskPercent      = 0.5;        // Risk per trade (% )
input bool     InpRiskFromEquity   = true;       // Size from equity (true) or balance (false)
input long     InpMagic            = 930930;     // Magic number
input int      InpSlippage         = 20;         // Max slippage (points)

//--- Capital protection (the part that decides survival) ----------
input double   InpMaxEquityDD_Pct  = 12.0;       // Halt trading if equity DD from peak >= % (0=off)
input int      InpMaxConsecLossDays= 3;          // Pause after N consecutive losing days (0=off)
input int      InpCooldownDays     = 2;          // Days to pause after the streak triggers
input int      InpMaxSpreadPoints  = 60;         // Skip entry if spread > points (0=off)
input bool     InpTradeFriday      = true;       // Allow trades on Friday

//--- Session timing (BROKER SERVER time, 24h) ---------------------
// Set so OR start matches 15:30 CET on your broker (EET brokers: usually 16:30/17:30).
input int      InpORStartHour      = 15;         // OR window start hour (server)
input int      InpORStartMinute    = 30;         // OR window start minute (server)
input int      InpORDurationMin    = 15;         // OR length in minutes (15 / 30)
input int      InpEntryCutoffHour  = 18;         // No new entries after this hour
input int      InpEntryCutoffMin   = 0;          // No new entries after this minute
input int      InpForceCloseHour   = 21;         // Force-close all positions (server)
input int      InpForceCloseMin    = 0;          // Force-close minute

//--- Core breakout parameters -------------------------------------
input int      InpATRPeriod        = 14;         // ATR period
input double   InpBufferATR        = 0.10;       // Breakout buffer = x * ATR
input double   InpORrangeMinATR     = 0.5;       // Min OR range as x * ATR (chop filter)
input double   InpORrangeMaxATR     = 2.5;       // Max OR range as x * ATR (over-extended filter)

//--- Stop loss / take profit --------------------------------------
input double   InpSLcapATR         = 1.5;        // Cap SL distance at x * ATR (0 = no cap)
input double   InpTP_R             = 2.0;        // Take profit in R multiples
input bool     InpUsePartialTP     = true;       // Take 50% off at 1R + move SL to BE
input double   InpPartialTP_R      = 1.0;        // Partial TP level in R

//--- Runner trailing (let winners run after partial) --------------
input bool     InpUseTrailing      = true;       // Trail the runner with Chandelier ATR
input int      InpTrailLookback    = 10;         // Highest/lowest lookback bars
input double   InpTrailATR         = 2.5;        // Trail distance = x * ATR

//--- OPTIONAL directional/chop filters (default OFF) --------------
input bool     InpUseEMAfilter     = false;      // Require price on correct side of EMA
input int      InpEMAperiod        = 50;         // EMA period
input bool     InpUseTimeStop      = false;      // Exit if no progress after N bars
input int      InpTimeStopBars     = 12;         // Bars before time-stop

//--- News filter (deterministic, testable) ------------------------
// Comma-separated server-time windows to BLOCK: "HH:MM-HH:MM,HH:MM-HH:MM"
input string   InpNewsBlocks       = "";         // Daily news block windows (server time)

//==================================================================
// GLOBALS
//==================================================================
CTrade   trade;

int      atrHandle = INVALID_HANDLE;
int      emaHandle = INVALID_HANDLE;

datetime g_currentDay     = 0;       // day of last reset (server midnight)
double   g_orHigh         = 0.0;
double   g_orLow          = 0.0;
bool     g_orLocked       = false;
bool     g_orValid        = false;
bool     g_tradedToday    = false;
datetime g_entryBarTime   = 0;
bool     g_beMoved        = false;

datetime g_lastBarTime    = 0;

// capital protection state
double   g_equityPeak     = 0.0;
bool     g_halted         = false;   // hard halt on equity DD
int      g_consecLossDays = 0;
datetime g_pauseUntil     = 0;       // server-day until which entries are paused

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

   g_equityPeak = AccountInfoDouble(ACCOUNT_EQUITY);

   PrintFormat("ORB930 v2 init. Risk=%.2f%%  OR=%dmin  DDguard=%.1f%%  cooldownAfter=%d losing days",
               InpRiskPercent, InpORDurationMin, InpMaxEquityDD_Pct, InpMaxConsecLossDays);
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
   datetime curBarTime = iTime(_Symbol, PERIOD_CURRENT, 0);
   bool newBar = (curBarTime != g_lastBarTime);
   if(newBar) g_lastBarTime = curBarTime;

   UpdateEquityGuard();          // track peak / halt every tick
   ManageOpenPosition();         // BE / trailing / time-stop

   if(TimeReachedOrPast(InpForceCloseHour, InpForceCloseMin))
   {
      CloseAllOurPositions("session end");
      return;
   }

   if(!newBar)
      return;

   HandleDailyReset();           // also runs daily risk review
   UpdateOpeningRange();

   if(EntriesAllowed() && g_orLocked && g_orValid && !g_tradedToday && !HasOpenPosition())
      TryEnter();
}

//==================================================================
// CAPITAL PROTECTION
//==================================================================
void UpdateEquityGuard()
{
   double eq = AccountInfoDouble(ACCOUNT_EQUITY);
   if(eq > g_equityPeak) g_equityPeak = eq;

   if(InpMaxEquityDD_Pct > 0.0 && g_equityPeak > 0.0 && !g_halted)
   {
      double ddPct = (g_equityPeak - eq) / g_equityPeak * 100.0;
      if(ddPct >= InpMaxEquityDD_Pct)
      {
         g_halted = true;
         CloseAllOurPositions("equity DD guard");
         PrintFormat("HALT: equity DD %.2f%% >= %.2f%% (peak=%.2f eq=%.2f). Manual restart required.",
                     ddPct, InpMaxEquityDD_Pct, g_equityPeak, eq);
      }
   }
}

// returns false if any account-level gate blocks new entries
bool EntriesAllowed()
{
   if(g_halted) return false;

   // cooldown after losing streak
   if(g_pauseUntil > 0 && g_currentDay < g_pauseUntil)
      return false;

   // friday filter
   if(!InpTradeFriday)
   {
      MqlDateTime mt; TimeToStruct(TimeCurrent(), mt);
      if(mt.day_of_week == 5) return false;
   }
   return true;
}

// Review previous day's realized P/L and update losing-streak state.
void DailyRiskReview(datetime prevDayStart, datetime newDayStart)
{
   if(InpMaxConsecLossDays <= 0 || prevDayStart == 0) return;

   double pl = GetRealizedProfit(prevDayStart, newDayStart);
   if(pl < 0.0)      g_consecLossDays++;
   else if(pl > 0.0) g_consecLossDays = 0;

   if(g_consecLossDays >= InpMaxConsecLossDays)
   {
      g_pauseUntil = newDayStart + (datetime)InpCooldownDays * 86400;
      PrintFormat("Cooldown: %d consecutive losing days -> pausing entries until %s",
                  g_consecLossDays, TimeToString(g_pauseUntil, TIME_DATE));
      g_consecLossDays = 0;
   }
}

double GetRealizedProfit(datetime from, datetime to)
{
   if(!HistorySelect(from, to)) return 0.0;
   double sum = 0.0;
   int total = HistoryDealsTotal();
   for(int i = 0; i < total; i++)
   {
      ulong ticket = HistoryDealGetTicket(i);
      if(ticket == 0) continue;
      if(HistoryDealGetInteger(ticket, DEAL_MAGIC) != InpMagic) continue;
      if(HistoryDealGetInteger(ticket, DEAL_ENTRY) != DEAL_ENTRY_OUT) continue;
      sum += HistoryDealGetDouble(ticket, DEAL_PROFIT)
           + HistoryDealGetDouble(ticket, DEAL_SWAP)
           + HistoryDealGetDouble(ticket, DEAL_COMMISSION);
   }
   return sum;
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
      DailyRiskReview(g_currentDay, dayStart);

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
// OPENING RANGE
//==================================================================
void UpdateOpeningRange()
{
   if(g_orLocked) return;

   int orStartSec = (InpORStartHour*60 + InpORStartMinute) * 60;
   int orEndSec   = orStartSec + InpORDurationMin*60;

   datetime barTime = iTime(_Symbol, PERIOD_CURRENT, 1);
   if(barTime <= 0) return;

   int barSec = SecondsOfDay(barTime);
   if(barSec >= orStartSec && barSec < orEndSec)
   {
      double h = iHigh(_Symbol, PERIOD_CURRENT, 1);
      double l = iLow(_Symbol, PERIOD_CURRENT, 1);
      if(g_orHigh == 0.0 || h > g_orHigh) g_orHigh = h;
      if(g_orLow  == 0.0 || l < g_orLow)  g_orLow  = l;
   }

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
      PrintFormat("OR rejected (chop/over-extended): range=%.1f pts band=[%.1f,%.1f]",
                  orRange/_Point, minR/_Point, maxR/_Point);
}

//==================================================================
// ENTRY
//==================================================================
void TryEnter()
{
   if(!TimeReachedOrPast(InpORStartHour, InpORStartMinute)) return;
   if(TimeReachedOrPast(InpEntryCutoffHour, InpEntryCutoffMin)) return;
   if(InNewsBlock()) return;
   if(SpreadTooWide()) return;

   double atr = GetATR();
   if(atr <= 0.0) return;

   double buffer     = InpBufferATR * atr;
   double closePrice = iClose(_Symbol, PERIOD_CURRENT, 1);

   bool emaOK_buy = true, emaOK_sell = true;
   if(InpUseEMAfilter)
   {
      double emaVal = GetEMA();
      emaOK_buy  = (closePrice > emaVal);
      emaOK_sell = (closePrice < emaVal);
   }

   if(closePrice > g_orHigh + buffer && emaOK_buy)
   {
      OpenTrade(ORDER_TYPE_BUY, atr);
      return;
   }
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
      if(InpSLcapATR > 0.0)
      {
         double maxDist = InpSLcapATR * atr;
         if(price - sl > maxDist) sl = price - maxDist;
      }
      tp = price + InpTP_R * (price - sl);
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
      tp = price - InpTP_R * (sl - price);
   }

   double slDist = MathAbs(price - sl);
   if(slDist <= 0.0) return;

   double lots = CalcLots(slDist);
   if(lots <= 0.0) { Print("Lot size 0 - skip"); return; }

   bool ok = (type == ORDER_TYPE_BUY)
             ? trade.Buy(lots, _Symbol, price, sl, tp, "ORB930")
             : trade.Sell(lots, _Symbol, price, sl, tp, "ORB930");

   if(ok)
   {
      g_tradedToday  = true;
      g_entryBarTime = iTime(_Symbol, PERIOD_CURRENT, 0);
      g_beMoved      = false;
      PrintFormat("ENTRY %s lots=%.2f price=%.1f sl=%.1f tp=%.1f",
                  (type==ORDER_TYPE_BUY?"BUY":"SELL"), lots, price, sl, tp);
   }
   else
   {
      PrintFormat("Order failed: %d / %s", trade.ResultRetcode(), trade.ResultRetcodeDescription());
   }
}

//==================================================================
// POSITION MANAGEMENT
//==================================================================
void ManageOpenPosition()
{
   if(!PositionSelect(_Symbol)) return;
   if(PositionGetInteger(POSITION_MAGIC) != InpMagic) return;

   long   type      = PositionGetInteger(POSITION_TYPE);
   double openPrice = PositionGetDouble(POSITION_PRICE_OPEN);
   double sl        = PositionGetDouble(POSITION_SL);
   double tp        = PositionGetDouble(POSITION_TP);
   double volume    = PositionGetDouble(POSITION_VOLUME);
   double bid       = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double ask       = SymbolInfoDouble(_Symbol, SYMBOL_ASK);

   double initialRisk = MathAbs(openPrice - sl);
   if(initialRisk <= 0.0) return;

   // --- Partial TP at xR + break-even -----------------------------
   if(InpUsePartialTP && !g_beMoved)
   {
      bool hit = false;
      if(type == POSITION_TYPE_BUY  && bid >= openPrice + InpPartialTP_R*initialRisk) hit = true;
      if(type == POSITION_TYPE_SELL && ask <= openPrice - InpPartialTP_R*initialRisk) hit = true;

      if(hit)
      {
         double half = NormalizeVolume(volume * 0.5);
         if(half >= SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN) && half < volume)
            trade.PositionClosePartial(_Symbol, half);

         if(trade.PositionModify(_Symbol, openPrice, tp))   // SL -> break-even
            g_beMoved = true;
      }
   }

   // --- Trailing for the runner (after BE) ------------------------
   if(InpUseTrailing && g_beMoved)
   {
      double atr = GetATR();
      if(atr > 0.0)
      {
         double trail = InpTrailATR * atr;
         if(type == POSITION_TYPE_BUY)
         {
            int hi = iHighest(_Symbol, PERIOD_CURRENT, MODE_HIGH, InpTrailLookback, 1);
            double newSL = iHigh(_Symbol, PERIOD_CURRENT, hi) - trail;
            if(newSL > sl && newSL < bid)
               trade.PositionModify(_Symbol, newSL, tp);
         }
         else
         {
            int lo = iLowest(_Symbol, PERIOD_CURRENT, MODE_LOW, InpTrailLookback, 1);
            double newSL = iLow(_Symbol, PERIOD_CURRENT, lo) + trail;
            if(newSL < sl && newSL > ask)
               trade.PositionModify(_Symbol, newSL, tp);
         }
      }
   }

   // --- Time-stop (optional) --------------------------------------
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

bool SpreadTooWide()
{
   if(InpMaxSpreadPoints <= 0) return false;
   long spread = SymbolInfoInteger(_Symbol, SYMBOL_SPREAD);
   if(spread > InpMaxSpreadPoints)
   {
      PrintFormat("Skip entry: spread %d > max %d", (int)spread, InpMaxSpreadPoints);
      return true;
   }
   return false;
}

double CalcLots(double slDistancePrice)
{
   double base = InpRiskFromEquity ? AccountInfoDouble(ACCOUNT_EQUITY)
                                   : AccountInfoDouble(ACCOUNT_BALANCE);
   double riskMoney = base * InpRiskPercent / 100.0;

   double tickValue = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
   double tickSize  = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   if(tickSize <= 0.0 || tickValue <= 0.0) return 0.0;

   double valuePerPricePerLot = tickValue / tickSize;
   double riskPerLot          = slDistancePrice * valuePerPricePerLot;
   if(riskPerLot <= 0.0) return 0.0;

   return NormalizeVolume(riskMoney / riskPerLot);
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

//--- News block parser: "HH:MM-HH:MM,HH:MM-HH:MM" -----------------
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

      int aSec = ParseHHMM(StringSubstr(w, 0, dash));
      int bSec = ParseHHMM(StringSubstr(w, dash+1));
      if(aSec < 0 || bSec < 0) continue;
      if(nowSec >= aSec && nowSec <= bSec) return true;
   }
   return false;
}

int ParseHHMM(string s)
{
   StringTrimLeft(s); StringTrimRight(s);
   int colon = StringFind(s, ":");
   if(colon < 0) return -1;
   int h = (int)StringToInteger(StringSubstr(s, 0, colon));
   int m = (int)StringToInteger(StringSubstr(s, colon+1));
   if(h < 0 || h > 23 || m < 0 || m > 59) return -1;
   return h*3600 + m*60;
}
//+------------------------------------------------------------------+
