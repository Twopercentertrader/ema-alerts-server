const https = require('https');
const http  = require('http');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const NTFY_CHANNEL   = process.env.NTFY_CHANNEL || 'twopercenter_onlylearning_2k26_';
const NTFY_SERVER    = 'ntfy.sh';
const SCAN_INTERVAL  = 30 * 60 * 1000; // 30 minutes
const TOP_N          = 50;
const THRESHOLD      = 1.0;
const CHOP_SPREAD    = 0.2;
const SL_BUF         = 0.002;
const TP_RR          = 1.5;
const RISK_USD       = 2;

// PHT = UTC+8
// London open = 3PM PHT (07:00 UTC)
// NY close    = 4AM PHT (20:00 UTC previous day)
const LONDON_OPEN_UTC = 7;
const NY_CLOSE_UTC    = 20;

const BASES = ['https://api.bybit.com', 'https://api.bytick.com'];

// Track seen signals to only notify NEW ones
const seenSignals = new Set();

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function isWithinTradingWindow() {
  const utcHour = new Date().getUTCHours();
  // London open to NY close: 07:00 UTC to 20:00 UTC
  return utcHour >= LONDON_OPEN_UTC || utcHour <= NY_CLOSE_UTC;
}

function fetch(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, { headers: { 'Accept': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function fetchAPI(path) {
  for (const base of BASES) {
    try {
      const data = await fetch(`${base}${path}`);
      return data;
    } catch(e) {}
  }
  throw new Error('All API endpoints failed');
}

// ─── EMA ──────────────────────────────────────────────────────────────────────
function calcEMA(prices, period) {
  const k = 2 / (period + 1);
  const r = [prices[0]];
  for (let i = 1; i < prices.length; i++)
    r.push(prices[i] * k + r[i-1] * (1-k));
  return r;
}

function analyseTrend(closes) {
  if (!closes || closes.length < 110) return 'unknown';
  const e20  = calcEMA(closes, 20);
  const e50  = calcEMA(closes, 50);
  const e100 = calcEMA(closes, 100);
  const v20  = e20[e20.length-1];
  const v50  = e50[e50.length-1];
  const v100 = e100[e100.length-1];
  const s1 = Math.abs(v20-v50)/v50*100;
  const s2 = Math.abs(v50-v100)/v100*100;
  if (s1 < CHOP_SPREAD && s2 < CHOP_SPREAD) return 'chop';
  if (v20 > v50 && v50 > v100) return 'uptrend';
  if (v20 < v50 && v50 < v100) return 'downtrend';
  return 'chop';
}

function checkEntry(closes, direction) {
  if (!closes || closes.length < 110) return null;
  const e20s  = calcEMA(closes, 20);
  const e50s  = calcEMA(closes, 50);
  const e100s = calcEMA(closes, 100);
  const price = closes[closes.length-1];
  const v20   = e20s[e20s.length-1];
  const v50   = e50s[e50s.length-1];
  const v100  = e100s[e100s.length-1];

  if (direction === 'long') {
    if (!(v20 > v50 && v50 > v100)) return null;
    if (price > v20) {
      const dist = (price - v20) / v20 * 100;
      if (dist <= THRESHOLD * 0.35) return { level: 'green', dist, status: 'Touching', ema20: v20, ema50: v50, ema100: v100, price };
    }
    if (price > v50 && price <= v20) {
      const dist = Math.abs(price - v50) / v50 * 100;
      if (dist <= THRESHOLD * 0.35) return { level: 'yellow', dist, status: 'Touching', ema20: v20, ema50: v50, ema100: v100, price };
    }
    if (price > v100 && price <= v50) {
      const dist = Math.abs(price - v100) / v100 * 100;
      if (dist <= THRESHOLD * 0.35) return { level: 'red', dist, status: 'Touching', ema20: v20, ema50: v50, ema100: v100, price };
    }
  }

  if (direction === 'short') {
    if (!(v20 < v50 && v50 < v100)) return null;
    if (price < v20) {
      const dist = (v20 - price) / v20 * 100;
      if (dist <= THRESHOLD * 0.35) return { level: 'green', dist, status: 'Touching', ema20: v20, ema50: v50, ema100: v100, price };
    }
    if (price < v50 && price >= v20) {
      const dist = Math.abs(price - v50) / v50 * 100;
      if (dist <= THRESHOLD * 0.35) return { level: 'yellow', dist, status: 'Touching', ema20: v20, ema50: v50, ema100: v100, price };
    }
    if (price < v100 && price >= v50) {
      const dist = Math.abs(price - v100) / v100 * 100;
      if (dist <= THRESHOLD * 0.35) return { level: 'red', dist, status: 'Touching', ema20: v20, ema50: v50, ema100: v100, price };
    }
  }
  return null;
}

// ─── BTC HEALTH ───────────────────────────────────────────────────────────────
async function checkBTCHealth() {
  try {
    const [d4h, d1h] = await Promise.all([
      fetchAPI('/v5/market/kline?category=linear&symbol=BTCUSDT&interval=240&limit=200'),
      fetchAPI('/v5/market/kline?category=linear&symbol=BTCUSDT&interval=60&limit=200'),
    ]);
    const c4h = [...d4h.result.list].reverse().map(r => parseFloat(r[4]));
    const c1h = [...d1h.result.list].reverse().map(r => parseFloat(r[4]));
    const t4h = analyseTrend(c4h);
    const t1h = analyseTrend(c1h);

    // Check price position on 1H
    const e20_1h = calcEMA(c1h, 20);
    const price1h = c1h[c1h.length-1];
    const priceAboveEMA20_1h = price1h > e20_1h[e20_1h.length-1];

    if (t4h === 'uptrend' && t1h === 'uptrend' && priceAboveEMA20_1h) return 'bullish';
    if (t4h === 'downtrend' && t1h === 'downtrend' && !priceAboveEMA20_1h) return 'bearish';
    return 'weak';
  } catch(e) {
    console.error('BTC health error:', e.message);
    return 'unknown';
  }
}

// ─── POSITION SIZING ──────────────────────────────────────────────────────────
function calcPositionSize(price, entry, direction) {
  const buf = SL_BUF;
  let sl;
  if (direction === 'long') {
    if (entry.level === 'green')       sl = entry.ema50  * (1 - buf);
    else if (entry.level === 'yellow') sl = entry.ema100 * (1 - buf);
    else                               sl = entry.ema100 * (1 - 0.015);
    if (sl >= price) sl = price * (1 - 0.005);
  } else {
    if (entry.level === 'green')       sl = entry.ema50  * (1 + buf);
    else if (entry.level === 'yellow') sl = entry.ema100 * (1 + buf);
    else                               sl = entry.ema100 * (1 + 0.015);
    if (sl <= price) sl = price * (1 + 0.005);
  }
  const slPct = Math.abs(price - sl) / price * 100;
  const tp = direction === 'long'
    ? price * (1 + (slPct/100) * TP_RR)
    : price * (1 - (slPct/100) * TP_RR);
  return { sl: sl.toFixed(6), tp: tp.toFixed(6), slPct: slPct.toFixed(2) };
}

function fmt(p) {
  if (!p) return '';
  if (p < 0.001) return p.toFixed(6);
  if (p < 1)     return p.toFixed(4);
  if (p < 100)   return p.toFixed(3);
  return p.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

// ─── NTFY NOTIFICATION ────────────────────────────────────────────────────────
function sendNotification(title, message, priority = 'high', tags = '') {
  return new Promise((resolve) => {
    const body = Buffer.from(message);
    const options = {
      hostname: NTFY_SERVER,
      port: 443,
      path: `/${NTFY_CHANNEL}`,
      method: 'POST',
      headers: {
        'Title': title,
        'Priority': priority,
        'Tags': tags,
        'Content-Type': 'text/plain',
        'Content-Length': body.length,
      }
    };

    const req = https.request(options, (res) => {
      console.log(`Notification sent: ${title} (${res.statusCode})`);
      resolve();
    });

    req.on('error', (e) => {
      console.error('Notification error:', e.message);
      resolve();
    });

    req.write(body);
    req.end();
  });
}

// ─── MAIN SCAN ────────────────────────────────────────────────────────────────
async function runScan() {
  const now = new Date();
  const phtHour = (now.getUTCHours() + 8) % 24;
  const phtMin  = now.getUTCMinutes().toString().padStart(2, '0');
  console.log(`\n[${now.toISOString()}] PHT ${phtHour}:${phtMin} — Starting scan...`);

  try {
    // Check BTC health first
    const btcHealth = await checkBTCHealth();
    console.log(`BTC Health: ${btcHealth}`);

    if (btcHealth !== 'bullish' && btcHealth !== 'bearish') {
      console.log('BTC not clean  skipping scan');
      return;
    }

    // Check trading window
    const inWindow = isWithinTradingWindow();
    console.log(`Trading window: ${inWindow ? 'ACTIVE (London/NY)' : 'INACTIVE (Asia)'}`);

    // Get top symbols
    const tickers = await fetchAPI('/v5/market/tickers?category=linear');
    const symbols = tickers.result.list
      .filter(t => t.symbol.endsWith('USDT') && parseFloat(t.turnover24h) > 0)
      .sort((a,b) => parseFloat(b.turnover24h) - parseFloat(a.turnover24h))
      .slice(0, TOP_N)
      .map(t => t.symbol);

    console.log(`Scanning ${symbols.length} symbols...`);

    const newSignals = [];

    for (const symbol of symbols) {
      try {
        const [d4h, d1h, d15m] = await Promise.all([
          fetchAPI(`/v5/market/kline?category=linear&symbol=${symbol}&interval=240&limit=200`),
          fetchAPI(`/v5/market/kline?category=linear&symbol=${symbol}&interval=60&limit=200`),
          fetchAPI(`/v5/market/kline?category=linear&symbol=${symbol}&interval=15&limit=200`),
        ]);

        const c4h  = [...d4h.result.list].reverse().map(r => parseFloat(r[4]));
        const c1h  = [...d1h.result.list].reverse().map(r => parseFloat(r[4]));
        const c15m = [...d15m.result.list].reverse().map(r => parseFloat(r[4]));

        if (c4h.length < 110 || c1h.length < 110 || c15m.length < 110) continue;

        const t4h = analyseTrend(c4h);
        const t1h = analyseTrend(c1h);

        if (t4h === 'chop' || t1h === 'chop' || t4h === 'unknown' || t1h === 'unknown') continue;
        if (t4h !== t1h) continue;

        const direction = t4h === 'uptrend' ? 'long' : 'short';

        // BTC filter — only longs when bullish, only shorts when bearish
        if (direction === 'long'  && btcHealth !== 'bullish') continue;
        if (direction === 'short' && btcHealth !== 'bearish') continue;

        const entry = checkEntry(c15m, direction);
        if (!entry) continue;

        // Signal key for dedup
        const key = `${symbol}_${direction}_${entry.level}`;
        const isNew = !seenSignals.has(key);
        seenSignals.add(key);

        const ps = calcPositionSize(entry.price, entry, direction);
        const levelLabel = entry.level === 'green' ? ' EMA20' : entry.level === 'yellow' ? ' EMA50' : ' EMA100';
        const dirLabel   = direction === 'long' ? ' LONG' : ' SHORT';
        const base       = symbol.replace('USDT', '');

        console.log(`  ${isNew ? 'NEW' : 'repeat'} | ${symbol} ${dirLabel} ${levelLabel} | dist: ${entry.dist.toFixed(2)}%`);

        // Only notify if NEW + in window
        if (isNew && inWindow) {
          newSignals.push({
            symbol, base, direction, entry, ps, levelLabel, dirLabel, key
          });
        }

        await new Promise(r => setTimeout(r, 80));
      } catch(e) {
        console.error(`  Error scanning ${symbol}:`, e.message);
      }
    }

    // Send notifications
    if (newSignals.length === 0) {
      console.log('No new precision signals this scan.');
    } else {
      console.log(`Sending ${newSignals.length} notifications...`);
      for (const sig of newSignals) {
        const emoji  = sig.direction === 'long' ? '' : '';
        const title  = `${emoji} ${sig.base}/USDT — ${sig.dirLabel} ${sig.levelLabel}`;
        const msg    = `Touching EMA | 4H+1H ${sig.direction === 'long' ? 'Uptrend' : 'Downtrend'} | BTC ${btcHealth}\nEntry: $${fmt(sig.entry.price)} | Stop: $${sig.ps.sl} | Target: $${sig.ps.tp}\nDist: ${sig.entry.dist.toFixed(2)}% | Risk: $${RISK_USD} | Reward: $${(RISK_USD * TP_RR).toFixed(2)}`;
        const tags   = sig.direction === 'long' ? 'chart_with_upwards_trend' : 'chart_with_downwards_trend';
        await sendNotification(title, msg, 'urgent', tags);
        await new Promise(r => setTimeout(r, 500));
      }
    }

  } catch(e) {
    console.error('Scan error:', e.message);
  }

  console.log('Scan complete.');
}

// ─── KEEP ALIVE SERVER (required by Render free tier) ─────────────────────────
const server = http.createServer(async (req, res) => {
  if (req.url === '/test') {
    // Send test notification
    await sendNotification(
      'EMA Server Test',
      'Your EMA Precision Alert Server is working! Notifications will fire during London+NY session when BTC is bullish and a Touching signal is detected.',
      'high',
      'white_check_mark'
    );
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Test notification sent! Check your ntfy app. ');
  } else if (req.url === '/scan') {
    // Trigger manual scan
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Manual scan triggered! Check logs.');
    runScan();
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('EMA Precision Scanner running - OK\n\nEndpoints:\n/test - send test notification\n/scan - trigger manual scan');
  }
});
server.listen(process.env.PORT || 3000, () => {
  console.log('Keep-alive server running on port', process.env.PORT || 3000);
});

// ─── SELF PING (prevents Render free tier from sleeping) ─────────────────────
function selfPing() {
  const url = process.env.RENDER_EXTERNAL_URL || 'https://ema-alerts-server.onrender.com';
  https.get(url, (res) => {
    console.log('[Self-ping] Status:', res.statusCode);
  }).on('error', (e) => {
    console.error('[Self-ping] Error:', e.message);
  });
}
// Ping every 4 minutes to stay awake
setInterval(selfPing, 4 * 60 * 1000);

// ─── START ────────────────────────────────────────────────────────────────────
console.log(' EMA Precision Alert Server started');
console.log(`📱 Notifications → ntfy.sh/${NTFY_CHANNEL}`);
console.log(`⏱  Scan interval: 30 minutes`);
console.log(`🌍 Active window: London + NY session`);

runScan(); // run immediately on start
setInterval(runScan, SCAN_INTERVAL); // then every 30 mins
