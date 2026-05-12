const https = require('https');
const http  = require('http');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const NTFY_CHANNEL  = process.env.NTFY_CHANNEL || 'twopercenter_onlylearning_2k26_';
const SCAN_INTERVAL = 30 * 60 * 1000;
const TOP_N         = 30;
const THRESHOLD     = 1.0;
const CHOP_SPREAD   = 0.2;
const SL_BUF        = 0.002;
const TP_RR         = 1.5;
const RISK_USD      = 2;

// London open = 07:00 UTC = 15:00 PHT
// NY close    = 20:00 UTC = 04:00 PHT
const LONDON_OPEN_UTC = 7;
const NY_CLOSE_UTC    = 20;

const seenSignals = new Set();

// ─── HTTP FETCH ───────────────────────────────────────────────────────────────
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const options = {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json',
      }
    };
    const req = client.get(url, options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch(e) { reject(new Error('JSON parse error')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function fetchAPI(path) {
  const bases = ['https://api.bybit.com', 'https://api.bytick.com'];
  for (const base of bases) {
    try {
      const data = await fetchUrl(`${base}${path}`);
      if (data?.retCode === 0) return data;
    } catch(e) {
      console.log(`  ${base} error: ${e.message}`);
    }
  }
  throw new Error('All endpoints failed');
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function isWithinWindow() {
  const h = new Date().getUTCHours();
  return h >= LONDON_OPEN_UTC || h <= NY_CLOSE_UTC;
}

function calcEMA(prices, period) {
  const k = 2 / (period + 1);
  const r = [prices[0]];
  for (let i = 1; i < prices.length; i++) r.push(prices[i] * k + r[i-1] * (1-k));
  return r;
}

function trend(closes) {
  if (!closes || closes.length < 110) return 'unknown';
  const e20 = calcEMA(closes, 20), e50 = calcEMA(closes, 50), e100 = calcEMA(closes, 100);
  const v20 = e20[e20.length-1], v50 = e50[e50.length-1], v100 = e100[e100.length-1];
  if (Math.abs(v20-v50)/v50*100 < CHOP_SPREAD && Math.abs(v50-v100)/v100*100 < CHOP_SPREAD) return 'chop';
  if (v20 > v50 && v50 > v100) return 'uptrend';
  if (v20 < v50 && v50 < v100) return 'downtrend';
  return 'chop';
}

function checkEntry(closes, dir) {
  if (!closes || closes.length < 110) return null;
  const e20s = calcEMA(closes,20), e50s = calcEMA(closes,50), e100s = calcEMA(closes,100);
  const price = closes[closes.length-1];
  const v20 = e20s[e20s.length-1], v50 = e50s[e50s.length-1], v100 = e100s[e100s.length-1];
  const TOUCH = THRESHOLD * 0.35;

  if (dir === 'long') {
    if (!(v20>v50&&v50>v100)) return null;
    if (price>v20 && (price-v20)/v20*100 <= TOUCH) return {level:'green',dist:(price-v20)/v20*100,v20,v50,v100,price};
    if (price>v50&&price<=v20 && Math.abs(price-v50)/v50*100<=TOUCH) return {level:'yellow',dist:Math.abs(price-v50)/v50*100,v20,v50,v100,price};
    if (price>v100&&price<=v50 && Math.abs(price-v100)/v100*100<=TOUCH) return {level:'red',dist:Math.abs(price-v100)/v100*100,v20,v50,v100,price};
  }
  if (dir === 'short') {
    if (!(v20<v50&&v50<v100)) return null;
    if (price<v20 && (v20-price)/v20*100<=TOUCH) return {level:'green',dist:(v20-price)/v20*100,v20,v50,v100,price};
    if (price<v50&&price>=v20 && Math.abs(price-v50)/v50*100<=TOUCH) return {level:'yellow',dist:Math.abs(price-v50)/v50*100,v20,v50,v100,price};
    if (price<v100&&price>=v50 && Math.abs(price-v100)/v100*100<=TOUCH) return {level:'red',dist:Math.abs(price-v100)/v100*100,v20,v50,v100,price};
  }
  return null;
}

function calcSLTP(entry, dir) {
  let sl;
  if (dir === 'long') {
    if (entry.level==='green') sl = entry.v50*(1-SL_BUF);
    else if (entry.level==='yellow') sl = entry.v100*(1-SL_BUF);
    else sl = entry.v100*(1-0.015);
    if (sl >= entry.price) sl = entry.price*(1-0.005);
  } else {
    if (entry.level==='green') sl = entry.v50*(1+SL_BUF);
    else if (entry.level==='yellow') sl = entry.v100*(1+SL_BUF);
    else sl = entry.v100*(1+0.015);
    if (sl <= entry.price) sl = entry.price*(1+0.005);
  }
  const slPct = Math.abs(entry.price-sl)/entry.price*100;
  const tp = dir==='long' ? entry.price*(1+(slPct/100)*TP_RR) : entry.price*(1-(slPct/100)*TP_RR);
  return {sl:sl.toFixed(6), tp:tp.toFixed(6), slPct:slPct.toFixed(2)};
}

function fmt(p) {
  if (!p) return '0';
  if (p<0.001) return p.toFixed(6);
  if (p<1) return p.toFixed(4);
  if (p<100) return p.toFixed(3);
  return Math.round(p).toLocaleString();
}

// ─── NOTIFY ───────────────────────────────────────────────────────────────────
function notify(title, body, priority='high') {
  return new Promise((resolve) => {
    const buf = Buffer.from(body);
    const req = https.request({
      hostname: 'ntfy.sh',
      port: 443,
      path: `/${NTFY_CHANNEL}`,
      method: 'POST',
      headers: {
        'Title': title,
        'Priority': priority,
        'Content-Type': 'text/plain',
        'Content-Length': buf.length,
      }
    }, (res) => { console.log(`Notified: ${title} (${res.statusCode})`); resolve(); });
    req.on('error', (e) => { console.error('Notify error:', e.message); resolve(); });
    req.write(buf);
    req.end();
  });
}

// ─── BTC HEALTH ───────────────────────────────────────────────────────────────
async function btcHealth() {
  try {
    const [d4h, d1h] = await Promise.all([
      fetchAPI('/v5/market/kline?category=linear&symbol=BTCUSDT&interval=240&limit=200'),
      fetchAPI('/v5/market/kline?category=linear&symbol=BTCUSDT&interval=60&limit=200'),
    ]);
    const c4h = [...d4h.result.list].reverse().map(r=>parseFloat(r[4]));
    const c1h = [...d1h.result.list].reverse().map(r=>parseFloat(r[4]));
    const t4h = trend(c4h), t1h = trend(c1h);
    const e20_1h = calcEMA(c1h,20);
    const priceAbove = c1h[c1h.length-1] > e20_1h[e20_1h.length-1];
    if (t4h==='uptrend'&&t1h==='uptrend'&&priceAbove) return 'bullish';
    if (t4h==='downtrend'&&t1h==='downtrend'&&!priceAbove) return 'bearish';
    return 'weak';
  } catch(e) {
    console.log('BTC health error:', e.message);
    return 'unknown';
  }
}

// ─── MAIN SCAN ────────────────────────────────────────────────────────────────
async function scan() {
  const now = new Date();
  const phtH = (now.getUTCHours()+8)%24;
  const phtM = now.getUTCMinutes().toString().padStart(2,'0');
  console.log(`\n[${now.toISOString()}] PHT ${phtH}:${phtM} - Scanning...`);

  const health = await btcHealth();
  console.log(`BTC: ${health}`);

  if (health==='unknown') { console.log('BTC unknown - skipping'); return; }
  if (health==='weak')    { console.log('BTC weak - skipping');    return; }

  const inWindow = isWithinWindow();
  console.log(`Window: ${inWindow ? 'ACTIVE' : 'INACTIVE'}`);

  try {
    const tickers = await fetchAPI('/v5/market/tickers?category=linear');
    const symbols = tickers.result.list
      .filter(t=>t.symbol.endsWith('USDT')&&parseFloat(t.turnover24h)>0)
      .sort((a,b)=>parseFloat(b.turnover24h)-parseFloat(a.turnover24h))
      .slice(0,TOP_N).map(t=>t.symbol);

    console.log(`Scanning ${symbols.length} symbols...`);
    const newSigs = [];

    for (const sym of symbols) {
      try {
        const [d4h,d1h,d15] = await Promise.all([
          fetchAPI(`/v5/market/kline?category=linear&symbol=${sym}&interval=240&limit=200`),
          fetchAPI(`/v5/market/kline?category=linear&symbol=${sym}&interval=60&limit=200`),
          fetchAPI(`/v5/market/kline?category=linear&symbol=${sym}&interval=15&limit=200`),
        ]);
        const c4h  = [...d4h.result.list].reverse().map(r=>parseFloat(r[4]));
        const c1h  = [...d1h.result.list].reverse().map(r=>parseFloat(r[4]));
        const c15  = [...d15.result.list].reverse().map(r=>parseFloat(r[4]));
        const t4h  = trend(c4h), t1h = trend(c1h);
        if (t4h==='chop'||t4h==='unknown'||t1h==='chop'||t1h==='unknown'||t4h!==t1h) continue;
        const dir = t4h==='uptrend'?'long':'short';
        if (dir==='long'&&health!=='bullish') continue;
        if (dir==='short'&&health!=='bearish') continue;
        const entry = checkEntry(c15,dir);
        if (!entry) continue;
        const key = `${sym}_${dir}_${entry.level}`;
        const isNew = !seenSignals.has(key);
        seenSignals.add(key);
        const ps = calcSLTP(entry,dir);
        const base = sym.replace('USDT','');
        const lvl = entry.level==='green'?'EMA20':entry.level==='yellow'?'EMA50':'EMA100';
        const dirL = dir==='long'?'LONG':'SHORT';
        console.log(`  ${isNew?'NEW':'seen'} | ${sym} ${dirL} ${lvl} dist:${entry.dist.toFixed(2)}%`);
        if (isNew&&inWindow) newSigs.push({sym,base,dir,entry,ps,lvl,dirL});
        await new Promise(r=>setTimeout(r,100));
      } catch(e) { console.log(`  ${sym} error: ${e.message}`); }
    }

    if (newSigs.length===0) {
      console.log('No new precision signals.');
    } else {
      for (const s of newSigs) {
        const title = `${s.base}/USDT - ${s.dirL} ${s.lvl} TOUCHING`;
        const body  = `${s.dir==='long'?'Uptrend':'Downtrend'} 4H+1H | BTC ${health}\nEntry: $${fmt(s.entry.price)} | Stop: $${s.ps.sl} | Target: $${s.ps.tp}\nDist: ${s.entry.dist.toFixed(2)}% | Risk: $${RISK_USD} | Reward: $${(RISK_USD*TP_RR).toFixed(2)}`;
        await notify(title, body, 'urgent');
        await new Promise(r=>setTimeout(r,500));
      }
    }
  } catch(e) { console.log('Scan error:', e.message); }
  console.log('Scan done.');
}

// ─── KEEP ALIVE ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  if (req.url==='/test') {
    await notify('EMA Server Test', 'Server is working! Alerts will fire during London+NY session.', 'high');
    res.writeHead(200); res.end('Test sent! Check ntfy.');
  } else if (req.url==='/scan') {
    res.writeHead(200); res.end('Manual scan triggered!');
    scan();
  } else {
    res.writeHead(200); res.end('EMA Precision Scanner - OK');
  }
});
server.listen(process.env.PORT||3000, () => console.log(`Server on port ${process.env.PORT||3000}`));

// Self ping every 4 mins
setInterval(() => {
  const url = `https://ema-alerts-server.onrender.com`;
  https.get(url, (r) => console.log(`[ping] ${r.statusCode}`)).on('error', e => console.log(`[ping] ${e.message}`));
}, 4*60*1000);

// Start
console.log('EMA Precision Alert Server started');
console.log(`Notifications to ntfy.sh/${NTFY_CHANNEL}`);
console.log('Scan interval: 30 minutes');
console.log('Active window: London + NY session');
scan();
setInterval(scan, SCAN_INTERVAL);
