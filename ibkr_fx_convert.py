"""
IBKR FX Conversion — CAD → USD
Connects to TWS paper account and places a market order to buy USD / sell CAD
on the IDEALPRO forex exchange.

Run:
    python ibkr_fx_convert.py

Prerequisites:
    pip install ib_insync
    TWS paper trading must be open with API enabled on port 7497.

Note: IDEALPRO minimum order is 25,000 of the base currency (USD here).
If your CAD balance is less than ~$34k CAD, the order will be rejected.
For smaller amounts you'll need to change base currency in Account Management:
    portal.interactivebrokers.com → Settings → Account Configuration → Base Currency
"""

import ib_insync as ib

TWS_HOST  = '127.0.0.1'
TWS_PORT  = 7497   # paper trading
CLIENT_ID = 15

ibkr = ib.IB()
ibkr.connect(TWS_HOST, TWS_PORT, clientId=CLIENT_ID)
print(f"Connected — account: {ibkr.wrapper.accounts}")

# ── 1. Get current balances via reqAccountUpdates ─────────────────────────────
# accountSummary() doesn't return per-currency CashBalance — need accountValues()
account_id = ibkr.wrapper.accounts[0]
ibkr.reqAccountUpdates(subscribe=True)
ibkr.sleep(1.5)

values = ibkr.accountValues()

# Print all cash-related values so we can see what the account holds
print("\nAll cash balances reported by TWS:")
cash_items = [v for v in values if v.tag == 'CashBalance']
for v in cash_items:
    print(f"  {v.currency}: {float(v.value):,.2f}")

cad_cash = next(
    (float(v.value) for v in cash_items if v.currency == 'CAD'),
    None
)
usd_cash = next(
    (float(v.value) for v in cash_items if v.currency == 'USD'),
    None
)
base_cash = next(
    (float(v.value) for v in cash_items if v.currency == 'BASE'),
    None
)

# If no explicit CAD entry, the account base currency total is the CAD balance
if cad_cash is None and base_cash is not None:
    cad_cash = base_cash
    print(f"\n(No explicit CAD entry — using BASE balance as CAD: {cad_cash:,.2f})")

ibkr.reqAccountUpdates(subscribe=False)  # unsubscribe

print(f"\nUsing for conversion:")
print(f"  CAD available: {cad_cash:,.2f}" if cad_cash is not None else "  CAD: n/a")
print(f"  USD existing:  {usd_cash:,.2f}" if usd_cash is not None else "  USD: n/a")

if not cad_cash or cad_cash < 1000:
    print("\nNot enough CAD balance to convert. Exiting.")
    ibkr.disconnect()
    exit(0)

# ── 2. Cancel any existing open USD.CAD orders ───────────────────────────────
open_orders = ibkr.openOrders()
usdcad_orders = [o for o in open_orders if getattr(o, 'symbol', '') == 'USD' or 'CAD' in str(getattr(o, 'symbol', ''))]
if usdcad_orders:
    print(f"\nFound {len(usdcad_orders)} existing USD.CAD order(s) — cancelling them first...")
    for o in ibkr.openTrades():
        c = o.contract
        if c.symbol == 'USD' and c.currency == 'CAD':
            ibkr.cancelOrder(o.order)
            print(f"  Cancelled order {o.order.orderId}")
    ibkr.sleep(1)

# ── 3. Get live USD/CAD rate ──────────────────────────────────────────────────
# Contract: symbol=USD, currency=CAD → price = CAD per 1 USD (e.g. 1.3722)
contract = ib.Forex('USDCAD')
ibkr.qualifyContracts(contract)

ticker = ibkr.reqMktData(contract, snapshot=True)
ibkr.sleep(1.5)
ibkr.cancelMktData(contract)

rate = ticker.marketPrice()
if not rate or rate != rate:  # nan check
    if ticker.bid and ticker.ask and ticker.bid == ticker.bid:
        rate = (ticker.bid + ticker.ask) / 2
    else:
        rate = None

if not rate:
    print("Could not get live USD/CAD rate from IDEALPRO. Exiting.")
    ibkr.disconnect()
    exit(1)

print(f"\nUSD/CAD rate: {rate:.4f}  (1 USD = {rate:.4f} CAD)")

# ── 4. Calculate USD to buy ───────────────────────────────────────────────────
# Leave a small buffer to avoid going over available cash
usd_to_buy = int((cad_cash / rate) * 0.995 / 1000) * 1000  # floor to nearest 1000

print(f"CAD to sell: ~{usd_to_buy * rate:,.0f}")
print(f"USD to buy:  {usd_to_buy:,}")

if usd_to_buy < 25000:
    print(
        f"\n⚠️  Order too small for IDEALPRO (minimum 25,000 USD = ~{25000 * rate:,.0f} CAD).\n"
        f"   Your convertible CAD ({cad_cash:,.0f}) only covers ~{int(cad_cash / rate):,} USD.\n"
        "   To convert smaller amounts, change base currency via Account Management:\n"
        "   portal.interactivebrokers.com → Settings → Account Configuration → Base Currency"
    )
    ibkr.disconnect()
    exit(0)

# ── 5. Confirm and place market order ────────────────────────────────────────
print(f"\nAbout to place: BUY {usd_to_buy:,} USD / SELL ~{usd_to_buy * rate:,.0f} CAD")
print(f"Exchange: IDEALPRO  |  Type: MKT  |  TIF: DAY  |  Account: {account_id} (PAPER)")
answer = input("\nConfirm? [y/N] ").strip().lower()
if answer != 'y':
    print("Cancelled.")
    ibkr.disconnect()
    exit(0)

order = ib.MarketOrder('BUY', usd_to_buy)
order.tif = 'DAY'
trade = ibkr.placeOrder(contract, order)
ibkr.sleep(2)

print(f"\nOrder placed:")
print(f"  Order ID : {trade.order.orderId}")
print(f"  Status   : {trade.orderStatus.status}")
if trade.orderStatus.filled:
    print(f"  Filled   : {trade.orderStatus.filled:,} USD @ {trade.orderStatus.avgFillPrice:.4f}")

ibkr.disconnect()
print("\nDone.")
