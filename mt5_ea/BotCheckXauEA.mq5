//+------------------------------------------------------------------+
//|                                              BotCheckXauEA.mq5  |
//|                                  Copyright 2026, BOTCHECKXAU     |
//|                         Cầu nối khớp lệnh tự động từ Node.js AI  |
//+------------------------------------------------------------------+
#property copyright "BOTCHECKXAU"
#property link      "http://127.0.0.1:3000"
#property version   "1.01"
#property strict

//+------------------------------------------------------------------+
//| INPUT PARAMETERS                                                 |
//+------------------------------------------------------------------+
input group "=== CẤU HÌNH CẦU NỐI (BRIDGE) ==="
input string   InpBridgeUrl            = "http://127.0.0.1:3000"; // URL Node.js Bridge Server
input int      InpPollIntervalSec      = 1;                       // Tần suất kiểm tra lệnh (giây)
input int      InpHeartbeatIntervalSec = 5;                       // Tần suất đồng bộ số dư (giây)

input group "=== CẤU HÌNH GIAO DỊCH ==="
input ulong    InpMagicNumber          = 888999;                  // Magic Number định danh lệnh của Bot
input ulong    InpSlippage             = 30;                      // Slippage cho phép (Points)
input bool     InpAutoDetectSuffix     = true;                    // Tự động nhận diện đuôi cặp tiền (m, .c...)

input group "=== QUẢN TRỊ RỦI RO & KHỐI LƯỢNG ==="
input double   InpMaxTotalLot          = 0.02;                    // Tổng volume tối đa cho phép (Max Total Lot)
input bool     InpAllowConcurrentOrders= false;                   // Cho phép nhiều lệnh cùng lúc (false = chỉ 1 lệnh)

input group "=== QUẢN LÝ DỜI SL HÒA VỐN & KHÓA LÃI DƯƠNG ==="
input bool     InpEnableBreakeven      = true;                    // Kích hoạt tự động dời SL về hòa vốn
input double   InpBreakevenTriggerUSD  = 10.0;                    // Đạt lãi từ bao nhiêu USD thì dời SL (mặc định 10.0 USD)
input double   InpBreakevenOffsetUSD   = 1.0;                     // Offset bảo vệ phí sàn/spread (mặc định 1.0 USD)
input bool     InpEnableLockProfit     = true;                    // Kích hoạt dời SL khóa lãi dương (+15u -> SL +6u)
input double   InpLockProfitTriggerUSD = 15.0;                    // Đạt lãi từ bao nhiêu USD thì khóa lãi (+15.0 USD)
input double   InpLockProfitOffsetUSD  = 6.0;                     // Mức SL khóa lãi dương (+6.0 USD)
input double   InpAutoCloseProfitUSD   = 0.0;                     // Cắt lệnh theo lợi nhuận USD (đặt 0.0 để tắt, cho lệnh chạy tới TP 30.0 USD)

input group "=== BẢO VỆ VỐN & NGẮT MẠCH KHẨN CẤP (CIRCUIT BREAKER) ==="
input bool     InpEnableCircuitBreaker = true;                    // Kích hoạt ngắt mạch bảo vệ vốn khi chạm ngưỡng lỗ
input double   InpInitialCapitalUSD    = 300.0;                   // Vốn mục tiêu/vốn cơ sở (300 USD)
input double   InpMaxLossUSD           = 150.0;                   // Mức lỗ tối đa cho phép dừng giao dịch (150 USD tương đương 50% vốn)
input double   InpMaxDrawdownPercent   = 50.0;                    // Mức sụt giảm tối đa (% vốn cơ sở, 50%)
input bool     InpCloseAllOnBreach     = true;                    // Tự động đóng tất cả vị thế khi vi phạm ngưỡng lỗ

// Biến cấu hình có thể đồng bộ động từ Node.js .env
double g_breakevenTriggerUSD   = 10.0;
double g_breakevenOffsetUSD    = 1.0;
double g_lockProfitTriggerUSD  = 15.0;
double g_lockProfitOffsetUSD   = 6.0;

// Biến lưu thời gian nhịp tim gần nhất (dùng mili-giây độc lập với tick thị trường)
ulong  g_lastHeartbeatMs = 0;
bool   g_circuitBreakerLocked = false;
double g_startEquity = 0.0;
double g_peakEquity = 0.0;
double g_baseCapital = 300.0;
double g_maxLossUSD = 150.0;


//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit()
{
   Print("=====================================================");
   Print("🤖 BotCheckXauEA: Đang khởi động cầu nối MT5 <-> Node.js...");
   Print("📡 Bridge URL: ", InpBridgeUrl);
   Print("⚡ Magic Number: ", InpMagicNumber);
   
   bool terminalAlgo = (bool)TerminalInfoInteger(TERMINAL_TRADE_ALLOWED);
   bool eaAlgo       = (bool)MQLInfoInteger(MQL_TRADE_ALLOWED);
   bool accountAlgo  = (bool)AccountInfoInteger(ACCOUNT_TRADE_EXPERT);

   Print("🔍 KIỂM TRA QUYỀN GIAO DỊCH:");
   Print("   1. Nút Algo Trading trên thanh công cụ: ", terminalAlgo ? "BẬT (OK)" : "TẮT (CẦN BẬT)");
   Print("   2. Quyền Algo Trading trong EA (F7):   ", eaAlgo ? "BẬT (OK)" : "TẮT (CẦN BẬT)");
   Print("   3. Máy chủ/Tài khoản cho phép Robot:  ", accountAlgo ? "CHO PHÉP (OK)" : "BỊ CHẶN BỞI SERVER");

   // Kích hoạt bộ hẹn giờ kiểm tra tín hiệu (1 giây)
   EventSetTimer(InpPollIntervalSec);
   
   // Ghi nhận mốc vốn ban đầu để bảo vệ tài khoản (Circuit Breaker)
   g_startEquity = AccountInfoDouble(ACCOUNT_EQUITY);
   g_peakEquity  = g_startEquity;
   g_circuitBreakerLocked = false;
   g_baseCapital = InpInitialCapitalUSD;
   g_maxLossUSD  = InpMaxLossUSD;

   // Tự động đồng bộ g_baseCapital nếu bị lệch quá xa so với vốn thực tế của tài khoản (tránh load template cũ 1000 USD)
   if(g_baseCapital <= 0.0 || MathAbs(g_startEquity - g_baseCapital) > (g_baseCapital * 0.5))
   {
      g_baseCapital = g_startEquity;
      if(InpMaxDrawdownPercent > 0)
         g_maxLossUSD = g_baseCapital * (InpMaxDrawdownPercent / 100.0);
   }

   Print("🛡️ [BẢO VỆ VỐN] Mốc vốn ban đầu: $", DoubleToString(g_startEquity, 2), 
         " USD | Vốn cơ sở: $", DoubleToString(g_baseCapital, 2),
         " USD | Ngưỡng lỗ tối đa: -$", DoubleToString(g_maxLossUSD, 2), " USD (", DoubleToString(InpMaxDrawdownPercent, 1), "%)");

   // Khởi tạo các mốc dời SL hòa vốn & khóa lãi
   g_breakevenTriggerUSD   = InpBreakevenTriggerUSD;
   g_breakevenOffsetUSD    = InpBreakevenOffsetUSD;
   g_lockProfitTriggerUSD  = InpLockProfitTriggerUSD;
   g_lockProfitOffsetUSD   = InpLockProfitOffsetUSD;

   Print("🎯 [QUẢN LÝ LÃI] Hòa vốn: Lãi >= +$", DoubleToString(g_breakevenTriggerUSD, 1), 
         " USD -> SL +", DoubleToString(g_breakevenOffsetUSD, 1), 
         " USD | Khóa lãi: Lãi >= +$", DoubleToString(g_lockProfitTriggerUSD, 1), 
         " USD -> SL dương +", DoubleToString(g_lockProfitOffsetUSD, 1), " USD");

   // Gửi nhịp tim đầu tiên báo danh tài khoản
   SendHeartbeat();
   g_lastHeartbeatMs = GetTickCount64();
   
   Print("✅ BotCheckXauEA đã sẵn sàng! Đang lắng nghe lệnh từ AI...");
   Print("=====================================================");
   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| Expert deinitialization function                                 |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   EventKillTimer();
   Print("🛑 BotCheckXauEA đã ngừng hoạt động.");
}

//+------------------------------------------------------------------+
//| Expert timer function (Chạy định kỳ mỗi 1 giây)                  |
//+------------------------------------------------------------------+
void OnTimer()
{
   ulong nowMs = GetTickCount64();

   // 1. Quét kiểm tra ngắt mạch khẩn cấp bảo vệ vốn (lỗ chạm 300 USD)
   CheckCircuitBreakerProtection();

   // 2. Quét và tự động dời SL về hòa vốn khi lãi >= InpBreakevenTriggerUSD (2.0 USD)
   CheckAndApplyBreakeven();

   // 3. Quét chốt lời tự động theo mục tiêu USD (nếu InpAutoCloseProfitUSD > 0)
   CheckAutoCloseByProfit();

   // 4. Gửi nhịp tim định kỳ mỗi InpHeartbeatIntervalSec giây
   if(nowMs - g_lastHeartbeatMs >= (ulong)(InpHeartbeatIntervalSec * 1000))
   {
      SendHeartbeat();
      g_lastHeartbeatMs = nowMs;
   }

   // 5. Kiểm tra hàng đợi lệnh từ Node.js Bridge Server
   PollAndExecuteSignal();
}

//+------------------------------------------------------------------+
//| Expert tick function (Chạy mỗi khi có biến động giá mới)         |
//+------------------------------------------------------------------+
void OnTick()
{
   // Quét kiểm tra ngắt mạch khẩn cấp bảo vệ vốn
   CheckCircuitBreakerProtection();

   // Quét dời SL hòa vốn tức thì theo từng biến động giá (Tick)
   CheckAndApplyBreakeven();

   // Kiểm tra chốt lời tự động tức thì theo từng biến động giá (Tick)
   CheckAutoCloseByProfit();
}

//+------------------------------------------------------------------+
//| Đóng một vị thế theo Ticket                                      |
//+------------------------------------------------------------------+
bool ClosePosition(ulong ticket)
{
   if(!PositionSelectByTicket(ticket)) return false;

   string symbol = PositionGetString(POSITION_SYMBOL);
   long type     = PositionGetInteger(POSITION_TYPE);
   double volume = PositionGetDouble(POSITION_VOLUME);
   int digits    = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);

   MqlTradeRequest request;
   MqlTradeResult  result;
   ZeroMemory(request);
   ZeroMemory(result);

   request.action       = TRADE_ACTION_DEAL;
   request.position     = ticket;
   request.symbol       = symbol;
   request.volume       = volume;
   request.deviation    = InpSlippage;
   request.magic        = InpMagicNumber;
   request.comment      = "AI_Scalp_Close_2U";

   if(type == POSITION_TYPE_BUY)
   {
      request.type  = ORDER_TYPE_SELL;
      request.price = NormalizeDouble(SymbolInfoDouble(symbol, SYMBOL_BID), digits);
   }
   else if(type == POSITION_TYPE_SELL)
   {
      request.type  = ORDER_TYPE_BUY;
      request.price = NormalizeDouble(SymbolInfoDouble(symbol, SYMBOL_ASK), digits);
   }
   else return false;

   uint filling = (uint)SymbolInfoInteger(symbol, SYMBOL_FILLING_MODE);
   if((filling & SYMBOL_FILLING_FOK) != 0)
      request.type_filling = ORDER_FILLING_FOK;
   else if((filling & SYMBOL_FILLING_IOC) != 0)
      request.type_filling = ORDER_FILLING_IOC;
   else
      request.type_filling = ORDER_FILLING_RETURN;

   ResetLastError();
   bool success = OrderSend(request, result);
   if(success && (result.retcode == TRADE_RETCODE_DONE || result.retcode == TRADE_RETCODE_PLACED))
   {
      Print("🎉 [CHỐT LỜI SCALP 2U] Đã cắt lệnh #", ticket, " thành công! Giá đóng: ", result.price);
      return true;
   }
   else
   {
      Print("❌ [CHỐT LỜI SCALP 2U] Đóng lệnh #", ticket, " thất bại! Retcode: ", result.retcode, " (", result.comment, ")");
      return false;
   }
}

//+------------------------------------------------------------------+
//| Đóng toàn bộ tất cả vị thế đang mở (Khẩn cấp / Circuit Breaker)  |
//+------------------------------------------------------------------+
void CloseAllPositions(string reason)
{
   int positions = PositionsTotal();
   if(positions == 0) return;

   Print("🚨 [KHẨN CẤP] Đang đóng toàn bộ ", positions, " vị thế! Lý do: ", reason);
   for(int i = positions - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket > 0)
      {
         ClosePosition(ticket);
      }
   }
}

//+------------------------------------------------------------------+
//| Quét kiểm tra sụt giảm vốn & ngắt mạch bảo vệ tài khoản         |
//+------------------------------------------------------------------+
void CheckCircuitBreakerProtection()
{
   if(!InpEnableCircuitBreaker || InpMaxLossUSD <= 0) return;

   double equity = AccountInfoDouble(ACCOUNT_EQUITY);
   if(equity <= 0) return;
   // Lọc lỗi rớt mạng tức thời của MT5 (equity tụt về 0 hoặc số ảo khi mất kết nối máy chủ)
   if(g_peakEquity > 10000.0 && equity < 1000.0) return;

   if(g_startEquity <= 0)
   {
      g_startEquity = equity;
      g_peakEquity  = equity;
   }

   if(equity > g_peakEquity) g_peakEquity = equity;

   // 1. Sụt giảm từ đỉnh (Peak Drawdown)
   double peakDrawdown = (g_peakEquity > equity) ? (g_peakEquity - equity) : 0.0;
   // 2. Sụt giảm từ đầu phiên chạy (Session Drawdown)
   double sessionDrawdown = (g_startEquity > equity) ? (g_startEquity - equity) : 0.0;
   double currentDrawdown = MathMax(peakDrawdown, sessionDrawdown);

   bool isBreached = false;
   string reason = "";

   // Vốn cơ sở tính toán
   double baseCapital = (g_baseCapital > 0) ? g_baseCapital : ((g_startEquity > 0) ? g_startEquity : equity);

   double maxAllowedLoss = (InpMaxDrawdownPercent > 0 && baseCapital > 0)
                           ? (baseCapital * (InpMaxDrawdownPercent / 100.0))
                           : g_maxLossUSD;

   if(maxAllowedLoss > 0 && currentDrawdown >= maxAllowedLoss)
   {
      isBreached = true;
      double ddPct = baseCapital > 0 ? (currentDrawdown / baseCapital * 100.0) : InpMaxDrawdownPercent;
      reason = StringFormat("Sut giam -$%.2f USD (-%.1f%%) vuot nguong dung lo cho phep (Co so: $%.2f USD, Nguong dung lo: -$%.2f USD)!",
                            currentDrawdown, ddPct, baseCapital, maxAllowedLoss);
   }

   if(isBreached)
   {
      if(!g_circuitBreakerLocked)
      {
         g_circuitBreakerLocked = true;
         Print("🚨🚨🚨 [CIRCUIT BREAKER TRIGGERED] ", reason, " Khóa giao dịch toàn bộ để bảo vệ vốn!");
         if(InpCloseAllOnBreach)
         {
            CloseAllPositions(reason);
         }
         SendExecutionReport("circuit_breaker", "CIRCUIT_BREAKER", 0, 0, reason);
      }
   }
}

//+------------------------------------------------------------------+
//| Tự động quét và cắt lệnh khi lợi nhuận đạt mức quy định (2u)     |
//+------------------------------------------------------------------+
void CheckAutoCloseByProfit()
{
   if(InpAutoCloseProfitUSD <= 0) return;

   int positions = PositionsTotal();
   for(int i = positions - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket > 0)
      {
         string sym = PositionGetString(POSITION_SYMBOL);
         // Áp dụng cho các cặp Vàng (XAUUSD, GOLD)
         if(StringFind(sym, "XAU") >= 0 || StringFind(sym, "GOLD") >= 0 || sym == _Symbol)
         {
            double profit = PositionGetDouble(POSITION_PROFIT) + PositionGetDouble(POSITION_SWAP);
            if(profit >= InpAutoCloseProfitUSD)
            {
               Print("🎯 [CHỐT LỜI SCALP] Vị thế #", ticket, " đạt lãi +$", DoubleToString(profit, 2), " USD (>= ", DoubleToString(InpAutoCloseProfitUSD, 2), " USD). Tiến hành cắt lệnh ngay lập tức...");
               ClosePosition(ticket);
            }
         }
      }
   }
}

//+------------------------------------------------------------------+
//| Tự động quét và dời SL về Hòa Vốn & Khóa Lãi Dương (+15u -> +6u) |
//+------------------------------------------------------------------+
void CheckAndApplyBreakeven()
{
   if(!InpEnableBreakeven && !InpEnableLockProfit) return;

   int positions = PositionsTotal();
   for(int i = positions - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;

      string sym = PositionGetString(POSITION_SYMBOL);
      // Áp dụng cho các cặp Vàng (XAUUSD, GOLD) hoặc symbol hiện tại
      if(StringFind(sym, "XAU") < 0 && StringFind(sym, "GOLD") < 0 && sym != _Symbol)
         continue;

      double profit = PositionGetDouble(POSITION_PROFIT) + PositionGetDouble(POSITION_SWAP);

      // Xác định mục tiêu dời SL:
      // Chặng 2 (Ưu tiên cao hơn): Nếu lãi >= g_lockProfitTriggerUSD (15.0 USD) -> Khóa lãi dương g_lockProfitOffsetUSD (+6.0 USD)
      // Chặng 1: Nếu lãi >= g_breakevenTriggerUSD (10.0 USD) -> Dời hòa vốn + g_breakevenOffsetUSD (+1.0 USD)
      double targetOffset = 0.0;
      string slStage = "";

      if(InpEnableLockProfit && g_lockProfitTriggerUSD > 0 && profit >= g_lockProfitTriggerUSD)
      {
         targetOffset = g_lockProfitOffsetUSD; // Khóa lãi dương 6.0 USD
         slStage = "LOCK_PROFIT";
      }
      else if(InpEnableBreakeven && g_breakevenTriggerUSD > 0 && profit >= g_breakevenTriggerUSD)
      {
         targetOffset = g_breakevenOffsetUSD; // Hòa vốn 1.0 USD
         slStage = "BREAKEVEN";
      }
      else
      {
         continue; // Chưa đạt mốc nào
      }

      long type         = PositionGetInteger(POSITION_TYPE);
      double openPrice  = PositionGetDouble(POSITION_PRICE_OPEN);
      double currentSl  = PositionGetDouble(POSITION_SL);
      double currentTp  = PositionGetDouble(POSITION_TP);
      double currentBid = SymbolInfoDouble(sym, SYMBOL_BID);
      double currentAsk = SymbolInfoDouble(sym, SYMBOL_ASK);
      int digits        = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
      double point      = SymbolInfoDouble(sym, SYMBOL_POINT);
      double stopsLevel = (double)SymbolInfoInteger(sym, SYMBOL_TRADE_STOPS_LEVEL) * point;

      double targetSl = 0.0;
      bool needModify = false;

      if(type == POSITION_TYPE_BUY)
      {
         // Với lệnh BUY: SL = Giá vào + targetOffset
         targetSl = openPrice + targetOffset;

         // Nếu SL hiện tại chưa có (currentSl <= 0) hoặc SL hiện tại còn dưới targetSl
         if(currentSl < (targetSl - (0.5 * point)))
         {
            // Kiểm tra an toàn: targetSl phải thấp hơn giá Bid hiện tại ít nhất stopsLevel
            if(targetSl < (currentBid - stopsLevel))
            {
               needModify = true;
            }
         }
      }
      else if(type == POSITION_TYPE_SELL)
      {
         // Với lệnh SELL: SL = Giá vào - targetOffset
         targetSl = openPrice - targetOffset;

         // Nếu SL hiện tại chưa có (currentSl <= 0) hoặc SL hiện tại còn trên targetSl
         if(currentSl <= 0.0 || currentSl > (targetSl + (0.5 * point)))
         {
            // Kiểm tra an toàn: targetSl phải cao hơn giá Ask hiện tại ít nhất stopsLevel
            if(targetSl > (currentAsk + stopsLevel))
            {
               needModify = true;
            }
         }
      }

      if(needModify)
      {
         targetSl = NormalizeDouble(targetSl, digits);

         MqlTradeRequest request;
         MqlTradeResult  result;
         ZeroMemory(request);
         ZeroMemory(result);

         request.action   = TRADE_ACTION_SLTP;
         request.position = ticket;
         request.symbol   = sym;
         request.sl       = targetSl;
         request.tp       = NormalizeDouble(currentTp, digits);

         ResetLastError();
         bool success = OrderSend(request, result);
         if(success && (result.retcode == TRADE_RETCODE_DONE || result.retcode == TRADE_RETCODE_PLACED))
         {
            if(slStage == "LOCK_PROFIT")
            {
               Print("🎯 [KHÓA LÃI DƯƠNG +", DoubleToString(targetOffset, 1), " USD] Thành công! Ticket #", ticket, " SL đã dời về ", targetSl, 
                     " (Giá vào: ", openPrice, ", Lãi hiện tại: +$", DoubleToString(profit, 2), " USD)");
               SendExecutionReport(IntegerToString(ticket), "LOCK_PROFIT", ticket, targetSl, 
                     StringFormat("Khoa lai: %.2f (Lai: +$%.2f USD, SL duong +$%.2f USD)", targetSl, profit, targetOffset));
            }
            else
            {
               Print("🛡️ [DỜI SL HÒA VỐN] Thành công! Ticket #", ticket, " SL đã dời về ", targetSl, 
                     " (Giá vào: ", openPrice, ", Lãi hiện tại: +$", DoubleToString(profit, 2), " USD)");
               SendExecutionReport(IntegerToString(ticket), "BREAKEVEN", ticket, targetSl, 
                     StringFormat("SL hoa von: %.2f (Lai: +$%.2f USD)", targetSl, profit));
            }
         }
         else
         {
            Print("⚠️ [DỜI SL ", slStage, "] Thất bại lệnh #", ticket, "! Retcode: ", result.retcode, " (", result.comment, ") Err: ", GetLastError());
         }
      }
   }
}

//+------------------------------------------------------------------+
//| Kiểm tra và thực thi tín hiệu từ Node.js Bridge                  |
//+------------------------------------------------------------------+
void PollAndExecuteSignal()
{
   string url = InpBridgeUrl + "/api/mt5/signal";
   string headers = "Content-Type: application/json\r\n";
   char postData[];
   char resultData[];
   string resultHeaders;
   
   ResetLastError();
   int res = WebRequest("GET", url, headers, 1500, postData, resultData, resultHeaders);
   
   if(res == -1)
   {
      int err = GetLastError();
      if(err == 4060)
      {
         Print("❌ LỖI 4060: Chưa cấp quyền WebRequest cho '", InpBridgeUrl, "'!");
         Print("👉 Vào MT5: Tools -> Options -> Expert Advisors -> Tích 'Allow WebRequest' -> Thêm '", InpBridgeUrl, "'");
      }
      return;
   }

   if(res != 200) return;

   string response = CharArrayToString(resultData);
   if(StringFind(response, "\"has_order\":true") < 0) return;

   Print("🔔 [MT5] Nhận được gói tin lệnh mới: ", response);

   string orderId  = ExtractJsonValue(response, "id");
   string action   = ExtractJsonValue(response, "action");
   string symbol   = ExtractJsonValue(response, "symbol");
   double lot      = StringToDouble(ExtractJsonValue(response, "lot"));
   double sl       = StringToDouble(ExtractJsonValue(response, "sl"));
   double tp       = StringToDouble(ExtractJsonValue(response, "tp"));
   double entryPrice = StringToDouble(ExtractJsonValue(response, "entry_price"));
   string comment  = ExtractJsonValue(response, "comment");

   if(orderId == "" || action == "") return;

   // Xử lý lệnh mở khóa Circuit Breaker từ Dashboard hoặc AI (UNLOCK / RESET_CIRCUIT_BREAKER)
   if(action == "UNLOCK" || action == "RESET_CIRCUIT_BREAKER")
   {
      g_circuitBreakerLocked = false;
      double eq = AccountInfoDouble(ACCOUNT_EQUITY);
      g_startEquity = eq;
      g_peakEquity = eq;
      g_baseCapital = eq;
      if(InpMaxDrawdownPercent > 0)
         g_maxLossUSD = g_baseCapital * (InpMaxDrawdownPercent / 100.0);
      Print("🔓 [CIRCUIT BREAKER UNLOCKED] Đã mở khóa bảo vệ vốn và reset mốc vốn cơ sở về: $", DoubleToString(eq, 2), " USD");
      SendExecutionReport(orderId, "UNLOCKED", 0, eq, "Da mo khoa Circuit Breaker thanh cong");
      return;
   }

   // Xử lý dời SL về hòa vốn (MOVE_SL_BE)
   if(action == "MOVE_SL_BE")
   {
      int modifiedCount = 0;
      int totalPos = PositionsTotal();
      string tradeSym = ResolveSymbol(symbol != "" ? symbol : "XAUUSD");
      for(int i = totalPos - 1; i >= 0; i--)
      {
         ulong t = PositionGetTicket(i);
         if(t > 0)
         {
            string pSym = PositionGetString(POSITION_SYMBOL);
            if(pSym == tradeSym || StringFind(pSym, "XAU") >= 0 || StringFind(pSym, "GOLD") >= 0)
            {
               double openPrice = PositionGetDouble(POSITION_PRICE_OPEN);
               double currentTp = PositionGetDouble(POSITION_TP);
               int digits = (int)SymbolInfoInteger(pSym, SYMBOL_DIGITS);

               MqlTradeRequest req;
               MqlTradeResult  res;
               ZeroMemory(req);
               ZeroMemory(res);
               req.action = TRADE_ACTION_SLTP;
               req.position = t;
               req.symbol = pSym;
               req.sl = NormalizeDouble(openPrice, digits);
               req.tp = NormalizeDouble(currentTp, digits);
               ResetLastError();
               if(OrderSend(req, res)) modifiedCount++;
            }
         }
      }
      Print("🛡️ [DỜI SL HÒA VỐN] Đã dời SL về BE cho ", modifiedCount, " vị thế.");
      SendExecutionReport(orderId, "SL_BE_APPLIED", (ulong)modifiedCount, 0, "Da doi SL ve hoa von");
      return;
   }

   // Xử lý cập nhật SL/TP linh động (UPDATE_SL_TP)
   if(action == "UPDATE_SL_TP")
   {
      int totalPos = PositionsTotal();
      string tradeSym = ResolveSymbol(symbol != "" ? symbol : "XAUUSD");
      int modifiedCount = 0;
      for(int i = totalPos - 1; i >= 0; i--)
      {
         ulong t = PositionGetTicket(i);
         if(t > 0)
         {
            string pSym = PositionGetString(POSITION_SYMBOL);
            if(pSym == tradeSym || StringFind(pSym, "XAU") >= 0 || StringFind(pSym, "GOLD") >= 0)
            {
               int digits = (int)SymbolInfoInteger(pSym, SYMBOL_DIGITS);
               double curSl = PositionGetDouble(POSITION_SL);
               double curTp = PositionGetDouble(POSITION_TP);
               double newSl = (sl > 0) ? NormalizeDouble(sl, digits) : curSl;
               double newTp = (tp > 0) ? NormalizeDouble(tp, digits) : curTp;

               MqlTradeRequest req;
               MqlTradeResult  res;
               ZeroMemory(req);
               ZeroMemory(res);
               req.action = TRADE_ACTION_SLTP;
               req.position = t;
               req.symbol = pSym;
               req.sl = newSl;
               req.tp = newTp;
               ResetLastError();
               if(OrderSend(req, res)) modifiedCount++;
            }
         }
      }
      Print("🔄 [CẬP NHẬT SL/TP] Đã cập nhật cho ", modifiedCount, " vị thế.");
      SendExecutionReport(orderId, "SL_TP_UPDATED", (ulong)modifiedCount, 0, "Da cap nhat SL TP");
      return;
   }

   // Xử lý hủy toàn bộ lệnh chờ (CANCEL_ALL_PENDING)
   if(action == "CANCEL_ALL_PENDING")
   {
      int cancelledCount = 0;
      int totalOrders = OrdersTotal();
      for(int i = totalOrders - 1; i >= 0; i--)
      {
         ulong t = OrderGetTicket(i);
         if(t > 0)
         {
            if(CancelPendingOrder(t)) cancelledCount++;
         }
      }
      Print("🗑️ [HỦY TẤT CẢ LỆNH CHỜ] Đã hủy ", cancelledCount, " lệnh chờ trên MT5.");
      SendExecutionReport(orderId, "ALL_PENDING_CANCELLED", (ulong)cancelledCount, 0, "Da huy tat ca lenh cho");
      return;
   }

   // Xử lý lệnh khẩn cấp CLOSE_ALL từ Circuit Breaker
   if(action == "CLOSE_ALL")
   {
      CloseAllPositions(comment != "" ? comment : "Lenh dong khan cap tu Circuit Breaker");
      SendExecutionReport(orderId, "CLOSED_ALL", 0, 0, "Da dong toan bo vi the thanh cong");
      return;
   }

   // Xử lý lệnh tự động đóng vị thế khi đảo chiều xu hướng (CLOSE / CLOSE_POSITION)
   if(action == "CLOSE" || action == "CLOSE_POSITION")
   {
      ulong closeTicket = (ulong)StringToInteger(ExtractJsonValue(response, "ticket"));
      string reasonText = ExtractJsonValue(response, "reason");
      if(reasonText == "") reasonText = comment != "" ? comment : "Dao chieu xu huong";

      bool closedOk = false;
      if(closeTicket > 0)
      {
         closedOk = ClosePosition(closeTicket);
      }
      else
      {
         string closeSym = ResolveSymbol(symbol);
         int totalPos = PositionsTotal();
         for(int i = totalPos - 1; i >= 0; i--)
         {
            ulong t = PositionGetTicket(i);
            if(t > 0 && PositionGetString(POSITION_SYMBOL) == closeSym)
            {
               if(ClosePosition(t)) closedOk = true;
            }
         }
      }

      if(closedOk)
      {
         Print("✅ [Trend Reversal] Đã ngắt lệnh #", closeTicket, " do đảo chiều xu hướng: ", reasonText);
         SendExecutionReport(orderId, "CLOSED", closeTicket, 0, reasonText);
      }
      else
      {
         Print("⚠️ [Trend Reversal] Ngắt lệnh thất bại hoặc không tìm thấy vị thế #", closeTicket);
         SendExecutionReport(orderId, "CLOSE_FAILED", closeTicket, 0, "Khong tim thay vi the hoac dong that bai");
      }
      return;
   }

   // Xử lý hủy lệnh chờ Pending Order (CANCEL_PENDING / CANCEL_ORDER)
   if(action == "CANCEL_PENDING" || action == "CANCEL_ORDER")
   {
      ulong cancelTicket = (ulong)StringToInteger(ExtractJsonValue(response, "ticket"));
      if(cancelTicket > 0)
      {
         bool cOk = CancelPendingOrder(cancelTicket);
         if(cOk) SendExecutionReport(orderId, "CANCELLED", cancelTicket, 0, "Da huy lenh cho thanh cong");
         else SendExecutionReport(orderId, "CANCEL_FAILED", cancelTicket, 0, "Huy lenh cho that bai");
      }
      return;
   }

   string tradeSymbol = ResolveSymbol(symbol);

   // Xử lý lệnh chờ Pending Limit (BUY_LIMIT / SELL_LIMIT)
   if(action == "BUY_LIMIT" || action == "SELL_LIMIT")
   {
      ExecutePendingOrder(orderId, action, tradeSymbol, lot, entryPrice, sl, tp, comment);
      return;
   }

   ExecuteMarketOrder(orderId, action, tradeSymbol, lot, sl, tp, entryPrice, comment);
}

//+------------------------------------------------------------------+
//| Hủy lệnh chờ (Pending Order)                                     |
//+------------------------------------------------------------------+
bool CancelPendingOrder(ulong orderTicket)
{
   MqlTradeRequest request;
   MqlTradeResult  result;
   ZeroMemory(request);
   ZeroMemory(result);

   request.action = TRADE_ACTION_REMOVE;
   request.order  = orderTicket;

   ResetLastError();
   bool ok = OrderSend(request, result);
   if(ok && result.retcode == TRADE_RETCODE_DONE)
   {
      Print("✅ [MT5 Pending] Đã hủy thành công lệnh chờ #", orderTicket);
      return true;
   }
   Print("❌ [MT5 Pending] Hủy lệnh chờ #", orderTicket, " thất bại. Retcode: ", result.retcode);
   return false;
}

//+------------------------------------------------------------------+
//| Thực thi lệnh chờ Limit (BUY_LIMIT / SELL_LIMIT)                 |
//+------------------------------------------------------------------+
void ExecutePendingOrder(string orderId, string action, string symbol, double lot, double price, double sl, double tp, string comment)
{
   // 0. Kiểm tra ngắt mạch bảo vệ vốn (Circuit Breaker)
   if(g_circuitBreakerLocked)
   {
      string rejectReason = "Tu choi dat limit: Tai khoan dang bi KHOA BAO VE VON (Circuit Breaker da kich hoat)!";
      Print("🚨 [MT5 Risk] ", rejectReason);
      SendExecutionReport(orderId, "REJECTED", 0, 0, rejectReason);
      return;
   }

   // 1. Kiểm tra quy tắc lệnh chưa đóng nếu không cho phép đồng thời
   int currentPositions = PositionsTotal();
   if(!InpAllowConcurrentOrders && currentPositions > 0)
   {
      string rejectReason = StringFormat("Tu choi dat limit: Dang co %d vi the chua dong! Quy tac: Khong vao lenh moi khi lenh truoc chua dong.", currentPositions);
      Print("⚠️ [MT5 Risk] ", rejectReason);
      SendExecutionReport(orderId, "REJECTED", 0, 0, rejectReason);
      return;
   }

   int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   price = NormalizeDouble(price, digits);
   if(price <= 0)
   {
      string rejectReason = "Gia dat limit khong hop le (<= 0)!";
      Print("⚠️ [MT5 Risk] ", rejectReason);
      SendExecutionReport(orderId, "REJECTED", 0, 0, rejectReason);
      return;
   }

   MqlTradeRequest request;
   MqlTradeResult  result;
   ZeroMemory(request);
   ZeroMemory(result);

   request.action = TRADE_ACTION_PENDING;
   request.symbol = symbol;
   request.volume = lot;
   request.magic  = InpMagicNumber;
   request.price  = price;

   uint filling = (uint)SymbolInfoInteger(symbol, SYMBOL_FILLING_MODE);
   if((filling & SYMBOL_FILLING_FOK) != 0) request.type_filling = ORDER_FILLING_FOK;
   else if((filling & SYMBOL_FILLING_IOC) != 0) request.type_filling = ORDER_FILLING_IOC;
   else request.type_filling = ORDER_FILLING_RETURN;

   if(action == "BUY_LIMIT")
   {
      request.type = ORDER_TYPE_BUY_LIMIT;
   }
   else if(action == "SELL_LIMIT")
   {
      request.type = ORDER_TYPE_SELL_LIMIT;
   }
   else return;

   if(sl > 0) request.sl = NormalizeDouble(sl, digits);
   if(tp > 0) request.tp = NormalizeDouble(tp, digits);
   request.comment = (comment != "") ? comment : StringFormat("BotCheckXau_%s", action);

   ResetLastError();
   bool ok = OrderSend(request, result);
   if(ok && (result.retcode == TRADE_RETCODE_DONE || result.retcode == TRADE_RETCODE_PLACED))
   {
      Print("✅ [MT5 Pending] Đã đặt thành công lệnh chờ ", action, " #", result.order, " ", lot, " lot @ ", price, " SL: ", sl, " TP: ", tp);
      SendExecutionReport(orderId, "PLACED", result.order, price, StringFormat("Order #%I64u placed", result.order));
   }
   else
   {
      string errReason = StringFormat("Loi dat limit (retcode %d): %s", result.retcode, result.comment != "" ? result.comment : IntegerToString(result.retcode));
      Print("❌ [MT5 Pending] ", errReason);
      SendExecutionReport(orderId, "FAILED", 0, 0, errReason);
   }
}

//+------------------------------------------------------------------+
//| Thực thi lệnh thị trường (BUY / SELL)                             |
//+------------------------------------------------------------------+
void ExecuteMarketOrder(string orderId, string action, string symbol, double lot, double sl, double tp, double entryPrice, string comment)
{
   // 0. Kiểm tra ngắt mạch bảo vệ vốn (Circuit Breaker)
   if(g_circuitBreakerLocked)
   {
      string rejectReason = "Tu choi khop: Tai khoan dang bi KHOA BAO VE VON (Circuit Breaker da kich hoat do cham nguong lo)!";
      Print("🚨 [MT5 Risk] ", rejectReason);
      SendExecutionReport(orderId, "REJECTED", 0, 0, rejectReason);
      return;
   }

   // 1. Kiểm tra quy tắc lệnh chưa đóng: Nếu đang có vị thế mở thì không cho vào lệnh mới
   int currentPositions = PositionsTotal();
   if(!InpAllowConcurrentOrders && currentPositions > 0)
   {
      string rejectReason = StringFormat("Tu choi khop: Dang co %d vi the chua dong! Quy tac: Khong vao lenh moi khi lenh truoc chua dong.", currentPositions);
      Print("⚠️ [MT5 Risk] ", rejectReason);
      SendExecutionReport(orderId, "REJECTED", 0, 0, rejectReason);
      return;
   }

   // 2. Kiểm tra tổng khối lượng không được vượt quá InpMaxTotalLot (mặc định 0.02)
   double currentTotalLot = 0;
   for(int i = 0; i < currentPositions; i++)
   {
      ulong posTicket = PositionGetTicket(i);
      if(posTicket > 0)
      {
         currentTotalLot += PositionGetDouble(POSITION_VOLUME);
      }
   }

   if(NormalizeDouble(currentTotalLot + lot, 2) > InpMaxTotalLot)
   {
      string rejectReason = StringFormat("Tu choi khop: Tong volume (%.2f + %.2f = %.2f lot) vuot muc toi da %.2f lot!",
         currentTotalLot, lot, currentTotalLot + lot, InpMaxTotalLot);
      Print("⚠️ [MT5 Risk] ", rejectReason);
      SendExecutionReport(orderId, "REJECTED", 0, 0, rejectReason);
      return;
   }

   MqlTradeRequest request;
   MqlTradeResult  result;
   ZeroMemory(request);
   ZeroMemory(result);

   ENUM_ORDER_TYPE orderType;
   double price = 0;

   if(action == "BUY")
   {
      orderType = ORDER_TYPE_BUY;
      price = SymbolInfoDouble(symbol, SYMBOL_ASK);
   }
   else if(action == "SELL")
   {
      orderType = ORDER_TYPE_SELL;
      price = SymbolInfoDouble(symbol, SYMBOL_BID);
   }
   else return;

   int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   price = NormalizeDouble(price, digits);

   // Kiểm tra và hiệu chỉnh SL/TP theo giá khớp thực tế (Ask/Bid) của MT5 để tránh Retcode 10016 (Invalid Stops)
   double point = SymbolInfoDouble(symbol, SYMBOL_POINT);
   double stopsLevel = (double)SymbolInfoInteger(symbol, SYMBOL_TRADE_STOPS_LEVEL) * point;
   
   // Xác định khoảng cách dừng lỗ và chốt lời mong muốn
   double slDist = 15.0; // Mặc định 15 giá (Hold dài)
   double tpDist = 30.0; // Mặc định 30 giá (Hold dài)
   
   if(entryPrice > 0 && sl > 0)
      slDist = MathAbs(entryPrice - sl);
   else if(sl > 0)
      slDist = MathAbs(price - sl);
      
   if(entryPrice > 0 && tp > 0)
      tpDist = MathAbs(tp - entryPrice);
   else if(tp > 0)
      tpDist = MathAbs(tp - price);

   // Nhận diện phong cách giao dịch từ comment hoặc khoảng cách đặt lệnh (Scalp M1 vs Hold)
   bool isScalpOrder = (StringFind(comment, "SCALP") >= 0 || StringFind(comment, "M1") >= 0 || (slDist > 0 && slDist <= 7.5));

   // Nếu là lệnh SCALP (hoặc Scalp M1): Tôn trọng SL 7 giá và TP 2-3 giá theo đúng cấu hình
   if(isScalpOrder)
   {
      if(slDist <= 0 || slDist < 3.0) slDist = 7.0; // Mặc định SL 7 giá cho Scalp
      if(tpDist <= 0 || tpDist < 1.0) tpDist = 2.5; // Mặc định TP 2.5 giá cho Scalp
      Print("⚡ [MT5 Scalp] Nhận diện lệnh SCALP M1: SL = ", DoubleToString(slDist, 1), " giá | TP = ", DoubleToString(tpDist, 1), " giá");
   }
   else
   {
      // Chế độ Hold dài mặc định: Tối thiểu 8 giá SL, 15 giá TP
      if(slDist < 8.0) slDist = 15.0;
      if(tpDist < 15.0) tpDist = 30.0;
   }

   // LUÔN TÍNH SL VÀ TP CỐ ĐỊNH THEO GIÁ KHỚP THỰC TẾ (price) TRÊN SÀN MT5
   // Triệt tiêu hoàn toàn hiện tượng trượt giá (Slippage) làm bóp nghẹt khoảng cách SL
   if(action == "BUY")
   {
      sl = price - slDist;
      tp = price + tpDist;

      // Bảo vệ chống vi phạm stopsLevel của sàn
      if(stopsLevel > 0)
      {
         if((price - sl) <= stopsLevel) sl = price - stopsLevel - (10 * point);
         if((tp - price) <= stopsLevel) tp = price + stopsLevel + (10 * point);
      }
   }
   else if(action == "SELL")
   {
      sl = price + slDist;
      tp = price - tpDist;

      // Bảo vệ chống vi phạm stopsLevel của sàn
      if(stopsLevel > 0)
      {
         if((sl - price) <= stopsLevel) sl = price + stopsLevel + (10 * point);
         if((price - tp) <= stopsLevel) tp = price - stopsLevel - (10 * point);
      }
   }

   sl = NormalizeDouble(sl, digits);
   tp = NormalizeDouble(tp, digits);


   request.action       = TRADE_ACTION_DEAL;
   request.symbol       = symbol;
   request.volume       = lot;
   request.type         = orderType;
   request.price        = price;
   request.sl           = sl;
   request.tp           = tp;
   request.deviation    = InpSlippage;
   request.magic        = InpMagicNumber;
   request.comment      = (comment != "") ? comment : "AI_BotCheckXAU";
   request.type_filling = ORDER_FILLING_FOK;

   uint filling = (uint)SymbolInfoInteger(symbol, SYMBOL_FILLING_MODE);
   if((filling & SYMBOL_FILLING_FOK) != 0)
      request.type_filling = ORDER_FILLING_FOK;
   else if((filling & SYMBOL_FILLING_IOC) != 0)
      request.type_filling = ORDER_FILLING_IOC;
   else
      request.type_filling = ORDER_FILLING_RETURN;

   Print("⚡ Đang gửi OrderSend: ", action, " ", lot, " lot ", symbol, " @ ", price, " | SL: ", sl, " | TP: ", tp);

   ResetLastError();
   bool success = OrderSend(request, result);

   if(success && (result.retcode == TRADE_RETCODE_DONE || result.retcode == TRADE_RETCODE_PLACED))
   {
      Print("🎉 KHỚP LỆNH THÀNH CÔNG! Ticket: #", result.order, " | Giá khớp: ", result.price);
      SendExecutionReport(orderId, "FILLED", result.order, result.price, "");
   }
   else
   {
      bool terminalAlgo = (bool)TerminalInfoInteger(TERMINAL_TRADE_ALLOWED);
      bool eaAlgo       = (bool)MQLInfoInteger(MQL_TRADE_ALLOWED);
      bool accountAlgo  = (bool)AccountInfoInteger(ACCOUNT_TRADE_EXPERT);

      string diagReason = "";
      if(!terminalAlgo) diagReason += "[Nut Algo Trading MT5 dang tat] ";
      if(!eaAlgo) diagReason += "[Chua tich Allow Algo Trading trong F7] ";
      if(!accountAlgo) diagReason += "[Tai khoan bi Server chan EA] ";

      string errDesc = StringFormat("Retcode: %d (%s) %s", result.retcode, result.comment, diagReason);
      Print("❌ KHỚP LỆNH THẤT BẠI: ", errDesc);
      SendExecutionReport(orderId, "FAILED", 0, 0, errDesc);
   }
}

//+------------------------------------------------------------------+
//| Báo cáo kết quả khớp lệnh về cho Node.js Bridge                  |
//+------------------------------------------------------------------+
void SendExecutionReport(string orderId, string status, ulong ticket, double price, string errorMsg)
{
   string url = InpBridgeUrl + "/api/mt5/execution";
   string headers = "Content-Type: application/json\r\n";
   
   string jsonPayload = StringFormat(
      "{\"id\":\"%s\",\"status\":\"%s\",\"ticket\":%I64u,\"price\":%.2f,\"error\":\"%s\"}",
      orderId, status, ticket, price, errorMsg
   );

   char postData[];
   StringToCharArray(jsonPayload, postData, 0, WHOLE_ARRAY, CP_UTF8);
   ArrayResize(postData, ArraySize(postData) - 1);

   char resultData[];
   string resultHeaders;
   ResetLastError();
   WebRequest("POST", url, headers, 2000, postData, resultData, resultHeaders);
}

//+------------------------------------------------------------------+
//| Gửi nhịp tim (Heartbeat) và thông tin tài khoản                  |
//+------------------------------------------------------------------+
void SendHeartbeat()
{
   string url = InpBridgeUrl + "/api/mt5/heartbeat";
   string headers = "Content-Type: application/json\r\n";

   double balance = AccountInfoDouble(ACCOUNT_BALANCE);
   double equity  = AccountInfoDouble(ACCOUNT_EQUITY);
   int positions  = PositionsTotal();
   string server  = AccountInfoString(ACCOUNT_SERVER);
   long account   = AccountInfoInteger(ACCOUNT_LOGIN);

   bool terminalAlgo = (bool)TerminalInfoInteger(TERMINAL_TRADE_ALLOWED);
   bool eaAlgo       = (bool)MQLInfoInteger(MQL_TRADE_ALLOWED);
   bool accountAlgo  = (bool)AccountInfoInteger(ACCOUNT_TRADE_EXPERT);

   // 1. Quét danh sách các vị thế đang chạy (Open Positions)
   string openPosJson = "[";
   int openCount = 0;
   for(int i = 0; i < positions; i++)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket > 0)
      {
         string sym = PositionGetString(POSITION_SYMBOL);
         long type = PositionGetInteger(POSITION_TYPE);
         double volume = PositionGetDouble(POSITION_VOLUME);
         double priceOpen = PositionGetDouble(POSITION_PRICE_OPEN);
         double priceCurrent = PositionGetDouble(POSITION_PRICE_CURRENT);
         double sl = PositionGetDouble(POSITION_SL);
         double tp = PositionGetDouble(POSITION_TP);
         double profit = PositionGetDouble(POSITION_PROFIT) + PositionGetDouble(POSITION_SWAP);

         ulong posMagic = PositionGetInteger(POSITION_MAGIC);
         string typeStr = (type == POSITION_TYPE_BUY) ? "BUY" : "SELL";
         if(openCount > 0) openPosJson += ",";
         openPosJson += StringFormat("{\"ticket\":%I64u,\"symbol\":\"%s\",\"type\":\"%s\",\"lot\":%.2f,\"magic\":%I64u,\"open\":%.2f,\"current\":%.2f,\"sl\":%.2f,\"tp\":%.2f,\"profit\":%.2f}",
            ticket, sym, typeStr, volume, posMagic, priceOpen, priceCurrent, sl, tp, profit);
         openCount++;
      }
   }
   openPosJson += "]";

   // 1b. Quét danh sách các lệnh chờ (Pending Orders)
   int totalPending = OrdersTotal();
   string pendingOrdersJson = "[";
   int pendingCount = 0;
   for(int i = 0; i < totalPending; i++)
   {
      ulong orderTicket = OrderGetTicket(i);
      if(orderTicket > 0)
      {
         string pSym = OrderGetString(ORDER_SYMBOL);
         long pType = OrderGetInteger(ORDER_TYPE);
         double pVol = OrderGetDouble(ORDER_VOLUME_CURRENT);
         double pPrice = OrderGetDouble(ORDER_PRICE_OPEN);
         double pSl = OrderGetDouble(ORDER_SL);
         double pTp = OrderGetDouble(ORDER_TP);
         ulong pMagic = OrderGetInteger(ORDER_MAGIC);
         string pTypeStr = (pType == ORDER_TYPE_BUY_LIMIT) ? "BUY_LIMIT" : (pType == ORDER_TYPE_SELL_LIMIT) ? "SELL_LIMIT" : "PENDING";
         if(pendingCount > 0) pendingOrdersJson += ",";
         pendingOrdersJson += StringFormat("{\"ticket\":%I64u,\"symbol\":\"%s\",\"type\":\"%s\",\"lot\":%.2f,\"price\":%.2f,\"sl\":%.2f,\"tp\":%.2f,\"magic\":%I64u}",
            orderTicket, pSym, pTypeStr, pVol, pPrice, pSl, pTp, pMagic);
         pendingCount++;
      }
   }
   pendingOrdersJson += "]";

   // 2. Quét lịch sử các lệnh đã đóng trong ngày hôm nay (Closed Deals)
   MqlDateTime dt;
   TimeCurrent(dt);
   dt.hour = 0;
   dt.min = 0;
   dt.sec = 0;
   datetime startOfDay = StructToTime(dt);
   datetime nowTime = TimeCurrent();

   HistorySelect(startOfDay, nowTime);
   int totalDeals = HistoryDealsTotal();
   double todayProfit = 0.0;
   string closedDealsJson = "[";
   int closedCount = 0;

   for(int i = totalDeals - 1; i >= 0; i--)
   {
      ulong dealTicket = HistoryDealGetTicket(i);
      if(dealTicket > 0)
      {
         ENUM_DEAL_TYPE dType = (ENUM_DEAL_TYPE)HistoryDealGetInteger(dealTicket, DEAL_TYPE);
         if(dType != DEAL_TYPE_BUY && dType != DEAL_TYPE_SELL) continue;

         ENUM_DEAL_ENTRY entry = (ENUM_DEAL_ENTRY)HistoryDealGetInteger(dealTicket, DEAL_ENTRY);
         if(entry == DEAL_ENTRY_OUT || entry == DEAL_ENTRY_INOUT)
         {
            double dealProfit = HistoryDealGetDouble(dealTicket, DEAL_PROFIT) + HistoryDealGetDouble(dealTicket, DEAL_SWAP) + HistoryDealGetDouble(dealTicket, DEAL_COMMISSION);
            todayProfit += dealProfit;

            if(closedCount < 20)
            {
               string dealSym = HistoryDealGetString(dealTicket, DEAL_SYMBOL);
               string dTypeStr = (dType == DEAL_TYPE_BUY) ? "BUY" : "SELL";
               double dealVol = HistoryDealGetDouble(dealTicket, DEAL_VOLUME);
               double dealPrice = HistoryDealGetDouble(dealTicket, DEAL_PRICE);
               datetime dealTime = (datetime)HistoryDealGetInteger(dealTicket, DEAL_TIME);
               string timeStr = TimeToString(dealTime, TIME_MINUTES);

               if(closedCount > 0) closedDealsJson += ",";
               closedDealsJson += StringFormat("{\"ticket\":%I64u,\"symbol\":\"%s\",\"type\":\"%s\",\"lot\":%.2f,\"price\":%.2f,\"profit\":%.2f,\"time\":\"%s\"}",
                  dealTicket, dealSym, dTypeStr, dealVol, dealPrice, dealProfit, timeStr);
               closedCount++;
            }
         }
      }
   }
   closedDealsJson += "]";

   // Lấy giá thị trường thời gian thực (Bid, Ask, Spread) của cặp Vàng trên MT5
   string tradeSym = ResolveSymbol("XAUUSD");
   SymbolSelect(tradeSym, true);
   double symBid = SymbolInfoDouble(tradeSym, SYMBOL_BID);
   double symAsk = SymbolInfoDouble(tradeSym, SYMBOL_ASK);
   long symSpread = SymbolInfoInteger(tradeSym, SYMBOL_SPREAD);
   string marketPriceJson = StringFormat(
      ",\"market_price\":{\"symbol\":\"%s\",\"bid\":%.2f,\"ask\":%.2f,\"spread\":%I64d}",
      tradeSym, symBid, symAsk, symSpread
   );

   string baseJson = StringFormat(
      "{\"balance\":%.2f,\"equity\":%.2f,\"positions_count\":%d,\"server\":\"%s\",\"account\":%I64d,\"terminal_algo\":%s,\"ea_algo\":%s,\"account_algo\":%s,\"today_profit\":%.2f",
      balance, equity, positions, server, account,
      terminalAlgo ? "true" : "false",
      eaAlgo ? "true" : "false",
      accountAlgo ? "true" : "false",
      todayProfit
   );
   string jsonPayload = baseJson + marketPriceJson + ",\"open_positions\":" + openPosJson + ",\"pending_orders\":" + pendingOrdersJson + ",\"closed_deals\":" + closedDealsJson + "}";

   char postData[];
   StringToCharArray(jsonPayload, postData, 0, WHOLE_ARRAY, CP_UTF8);
   ArrayResize(postData, ArraySize(postData) - 1);

   char resultData[];
   string resultHeaders;
   ResetLastError();
   int res = WebRequest("POST", url, headers, 2000, postData, resultData, resultHeaders);
   if(res == 200 && ArraySize(resultData) > 0)
   {
      string responseJson = CharArrayToString(resultData, 0, WHOLE_ARRAY, CP_UTF8);

      // Tự động đồng bộ các thông số Hòa vốn & Khóa lãi từ Node.js .env
      string beTrigStr = ExtractJsonValue(responseJson, "breakeven_trigger_usd");
      if(beTrigStr != "")
      {
         double beTrig = StringToDouble(beTrigStr);
         if(beTrig > 0 && MathAbs(beTrig - g_breakevenTriggerUSD) > 0.01)
         {
            g_breakevenTriggerUSD = beTrig;
            Print("🔄 [SYNC] Đã đồng bộ Breakeven Trigger từ Node.js .env: +$", DoubleToString(g_breakevenTriggerUSD, 1), " USD");
         }
      }

      string beOffStr = ExtractJsonValue(responseJson, "breakeven_offset_usd");
      if(beOffStr != "")
      {
         double beOff = StringToDouble(beOffStr);
         if(beOff > 0) g_breakevenOffsetUSD = beOff;
      }

      string lockTrigStr = ExtractJsonValue(responseJson, "lock_profit_trigger_usd");
      if(lockTrigStr != "")
      {
         double lockTrig = StringToDouble(lockTrigStr);
         if(lockTrig > 0 && MathAbs(lockTrig - g_lockProfitTriggerUSD) > 0.01)
         {
            g_lockProfitTriggerUSD = lockTrig;
            Print("🔄 [SYNC] Đã đồng bộ Lock Profit Trigger (+15u) từ Node.js .env: +$", DoubleToString(g_lockProfitTriggerUSD, 1), " USD");
         }
      }

      string lockOffStr = ExtractJsonValue(responseJson, "lock_profit_offset_usd");
      if(lockOffStr != "")
      {
         double lockOff = StringToDouble(lockOffStr);
         if(lockOff > 0 && MathAbs(lockOff - g_lockProfitOffsetUSD) > 0.01)
         {
            g_lockProfitOffsetUSD = lockOff;
            Print("🔄 [SYNC] Đã đồng bộ Lock Profit Offset (+6u) từ Node.js .env: +$", DoubleToString(g_lockProfitOffsetUSD, 1), " USD");
         }
      }
   }
   else if(res != 200)
   {
      Print("⚠️ [SendHeartbeat] WebRequest loi: res=", res, ", err=", GetLastError(), " len=", StringLen(jsonPayload));
   }
}

//+------------------------------------------------------------------+
//| Nhận diện mã Symbol chuẩn của Sàn (XAU/USD hoặc GOLD)            |
//+------------------------------------------------------------------+
string ResolveSymbol(string baseSymbol)
{
   // 1. Danh sách các dạng symbol XAU/USD và GOLD phổ biến của các sàn
   string candidates[] = {
      baseSymbol,                     // "XAUUSD"
      baseSymbol + "m",               // "XAUUSDm"
      baseSymbol + ".raw",            // "XAUUSD.raw"
      baseSymbol + ".pro",            // "XAUUSD.pro"
      baseSymbol + ".ecn",            // "XAUUSD.ecn"
      baseSymbol + ".c",              // "XAUUSD.c"
      baseSymbol + ".a",              // "XAUUSD.a"
      "GOLD",                         // "GOLD"
      "GOLDm",                        // "GOLDm"
      "GOLD.raw",                     // "GOLD.raw"
      "GOLD.pro"                      // "GOLD.pro"
   };

   for(int i = 0; i < ArraySize(candidates); i++)
   {
      ResetLastError();
      // Kiểm tra symbol có tồn tại và lấy được giá Bid không
      if(SymbolInfoDouble(candidates[i], SYMBOL_BID) > 0 || SymbolInfoInteger(candidates[i], SYMBOL_SELECT))
      {
         return candidates[i];
      }
   }

   // 2. Kiểm tra nếu chart hiện tại là XAUUSD hoặc GOLD (bắt buộc phải có cả XAU và USD, hoặc GOLD; tránh XAUEUR/XAUGBP)
   string curSym = _Symbol;
   if((StringFind(curSym, "XAU") >= 0 && StringFind(curSym, "USD") >= 0) || StringFind(curSym, "GOLD") >= 0)
   {
      return curSym;
   }

   return baseSymbol;
}

//+------------------------------------------------------------------+
//| Hàm trích xuất giá trị trường đơn giản từ chuỗi JSON             |
//+------------------------------------------------------------------+
string ExtractJsonValue(string json, string key)
{
   string searchPattern = "\"" + key + "\":";
   int startPos = StringFind(json, searchPattern);
   if(startPos < 0) return "";

   startPos += StringLen(searchPattern);

   while(startPos < StringLen(json) && (StringGetCharacter(json, startPos) == ' ' || StringGetCharacter(json, startPos) == '\t'))
   {
      startPos++;
   }

   if(StringGetCharacter(json, startPos) == '\"')
   {
      startPos++;
      int endPos = StringFind(json, "\"", startPos);
      if(endPos < 0) return "";
      return StringSubstr(json, startPos, endPos - startPos);
   }
   else
   {
      int endPos = startPos;
      while(endPos < StringLen(json))
      {
         ushort ch = StringGetCharacter(json, endPos);
         if(ch == ',' || ch == '}' || ch == '\r' || ch == '\n' || ch == ' ') break;
         endPos++;
      }
      return StringSubstr(json, startPos, endPos - startPos);
   }
}
