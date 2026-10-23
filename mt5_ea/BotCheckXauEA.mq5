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

input group "=== QUẢN LÝ DỜI SL HÒA VỐN (BREAKEVEN) & CHỐT LỜI ==="
input bool     InpEnableBreakeven      = true;                    // Kích hoạt tự động dời SL về hòa vốn
input double   InpBreakevenTriggerUSD  = 2.0;                     // Đạt lãi từ bao nhiêu USD thì dời SL (mặc định 2.0 USD)
input double   InpBreakevenOffsetUSD   = 0.2;                     // Offset bảo vệ phí sàn/spread (mặc định 0.2 USD)
input double   InpAutoCloseProfitUSD   = 0.0;                     // Cắt lệnh theo lợi nhuận USD (đặt 0.0 để tắt, cho lệnh chạy tới TP 6.0 USD)

input group "=== BẢO VỆ VỐN & NGẮT MẠCH KHẨN CẤP (CIRCUIT BREAKER) ==="
input bool     InpEnableCircuitBreaker = true;                    // Kích hoạt ngắt mạch bảo vệ vốn khi chạm ngưỡng lỗ
input double   InpInitialCapitalUSD    = 1000.0;                  // Vốn mục tiêu/vốn cơ sở (1000 USD)
input double   InpMaxLossUSD           = 300.0;                   // Mức lỗ tối đa cho phép dừng giao dịch (300 USD)
input double   InpMaxDrawdownPercent   = 30.0;                    // Mức sụt giảm tối đa (% vốn cơ sở, 30%)
input bool     InpCloseAllOnBreach     = true;                    // Tự động đóng tất cả vị thế khi vi phạm ngưỡng lỗ

// Biến lưu thời gian nhịp tim gần nhất (dùng mili-giây độc lập với tick thị trường)
ulong  g_lastHeartbeatMs = 0;
bool   g_circuitBreakerLocked = false;
double g_startEquity = 0.0;
double g_peakEquity = 0.0;


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
   Print("🛡️ [BẢO VỆ VỐN] Mốc vốn ban đầu: $", DoubleToString(g_startEquity, 2), 
         " USD | Ngưỡng lỗ tối đa: -$", DoubleToString(InpMaxLossUSD, 2), " USD (", DoubleToString(InpMaxDrawdownPercent, 1), "%)");

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

   if(g_startEquity <= 0)
   {
      g_startEquity = equity;
      g_peakEquity  = equity;
   }

   if(equity > g_peakEquity) g_peakEquity = equity;

   // 1. Sụt giảm từ đỉnh (Peak Drawdown)
   double peakDrawdown = g_peakEquity - equity;
   // 2. Sụt giảm từ đầu phiên chạy (Session Drawdown)
   double sessionDrawdown = g_startEquity - equity;
   double currentDrawdown = MathMax(peakDrawdown, sessionDrawdown);

   bool isBreached = false;
   string reason = "";

   if(currentDrawdown >= InpMaxLossUSD)
   {
      isBreached = true;
      reason = StringFormat("Sut giam -$%.2f USD vuot nguong lo cho phep -$%.2f USD!", currentDrawdown, InpMaxLossUSD);
   }
   else if(InpMaxDrawdownPercent > 0)
   {
      double baseCapital = (InpInitialCapitalUSD > 0 && MathAbs(equity - InpInitialCapitalUSD) < InpInitialCapitalUSD)
                           ? InpInitialCapitalUSD
                           : g_peakEquity;
      if(baseCapital > 0)
      {
         double ddPct = (baseCapital - equity) / baseCapital * 100.0;
         if(ddPct >= InpMaxDrawdownPercent)
         {
            isBreached = true;
            reason = StringFormat("Sut giam -%.1f%% vuot nguong toi da -%.1f%% von (Co so: $%.2f USD)!", ddPct, InpMaxDrawdownPercent, baseCapital);
         }
      }
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
//| Tự động quét và dời SL về mức hòa vốn (Breakeven)               |
//+------------------------------------------------------------------+
void CheckAndApplyBreakeven()
{
   if(!InpEnableBreakeven || InpBreakevenTriggerUSD <= 0) return;

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
      if(profit < InpBreakevenTriggerUSD) continue;

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
         // Với lệnh BUY: SL hòa vốn = Giá vào + InpBreakevenOffsetUSD
         targetSl = openPrice + InpBreakevenOffsetUSD;

         // Nếu SL hiện tại chưa có (currentSl <= 0) hoặc SL hiện tại còn dưới mức hòa vốn
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
         // Với lệnh SELL: SL hòa vốn = Giá vào - InpBreakevenOffsetUSD
         targetSl = openPrice - InpBreakevenOffsetUSD;

         // Nếu SL hiện tại chưa có (currentSl <= 0) hoặc SL hiện tại còn trên mức hòa vốn
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
            Print("🛡️ [DỜI SL HÒA VỐN] Thành công! Ticket #", ticket, " SL đã dời về ", targetSl, 
                  " (Giá vào: ", openPrice, ", Lãi hiện tại: +$", DoubleToString(profit, 2), " USD)");
            SendExecutionReport(IntegerToString(ticket), "BREAKEVEN", ticket, targetSl, 
                  StringFormat("SL hoa von: %.2f (Lai: +$%.2f USD)", targetSl, profit));
         }
         else
         {
            Print("⚠️ [DỜI SL HÒA VỐN] Thất bại lệnh #", ticket, "! Retcode: ", result.retcode, " (", result.comment, ") Err: ", GetLastError());
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

   string tradeSymbol = ResolveSymbol(symbol);
   ExecuteMarketOrder(orderId, action, tradeSymbol, lot, sl, tp, entryPrice, comment);
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
   
   // Xác định khoảng cách dừng lỗ và chốt lời mong muốn (tính theo USD)
   double slDist = 4.0; // Mặc định 4 giá (SL 4 USD)
   double tpDist = 6.0; // Mặc định 6 giá (TP 6 USD, R:R 1:1.5)
   
   if(entryPrice > 0 && sl > 0)
      slDist = MathAbs(entryPrice - sl);
   else if(sl > 0)
      slDist = MathAbs(price - sl);
      
   if(entryPrice > 0 && tp > 0)
      tpDist = MathAbs(tp - entryPrice);
   else if(tp > 0)
      tpDist = MathAbs(tp - price);

   // Đảm bảo khoảng cách hợp lý
   if(slDist < 1.0) slDist = 4.0;
   if(tpDist < 0.5) tpDist = 6.0;

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
   string jsonPayload = baseJson + marketPriceJson + ",\"open_positions\":" + openPosJson + ",\"closed_deals\":" + closedDealsJson + "}";

   char postData[];
   StringToCharArray(jsonPayload, postData, 0, WHOLE_ARRAY, CP_UTF8);
   ArrayResize(postData, ArraySize(postData) - 1);

   char resultData[];
   string resultHeaders;
   ResetLastError();
   int res = WebRequest("POST", url, headers, 2000, postData, resultData, resultHeaders);
   if(res != 200)
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
