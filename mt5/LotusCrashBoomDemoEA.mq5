//+------------------------------------------------------------------+
//| Lotus Crash/Boom Demo EA                                         |
//| Experimental tick-momentum trigger. DEMO accounts only.          |
//| Install in Deriv MT5 desktop; not executable from the web app.    |
//+------------------------------------------------------------------+
#property strict
#include <Trade/Trade.mqh>
CTrade trade;

input double Lots = 0.01;
input int FastEMA = 5;
input int SlowEMA = 13;
input int StopLossPoints = 0;   // Set per instrument after checking its contract specification.
input int TakeProfitPoints = 0; // Set per instrument after checking its contract specification.
input double MaxDailyLoss = 1.00;
input int MaxTradesPerDay = 3;
input ulong MagicNumber = 6111026;

int fastHandle = INVALID_HANDLE;
int slowHandle = INVALID_HANDLE;
datetime dayStart = 0;
int tradesToday = 0;
double dayStartEquity = 0.0;
datetime lastBar = 0;

bool IsDemoAccount()
{
   return (AccountInfoInteger(ACCOUNT_TRADE_MODE) == ACCOUNT_TRADE_MODE_DEMO);
}

void ResetDailyGuard()
{
   MqlDateTime now;
   TimeToStruct(TimeCurrent(), now);
   now.hour = 0; now.min = 0; now.sec = 0;
   datetime today = StructToTime(now);
   if(today != dayStart)
   {
      dayStart = today;
      dayStartEquity = AccountInfoDouble(ACCOUNT_EQUITY);
      tradesToday = 0;
   }
}

bool HasOurPosition()
{
   for(int i=PositionsTotal()-1; i>=0; --i)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket > 0 && PositionGetInteger(POSITION_MAGIC) == (long)MagicNumber)
         return true;
   }
   return false;
}

int OnInit()
{
   if(!IsDemoAccount())
   {
      Print("LOTUS SAFETY: This EA refuses to run on a real-money account.");
      return INIT_FAILED;
   }
   if(Lots <= 0 || FastEMA < 2 || SlowEMA <= FastEMA || MaxDailyLoss <= 0 || MaxTradesPerDay < 1)
      return INIT_PARAMETERS_INCORRECT;
   fastHandle = iMA(_Symbol, PERIOD_CURRENT, FastEMA, 0, MODE_EMA, PRICE_CLOSE);
   slowHandle = iMA(_Symbol, PERIOD_CURRENT, SlowEMA, 0, MODE_EMA, PRICE_CLOSE);
   if(fastHandle == INVALID_HANDLE || slowHandle == INVALID_HANDLE)
      return INIT_FAILED;
   trade.SetExpertMagicNumber(MagicNumber);
   ResetDailyGuard();
   Print("LOTUS DEMO EA INITIALIZED on ", _Symbol, ". Experimental EMA crossover only; no profitability claim.");
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   if(fastHandle != INVALID_HANDLE) IndicatorRelease(fastHandle);
   if(slowHandle != INVALID_HANDLE) IndicatorRelease(slowHandle);
}

void OnTick()
{
   if(!IsDemoAccount()) return;
   ResetDailyGuard();
   if(dayStartEquity - AccountInfoDouble(ACCOUNT_EQUITY) >= MaxDailyLoss) return;
   if(tradesToday >= MaxTradesPerDay || HasOurPosition()) return;
   datetime bar = iTime(_Symbol, PERIOD_CURRENT, 0);
   if(bar == 0 || bar == lastBar) return;
   lastBar = bar;
   double fast[3], slow[3];
   ArraySetAsSeries(fast, true);
   ArraySetAsSeries(slow, true);
   if(CopyBuffer(fastHandle, 0, 0, 3, fast) != 3 || CopyBuffer(slowHandle, 0, 0, 3, slow) != 3) return;
   bool buySignal = fast[2] <= slow[2] && fast[1] > slow[1];
   bool sellSignal = fast[2] >= slow[2] && fast[1] < slow[1];
   if(!buySignal && !sellSignal) return;
   MqlTick tick;
   if(!SymbolInfoTick(_Symbol, tick)) return;
   double sl = 0.0, tp = 0.0;
   if(buySignal)
   {
      if(StopLossPoints > 0) sl = NormalizeDouble(tick.ask - StopLossPoints * _Point, _Digits);
      if(TakeProfitPoints > 0) tp = NormalizeDouble(tick.ask + TakeProfitPoints * _Point, _Digits);
      if(trade.Buy(Lots, _Symbol, 0.0, sl, tp, "Lotus demo EMA"))
         tradesToday++;
      else Print("Lotus demo buy rejected: ", trade.ResultRetcodeDescription());
   }
   if(sellSignal)
   {
      if(StopLossPoints > 0) sl = NormalizeDouble(tick.bid + StopLossPoints * _Point, _Digits);
      if(TakeProfitPoints > 0) tp = NormalizeDouble(tick.bid - TakeProfitPoints * _Point, _Digits);
      if(trade.Sell(Lots, _Symbol, 0.0, sl, tp, "Lotus demo EMA"))
         tradesToday++;
      else Print("Lotus demo sell rejected: ", trade.ResultRetcodeDescription());
   }
}
//+------------------------------------------------------------------+
