/**
 * Lấy giá thị trường thời gian thực cho XAU/USD (Ưu tiên MT5 Live -> TradingView -> Yahoo Finance)
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

export async function getCurrentXAUPrice(symbol = 'OANDA:XAUUSD', bridgeServer = null) {
  // 1. ƯU TIÊN SỐ 1: Lấy trực tiếp từ MT5 EA (giá sàn thực tế, độ trễ 0ms)
  try {
    const mt5 = bridgeServer?.getLatestMarketPrice ? bridgeServer.getLatestMarketPrice() : null;
    if (mt5 && mt5.bid && mt5.bid > 0) {
      const mid = ((mt5.bid + (mt5.ask || mt5.bid)) / 2).toFixed(2);
      return {
        price: mid,
        bid: Number(mt5.bid).toFixed(2),
        ask: Number(mt5.ask || mt5.bid).toFixed(2),
        spread: Number(mt5.spread || 0),
        symbol: mt5.symbol || 'XAUUSD',
        source: 'MT5',
        server: mt5.server || 'MT5 Live Broker',
        change: 'Live MT5',
        high: '-',
        low: '-'
      };
    }
  } catch (err) {
    console.warn('[MarketData] Không lấy được giá MT5, chuyển sang TradingView:', err.message);
  }

  // 2. NGUỒN DỰ PHÒNG 1: TradingView CFD Scanner
  try {
    const res = await fetch('https://scanner.tradingview.com/cfd/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbols: { tickers: [symbol] },
        columns: ['close', 'change', 'high', 'low']
      })
    });
    const json = await res.json();
    if (json.data && json.data[0] && json.data[0].d) {
      const [price, change, high, low] = json.data[0].d;
      return {
        price: Number(price).toFixed(2),
        bid: Number(price).toFixed(2),
        ask: Number(price).toFixed(2),
        spread: 0,
        symbol,
        source: 'TradingView',
        server: 'TradingView (OANDA)',
        change: (Number(change) >= 0 ? '+' : '') + Number(change).toFixed(2) + '%',
        high: Number(high).toFixed(2),
        low: Number(low).toFixed(2)
      };
    }
  } catch (err) {
    console.warn('[MarketData] Lỗi lấy giá TradingView, thử fallback Yahoo:', err.message);
  }

  // 3. NGUỒN DỰ PHÒNG 2: Yahoo Finance (COMEX Gold)
  try {
    const res = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=1m&range=1d');
    const json = await res.json();
    const meta = json.chart?.result?.[0]?.meta;
    if (meta && meta.regularMarketPrice) {
      return {
        price: Number(meta.regularMarketPrice).toFixed(2),
        bid: Number(meta.regularMarketPrice).toFixed(2),
        ask: Number(meta.regularMarketPrice).toFixed(2),
        spread: 0,
        symbol: 'GC=F',
        source: 'YahooFinance',
        server: 'Yahoo Finance (COMEX)',
        change: 'N/A',
        high: Number(meta.regularMarketDayHigh || meta.regularMarketPrice).toFixed(2),
        low: Number(meta.regularMarketDayLow || meta.regularMarketPrice).toFixed(2)
      };
    }
  } catch (err) {
    console.error('[MarketData] Lỗi fallback Yahoo:', err.message);
  }

  return null;
}
