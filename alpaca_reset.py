"""
Alpaca Paper Account Cleanup
Cancels all open orders and closes all positions.

NOTE: To reset the cash balance back to $100k you must do it via the web UI:
  app.alpaca.markets → Paper Trading → top-right menu → Reset Account

Run:
    python alpaca_reset.py
"""

import json
import urllib.request
import urllib.error

# Load keys from config.json or enter manually
try:
    with open('config.json') as f:
        cfg = json.load(f)
    KEY    = cfg.get('alpaca_key', '')
    SECRET = cfg.get('alpaca_secret', '')
except Exception:
    KEY    = ''
    SECRET = ''

if not KEY or not SECRET:
    KEY    = input('Alpaca API Key: ').strip()
    SECRET = input('Alpaca Secret:  ').strip()

BASE = 'https://paper-api.alpaca.markets/v2'
HEADERS = {
    'APCA-API-KEY-ID':     KEY,
    'APCA-API-SECRET-KEY': SECRET,
    'Content-Type':        'application/json',
}


def request(method, path, body=None):
    url  = BASE + path
    data = json.dumps(body).encode() if body else None
    req  = urllib.request.Request(url, data=data, headers=HEADERS, method=method)
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read()
            return r.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        raw = e.read()
        return e.code, json.loads(raw) if raw else {}


# ── 1. Show current account ───────────────────────────────────────────────────
status, acct = request('GET', '/account')
if status != 200:
    print(f'Failed to fetch account: {status} {acct}')
    exit(1)

print(f"\nAccount: {acct.get('id','?')}")
print(f"  Portfolio value : ${float(acct.get('portfolio_value', 0)):,.2f}")
print(f"  Cash            : ${float(acct.get('cash', 0)):,.2f}")
print(f"  Buying power    : ${float(acct.get('buying_power', 0)):,.2f}")

# ── 2. Cancel all open orders ─────────────────────────────────────────────────
status, orders = request('GET', '/orders?status=open&limit=100')
if isinstance(orders, list) and orders:
    print(f"\nCancelling {len(orders)} open order(s)...")
    s, r = request('DELETE', '/orders')
    print(f"  → {s}: {r.get('message', r) if isinstance(r, dict) else r}")
else:
    print('\nNo open orders.')

# ── 3. Close all positions ────────────────────────────────────────────────────
status, positions = request('GET', '/positions')
if isinstance(positions, list) and positions:
    print(f"\nClosing {len(positions)} position(s)...")
    for p in positions:
        sym = p['symbol']
        s, r = request('DELETE', f'/positions/{sym}')
        pnl  = float(p.get('unrealized_pl', 0))
        sign = '+' if pnl >= 0 else ''
        print(f"  {sym:10s}  qty={p['qty']:>10}  P&L={sign}${pnl:,.2f}  → {s}")
else:
    print('\nNo open positions.')

# ── 4. Remind about balance reset ────────────────────────────────────────────
print("""
Done. Positions closed, orders cancelled.

To reset cash back to $100,000:
  1. Go to app.alpaca.markets
  2. Switch to Paper Trading (top-left)
  3. Click your account name (top-right) → Reset Account
  4. Confirm — balance resets to $100k instantly
""")
