const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const gameOverScreen = document.getElementById('gameOver');
const finalScoreElement = document.getElementById('finalScore');
const restartBtn = document.getElementById('restartBtn');
const musicSelect = document.getElementById('bgMusicSelect');
const tapeList = document.getElementById('tapeList');

// UI Elements
const portfolioElement = document.getElementById('portfolioValue');
const pnlDollarElement = document.getElementById('pnlDollar');
const pnlPercentElement = document.getElementById('pnlPercent');
const livesElement = document.getElementById('lives');
const timerElement = document.getElementById('timer');
const progressBar = document.getElementById('progress-bar');
const progressThumb = document.getElementById('progress-thumb');
const progressContainer = document.getElementById('progress-container');
const highScoresList = document.getElementById('highScores');
const finalTimeElement = document.getElementById('finalTime');

// ---- Virtual paper trading (no API keys needed) ----
// Prices fetched from Yahoo Finance via CORS proxy chain; portfolio is local.

// Settings Elements
const settingsBtn = document.getElementById('settingsBtn');
const settingsModal = document.getElementById('settingsModal');
const saveSettingsBtn = document.getElementById('saveSettingsBtn');
const startingPortfolioInput = document.getElementById('startingPortfolio');
const tradeAllocationInput = document.getElementById('tradeAllocation');
const muteMusicCheckbox = document.getElementById('muteMusic');

// Load Assets
const nyanFrames = [];
const frameCount = 6;
for (let i = 1; i <= frameCount; i++) {
    const img = new Image();
    img.src = `assets/nyan${i}.svg`;
    nyanFrames.push(img);
}

const btcIcon = new Image();
btcIcon.src = 'assets/btc.svg';

// Game Variables
let frames = 0;
let START_PORTFOLIO = parseFloat(localStorage.getItem('nyan_start_portfolio')) || 1000000.00;
let TRADE_ALLOCATION = parseFloat(localStorage.getItem('nyan_trade_allocation')) || 10;
let isMuted       = localStorage.getItem('nyan_muted') === 'true';
let moveOnlyDown  = localStorage.getItem('nyan_move_only_down') === 'true';
let activeTicker  = localStorage.getItem('nyan_active_ticker') || 'SPY';
let activeTickerIsCrypto = activeTicker === 'BTC/USD';

let portfolioAmount = START_PORTFOLIO;
let livesCount = 3;
let isGameOver = false;
let isPaused = false;
let musicStarted = false;
let LEVEL_DURATION = 7200;

// Initialize Settings UI
startingPortfolioInput.value = START_PORTFOLIO;
tradeAllocationInput.value = TRADE_ALLOCATION;
muteMusicCheckbox.checked = isMuted;
document.getElementById('moveOnlyDown').checked = moveOnlyDown;

let bgMusic = new Audio(musicSelect.value);
bgMusic.loop = true;
bgMusic.volume = isMuted ? 0 : 0.5;

musicSelect.addEventListener('change', () => {
    const wasPlaying = !bgMusic.paused;
    bgMusic.pause();
    bgMusic = new Audio(musicSelect.value);
    bgMusic.loop = true;
    bgMusic.volume = isMuted ? 0 : 0.5;
    if (wasPlaying && musicStarted) bgMusic.play();
});

// Settings Logic
settingsBtn.addEventListener('click', () => {
    isPaused = true;
    bgMusic.pause();
    renderSeatSettings();
    settingsModal.classList.remove('hidden');
});

saveSettingsBtn.addEventListener('click', () => {
    START_PORTFOLIO = parseFloat(startingPortfolioInput.value) || 1000000.00;
    localStorage.setItem('nyan_start_portfolio', START_PORTFOLIO);
    TRADE_ALLOCATION = parseFloat(tradeAllocationInput.value) || 10;
    isMuted          = muteMusicCheckbox.checked;
    moveOnlyDown     = document.getElementById('moveOnlyDown').checked;
    localStorage.setItem('nyan_move_only_down', moveOnlyDown);
    localStorage.setItem('nyan_trade_allocation', TRADE_ALLOCATION);
    localStorage.setItem('nyan_muted',            isMuted);

    bgMusic.volume = isMuted ? 0 : 0.5;
    settingsModal.classList.add('hidden');
    isPaused = false;
    if (musicStarted && !isGameOver) bgMusic.play();

    if (frames === 0) {
        portfolioAmount = START_PORTFOLIO;
        updateHUD();
    }
});

// ---- Live data layer (Yahoo Finance via CORS proxy — no API keys needed) ----
let livePrice = null;
window.opponentState = null;  // set by multiplayer.js

const liveIndicatorEl = document.getElementById('liveIndicator');

function setIndicator(label, color, ticker) {
    const dotStyle = color ? `style="color:${color}"` : '';
    const t = ticker !== undefined ? ticker : (typeof activeTicker !== 'undefined' ? activeTicker : 'SPY');
    liveIndicatorEl.innerHTML = `<span class="dot" ${dotStyle}>●</span> ${t}${label ? ' — ' + label : ''}`;
}

// Map game ticker → Yahoo Finance symbol convention.
function yahooSymbol(ticker) {
    if (ticker === 'BTC/USD') return 'BTC-USD';
    if (ticker === 'ETH/USD') return 'ETH-USD';
    if (ticker === 'SOL/USD') return 'SOL-USD';
    return ticker;  // SPY, AAPL, NVDA, etc.
}

function isCryptoTicker(ticker) {
    return /[\/-]USD$/i.test(ticker) || ticker === 'BTC' || ticker === 'ETH';
}

// CORS proxy chain — Yahoo's chart API blocks browser CORS, so we route through these.
// allorigins.win is primary; corsproxy.io was free-tier 403'd around 2026-04 but kept as fallback.
const _PROXY_CHAIN = [
    u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    u => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
];

async function _fetchProxiedJson(url) {
    for (const wrap of _PROXY_CHAIN) {
        try {
            const r = await fetch(wrap(url), { cache: 'no-store' });
            if (!r.ok) continue;
            const text = await r.text();
            if (!text) continue;
            try { return JSON.parse(text); } catch { continue; }
        } catch { /* try next proxy */ }
    }
    return null;
}

// Fetch 1-min bars from Yahoo for a window. startSec/endSec are unix seconds.
async function fetchYahooBars(ticker, startSec, endSec) {
    const sym = yahooSymbol(ticker);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=${startSec}&period2=${endSec}&interval=1m`;
    const j = await _fetchProxiedJson(url);
    const result = j?.chart?.result?.[0];
    if (!result) return [];
    const ts = result.timestamp || [];
    const q  = result.indicators?.quote?.[0];
    if (!q || !ts.length) return [];
    const bars = [];
    for (let i = 0; i < ts.length; i++) {
        if (q.close[i] == null) continue;
        bars.push({
            t: new Date(ts[i] * 1000).toISOString(),
            o: q.open[i]  ?? q.close[i],
            h: q.high[i]  ?? q.close[i],
            l: q.low[i]   ?? q.close[i],
            c: q.close[i],
            v: q.volume[i] || 0,
        });
    }
    return bars;
}

// ---- Bar-level cache (localStorage) ----
// 1-min bars are immutable once they're a few minutes old, so cache them
// forever (24h ring buffer per ticker). Replays of the same window, or
// rerunning Quick Play within an hour, become instant — no network call.
const _BAR_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const _barCacheKey = t => `nyan_bars_v2_${t.replace('/', '_')}`;

function _loadCachedBars(ticker) {
    try {
        const raw = localStorage.getItem(_barCacheKey(ticker));
        if (!raw) return [];
        const cutoff = Date.now() - _BAR_CACHE_TTL_MS;
        return JSON.parse(raw).filter(b => new Date(b.t).getTime() >= cutoff);
    } catch { return []; }
}

function _saveCachedBars(ticker, bars) {
    try {
        const map = new Map();
        for (const b of bars) map.set(b.t, b);  // dedupe by timestamp
        const sorted = [...map.values()].sort((a, b) => new Date(a.t) - new Date(b.t));
        localStorage.setItem(_barCacheKey(ticker), JSON.stringify(sorted));
    } catch { /* localStorage full / disabled — just skip */ }
}

// Fetch bars for [startSec, endSec], serving cache for windows whose newest
// bar is >60 min old. Live/recent windows still fetch (bars within last
// few minutes can update).
async function fetchYahooBarsCached(ticker, startSec, endSec) {
    const startMs = startSec * 1000;
    const endMs   = endSec * 1000;
    const cached  = _loadCachedBars(ticker);
    const inRange = cached.filter(b => {
        const t = new Date(b.t).getTime();
        return t >= startMs && t <= endMs;
    });

    const expectedBars    = Math.max(1, Math.floor((endMs - startMs) / 60000));
    const isStable        = endMs < Date.now() - 3 * 60 * 1000;  // bars settle within ~3 min on Yahoo
    const hasGoodCoverage = inRange.length >= expectedBars * 0.7;

    // Whole window has settled and we already have most of it — no network.
    if (isStable && hasGoodCoverage) return inRange;

    // Otherwise fetch from network and merge into cache.
    const fresh = await fetchYahooBars(ticker, startSec, endSec);
    if (fresh && fresh.length > 0) {
        _saveCachedBars(ticker, [...cached, ...fresh]);
        return fresh;
    }
    // Network failed — fall back to cache, even partial.
    return inRange;
}

// Latest price = most recent close from a 1-day fetch. Used to seed the chart.
async function fetchYahooLatestPrice(ticker) {
    const sym = yahooSymbol(ticker);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1m`;
    const j = await _fetchProxiedJson(url);
    const result = j?.chart?.result?.[0];
    return result?.meta?.regularMarketPrice || null;
}

// ---- Compatibility stubs (existing call-sites still reference these) ----
let DATA_SOURCE = 'sim';  // legacy flag — kept so executeTrade/drawBackground/updateMarket branches still work
function renderSeatHUD()       { const el = document.getElementById('seat-scoreboard'); if (el) el.innerHTML = ''; }
function renderSeatSettings()  { const el = document.getElementById('seat-settings');   if (el) el.innerHTML = ''; }
async function fetchIBPortfolio()       { /* virtual paper — no live sync */ }
async function fetchAlpacaPortfolio()   { /* virtual paper — no live sync */ }
async function flattenAlpacaPositions() { /* virtual paper — no real positions */ }
function connectAlpaca()  { /* no-op */ }
function initDataSource() { setIndicator('VIRTUAL', '#888', typeof activeTicker !== 'undefined' ? activeTicker : 'SPY'); }

initDataSource();
renderSeatHUD();

// ---- Level Select ----

function showLevelSelect() {
    document.getElementById('levelSelect').classList.remove('hidden');
    populateLevelSelect();
}

function hideLevelSelect() {
    document.getElementById('levelSelect').classList.add('hidden');
}

function populateLevelSelect() {
    const inp = document.getElementById('tickerInput');
    if (inp) inp.value = activeTicker || 'SPY';
    const status = document.getElementById('levelSelectStatus');
    if (status) status.textContent = '';
}

// Most recent YYYY-MM-DD (in ET) where 9:30–10:30 ET has finished. Weekends skipped.
function lastCompletedOpenDateStr() {
    const now = new Date();
    const month = now.getUTCMonth() + 1;
    const etOffsetMs = (month >= 3 && month <= 11) ? 4 * 3600000 : 5 * 3600000;  // EDT vs EST
    // Shift back by 10:30 ET so the "boundary" time is midnight in our shifted clock,
    // then take the date — this is the most recent date whose open window has closed.
    const candidateMs = now.getTime() - etOffsetMs - (10 * 3600000 + 30 * 60000);
    let date = new Date(candidateMs);
    while (date.getUTCDay() === 0 || date.getUTCDay() === 6) {
        date = new Date(date.getTime() - 86400000);
    }
    return date.toISOString().slice(0, 10);
}

// Fetch a window of 1-min bars for a date+window. Bar-level cache makes
// repeat loads of the same level instant.
async function fetchBars(symbol, dateStr, win) {
    // Compute UTC start/end for the requested window. ET → UTC: Mar–Nov = +4 (EDT), else +5 (EST).
    const month = parseInt(dateStr.slice(5, 7), 10);
    const etToUtc = (month >= 3 && month <= 11) ? 4 : 5;
    const [y, m, d] = dateStr.split('-').map(Number);
    const startEtH = (win === 'close') ? 15 : 9;
    const startEtM = (win === 'close') ? 0  : 30;
    const endEtH   = (win === 'open')  ? 10 : 16;
    const endEtM   = (win === 'open')  ? 30 : 0;
    const startSec = Math.floor(Date.UTC(y, m - 1, d, startEtH + etToUtc, startEtM) / 1000);
    const endSec   = Math.floor(Date.UTC(y, m - 1, d, endEtH   + etToUtc, endEtM)   / 1000);

    return await fetchYahooBarsCached(symbol, startSec, endSec);
}

async function fetchLatestPrice(symbol) {
    return await fetchYahooLatestPrice(symbol);
}

// Read ticker input → activeTicker globals. Defaults to SPY if empty.
function readTickerFromInput() {
    const inp = document.getElementById('tickerInput');
    let val = (inp ? inp.value : 'SPY').trim().toUpperCase() || 'SPY';
    activeTicker = val;
    activeTickerIsCrypto = isCryptoTicker(val);
    localStorage.setItem('nyan_active_ticker', activeTicker);
}

async function loadLevel(dateStr, win, btn) {
    const statusEl = document.getElementById('levelSelectStatus');
    statusEl.textContent = `Fetching ${activeTicker} bars…`;
    const origText = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
    try {
        const bars = await fetchBars(activeTicker, dateStr, win);
        if (bars.length < 2) throw new Error('No trading data for this date/window');

        // Determine if this is a near-live replay (< 60 min since window closed → lock to 1x)
        const lvlMonth = parseInt(dateStr.slice(5, 7), 10);
        const etOffsetHours = (lvlMonth >= 3 && lvlMonth <= 11) ? 4 : 5;
        const endHourET = (win === 'open') ? 10.5 : 16.0;
        const endHourUTC = endHourET + etOffsetHours;
        const [lvlY, lvlM, lvlD] = dateStr.split('-').map(Number);
        const windowEndUTC = Date.UTC(lvlY, lvlM - 1, lvlD, Math.floor(endHourUTC), Math.round((endHourUTC % 1) * 60));
        spyIsLive = (Date.now() - windowEndUTC) < 60 * 60 * 1000;

        spyBars = bars;
        spyBarIdx = 0;
        spyFrameCounter = 0;
        spyMode = true;
        spyFramesPerBar = Math.max(1, Math.round(3600 / spySpeed));
        LEVEL_DURATION = bars.length * spyFramesPerBar;

        const winLabel = win === 'open' ? '9:30–10:30 Open'
                       : win === 'close' ? '3–4PM Close' : 'Full Day';
        const dateLabel = new Date(dateStr + 'T12:00:00Z')
            .toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
        spyLevelLabel = `${dateLabel} ${winLabel}`;

        statusEl.textContent = '';
        hideLevelSelect();
        resetGame();
    } catch (e) {
        statusEl.textContent = `Error: ${e.message}`;
        if (btn) { btn.disabled = false; btn.textContent = origText; }
    }
}

async function startQuickPlay(ticker, isCrypto) {
    activeTicker = ticker || 'SPY';
    activeTickerIsCrypto = isCrypto != null ? !!isCrypto : isCryptoTicker(activeTicker);
    localStorage.setItem('nyan_active_ticker', activeTicker);

    const statusEl = document.getElementById('levelSelectStatus');
    if (statusEl) statusEl.textContent = `Fetching ${activeTicker} last hour…`;

    // Last-hour replay at 60× — fetch the most recent ~65 min of 1-min bars from Yahoo.
    // Goes through the bar cache: anything >60min old is served instantly.
    const endSec   = Math.floor(Date.now() / 1000);
    const startSec = endSec - 65 * 60;
    const bars = await fetchYahooBarsCached(activeTicker, startSec, endSec);
    if (!bars || bars.length < 2) {
        if (statusEl) statusEl.textContent = `No recent data for ${activeTicker} (market closed?)`;
        return;
    }

    spyBars = bars;
    spyBarIdx = 0;
    spyFrameCounter = 0;
    spyMode = true;
    spyFramesPerBar = Math.max(1, Math.round(3600 / spySpeed));
    LEVEL_DURATION = bars.length * spyFramesPerBar;
    spyLevelLabel = `${activeTicker} Last Hour`;
    spyIsLive = false;

    if (statusEl) statusEl.textContent = '';
    hideLevelSelect();
    resetGame(bars[0].o ?? bars[0].c);
}

// BTC Chart Data
const priceHistory = [];
let currentBTCPrice = 65000.00;
let smoothedPriceY = 0;
const chartCapacity = 150;
const trades = [];

// SPY Level State
let spyMode = false;
let spyBars = [];
let spyBarIdx = 0;
let spyFrameCounter = 0;
let spyFramesPerBar = 60;  // at 60x default: 3600/60 = 60 frames per 1-min bar
let spySpeed = 60;         // 60x = current realtime feel; 1x = full 60-min session in 60 mins
let spyLevelLabel = '';
let spyIsLive = false; // true when level data ended < 60 min ago → no speedup

// Trading State
let openPosition = 0;
let entryPrice = 0;
const HEART_LOSS_STEP = 1000.00;

// MACD Data
const ema12 = [];
const ema26 = [];
const macdLine = [];
const signalLine = [];
const histogram = [];

// Leaderboard
let leaderboard = JSON.parse(localStorage.getItem('nyan_leaderboard') || '[]');
let allSessions = JSON.parse(localStorage.getItem('nyan_all_sessions') || '[]');
// One-time migration from old leaderboard
if (allSessions.length === 0 && leaderboard.length > 0) {
    allSessions = leaderboard.map(e => ({ ...e, isoDate: e.isoDate || null }));
    localStorage.setItem('nyan_all_sessions', JSON.stringify(allSessions));
}

// Controls
const keys = {};

function tryStartMusic() {
    if (!musicStarted && !isGameOver && !isPaused) {
        bgMusic.play().catch(e => console.log("Audio play failed", e));
        musicStarted = true;
    }
}

window.addEventListener('keydown', e => {
    if (e.code === 'Escape') {
        // ESC ends the session (qualifies for leaderboard if >=10s played).
        if (!isGameOver) endGame('Session Ended');
        return;
    }

    const inInput = e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA';

    keys[e.code] = true;
    if (!inInput) tryStartMusic();

    if (!isGameOver && !isPaused && !inInput) {
        if (e.code === 'ArrowUp' || e.code === 'KeyW') executeTrade('BUY');
        if ((e.code === 'ArrowDown' || e.code === 'KeyS') && !moveOnlyDown) executeTrade('SELL');
        if (e.code === 'Space') { if (openPosition > 0) executeTrade('SELL_ALL'); }

        // Number keys: quick-buy at preset allocations (BUY = key, SELL = Shift+key)
        const hotkeys = { Digit1: 10, Digit2: 25, Digit3: 50, Digit4: 75, Digit5: 100 };
        if (hotkeys[e.code] !== undefined) {
            e.preventDefault();
            executeTrade(e.shiftKey ? 'SELL' : 'BUY', hotkeys[e.code]);
        }
    }
});
window.addEventListener('keyup', e => keys[e.code] = false);

// Touch on canvas: right half = BUY, left half = SELL
canvas.addEventListener('touchstart', e => {
    e.preventDefault();
    tryStartMusic();
    if (!isGameOver && !isPaused) {
        const touch = e.touches[0];
        const rect = canvas.getBoundingClientRect();
        const x = touch.clientX - rect.left;
        if (x >= rect.width / 2) {
            executeTrade('BUY');
        } else {
            executeTrade('SELL');
        }
    }
}, { passive: false });

// Mobile control buttons
document.getElementById('mobileBuyBtn').addEventListener('pointerdown', e => {
    e.preventDefault();
    tryStartMusic();
    if (!isGameOver && !isPaused) executeTrade('BUY');
});

document.getElementById('mobileSellBtn').addEventListener('pointerdown', e => {
    e.preventDefault();
    if (!isGameOver && !isPaused) executeTrade('SELL');
});

document.getElementById('mobileSellAllBtn').addEventListener('pointerdown', e => {
    e.preventDefault();
    if (!isGameOver && !isPaused && openPosition > 0) executeTrade('SELL_ALL');
});

let lastLiveOrderTime = 0;
const LIVE_ORDER_COOLDOWN_MS = 1500;  // min ms between real orders

function sendLiveOrder(_action, _cashQty, _qty) {
    // Virtual paper trading — no real broker call. Stub kept so executeTrade compiles.
}

// pct: percentage of portfolio (0-100). Default uses TRADE_ALLOCATION setting.
function executeTrade(type, pct) {
    const alloc = pct != null ? pct : TRADE_ALLOCATION;
    let tradePrice = currentBTCPrice;
    let timeStr = new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

    const tradeValueDollars = portfolioAmount * (alloc / 100);
    const unitsToTrade = tradeValueDollars / tradePrice;

    if (type === 'BUY') {
        // Virtual paper: buying power = free cash (portfolio value minus open position value)
        const positionValue = openPosition * tradePrice;
        const freeCash = Math.max(0, portfolioAmount - positionValue);
        if (freeCash < 1) {
            addTapeNotice('No buying power — close position first');
            return;
        }
        const effectiveNotional = Math.min(tradeValueDollars, freeCash);
        const effectiveUnits = effectiveNotional / tradePrice;
        openPosition += effectiveUnits;
        entryPrice = tradePrice;
        addTradeMarker('BUY', tradePrice);
        addToTape(timeStr, tradePrice, 'BUY', effectiveNotional, null);
        pushTradeLog('BUY', effectiveUnits, tradePrice, null, alloc);
        sendLiveOrder('BUY', effectiveNotional, null);
    } else if (type === 'SELL') {
        let pnl = null;
        let unitsSold = 0;
        if (openPosition > 0) {
            unitsSold = Math.min(unitsToTrade, openPosition);
            pnl = (tradePrice - entryPrice) * unitsSold;
            openPosition = Math.max(0, openPosition - unitsToTrade);
            sendLiveOrder('SELL', unitsSold * tradePrice, unitsSold);
        }
        addTradeMarker('SELL', tradePrice);
        addToTape(timeStr, tradePrice, 'SELL', tradeValueDollars, pnl);
        if (unitsSold > 0) pushTradeLog('SELL', unitsSold, tradePrice, pnl, alloc);
    } else if (type === 'SELL_ALL') {
        const exitedUnits = openPosition;
        const pnl = exitedUnits > 0 ? (tradePrice - entryPrice) * exitedUnits : null;
        const exitValue = exitedUnits * tradePrice;
        if (exitedUnits > 0) sendLiveOrder('SELL', exitValue, exitedUnits);
        addTradeMarker('SELL', tradePrice);
        addToTape(timeStr, tradePrice, 'EXIT', exitValue, pnl);
        if (exitedUnits > 0) pushTradeLog('SELL', exitedUnits, tradePrice, pnl, 100);
        openPosition = 0;
    }
}

function addTradeMarker(type, price) {
    trades.push({
        type: type,
        price: price,
        frame: frames,
        x: (priceHistory.length / chartCapacity) * canvas.width,
        catX: cat.x,   // capture cat position so we can mark the trail later
        catY: cat.y,
    });
}

function addTapeNotice(msg) {
    const li = document.createElement('li');
    li.className = 'tape-exit';
    li.style.color = '#aaa';
    li.style.fontSize = '10px';
    li.textContent = msg;
    tapeList.insertBefore(li, tapeList.firstChild);
}

function addToTape(time, price, side, qty, pnl) {
    const li = document.createElement('li');
    const cssClass = side === 'BUY' ? 'tape-buy' : side === 'EXIT' ? 'tape-exit' : 'tape-sell';
    li.className = cssClass;

    const qtyStr = qty != null ? `$${Math.round(qty).toLocaleString()}` : '';
    const priceStr = `$${price.toFixed(0)}`;
    let pnlStr = '';
    let pnlClass = '';
    if (pnl != null) {
        const sign = pnl >= 0 ? '+' : '';
        pnlStr = `${sign}$${Math.abs(pnl).toFixed(0)}`;
        pnlClass = pnl >= 0 ? 'tape-pnl-profit' : 'tape-pnl-loss';
    }

    li.innerHTML = `
        <span class="col-time">${time}</span>
        <span class="col-side">${side}</span>
        <span class="col-qty">${qtyStr}</span>
        <span class="col-price">${priceStr}</span>
        <span class="col-pnl ${pnlClass}">${pnlStr}</span>
    `;
    tapeList.insertBefore(li, tapeList.firstChild);
    if (tapeList.children.length > 50) tapeList.removeChild(tapeList.lastChild);
}

function calculateEMA(data, period, prevEMA) {
    const k = 2 / (period + 1);
    return data * k + prevEMA * (1 - k);
}

// ---- Ghost race: replay top performers' trade timelines on the same bars ----
// Each ghost has its own portfolio + cat sprite, fires trades from a recorded
// schedule keyed by frame number. All ghosts watch the same currentBTCPrice as
// the player, so positioning is fair and deterministic.
let raceMode = false;
const ghosts = [];
// 6 distinct hues from the nyan rainbow palette — one per ghost lane.
const RAINBOW_COLORS = ['#ff4444', '#ff9900', '#ffdd33', '#33dd33', '#33aaff', '#aa44ff'];

function makeGhost(name, color, schedule, startPortfolio) {
    return {
        name,
        color,
        cat: { y: 0, trail: [] },        // x is locked to player so ghosts run alongside
        startPortfolio,
        portfolio: startPortfolio,
        position: 0,
        entryPrice: 0,
        prevPrice: 0,
        schedule: schedule || [],         // [{ frame, side, alloc }]
        scheduleIdx: 0,
        livesCount: 3,
        isAlive: true,
    };
}

// Find leaderboard entries that played the same fixed-data level.
function loadGhostsForLevel(ticker, mode, levelDate) {
    if (!ticker || !mode || mode === 'sim') return [];
    return allSessions
        .filter(s => s.ticker === ticker && s.mode === mode && s.levelDate === levelDate
                  && Array.isArray(s.tradeLog) && s.tradeLog.length > 0)
        .sort((a, b) => b.profit - a.profit)
        .slice(0, 6);
}

function initGhosts(matches, startPortfolio) {
    ghosts.length = 0;
    if (matches.length === 0) {
        // Synthetic baseline so the first racer of any level isn't alone.
        ghosts.push(makeGhost(
            'Hodl Bot',
            RAINBOW_COLORS[0],
            [{ frame: 0, side: 'BUY', alloc: 100 }],
            startPortfolio,
        ));
        return;
    }
    matches.forEach((m, i) => {
        const sign = m.profitPercent >= 0 ? '+' : '';
        const name = `${sign}${m.profitPercent.toFixed(1)}%`;
        ghosts.push(makeGhost(name, RAINBOW_COLORS[i], m.tradeLog, startPortfolio));
    });
}

function executeGhostTrade(g, side, alloc) {
    const tradeValue = g.portfolio * (alloc / 100);
    const units = tradeValue / currentBTCPrice;
    if (side === 'BUY') {
        const positionValue = g.position * currentBTCPrice;
        const freeCash = Math.max(0, g.portfolio - positionValue);
        const effectiveValue = Math.min(tradeValue, freeCash);
        const effectiveUnits = effectiveValue / currentBTCPrice;
        if (effectiveUnits > 0) {
            g.position += effectiveUnits;
            g.entryPrice = currentBTCPrice;
        }
    } else if (side === 'SELL') {
        if (g.position > 0) {
            const unitsSold = Math.min(units, g.position);
            g.position = Math.max(0, g.position - unitsSold);
        }
    }
}

function ghostsTick() {
    if (!raceMode || ghosts.length === 0) return;
    ghosts.forEach((g, i) => {
        if (!g.isAlive) return;

        // Fire any due trades
        while (g.scheduleIdx < g.schedule.length && g.schedule[g.scheduleIdx].frame <= frames) {
            const t = g.schedule[g.scheduleIdx];
            executeGhostTrade(g, t.side, t.alloc);
            g.scheduleIdx++;
        }

        // P&L from price movement on open position
        if (g.position !== 0 && g.prevPrice !== 0) {
            g.portfolio += (currentBTCPrice - g.prevPrice) * g.position;
        }
        g.prevPrice = currentBTCPrice;

        // Drawdown lives — same rule as player (3 hearts × $1k each on $1M default).
        const totalDrawdown = g.startPortfolio - g.portfolio;
        const maxAllowedDrawdown = (3 - g.livesCount + 1) * HEART_LOSS_STEP;
        if (totalDrawdown >= maxAllowedDrawdown && g.livesCount > 0) g.livesCount--;
        if (g.livesCount <= 0) { g.isAlive = false; g.position = 0; }

        // Cat position: spread across vertical band based on rank, smoothed.
        // We compute rank below in updateRaceBoard; use stored prevRank for now.
        const targetY = canvas.height * 0.18 + (i * (canvas.height * 0.6) / Math.max(ghosts.length - 1, 1));
        if (g.cat.y === 0) g.cat.y = targetY;
        g.cat.y += (targetY - g.cat.y) * 0.04;

        // Trail
        g.cat.trail.push({ x: cat.x + 40, y: g.cat.y + 30, frame: frames });
        if (g.cat.trail.length > 800) g.cat.trail.shift();
    });
}

function drawGhostCat(g) {
    const ox = cat.x + 18;
    const oy = g.cat.y;
    const alpha = g.isAlive ? 0.5 : 0.18;

    ctx.save();
    ctx.globalAlpha = alpha;

    // Solid color trail (single hue, no rainbow — keeps player's cat distinct)
    for (let i = 0; i < 12; i++) {
        const wy = Math.sin((frames - i * 5) * 0.2) * 6;
        ctx.fillStyle = g.color;
        ctx.fillRect(ox + 25 - i * 10 - 10, oy + 18 + wy, 10, 14);
    }

    // Cat sprite
    const af = Math.floor(frames / 8) % frameCount;
    if (nyanFrames[af]?.complete) ctx.drawImage(nyanFrames[af], ox, oy, cat.width, cat.height);

    // Color outline
    ctx.globalAlpha = alpha + 0.25;
    ctx.strokeStyle = g.color;
    ctx.lineWidth = 2;
    ctx.strokeRect(ox - 2, oy - 2, cat.width + 4, cat.height + 4);

    // Tiny name tag
    ctx.font = 'bold 10px Arial';
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    const tw = ctx.measureText(g.name).width;
    ctx.fillRect(ox, oy - 14, tw + 8, 12);
    ctx.fillStyle = g.color;
    ctx.fillText(g.name, ox + 4, oy - 4);

    ctx.restore();
}

function drawGhosts() {
    if (!raceMode) return;
    ghosts.forEach(drawGhostCat);
}

// Live-sorted flip-board on the left.
const _raceBoardEl = () => document.getElementById('raceBoard');
let _lastRaceBoardFrame = -999;
function updateRaceBoard() {
    if (!raceMode) return;
    if (frames - _lastRaceBoardFrame < 10) return;  // ~6 Hz
    _lastRaceBoardFrame = frames;
    const board = _raceBoardEl();
    if (!board) return;

    // Build standings: player + ghosts, sorted by P&L %
    const playerPct = START_PORTFOLIO > 0 ? (portfolioAmount - START_PORTFOLIO) / START_PORTFOLIO * 100 : 0;
    const standings = [
        { isYou: true, name: 'YOU', color: '#ffffff', pct: playerPct, dollars: portfolioAmount - START_PORTFOLIO, alive: livesCount > 0 },
        ...ghosts.map(g => ({
            isYou: false, name: g.name, color: g.color,
            pct: g.startPortfolio > 0 ? (g.portfolio - g.startPortfolio) / g.startPortfolio * 100 : 0,
            dollars: g.portfolio - g.startPortfolio,
            alive: g.isAlive,
        })),
    ].sort((a, b) => b.pct - a.pct);

    const medals = ['🥇', '🥈', '🥉'];
    board.innerHTML = standings.map((s, i) => {
        const rank = i < 3 ? medals[i] : `<span class="rb-num">${i + 1}</span>`;
        const sign = s.pct >= 0 ? '+' : '';
        const dollarsAbs = Math.abs(s.dollars);
        const dollars = `${sign}$${dollarsAbs >= 1000 ? (dollarsAbs / 1000).toFixed(1) + 'k' : dollarsAbs.toFixed(0)}`;
        const pct = `${sign}${s.pct.toFixed(1)}%`;
        const cls = ['rb-row', s.isYou ? 'rb-you' : '', !s.alive ? 'rb-out' : ''].filter(Boolean).join(' ');
        return `<div class="${cls}">
            <div class="rb-rank">${rank}</div>
            <div class="rb-dot" style="background:${s.color}"></div>
            <div class="rb-name">${s.isYou ? '▶ YOU' : s.name}</div>
            <div class="rb-pnl ${s.pct >= 0 ? 'profit' : 'loss'}">${dollars}<br>${pct}</div>
        </div>`;
    }).join('');
}

function updateMarket() {
    const prevPrice = currentBTCPrice;

    if (spyMode && spyBars.length > 0) {
        spyFrameCounter++;
        if (spyFrameCounter >= spyFramesPerBar) {
            spyFrameCounter = 0;
            if (spyBarIdx < spyBars.length - 1) spyBarIdx++;
        }
        const bar = spyBars[spyBarIdx];
        const t = spyFramesPerBar > 0 ? spyFrameCounter / spyFramesPerBar : 0;
        currentBTCPrice = bar.o + (bar.c - bar.o) * t;
    } else if (DATA_SOURCE !== 'sim' && livePrice !== null) {
        currentBTCPrice = livePrice;
    } else {
        currentBTCPrice += (Math.random() - 0.48) * currentBTCPrice * 0.00013;
    }

    // Sim + SPY backtesting: interpolate P&L from price movement each frame.
    // Live mode only: portfolio_value from the API poll is the source of truth.
    if ((DATA_SOURCE === 'sim' || spyMode) && openPosition !== 0) {
        const pnl = (currentBTCPrice - prevPrice) * openPosition;
        portfolioAmount += pnl;
    }

    const totalDrawdown = START_PORTFOLIO - portfolioAmount;
    const currentMaxAllowedDrawdown = (3 - livesCount + 1) * HEART_LOSS_STEP;

    if (totalDrawdown >= currentMaxAllowedDrawdown) {
        takeDamage("Drawdown Threshold Hit!");
    }

    if (frames % 5 === 0) {
        const lastPrice = currentBTCPrice;
        priceHistory.push({
            price: lastPrice,
            time: new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
        });
        if (priceHistory.length > chartCapacity) priceHistory.shift();

        const lastEMA12 = ema12.length > 0 ? ema12[ema12.length - 1] : lastPrice;
        const lastEMA26 = ema26.length > 0 ? ema26[ema26.length - 1] : lastPrice;
        const newEMA12 = calculateEMA(lastPrice, 12, lastEMA12);
        const newEMA26 = calculateEMA(lastPrice, 26, lastEMA26);
        ema12.push(newEMA12); ema26.push(newEMA26);
        const currentMACD = newEMA12 - newEMA26;
        macdLine.push(currentMACD);
        const lastSignal = signalLine.length > 0 ? signalLine[signalLine.length - 1] : currentMACD;
        const currentSignal = calculateEMA(currentMACD, 9, lastSignal);
        signalLine.push(currentSignal);
        histogram.push(currentMACD - currentSignal);
        if (ema12.length > chartCapacity) {
            ema12.shift(); ema26.shift(); macdLine.shift(); signalLine.shift(); histogram.shift();
        }
    }
}

function updateHUD() {
    portfolioElement.innerText = `$${portfolioAmount.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
    const diff = portfolioAmount - START_PORTFOLIO;
    const percent = (diff / START_PORTFOLIO) * 100;
    pnlDollarElement.innerText = `${diff >= 0 ? '+' : ''}$${diff.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
    pnlPercentElement.innerText = `${diff >= 0 ? '+' : ''}${percent.toFixed(2)}%`;
    pnlDollarElement.className = diff >= 0 ? 'profit' : 'loss';
    pnlPercentElement.className = diff >= 0 ? 'profit' : 'loss';
    livesElement.innerText = '❤️'.repeat(Math.max(0, livesCount));
    let secondsLeft;
    let progressPercent;
    if (spyMode && spyBars.length > 0) {
        // Show actual bar clock time in ET
        const barMs = new Date(spyBars[spyBarIdx].t).getTime();
        const month = new Date(barMs).getUTCMonth() + 1;
        const etOffsetMs = (month >= 3 && month <= 11) ? 4 * 3600000 : 5 * 3600000;
        const etDate = new Date(barMs - etOffsetMs);
        const bh = etDate.getUTCHours();
        const bm = etDate.getUTCMinutes();
        const period = bh >= 12 ? 'PM' : 'AM';
        const bh12 = bh > 12 ? bh - 12 : (bh === 0 ? 12 : bh);
        timerElement.innerText = `${bh12}:${bm.toString().padStart(2, '0')} ${period}`;
        progressPercent = Math.min(100, (spyBarIdx / Math.max(1, spyBars.length - 1)) * 100);
    } else {
        secondsLeft = Math.max(0, Math.ceil((LEVEL_DURATION - frames) / 60));
        progressPercent = Math.min(100, (frames / LEVEL_DURATION) * 100);
        let m = Math.floor(secondsLeft / 60).toString().padStart(2, '0');
        let s = (secondsLeft % 60).toString().padStart(2, '0');
        timerElement.innerText = `${m}:${s}`;
    }
    progressBar.style.width = `${progressPercent}%`;
    progressThumb.style.left = `${progressPercent}%`;
}

// Entities
const cat = {
    x: 100,
    y: 0, // set after resizeCanvas
    width: 110,
    height: 72,   // +20% taller — SVG native aspect is ~110×68; this gives a fuller cat
    speed: 6,
    isHit: false,
    hitTimer: 0,
    trail: [],
    animFrame: 0,
    priceOffsetY: 0, // manual vertical nudge relative to price line

    draw() {
        if (this.trail.length > 1) {
            ctx.strokeStyle = 'rgba(0, 255, 255, 0.4)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            this.trail.forEach((p, i) => {
                const drawX = p.x - (frames - p.frame) * 0.5;
                if (drawX < -100) return;
                if (i === 0) ctx.moveTo(drawX, p.y);
                else ctx.lineTo(drawX, p.y);
            });
            ctx.stroke();
        }

        if (this.isHit && Math.floor(Date.now() / 100) % 2 === 0) return;

        const colors = ['#ff0000', '#ff9900', '#ffff00', '#33ff00', '#0099ff', '#6633ff'];
        const segmentWidth = 10;
        const trailLength = 15;
        for (let i = 0; i < trailLength; i++) {
            const waveY = Math.sin((frames - i * 5) * 0.2) * 8;
            for (let j = 0; j < 6; j++) {
                ctx.fillStyle = colors[j];
                ctx.fillRect(this.x + 25 - (i * segmentWidth) - segmentWidth, this.y + 12 + (j * 6) + waveY, segmentWidth + 2, 6);
            }
        }

        // Trade markers along the trail — filled triangles where BUY/SELL fired.
        // Position scrolls left with the trail (matches the per-frame trail offset).
        trades.forEach(t => {
            if (t.catX == null) return;
            const tx = t.catX + 40 - (frames - t.frame) * 0.5;
            const ty = t.catY + 30;
            if (tx < -20 || tx > canvas.width) return;

            ctx.save();
            ctx.shadowBlur = 8;
            if (t.type === 'BUY') {
                ctx.fillStyle = '#00ff00';
                ctx.shadowColor = '#00ff00';
                ctx.beginPath();
                ctx.moveTo(tx, ty - 9);
                ctx.lineTo(tx - 7, ty + 4);
                ctx.lineTo(tx + 7, ty + 4);
                ctx.closePath();
                ctx.fill();
            } else {
                ctx.fillStyle = '#ff2222';
                ctx.shadowColor = '#ff2222';
                ctx.beginPath();
                ctx.moveTo(tx, ty + 9);
                ctx.lineTo(tx - 7, ty - 4);
                ctx.lineTo(tx + 7, ty - 4);
                ctx.closePath();
                ctx.fill();
            }
            ctx.restore();
        });

        this.animFrame = Math.floor(frames / 8) % frameCount;
        const currentFrame = nyanFrames[this.animFrame];
        if (currentFrame.complete) {
            ctx.drawImage(currentFrame, this.x, this.y, this.width, this.height);
        }
    },

    update() {
        if (this.isHit) {
            this.hitTimer--;
            if (this.hitTimer <= 0) this.isHit = false;
        }

        this.priceOffsetY = 0;
        if (keys['ArrowUp'] || keys['KeyW']) this.y -= this.speed;
        if (keys['ArrowDown'] || keys['KeyS']) this.y += this.speed;
        if (keys['ArrowLeft'] || keys['KeyA']) this.x -= this.speed;
        if (keys['ArrowRight'] || keys['KeyD']) this.x += this.speed;

        this.x = Math.max(0, Math.min(canvas.width - this.width, this.x));
        this.y = Math.max(0, Math.min(canvas.height - this.height, this.y));

        this.trail.push({ x: this.x + 40, y: this.y + 30, frame: frames });
        if (this.trail.length > 1000) this.trail.shift();
    }
};

function drawOpponentCat(state) {
    if (!state || state.catY == null) return;
    const ox = cat.x + 18;
    const oy = state.catY;
    const color = state.color || '#ffaa00';
    const alive = state.alive !== false;

    ctx.save();
    ctx.globalAlpha = alive ? 0.78 : 0.28;

    // Rainbow trail (offset from player's)
    const rc = ['#ff0000','#ff9900','#ffff00','#33ff00','#0099ff','#6633ff'];
    for (let i = 0; i < 15; i++) {
        const wy = Math.sin((frames - i * 5) * 0.2) * 8;
        for (let j = 0; j < 6; j++) {
            ctx.fillStyle = rc[j];
            ctx.fillRect(ox + 25 - i * 10 - 10, oy + 12 + j * 6 + wy, 12, 6);
        }
    }

    // Cat sprite
    const af = Math.floor(frames / 8) % frameCount;
    if (nyanFrames[af]?.complete) ctx.drawImage(nyanFrames[af], ox, oy, cat.width, cat.height);

    // Colored outline so it's visually distinct from the local cat
    ctx.globalAlpha = alive ? 0.9 : 0.4;
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.strokeRect(ox - 3, oy - 3, cat.width + 6, cat.height + 6);

    // Name tag
    ctx.font = 'bold 11px Arial';
    const tw = ctx.measureText(state.name || 'Opponent').width;
    ctx.fillStyle = 'rgba(0,0,0,0.82)';
    ctx.fillRect(ox, oy - 23, tw + 12, 19);
    ctx.fillStyle = color;
    ctx.fillText(state.name || 'Opponent', ox + 6, oy - 8);

    // P&L badge
    if (state.pct != null) {
        const ps = (state.pct >= 0 ? '+' : '') + state.pct.toFixed(1) + '%';
        ctx.font = 'bold 10px Arial';
        ctx.fillStyle = state.pct >= 0 ? '#00ff88' : '#ff4444';
        ctx.fillText(ps, ox + cat.width + 5, oy + 20);
    }

    ctx.restore();
}

function drawBackground() {
    const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
    grad.addColorStop(0, '#000000');
    grad.addColorStop(1, '#000022');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (priceHistory.length < 2) return;

    const chartAreaHeight = canvas.height * 0.7;
    const chartYOffset = (canvas.height - chartAreaHeight) / 2;
    const macdChartHeight = canvas.height * 0.15;
    const rawMin = Math.min(...priceHistory.map(d => d.price));
    const rawMax = Math.max(...priceHistory.map(d => d.price));
    const mid = (rawMin + rawMax) / 2;
    const minRange = DATA_SOURCE !== 'sim' ? mid * 0.002 : 0; // 0.2% min range for live data
    const halfRange = Math.max(rawMax - rawMin, minRange) / 2 * 1.05;
    const minPrice = mid - halfRange;
    const maxPrice = mid + halfRange;
    const priceRange = maxPrice - minPrice;

    function getPriceY(price) {
        return chartYOffset + chartAreaHeight - ((price - minPrice) / priceRange) * chartAreaHeight;
    }

    const targetPriceY = getPriceY(currentBTCPrice);
    if (smoothedPriceY === 0) smoothedPriceY = targetPriceY;
    else smoothedPriceY += (targetPriceY - smoothedPriceY) * 0.1;

    // Chart anchor: newest bar always sits at 75% of screen width, leaving 25% ahead as negative space
    const anchorX = canvas.width * 0.75;
    const stepX = anchorX / Math.max(chartCapacity - 1, 1);
    // chartX(i): maps history index to canvas x, anchored so index (length-1) = anchorX
    const chartX = i => anchorX + (i - (priceHistory.length - 1)) * stepX;

    // Main Chart
    ctx.strokeStyle = '#00ff00';
    ctx.lineWidth = 2;
    ctx.beginPath();
    priceHistory.forEach((data, i) => {
        const x = chartX(i);
        const y = getPriceY(data.price);
        const prevX = i > 0 ? chartX(i - 1) : x;
        if (i === 0 || prevX < 0) ctx.moveTo(Math.max(0, x), y);
        else ctx.lineTo(x, y);
        if (x >= 0 && i % 40 === 0) {
            ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
            ctx.font = '10px Arial';
            ctx.fillText(data.time, x, chartYOffset + chartAreaHeight + 12);
        }
    });
    ctx.stroke();

    // Optimal signals — hollow glowing triangles at local peaks/troughs
    const win = 8;
    for (let i = win; i < priceHistory.length - win; i++) {
        const price = priceHistory[i].price;
        let isMin = true, isMax = true;
        for (let j = i - win; j <= i + win; j++) {
            if (j === i) continue;
            if (priceHistory[j].price < price) isMax = false;
            if (priceHistory[j].price > price) isMin = false;
        }
        if (!isMin && !isMax) continue;
        // Suppress low-prominence signals (reduces noise on live data)
        const windowPrices = priceHistory.slice(i - win, i + win + 1).map(d => d.price);
        const winMin = Math.min(...windowPrices);
        const winMax = Math.max(...windowPrices);
        const prominence = isMax ? (price - winMin) : (winMax - price);
        if (prominence < currentBTCPrice * 0.0003) continue;
        const ox = chartX(i);
        if (ox < 0 || ox > canvas.width) continue;
        const oy = getPriceY(price);
        ctx.save();
        ctx.lineWidth = 1.5;
        if (isMin) {
            ctx.shadowBlur = 12;
            ctx.shadowColor = '#00ff88';
            ctx.strokeStyle = '#00ff88';
            ctx.beginPath();
            ctx.moveTo(ox, oy + 7);
            ctx.lineTo(ox - 7, oy + 20);
            ctx.lineTo(ox + 7, oy + 20);
            ctx.closePath();
            ctx.stroke();
        } else {
            ctx.shadowBlur = 12;
            ctx.shadowColor = '#ff4444';
            ctx.strokeStyle = '#ff4444';
            ctx.beginPath();
            ctx.moveTo(ox, oy - 7);
            ctx.lineTo(ox - 7, oy - 20);
            ctx.lineTo(ox + 7, oy - 20);
            ctx.closePath();
            ctx.stroke();
        }
        ctx.restore();
    }

    // Player trade markers on the chart — outline only.
    // Filled versions are drawn on the cat trail (see cat.draw()).
    trades.forEach(t => {
        const pointsBack = (frames - t.frame) / 5;
        const x = anchorX - pointsBack * stepX;
        const y = getPriceY(t.price);

        if (x < 0) return;

        ctx.save();
        ctx.lineWidth = 2;
        if (t.type === 'BUY') {
            ctx.shadowBlur = 18;
            ctx.shadowColor = '#00ff00';
            ctx.strokeStyle = '#00ff00';
            ctx.beginPath();
            ctx.moveTo(x, y + 10);
            ctx.lineTo(x - 9, y + 26);
            ctx.lineTo(x + 9, y + 26);
            ctx.closePath();
            ctx.stroke();
        } else {
            ctx.shadowBlur = 18;
            ctx.shadowColor = '#ff2222';
            ctx.strokeStyle = '#ff2222';
            ctx.beginPath();
            ctx.moveTo(x, y - 10);
            ctx.lineTo(x - 9, y - 26);
            ctx.lineTo(x + 9, y - 26);
            ctx.closePath();
            ctx.stroke();
        }
        ctx.restore();
    });

    // BTC Icon & Price — always at the chart anchor (75% of screen)
    const priceX = Math.min(anchorX, canvas.width - 165);
    const blink = Math.floor(frames / 30) % 2 === 0;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(priceX + 25, smoothedPriceY - 20, 140, 40);
    ctx.strokeStyle = blink ? '#00ff00' : '#004400';
    ctx.strokeRect(priceX + 25, smoothedPriceY - 20, 140, 40);
    ctx.fillStyle = blink ? (spyMode ? '#00cfff' : '#00ff00') : (spyMode ? '#0088aa' : '#00aa00');
    ctx.font = 'bold 16px Arial';
    if (spyMode) {
        ctx.fillText(`${activeTicker} $${currentBTCPrice.toFixed(2)}`, priceX + 5, smoothedPriceY + 6);
    } else if (activeTicker === 'BTC/USD') {
        ctx.fillText(`$${currentBTCPrice.toFixed(2)}`, priceX + 30, smoothedPriceY + 6);
        if (btcIcon.complete) {
            ctx.drawImage(btcIcon, priceX - 20, smoothedPriceY - 20, 40, 40);
        }
    } else {
        ctx.fillText(`${activeTicker} $${currentBTCPrice.toFixed(2)}`, priceX + 5, smoothedPriceY + 6);
    }

    // MACD — aligned to same anchor so bars line up with chart
    const macdYBase = canvas.height - 30;
    const maxHist = Math.max(...histogram.map(Math.abs), 0.1);
    histogram.forEach((val, i) => {
        const x = anchorX + (i - (histogram.length - 1)) * stepX;
        if (x < 0) return;
        const h = (val / maxHist) * (macdChartHeight / 2);
        ctx.fillStyle = val >= 0 ? 'rgba(0, 255, 0, 0.5)' : 'rgba(255, 0, 0, 0.5)';
        ctx.fillRect(x, macdYBase - h, stepX - 1, h);
    });
}

function takeDamage(msg) {
    if (cat.isHit) return;
    livesCount--;
    portfolioAmount = START_PORTFOLIO - (3 - livesCount) * HEART_LOSS_STEP;
    cat.isHit = true;
    cat.hitTimer = 60;
    if (livesCount <= 0) endGame("Portfolio Liquidated!");
}

// ---- SFX ----
let _sfxCtx = null;
function _sfxGetCtx() {
    if (!_sfxCtx) _sfxCtx = new (window.AudioContext || window.webkitAudioContext)();
    return _sfxCtx;
}

// Mario-style coin: short B5 → E6 chirp, square wave for 8-bit feel.
function sfxCoin() {
    if (isMuted) return;
    try {
        const ctx = _sfxGetCtx();
        const t0 = ctx.currentTime;
        [[988, 0, 0.06], [1319, 0.07, 0.16]].forEach(([f, dt, dur]) => {
            const o = ctx.createOscillator();
            const g = ctx.createGain();
            o.connect(g); g.connect(ctx.destination);
            o.type = 'square';
            o.frequency.value = f;
            g.gain.setValueAtTime(0, t0 + dt);
            g.gain.linearRampToValueAtTime(0.07, t0 + dt + 0.005);
            g.gain.linearRampToValueAtTime(0, t0 + dt + dur);
            o.start(t0 + dt);
            o.stop(t0 + dt + dur);
        });
    } catch {}
}

// Slow descending hit: A3 → low rumble.
function sfxHit() {
    if (isMuted) return;
    try {
        const ctx = _sfxGetCtx();
        const t0 = ctx.currentTime;
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.connect(g); g.connect(ctx.destination);
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(220, t0);
        o.frequency.exponentialRampToValueAtTime(70, t0 + 0.35);
        g.gain.setValueAtTime(0.10, t0);
        g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.35);
        o.start(t0);
        o.stop(t0 + 0.38);
    } catch {}
}

// Watch portfolio over the last 1s; fire coin/hit if it moved meaningfully.
let _sfxLastPortfolio = null;
let _sfxLastFireFrame = -999;
function checkPortfolioSFX() {
    if (frames % 60 !== 0) return;
    if (_sfxLastPortfolio === null) { _sfxLastPortfolio = portfolioAmount; return; }
    const delta = portfolioAmount - _sfxLastPortfolio;
    _sfxLastPortfolio = portfolioAmount;
    // 0.05% of starting portfolio = $500 default — quiet during flat periods.
    const threshold = (START_PORTFOLIO || 1000000) * 0.0005;
    if (frames - _sfxLastFireFrame < 60) return;  // throttle to 1/sec
    if (delta > threshold) { sfxCoin(); _sfxLastFireFrame = frames; }
    else if (delta < -threshold) { sfxHit(); _sfxLastFireFrame = frames; }
}

// ---- Trade log + IBKR/TraderVue CSV export ----
const tradeLog = [];

function pushTradeLog(side, units, price, pnl, alloc) {
    if (!units || units <= 0) return;
    tradeLog.push({
        when: new Date().toISOString(),
        frame: frames,                // relative frame, used for ghost replay
        symbol: activeTicker,
        side,                         // 'BUY' or 'SELL'
        qty: units,
        price,
        pnl,
        alloc,                        // % of portfolio at trade time, for portfolio-agnostic replay
    });
}

// Generic TraderVue CSV (also accepted by Tradervue's IBKR import flow).
// Header: Date,Time,Symbol,Quantity,Price,Side,Commission
function exportTradesCSV() {
    if (tradeLog.length === 0) {
        addTapeNotice('No trades to export yet');
        return;
    }
    const lines = ['Date,Time,Symbol,Quantity,Price,Side,Commission'];
    for (const t of tradeLog) {
        const d = new Date(t.when);
        const date = d.toISOString().slice(0, 10);
        const time = d.toISOString().slice(11, 19);
        const side = t.side === 'BUY' ? 'B' : 'S';
        const qty = (Math.round(t.qty * 1e6) / 1e6).toString();
        lines.push(`${date},${time},${t.symbol},${qty},${t.price.toFixed(4)},${side},0`);
    }
    const csv = lines.join('\n') + '\n';
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `nyan-web_trades_${activeTicker.replace(/[\/\s]/g,'-')}_${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function playFanfare() {
    try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        [[523.25, 0], [659.25, 0.15], [783.99, 0.30], [1046.50, 0.50]].forEach(([freq, t]) => {
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            osc.type = 'sine';
            osc.frequency.value = freq;
            gain.gain.setValueAtTime(0, audioCtx.currentTime + t);
            gain.gain.linearRampToValueAtTime(0.22, audioCtx.currentTime + t + 0.04);
            gain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + t + 0.55);
            osc.start(audioCtx.currentTime + t);
            osc.stop(audioCtx.currentTime + t + 0.6);
        });
    } catch(e) {}
}

function startConfetti() {
    const cc = document.getElementById('confettiCanvas');
    cc.width = window.innerWidth;
    cc.height = window.innerHeight;
    cc.style.display = 'block';
    const cctx = cc.getContext('2d');
    const COLORS = ['#ff99cc', '#00ff88', '#ffff00', '#00cfff', '#ff6600', '#cc44ff'];
    const particles = Array.from({ length: 160 }, () => ({
        x: Math.random() * cc.width,
        y: Math.random() * -cc.height * 0.5,
        w: Math.random() * 10 + 4,
        h: Math.random() * 5 + 3,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
        vx: (Math.random() - 0.5) * 3,
        vy: Math.random() * 3 + 1.5,
        rot: Math.random() * Math.PI * 2,
        vrot: (Math.random() - 0.5) * 0.15,
    }));
    let cf = 0;
    const maxF = 300;
    function draw() {
        cctx.clearRect(0, 0, cc.width, cc.height);
        const opacity = cf > maxF - 60 ? (maxF - cf) / 60 : 1;
        particles.forEach(p => {
            p.x += p.vx; p.y += p.vy; p.rot += p.vrot;
            if (p.y > cc.height + 10) { p.y = -10; p.x = Math.random() * cc.width; }
            cctx.save();
            cctx.globalAlpha = opacity;
            cctx.translate(p.x, p.y);
            cctx.rotate(p.rot);
            cctx.fillStyle = p.color;
            cctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
            cctx.restore();
        });
        cf++;
        if (cf < maxF) requestAnimationFrame(draw);
        else { cc.style.display = 'none'; cctx.clearRect(0, 0, cc.width, cc.height); }
    }
    draw();
}

function endGame(message) {
    if (window.mpOnGameEnd) { const fn = window.mpOnGameEnd; window.mpOnGameEnd = null; fn(); }
    isGameOver = true;
    gameOverScreen.classList.remove('hidden');
    gameOverScreen.classList.remove('leaderboard-glow');
    document.getElementById('gameOverTitle').innerText = message;

    const profit = portfolioAmount - START_PORTFOLIO;
    const profitPct = (profit / START_PORTFOLIO) * 100;
    finalScoreElement.innerText = `$${portfolioAmount.toLocaleString(undefined, {minimumFractionDigits: 2})}`;
    finalTimeElement.innerText = `${Math.floor(frames / 60)}s`;

    // Downsample price history for calendar mini-charts (~50 points)
    const snapshotStep = Math.max(1, Math.floor(priceHistory.length / 50));
    const priceSnapshot = [];
    for (let i = 0; i < priceHistory.length; i += snapshotStep) priceSnapshot.push(priceHistory[i].price);

    const isoDate = new Date().toISOString().slice(0, 10);
    const sessionMode = spyMode
        ? (spyLevelLabel.includes('Open') ? 'open' : spyLevelLabel.includes('Close') ? 'close' : 'full')
        : 'sim';
    // Identify the exact level played so ghost replay matches bars 1:1.
    // For Quick Play (mode='sim') we don't have a fixed-data level → not raceable.
    const levelDate = spyMode && spyBars.length > 0
        ? new Date(spyBars[0].t).toISOString().slice(0, 10)
        : isoDate;

    // Compact ghost-replay schedule: keep only fields needed to re-execute trades.
    const replayLog = tradeLog.map(t => ({ frame: t.frame, side: t.side, alloc: t.alloc }));

    const entry = {
        profit: profit,
        profitPercent: profitPct,
        startPortfolio: START_PORTFOLIO,
        time: Math.floor(frames / 60),
        timestamp: new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }),
        isoDate: isoDate,
        levelDate: levelDate,         // bars-anchored date — matches what ghosts replay against
        ticker: activeTicker,
        mode: sessionMode,
        priceSnapshot: priceSnapshot,
        tradeLog: replayLog,          // for ghost racing
        sessionFrames: frames,
    };

    // Sessions <10s don't qualify — quick rage-quits, accidental ESC, etc.
    const qualifiesForLeaderboard = frames >= 600;  // 10s @ 60fps
    let leaderboardPos = null;

    if (qualifiesForLeaderboard) {
        // All sessions (cap at 300)
        allSessions.push(entry);
        if (allSessions.length > 300) allSessions.shift();
        localStorage.setItem('nyan_all_sessions', JSON.stringify(allSessions));

        // Derive top-20 leaderboard
        leaderboard = [...allSessions].sort((a, b) => b.profit - a.profit).slice(0, 20);
        const posIdx = leaderboard.findIndex(e => e === entry);
        leaderboardPos = (posIdx >= 0 && posIdx < 20) ? posIdx + 1 : null;
        localStorage.setItem('nyan_leaderboard', JSON.stringify(leaderboard));
    }

    // Result summary
    const resultAmountEl = document.getElementById('resultAmount');
    const resultMessageEl = document.getElementById('resultMessage');
    const leaderboardPosEl = document.getElementById('leaderboardPosition');
    const sign = profit >= 0 ? '+' : '';
    resultAmountEl.innerText = `${sign}$${Math.abs(profit).toLocaleString(undefined, {minimumFractionDigits: 2})} (${sign}${profitPct.toFixed(2)}%)`;
    resultAmountEl.className = profit >= 0 ? 'profit' : 'loss';

    const medals = ['🥇', '🥈', '🥉'];
    if (!qualifiesForLeaderboard) {
        leaderboardPosEl.innerText = '';
        leaderboardPosEl.className = '';
        resultMessageEl.innerText = `Too short — ${Math.floor(frames / 60)}s session (10s minimum to save)`;
    } else if (leaderboardPos) {
        const medal = leaderboardPos <= 3 ? medals[leaderboardPos - 1] : `#${leaderboardPos}`;
        leaderboardPosEl.innerHTML = `${medal} Wall of Fame &mdash; #${leaderboardPos}/20!`;
        leaderboardPosEl.className = 'result-leaderboard';
        resultMessageEl.innerText = profit >= 0 ? "Legendary session. You're on the board!" : 'Even in losses, you made history.';
        gameOverScreen.classList.add('leaderboard-glow');
        playFanfare();
    } else {
        leaderboardPosEl.innerText = '';
        leaderboardPosEl.className = '';
        resultMessageEl.innerText = profit > 0 ? 'Nice trading! Keep grinding.' : 'Markets are tough. Come back stronger.';
    }

    if (profit > 0) startConfetti();

    updateLeaderboardUI(leaderboardPos);
    bgMusic.pause();
    musicStarted = false;
}

function updateLeaderboardUI(highlightPos) {
    const topEntries = [...allSessions].sort((a, b) => b.profit - a.profit).slice(0, 20);
    highScoresList.innerHTML = topEntries.map((s, i) => {
        const isHighlight = highlightPos != null && i === highlightPos - 1;
        const startAmt = s.startPortfolio != null
            ? `$${s.startPortfolio.toLocaleString()} start`
            : 'Unknown start';
        const profitStr = `${s.profit >= 0 ? '+' : ''}$${Math.abs(s.profit).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
        const sign = s.profit >= 0 ? '+' : '-';
        const pctStr = s.profitPercent != null
            ? ` (${sign}${Math.abs(s.profitPercent).toFixed(2)}%)`
            : '';
        const pnlClass = s.profit >= 0 ? 'profit' : 'loss';
        const badge = [s.ticker || 'BTC/USD', s.mode || 'sim', s.timestamp || ''].filter(Boolean).join(' · ');
        return `
            <li class="${isHighlight ? 'lb-highlight' : ''}">
                <div class="lb-name">${isHighlight ? '▶ ' : ''}${startAmt}</div>
                <div class="lb-pnl ${pnlClass}">${profitStr}${pctStr}</div>
                <div class="lb-meta">
                    <span class="lb-time">${s.time}s session</span>
                    <span class="lb-badge">${badge}</span>
                </div>
            </li>
        `;
    }).join('');
}

function resetGame(startPrice) {
    spyBarIdx = 0;
    spyFrameCounter = 0;
    if (spyMode && spyBars.length > 0) {
        currentBTCPrice = spyBars[0].o;
        setIndicator(spyLevelLabel, '#00cfff', activeTicker);
        const maxSpeed = spyIsLive ? 1 : 120;
        const slider = document.getElementById('speedSlider');
        slider.max = maxSpeed;
        spySpeed = 60;
        slider.value = 60;
        spyFramesPerBar = Math.max(1, Math.round(3600 / spySpeed));
        document.getElementById('speedLabel').textContent = '60x';
        document.getElementById('speedControl').style.display = spyIsLive ? 'none' : '';
    } else {
        const tickerFallback = activeTicker === 'BTC/USD' ? (livePrice || 65000.00) : activeTicker === 'SPY' ? 500.00 : 100.00;
        currentBTCPrice = startPrice || tickerFallback;
        document.getElementById('speedControl').style.display = 'none';
        if (DATA_SOURCE === 'sim') setIndicator('SIM', '#888', activeTicker);
    }
    cat.x = 100; cat.y = canvas.height / 2; cat.isHit = false; cat.trail = []; cat.priceOffsetY = 0;
    priceHistory.length = 0; trades.length = 0; smoothedPriceY = 0;
    ema12.length = 0; ema26.length = 0; macdLine.length = 0; signalLine.length = 0; histogram.length = 0;
    portfolioAmount = START_PORTFOLIO; livesCount = 3; frames = 0; openPosition = 0;
    isGameOver = false; isPaused = false;
    tapeList.innerHTML = '';
    tradeLog.length = 0;
    _sfxLastPortfolio = null;
    _sfxLastFireFrame = -999;
    // Reset ghost runtime state (schedules already loaded by initGhosts)
    ghosts.forEach(g => {
        g.portfolio = g.startPortfolio;
        g.position = 0;
        g.entryPrice = 0;
        g.prevPrice = 0;
        g.scheduleIdx = 0;
        g.livesCount = 3;
        g.isAlive = true;
        g.cat.y = 0;
        g.cat.trail.length = 0;
    });
    _lastRaceBoardFrame = -999;
    const board = document.getElementById('raceBoard');
    if (board) board.style.display = raceMode ? '' : 'none';
    gameOverScreen.classList.add('hidden');
    gameOverScreen.classList.remove('leaderboard-glow');
    document.getElementById('resultAmount').innerText = '';
    document.getElementById('leaderboardPosition').innerText = '';
    document.getElementById('resultMessage').innerText = '';
    animate();
}

// Canvas sizing
function resizeCanvas() {
    const container = document.getElementById('canvas-container');
    canvas.width = container.clientWidth;
    canvas.height = container.clientHeight;
    smoothedPriceY = 0;
}

window.addEventListener('resize', () => {
    resizeCanvas();
    cat.x = Math.min(cat.x, canvas.width - cat.width);
    cat.y = Math.min(cat.y, canvas.height - cat.height);
});

function animate() {
    if (isGameOver) return;
    if (isPaused) {
        requestAnimationFrame(animate);
        return;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    updateMarket();
    ghostsTick();
    drawBackground();
    cat.update();
    drawGhosts();                  // ghosts under player so player cat reads as primary
    cat.draw();
    if (window.opponentState) drawOpponentCat(window.opponentState);
    updateHUD();
    updateRaceBoard();
    checkPortfolioSFX();
    frames++;
    const spyDone = spyMode && spyBarIdx >= spyBars.length - 1 && spyFrameCounter >= spyFramesPerBar - 1;
    if (spyDone || (!spyMode && frames >= LEVEL_DURATION)) endGame(spyMode ? 'SPY Level Complete!' : 'Session Closed!');
    else requestAnimationFrame(animate);
}

function clearRaceMode() {
    raceMode = false;
    ghosts.length = 0;
    const board = document.getElementById('raceBoard');
    if (board) board.style.display = 'none';
}

restartBtn.addEventListener('click', () => {
    gameOverScreen.classList.add('hidden');
    clearRaceMode();
    showLevelSelect();
});
document.getElementById('quickPlayLastOpenBtn').addEventListener('click', async () => {
    readTickerFromInput();
    clearRaceMode();
    const btn = document.getElementById('quickPlayLastOpenBtn');
    await loadLevel(lastCompletedOpenDateStr(), 'open', btn);
});
document.getElementById('quickPlayLast60Btn').addEventListener('click', () => {
    readTickerFromInput();
    clearRaceMode();
    startQuickPlay(activeTicker, activeTickerIsCrypto);
});

// Race the Rainbow: load top 6 ghosts from the same level + replay them.
document.getElementById('raceRainbowBtn').addEventListener('click', async () => {
    readTickerFromInput();
    const date = lastCompletedOpenDateStr();
    const matches = loadGhostsForLevel(activeTicker, 'open', date);
    initGhosts(matches, START_PORTFOLIO);
    raceMode = true;
    const btn = document.getElementById('raceRainbowBtn');
    await loadLevel(date, 'open', btn);
});

// Export Time & Sales as TraderVue/IBKR-compatible CSV
document.getElementById('exportTradesBtn')?.addEventListener('click', exportTradesCSV);

// Pressing Enter in the ticker input fires Last 60 min (most common quick action)
document.getElementById('tickerInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
        e.preventDefault();
        readTickerFromInput();
        clearRaceMode();
        startQuickPlay(activeTicker, activeTickerIsCrypto);
    }
});

// Speed toast
const speedToastEl = document.getElementById('speed-toast');
let speedSettleTimer = null;
function showSpeedToast(speed) {
    clearTimeout(speedSettleTimer);
    speedSettleTimer = setTimeout(() => {
        speedToastEl.textContent = speed + 'x';
        speedToastEl.classList.add('visible');
        setTimeout(() => speedToastEl.classList.remove('visible'), 1400);
    }, 1000);
}

document.getElementById('speedSlider').addEventListener('input', function () {
    let v = parseInt(this.value, 10);
    const maxSpeed = spyIsLive ? 1 : 120;
    v = Math.min(v, maxSpeed);
    this.value = v;
    // Magnetic snap to meaningful real-time multiples (within ±2)
    const snaps = [1, 5, 10, 30, 60, 90, 120];
    for (const s of snaps) {
        if (s <= maxSpeed && Math.abs(v - s) <= 2) { v = s; this.value = v; break; }
    }
    spySpeed = v;
    document.getElementById('speedLabel').textContent = spySpeed + 'x';
    if (spyMode && spyBars.length > 0) {
        spyFramesPerBar = Math.max(1, Math.round(3600 / spySpeed));
        const remainingBars = spyBars.length - spyBarIdx;
        LEVEL_DURATION = frames + remainingBars * spyFramesPerBar;
    }
    showSpeedToast(spySpeed);
});

// Progress scrubber
function scrubToPercent(pct) {
    if (!spyMode || spyBars.length === 0) return;
    spyBarIdx = Math.round(Math.max(0, Math.min(1, pct)) * (spyBars.length - 1));
    spyFrameCounter = 0;
    currentBTCPrice = spyBars[spyBarIdx].o;
    priceHistory.length = 0;
    ema12.length = 0; ema26.length = 0;
    macdLine.length = 0; signalLine.length = 0; histogram.length = 0;
    smoothedPriceY = 0;
}

function scrubPctFromEvent(e) {
    const rect = progressContainer.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    return (clientX - rect.left) / rect.width;
}

let isScrubbing = false;

progressContainer.addEventListener('mousedown', (e) => {
    if (!spyMode) return;
    isScrubbing = true;
    progressContainer.classList.add('scrubbing');
    scrubToPercent(scrubPctFromEvent(e));
});

document.addEventListener('mousemove', (e) => {
    if (!isScrubbing) return;
    scrubToPercent(scrubPctFromEvent(e));
});

document.addEventListener('mouseup', () => {
    isScrubbing = false;
    progressContainer.classList.remove('scrubbing');
});

progressContainer.addEventListener('touchstart', (e) => {
    if (!spyMode) return;
    isScrubbing = true;
    progressContainer.classList.add('scrubbing');
    scrubToPercent(scrubPctFromEvent(e));
}, { passive: true });

document.addEventListener('touchmove', (e) => {
    if (!isScrubbing) return;
    scrubToPercent(scrubPctFromEvent(e));
}, { passive: true });

document.addEventListener('touchend', () => {
    isScrubbing = false;
    progressContainer.classList.remove('scrubbing');
});

// Tape column toggles
const timeAndSalesEl = document.getElementById('timeAndSales');
document.querySelectorAll('.tape-toggle').forEach(btn => {
    const col = btn.dataset.col;
    btn.addEventListener('click', () => {
        btn.classList.toggle('active');
        timeAndSalesEl.classList.toggle(`hide-${col}`);
    });
});

// ---- Calendar / Leaderboard ----
let calendarYear = new Date().getFullYear();
let calendarMonth = new Date().getMonth();
let calendarActiveTab = 'monthly';

function showCalendar() {
    isPaused = true;
    bgMusic.pause();
    calendarYear = new Date().getFullYear();
    calendarMonth = new Date().getMonth();
    renderCalendar();
    document.getElementById('calendarModal').classList.remove('hidden');
}

function hideCalendar() {
    document.getElementById('calendarModal').classList.add('hidden');
    if (!isGameOver) {
        isPaused = false;
        if (musicStarted) bgMusic.play();
    }
}

function renderCalendar() {
    const monthLabel = new Date(calendarYear, calendarMonth, 1)
        .toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    document.getElementById('calMonthLabel').textContent = monthLabel;

    if (calendarActiveTab === 'monthly') {
        document.getElementById('calGrid').classList.remove('hidden');
        document.getElementById('calAllSessions').classList.add('hidden');
        renderCalendarGrid();
    } else {
        document.getElementById('calGrid').classList.add('hidden');
        document.getElementById('calDayDetail').classList.add('hidden');
        document.getElementById('calAllSessions').classList.remove('hidden');
        renderAllSessions();
    }
}

function renderCalendarGrid() {
    const year = calendarYear;
    const month = calendarMonth;
    const yearMonthStr = `${year}-${String(month + 1).padStart(2, '0')}`;

    // Build daily scores map
    const dailyScores = {};
    allSessions.forEach(s => {
        if (!s.isoDate || !s.isoDate.startsWith(yearMonthStr)) return;
        const day = s.isoDate.slice(8, 10);
        if (!dailyScores[day]) dailyScores[day] = [];
        dailyScores[day].push(s);
    });

    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    let html = '<div class="cal-weekdays">';
    ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].forEach(d => html += `<div class="cal-wd">${d}</div>`);
    html += '</div><div class="cal-days">';

    for (let i = 0; i < firstDay; i++) html += '<div class="cal-day empty"></div>';

    for (let d = 1; d <= daysInMonth; d++) {
        const dayStr = String(d).padStart(2, '0');
        const scores = dailyScores[dayStr] ? [...dailyScores[dayStr]].sort((a, b) => b.profit - a.profit) : null;
        const best = scores ? scores[0] : null;
        const hasScores = best != null;
        const profitClass = best ? (best.profit >= 0 ? 'cal-profit' : 'cal-loss') : '';
        const isoDate = `${yearMonthStr}-${dayStr}`;

        html += `<div class="cal-day ${profitClass} ${hasScores ? 'cal-has-scores' : ''}"
                      ${hasScores ? `onclick="showCalDayDetail('${isoDate}')"` : ''}>
            <div class="cal-day-num">${d}</div>
            ${best ? `<div class="cal-day-pnl">${best.profit >= 0 ? '+' : ''}$${Math.abs(best.profit).toFixed(0)}</div>` : ''}
            ${best ? renderMiniChart(best.priceSnapshot, 58, 22) : ''}
        </div>`;
    }

    html += '</div>';
    document.getElementById('calGrid').innerHTML = html;
    document.getElementById('calDayDetail').classList.add('hidden');
}

function renderMiniChart(snapshot, w, h) {
    if (!snapshot || snapshot.length < 2) return '';
    w = w || 58; h = h || 22;
    const min = Math.min(...snapshot);
    const max = Math.max(...snapshot);
    const range = max - min || 1;
    const pts = snapshot.map((p, i) => {
        const x = (i / (snapshot.length - 1)) * w;
        const y = h - ((p - min) / range) * h;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    const color = snapshot[snapshot.length - 1] >= snapshot[0] ? '#00ff88' : '#ff4444';
    return `<svg width="${w}" height="${h}" class="cal-chart" style="overflow:visible"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5"/></svg>`;
}

function showCalDayDetail(isoDate) {
    const sessions = allSessions.filter(s => s.isoDate === isoDate);
    if (!sessions.length) return;
    sessions.sort((a, b) => b.profit - a.profit);

    const dateLabel = new Date(isoDate + 'T12:00:00Z')
        .toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

    const detail = document.getElementById('calDayDetail');
    detail.innerHTML = `
        <div class="cal-detail-header">${dateLabel} — ${sessions.length} session${sessions.length > 1 ? 's' : ''}</div>
        ${sessions.map(s => `
            <div class="cal-session ${s.profit >= 0 ? 'cal-profit' : 'cal-loss'}">
                <div class="cal-session-pnl">
                    ${s.profit >= 0 ? '+' : ''}$${Math.abs(s.profit).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}<br>
                    <span style="font-size:10px;font-weight:normal;color:${s.profit >= 0 ? '#00aa55' : '#aa2222'}">${s.profit >= 0 ? '+' : ''}${(s.profitPercent || 0).toFixed(2)}%</span>
                </div>
                <div class="cal-session-meta">
                    ${s.ticker || 'BTC/USD'} · ${s.mode || 'sim'} · ${s.time}s<br>
                    ${s.startPortfolio ? '$' + s.startPortfolio.toLocaleString() + ' start' : ''}
                </div>
                ${renderMiniChart(s.priceSnapshot, 80, 34)}
            </div>
        `).join('')}
    `;
    detail.classList.remove('hidden');
}

function renderAllSessions() {
    const container = document.getElementById('calAllSessions');
    const sorted = [...allSessions].sort((a, b) =>
        (b.isoDate || '').localeCompare(a.isoDate || '') || b.profit - a.profit);

    if (sorted.length === 0) {
        container.innerHTML = '<div style="text-align:center;color:#444;padding:24px;font-family:monospace;">No sessions recorded yet.</div>';
        return;
    }

    container.innerHTML = sorted.map(s => `
        <div class="cal-all-entry ${s.profit >= 0 ? 'cal-profit' : 'cal-loss'}">
            <div class="cal-all-date">${s.isoDate || s.timestamp || '—'}</div>
            <div class="cal-all-pnl">
                ${s.profit >= 0 ? '+' : ''}$${Math.abs(s.profit).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}<br>
                <span style="font-size:9px;font-weight:normal">${s.profit >= 0 ? '+' : ''}${(s.profitPercent || 0).toFixed(2)}%</span>
            </div>
            <div class="cal-all-meta">${s.ticker || 'BTC/USD'} · ${s.mode || 'sim'} · ${s.time}s</div>
            ${renderMiniChart(s.priceSnapshot, 68, 26)}
        </div>
    `).join('');
}

// Calendar event listeners
document.getElementById('calendarBtn').addEventListener('click', showCalendar);
document.getElementById('calCloseBtn').addEventListener('click', hideCalendar);
document.getElementById('calPrevMonth').addEventListener('click', () => {
    calendarMonth--;
    if (calendarMonth < 0) { calendarMonth = 11; calendarYear--; }
    renderCalendar();
});
document.getElementById('calNextMonth').addEventListener('click', () => {
    calendarMonth++;
    if (calendarMonth > 11) { calendarMonth = 0; calendarYear++; }
    renderCalendar();
});
document.getElementById('calTabMonthly').addEventListener('click', () => {
    calendarActiveTab = 'monthly';
    document.querySelectorAll('.cal-tab').forEach(t => t.classList.toggle('active', t.id === 'calTabMonthly'));
    renderCalendar();
});
document.getElementById('calTabAll').addEventListener('click', () => {
    calendarActiveTab = 'all';
    document.querySelectorAll('.cal-tab').forEach(t => t.classList.toggle('active', t.id === 'calTabAll'));
    renderCalendar();
});


// Init
resizeCanvas();
cat.y = canvas.height / 2;
updateLeaderboardUI();
showLevelSelect();

// ---- Multiplayer API (used by multiplayer.js) ----
window.mpOnGameEnd = null;
window.gameAPI = {
    getState()  { return { catY: cat.y, pct: START_PORTFOLIO > 0 ? ((portfolioAmount - START_PORTFOLIO) / START_PORTFOLIO) * 100 : 0, alive: livesCount > 0, isOver: isGameOver }; },
    setOpponent(state) { window.opponentState = state; },
    setLivePrice(p)    { if (typeof p === 'number' && !isNaN(p)) livePrice = p; },
    endGame(msg)       { if (!isGameOver) endGame(msg || 'Race Over!'); },
    get isGameOver()   { return isGameOver; },
    get currentPrice() { return currentBTCPrice; },
};
