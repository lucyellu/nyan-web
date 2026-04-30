"""
IBKR Bridge Server
Connects TWS (running locally) to the web dashboard.

Install deps:
    pip install ib_insync aiohttp

Run:
    python ibkr_bridge.py

Then open ibkr_dashboard.html in your browser.
"""

import asyncio
import json
import logging
import time as _time
from collections import deque
from datetime import datetime
import aiohttp
from aiohttp import web
from aiohttp.web_middlewares import middleware
import ib_insync as ib

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────────────
TWS_HOST   = '127.0.0.1'
TWS_PORT   = 7497   # 7497 = TWS paper, 7496 = TWS live, 4002 = IB Gateway paper, 4001 = GW live
CLIENT_ID  = 10     # Arbitrary client ID — change if conflicting
BRIDGE_PORT = 8765

# Tick-by-tick LAST requires LIVE market data (type 1) and a US equity data
# subscription (~$1.50/mo, waived if commissions ≥ $30/mo). With delayed data
# (type 3) reqTickByTickData returns nothing. Flip to True once you've
# subscribed in TWS → Account Management → Market Data Subscriptions.
LIVE_TICK_BY_TICK = False
CANDLE_HISTORY_MAX = 600   # keep last N completed 1s candles per symbol (10 min)
# ──────────────────────────────────────────────────────────────────────────────

ibkr = ib.IB()

# ── WebSocket state ───────────────────────────────────────────────────────────
ws_clients     = set()          # active WebSocket connections
stream_tickers = {}             # symbol → ib.Ticker (persistent streaming subscriptions)
candle_subs    = {}             # symbol → ib.Ticker (tick-by-tick LAST subscription)
candle_buckets = {}             # symbol → {'ts','o','h','l','c','v'} for current open second
candle_history = {}             # symbol → deque[dict] (closed candles, ring buffer)
_loop          = None           # event loop reference set during startup


def _push_all(msg: dict):
    """Fire-and-forget JSON push to all connected WebSocket clients."""
    global ws_clients, _loop
    if not ws_clients or _loop is None:
        return
    dead = set()
    for ws in list(ws_clients):
        if ws.closed:
            dead.add(ws)
        else:
            try:
                _loop.create_task(ws.send_json(msg))
            except Exception:
                dead.add(ws)
    ws_clients.difference_update(dead)


async def subscribe_stream(sym: str):
    """Start persistent (non-snapshot) streaming for sym if not already active."""
    if sym in stream_tickers or not ibkr.isConnected():
        return
    try:
        contract = ib.Stock(sym, 'SMART', 'USD')
        await ibkr.qualifyContractsAsync(contract)
        ticker = ibkr.reqMktData(contract, genericTickList='', snapshot=False, regulatorySnapshot=False)
        stream_tickers[sym] = ticker
        log.info(f"Streaming market data: {sym}")
    except Exception as e:
        log.warning(f"subscribe_stream {sym}: {e}")


def _contract_for(sym: str):
    """Pick the right ib_insync contract type. BTC/ETH go through PAXOS crypto."""
    if sym in ('BTC', 'ETH', 'LTC', 'BCH'):
        return ib.Crypto(sym, 'PAXOS', 'USD')
    return ib.Stock(sym, 'SMART', 'USD')


async def subscribe_candles_1s(sym: str):
    """1-second OHLCV stream for sym via tick-by-tick LAST trades.

    Requires LIVE_TICK_BY_TICK=True and a live US equity data subscription.
    Each closed second is pushed via WS as {type:'candle1s', symbol, ts, o,h,l,c, v}.
    Quiet seconds get a forward-filled flat candle (v=0, filled=True).
    """
    if sym in candle_subs or not ibkr.isConnected():
        return
    try:
        contract = _contract_for(sym)
        await ibkr.qualifyContractsAsync(contract)
        # 'Last' = trade prints only (skip auction/odd-lot). 0 = continuous, not snapshot.
        ticker = ibkr.reqTickByTickData(contract, 'Last', 0, False)
        candle_subs[sym] = ticker
        candle_history[sym] = deque(maxlen=CANDLE_HISTORY_MAX)
        log.info(f"1s candles subscribed: {sym}")
    except Exception as e:
        log.warning(f"subscribe_candles_1s {sym}: {e}")


def _ingest_tick(sym: str, ts_ms: int, price: float, size: int):
    """Fold a single trade print into the live 1s bucket. Closes the previous
    second on bucket rollover (and emits it). Forward-fill of skipped quiet
    seconds is handled by the flusher, not here."""
    if not (price and price == price):
        return
    sec = ts_ms // 1000
    bucket = candle_buckets.get(sym)
    if bucket is None:
        candle_buckets[sym] = {'ts': sec, 'o': price, 'h': price, 'l': price, 'c': price, 'v': size}
        return
    if sec == bucket['ts']:
        if price > bucket['h']: bucket['h'] = price
        if price < bucket['l']: bucket['l'] = price
        bucket['c'] = price
        bucket['v'] += size
        return
    if sec > bucket['ts']:
        # Close current bucket and emit
        _push_all({'type': 'candle1s', 'symbol': sym, **bucket})
        candle_history[sym].append(dict(bucket))
        # Forward-fill any fully-skipped seconds with flat candles at last close
        last_c = bucket['c']
        for fill_ts in range(bucket['ts'] + 1, sec):
            flat = {'ts': fill_ts, 'o': last_c, 'h': last_c, 'l': last_c, 'c': last_c, 'v': 0}
            _push_all({'type': 'candle1s', 'symbol': sym, **flat, 'filled': True})
            candle_history[sym].append(flat)
        candle_buckets[sym] = {'ts': sec, 'o': price, 'h': price, 'l': price, 'c': price, 'v': size}
    # sec < bucket['ts']: out-of-order tick, drop


def _drain_tick_by_tick(ticker):
    """Move any new tick-by-tick prints off the ticker into our aggregator."""
    if not ticker.tickByTicks:
        return
    sym = ticker.contract.symbol
    for tbt in list(ticker.tickByTicks):
        ts_ms = int(tbt.time.timestamp() * 1000)
        _ingest_tick(sym, ts_ms, float(tbt.price), int(getattr(tbt, 'size', 0) or 0))
    ticker.tickByTicks.clear()


async def _candle_flusher():
    """Once per ~500ms, finalize any open bucket whose second has fully elapsed
    even if no trades arrived. Forward-fills until caught up to wall clock."""
    while True:
        await asyncio.sleep(0.5)
        now_sec = int(_time.time())
        for sym in list(candle_buckets.keys()):
            bucket = candle_buckets.get(sym)
            if not bucket or bucket['ts'] >= now_sec:
                continue
            # Close it, then keep rolling forward flat until current second
            _push_all({'type': 'candle1s', 'symbol': sym, **bucket})
            candle_history[sym].append(dict(bucket))
            last_c = bucket['c']
            for fill_ts in range(bucket['ts'] + 1, now_sec):
                flat = {'ts': fill_ts, 'o': last_c, 'h': last_c, 'l': last_c, 'c': last_c, 'v': 0}
                _push_all({'type': 'candle1s', 'symbol': sym, **flat, 'filled': True})
                candle_history[sym].append(flat)
            candle_buckets[sym] = {'ts': now_sec, 'o': last_c, 'h': last_c, 'l': last_c, 'c': last_c, 'v': 0}


def _on_pending_tickers(tickers):
    """ib_insync event: fires whenever any streaming ticker has a new price."""
    updates = []
    for t in tickers:
        if not t.contract:
            continue
        sym = t.contract.symbol
        # Drain tick-by-tick prints into 1s aggregator if this is a candle sub
        if sym in candle_subs and t is candle_subs[sym]:
            _drain_tick_by_tick(t)
        if not ws_clients:
            continue
        p = t.marketPrice()
        if p and p == p:  # skip nan
            u = {'symbol': sym, 'price': round(p, 4)}
            if t.close and t.close == t.close:
                u['close'] = round(t.close, 4)
            updates.append(u)
    if updates:
        _push_all({'type': 'prices', 'data': updates})


def _on_pnl(pnl):
    """ib_insync event: fires on every P&L update from TWS."""
    _push_all({
        'type':       'pnl',
        'unrealized': round(pnl.unrealizedPnL or 0, 2),
        'daily':      round(pnl.dailyPnL      or 0, 2),
        'realized':   round(pnl.realizedPnL   or 0, 2),
    })


# Purely informational TWS codes — not errors
# 300 = "Can't find EId with tickerId" (benign race on mktdata cancel)
# 10168 = market data not subscribed (handled by reqMarketDataType)
_INFO_CODES = {300, 1100, 1101, 1102, 2104, 2106, 2107, 2108, 2119, 2158, 2176, 10168}

def _on_error(reqId: int, errorCode: int, errorString: str, contract):
    """ib_insync event: fires for ALL TWS errors and warnings."""
    if errorCode in _INFO_CODES:
        return
    log.error(f"TWS [{errorCode}] reqId={reqId}: {errorString}")
    _push_all({
        'type':    'tws_error',
        'code':    errorCode,
        'message': errorString,
        'reqId':   reqId,
    })


async def connect_ibkr():
    """Try to connect to TWS. Non-fatal if it fails."""
    try:
        await ibkr.connectAsync(TWS_HOST, TWS_PORT, clientId=CLIENT_ID)
        log.info(f"Connected to TWS at {TWS_HOST}:{TWS_PORT} — account: {ibkr.wrapper.accounts}")
    except Exception as e:
        log.warning(f"Could not connect to TWS: {e}")


# ── CORS middleware ───────────────────────────────────────────────────────────
@middleware
async def cors_middleware(request, handler):
    if request.method == 'OPTIONS':
        return web.Response(headers={
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        })
    response = await handler(request)
    response.headers['Access-Control-Allow-Origin'] = '*'
    return response


# ── Routes ────────────────────────────────────────────────────────────────────
async def handle_status(request):
    connected = ibkr.isConnected()
    account = ibkr.wrapper.accounts[0] if connected and ibkr.wrapper.accounts else None
    return web.json_response({
        'connected': connected,
        'account': account,
        'timestamp': datetime.utcnow().isoformat()
    })


async def handle_portfolio(request):
    if not ibkr.isConnected():
        return web.json_response({'error': 'Not connected to TWS'}, status=503)

    try:
        account_id = ibkr.wrapper.accounts[0]

        # Account summary
        summary = await ibkr.accountSummaryAsync(account_id)
        account = {item.tag: item.value for item in summary}

        # PnL
        pnl = ibkr.pnl()
        if not pnl:
            ibkr.reqPnL(account_id)
            await asyncio.sleep(0.5)
            pnl = ibkr.pnl()

        if pnl:
            p = pnl[0]
            account['DailyPnL']     = str(p.dailyPnL or 0)
            account['UnrealizedPnL'] = str(p.unrealizedPnL or 0)
            account['RealizedPnL']   = str(p.realizedPnL or 0)

        # Positions
        positions_raw = ibkr.positions(account_id)
        positions = []

        for p in positions_raw:
            c = p.contract
            pos_dict = {
                'symbol':    c.symbol,
                'secType':   c.secType,
                'exchange':  c.exchange,
                'currency':  c.currency,
                'position':  p.position,
                'avgCost':   round(p.avgCost, 4),
                'marketPrice': None,
                'marketValue': None,
                'unrealizedPnl': None,
                'pnlPct': None,
            }

            # Option-specific fields
            if c.secType == 'OPT':
                pos_dict.update({
                    'right':  c.right,
                    'strike': c.strike,
                    'expiry': c.lastTradeDateOrContractMonth,
                    'delta':  None,
                    'gamma':  None,
                    'theta':  None,
                    'vega':   None,
                    'iv':     None,
                })

            # Try to get market data
            try:
                ticker = ibkr.reqMktData(c, genericTickList='', snapshot=True, regulatorySnapshot=False)
                await asyncio.sleep(0.3)
                ibkr.cancelMktData(c)

                mp = ticker.marketPrice()
                if mp and mp == mp:  # not nan
                    pos_dict['marketPrice'] = round(mp, 4)
                    mv = mp * p.position * (100 if c.secType == 'OPT' else 1)
                    cost_basis = p.avgCost * abs(p.position) * (100 if c.secType == 'OPT' else 1)
                    upnl = mv - cost_basis
                    pos_dict['marketValue']    = round(mv, 2)
                    pos_dict['unrealizedPnl']  = round(upnl, 2)
                    pos_dict['pnlPct']         = round(upnl / cost_basis * 100, 2) if cost_basis else None

                # Greeks for options
                if c.secType == 'OPT' and ticker.modelGreeks:
                    g = ticker.modelGreeks
                    pos_dict.update({
                        'delta': round(g.delta, 4) if g.delta else None,
                        'gamma': round(g.gamma, 4) if g.gamma else None,
                        'theta': round(g.theta, 4) if g.theta else None,
                        'vega':  round(g.vega,  4) if g.vega  else None,
                        'iv':    round(g.impliedVol, 4) if g.impliedVol else None,
                    })
            except Exception as e:
                log.warning(f"Market data error for {c.symbol}: {e}")

            positions.append(pos_dict)

        return web.json_response({'account': account, 'positions': positions})

    except Exception as e:
        log.error(f"Portfolio error: {e}")
        return web.json_response({'error': str(e)}, status=500)


async def handle_order(request):
    if not ibkr.isConnected():
        return web.json_response({'success': False, 'error': 'Not connected to TWS'}, status=503)

    try:
        data = await request.json()
        symbol    = data['symbol']
        action    = data['action'].upper()   # BUY | SELL
        quantity  = int(data.get('quantity', 0))
        order_type = data.get('orderType', 'MKT').upper()
        price     = data.get('price')
        sec_type  = data.get('secType', 'STK')

        # Build contract
        if sec_type == 'OPT':
            contract = ib.Option(
                symbol   = symbol,
                lastTradeDateOrContractMonth = data['expiry'],
                strike   = float(data['strike']),
                right    = data['right'],  # 'C' or 'P'
                exchange = data.get('exchange', 'SMART'),
            )
        elif sec_type == 'CRYPTO':
            contract = ib.Crypto(symbol, 'PAXOS', data.get('currency', 'USD'))
            await ibkr.qualifyContractsAsync(contract)
            order = ib.Order()
            order.action = action
            order.orderType = 'MKT'
            order.cashQty = float(data['cashQty'])
            order.tif = 'GTC'
            trade = ibkr.placeOrder(contract, order)
            await asyncio.sleep(0.5)
            log.info(f"Crypto order: {action} ${data['cashQty']} {symbol} — {trade.orderStatus.status}")
            return web.json_response({
                'success': True,
                'orderId': trade.order.orderId,
                'status':  trade.orderStatus.status
            })
        else:
            contract = ib.Stock(symbol, data.get('exchange', 'SMART'), data.get('currency', 'USD'))

        await ibkr.qualifyContractsAsync(contract)

        # Build order
        if order_type == 'MKT':
            order = ib.MarketOrder(action, quantity)
        elif order_type == 'LMT' and price:
            order = ib.LimitOrder(action, quantity, round(float(price), 2))
        else:
            return web.json_response({'success': False, 'error': 'Invalid order type or missing price'})

        trade = ibkr.placeOrder(contract, order)

        # Wait up to 3 s for TWS to acknowledge
        for _ in range(30):
            await asyncio.sleep(0.1)
            if trade.orderStatus.status not in ('', 'Unknown'):
                break

        status = trade.orderStatus.status

        # Collect every log entry from TWS for this trade
        trade_log = [
            {'status': e.status, 'message': e.message, 'code': e.errorCode}
            for e in trade.log
        ]

        # Explicit error codes from TWS attached to this trade
        errors = [
            f"[{e.errorCode}] {e.message}" for e in trade.log
            if e.errorCode and e.errorCode not in _INFO_CODES
        ]
        if errors:
            log.warning(f"Order rejected {symbol}: {errors}")
            return web.json_response({'success': False, 'error': '; '.join(errors), 'log': trade_log})

        # Status never changed from '' — TWS silently ignored the order.
        # Most common causes: Read-Only API enabled, or API not permitted for account.
        if status in ('', 'Unknown'):
            msg = ('TWS did not acknowledge the order. '
                   'Check: TWS → Edit → Global Configuration → API → Settings '
                   '→ uncheck "Read-Only API" and check "Bypass Order Precautions for API Orders".')
            log.error(msg)
            return web.json_response({'success': False, 'error': msg, 'log': trade_log})

        log.info(f"Order: {action} {quantity} {symbol} @ {order_type} — {status}")
        return web.json_response({
            'success':   status in ('Submitted', 'Filled', 'PreSubmitted'),
            'orderId':   trade.order.orderId,
            'status':    status,
            'filled':    trade.orderStatus.filled,
            'remaining': trade.orderStatus.remaining,
            'log':       trade_log,
        })

    except Exception as e:
        log.error(f"Order error: {e}")
        return web.json_response({'success': False, 'error': str(e)}, status=500)


async def handle_option_chain(request):
    """Get option chain for a symbol — called by the AI when user asks for best contracts."""
    if not ibkr.isConnected():
        return web.json_response({'error': 'Not connected'}, status=503)

    symbol = request.rel_url.query.get('symbol', 'SPY')
    try:
        stock = ib.Stock(symbol, 'SMART', 'USD')
        await ibkr.qualifyContractsAsync(stock)

        chains = await ibkr.reqSecDefOptParamsAsync(stock.symbol, '', stock.secType, stock.conId)
        chain = next((c for c in chains if c.exchange == 'SMART'), chains[0] if chains else None)

        if not chain:
            return web.json_response({'error': 'No chain found'})

        # Return expirations + strikes
        expirations = sorted(chain.expirations)[:6]  # nearest 6 expirations
        strikes = sorted(chain.strikes)

        # Get current price
        ticker = ibkr.reqMktData(stock, snapshot=True)
        await asyncio.sleep(0.3)
        ibkr.cancelMktData(stock)
        price = ticker.marketPrice()

        # Filter strikes near ATM
        if price and price == price:
            atm_strikes = [s for s in strikes if abs(s - price) / price < 0.15]
        else:
            atm_strikes = strikes[len(strikes)//2-10:len(strikes)//2+10]

        return web.json_response({
            'symbol': symbol,
            'underlyingPrice': round(price, 2) if price == price else None,
            'expirations': expirations,
            'strikes': atm_strikes,
        })

    except Exception as e:
        return web.json_response({'error': str(e)}, status=500)


async def handle_bars(request):
    """OHLCV bars for the chart — GET /bars?symbol=SPY&tf=5m"""
    if not ibkr.isConnected():
        return web.json_response({'error': 'Not connected'}, status=503)

    symbol = request.rel_url.query.get('symbol', 'SPY').upper()
    tf     = request.rel_url.query.get('tf', '5m')

    TF_MAP = {
        '1m':  ('1 min',   '1 D'),
        '5m':  ('5 mins',  '3 D'),
        '15m': ('15 mins', '5 D'),
        '1h':  ('1 hour',  '20 D'),
        '1d':  ('1 day',   '1 Y'),
    }
    bar_size, duration = TF_MAP.get(tf, ('5 mins', '3 D'))

    try:
        contract = ib.Stock(symbol, 'SMART', 'USD')
        await ibkr.qualifyContractsAsync(contract)
        bars = await ibkr.reqHistoricalDataAsync(
            contract,
            endDateTime='',
            durationStr=duration,
            barSizeSetting=bar_size,
            whatToShow='TRADES',
            useRTH=True,
        )
        result = [
            {'t': str(b.date), 'o': b.open, 'h': b.high, 'l': b.low, 'c': b.close, 'v': b.volume}
            for b in bars
        ]
        return web.json_response({'symbol': symbol, 'bars': result})
    except Exception as e:
        log.error(f"Bars error for {symbol}: {e}")
        return web.json_response({'error': str(e)}, status=500)


async def handle_candles(request):
    """Backfill recent 1s candles — GET /candles?symbol=SPY&n=300

    Returns last N closed candles from the in-memory ring buffer. Use this on
    WS reconnect to seed the chart, then live updates flow over /ws.
    """
    sym = request.rel_url.query.get('symbol', 'SPY').upper()
    try:
        n = int(request.rel_url.query.get('n', CANDLE_HISTORY_MAX))
    except ValueError:
        n = CANDLE_HISTORY_MAX
    hist = candle_history.get(sym)
    if hist is None:
        return web.json_response({'symbol': sym, 'candles': [], 'note': 'not subscribed — send WS {type:subscribe_candles, symbols:[...]}'})
    candles = list(hist)[-n:]
    return web.json_response({'symbol': sym, 'candles': candles, 'count': len(candles)})


async def handle_quote(request):
    """Snapshot quotes for multiple symbols — GET /quote?symbols=SPY,QQQ,TSLA"""
    if not ibkr.isConnected():
        return web.json_response({'error': 'Not connected'}, status=503)

    raw     = request.rel_url.query.get('symbols', 'SPY')
    symbols = [s.strip().upper() for s in raw.split(',') if s.strip()]

    async def fetch_one(sym):
        try:
            contract = ib.Stock(sym, 'SMART', 'USD')
            ticker   = ibkr.reqMktData(contract, genericTickList='', snapshot=True, regulatorySnapshot=False)
            await asyncio.sleep(0.4)
            ibkr.cancelMktData(contract)
            price = ticker.marketPrice()
            close = ticker.close
            return {
                'symbol': sym,
                'price':  round(price, 4) if price and price == price else None,
                'close':  round(close, 4) if close and close == close else None,
            }
        except Exception as e:
            return {'symbol': sym, 'price': None, 'close': None, 'error': str(e)}

    results = await asyncio.gather(*[fetch_one(s) for s in symbols])
    return web.json_response({'quotes': list(results)})


async def handle_flatten(request):
    """Close all open positions with market DAY orders."""
    if not ibkr.isConnected():
        return web.json_response({'success': False, 'error': 'Not connected to TWS'}, status=503)

    try:
        positions_raw = ibkr.positions()
        orders_placed = []
        for pos in positions_raw:
            if pos.position == 0:
                continue
            c = pos.contract
            action = 'SELL' if pos.position > 0 else 'BUY'
            qty = abs(int(pos.position))
            order = ib.MarketOrder(action, qty)
            order.tif = 'DAY'
            trade = ibkr.placeOrder(c, order)
            orders_placed.append({
                'symbol':  c.symbol,
                'action':  action,
                'qty':     qty,
                'orderId': trade.order.orderId,
            })
            log.info(f"Flatten: {action} {qty} {c.symbol}")
        return web.json_response({'success': True, 'orders': orders_placed})
    except Exception as e:
        log.error(f"Flatten error: {e}")
        return web.json_response({'success': False, 'error': str(e)}, status=500)


async def handle_open_orders(request):
    """Return all open orders TWS knows about — GET /open-orders"""
    if not ibkr.isConnected():
        return web.json_response({'error': 'Not connected'}, status=503)
    try:
        trades = await ibkr.reqOpenOrdersAsync()
        return web.json_response({'orders': [{
            'orderId':  t.order.orderId,
            'symbol':   t.contract.symbol,
            'action':   t.order.action,
            'qty':      t.order.totalQuantity,
            'type':     t.order.orderType,
            'status':   t.orderStatus.status,
            'filled':   t.orderStatus.filled,
        } for t in trades]})
    except Exception as e:
        return web.json_response({'error': str(e)}, status=500)


async def handle_ws(request):
    """WebSocket endpoint — pushes price ticks and P&L updates in real time."""
    ws = web.WebSocketResponse(heartbeat=20)
    await ws.prepare(request)
    ws_clients.add(ws)
    log.info(f"WS client connected ({len(ws_clients)} total)")

    try:
        async for msg in ws:
            if msg.type == aiohttp.WSMsgType.TEXT:
                try:
                    data = json.loads(msg.data)
                    # Client sends {"type": "subscribe", "symbols": ["SPY", ...]}
                    if data.get('type') == 'subscribe':
                        for sym in data.get('symbols', []):
                            await subscribe_stream(sym.upper().strip())
                    elif data.get('type') == 'subscribe_candles':
                        for sym in data.get('symbols', []):
                            await subscribe_candles_1s(sym.upper().strip())
                except Exception as e:
                    log.warning(f"WS message error: {e}")
            elif msg.type in (aiohttp.WSMsgType.ERROR, aiohttp.WSMsgType.CLOSE):
                break
    except Exception as e:
        log.warning(f"WS error: {e}")
    finally:
        ws_clients.discard(ws)
        log.info(f"WS client disconnected ({len(ws_clients)} remaining)")

    return ws


# ── App setup ─────────────────────────────────────────────────────────────────
async def on_startup(app):
    global _loop
    _loop = asyncio.get_event_loop()

    # Register ib_insync event handlers (these survive reconnects)
    ibkr.pendingTickersEvent += _on_pending_tickers
    ibkr.pnlEvent            += _on_pnl
    ibkr.errorEvent          += _on_error

    await connect_ibkr()

    if ibkr.isConnected():
        # 1 = live (needs subscription), 3 = delayed (free, 15–20 min)
        # tick-by-tick LAST requires type 1 — switches all subsequent reqMktData too
        ibkr.reqMarketDataType(1 if LIVE_TICK_BY_TICK else 3)
        if ibkr.wrapper.accounts:
            ibkr.reqPnL(ibkr.wrapper.accounts[0])

    asyncio.create_task(_candle_flusher())

    # Reconnect loop
    async def keep_connected():
        while True:
            await asyncio.sleep(30)
            if not ibkr.isConnected():
                log.info("Reconnecting to TWS...")
                # Cancel stale streaming subscriptions before reconnect
                for t in list(stream_tickers.values()):
                    try:
                        ibkr.cancelMktData(t.contract)
                    except Exception:
                        pass
                stream_tickers.clear()
                for t in list(candle_subs.values()):
                    try:
                        ibkr.cancelTickByTickData(t.contract, 'Last')
                    except Exception:
                        pass
                candle_subs.clear()
                candle_buckets.clear()
                await connect_ibkr()
                if ibkr.isConnected():
                    ibkr.reqMarketDataType(1 if LIVE_TICK_BY_TICK else 3)
                    if ibkr.wrapper.accounts:
                        ibkr.reqPnL(ibkr.wrapper.accounts[0])
    asyncio.create_task(keep_connected())


def create_app():
    app = web.Application(middlewares=[cors_middleware])
    app.router.add_get('/status',       handle_status)
    app.router.add_get('/portfolio',    handle_portfolio)
    app.router.add_post('/order',       handle_order)
    app.router.add_post('/flatten',     handle_flatten)
    app.router.add_get('/option-chain', handle_option_chain)
    app.router.add_get('/bars',         handle_bars)
    app.router.add_get('/candles',      handle_candles)
    app.router.add_get('/quote',        handle_quote)
    app.router.add_get('/ws',           handle_ws)
    app.router.add_get('/open-orders',  handle_open_orders)
    app.on_startup.append(on_startup)
    return app


if __name__ == '__main__':
    print(f"""
╔══════════════════════════════════════════╗
║         IBKR Bridge Server               ║
║  Connecting to TWS at {TWS_HOST}:{TWS_PORT}      ║
║  Bridge listening on  localhost:{BRIDGE_PORT}    ║
╚══════════════════════════════════════════╝

Make sure TWS is open with API enabled:
  File → Global Config → API → Settings
  ✓ Enable ActiveX and Socket Clients
  ✓ Socket port: {TWS_PORT}
  ✓ Allow connections from localhost

""")
    app = create_app()
    web.run_app(app, host='127.0.0.1', port=BRIDGE_PORT)
