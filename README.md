# nyan-web

Browser-based trading game. The cat is the player, prices are real, the portfolio is virtual. Default ticker is SPY; type any Yahoo Finance symbol (e.g. `BTC-USD`, `AAPL`, `NVDA`, `ETH-USD`) to play it. Each session replays the most recent hour of 1-minute bars at 60× — you BUY/SELL with arrow keys against actual market data.

Single-file HTML5/JS. No build step. No API keys.

## Run locally

```bash
cd nyan-web
python -m http.server 9100
# open http://localhost:9100
```

Or double-click `play.bat`.

## How prices work

- **Source:** Yahoo Finance v8 chart API (`query1.finance.yahoo.com`).
- **CORS:** browsers can't hit Yahoo directly, so requests go through a proxy chain: `api.allorigins.win` (primary) → `corsproxy.io` (fallback).
- **Cache:** every fetched window is stored in `localStorage` keyed by symbol+date+window, so repeat plays load instantly.
- **No keys:** Yahoo's chart endpoint is keyless and the proxies are public. Nothing to configure.

## Portfolio

- Default starting balance: **$1,000,000** (virtual). Adjustable in Settings.
- Trade allocation: **10%** per BUY/SELL by default. 5–100% slider in Settings.
- Drawdown lives: 3 hearts ≈ $1k drawdown each. Lose all 3 → game over.
- All trades are local sim — no broker, no orders, no real money.

## Optional: Interactive Brokers integration

Three Python utilities ship in this repo for users who want to run a local IB bridge for *real* paper trading separately from the game:

```bash
pip install ib_insync aiohttp
python ibkr_bridge.py        # REST bridge → IBKR TWS
# requires TWS or IB Gateway running on port 7497 (paper) or 7496 (live)
```

These are standalone — the game does not depend on them. They're kept here because the IBKR dashboard (`ibkr_dashboard.html`) is a useful companion tool for actual trading practice.

| File | Purpose |
|---|---|
| `index.html` + `game.js` + `style.css` | The game (canvas render loop, market replay, HUD) |
| `multiplayer.js` | Firebase rooms (foundation; needs further testing) |
| `config.json` | Public Firebase client config — by design, exposed to the browser |
| `ibkr_bridge.py` | Standalone Python REST bridge → IBKR TWS |
| `ibkr_dashboard.html` | Standalone IBKR dashboard with chat-driven trading |
| `ibkr_fx_convert.py` | FX conversion helper for non-USD accounts |
| `alpaca_reset.py` | Standalone Alpaca paper-account reset (legacy, optional) |
| `bridge/` | Older Node.js IBKR bridge (Python is preferred) |

## Hotkeys

| Key | Action |
|---|---|
| ↑ / W | BUY at current allocation % |
| ↓ / S | SELL at current allocation % |
| Space | EXIT ALL (close full position) |
| 1–5 | BUY 10 / 25 / 50 / 75 / 100% |
| Shift + 1–5 | SELL same percentages |
| Esc | Pause |

## Deploy

Drag the folder into Netlify, or `netlify deploy --prod`. No build command, no env vars. The game runs entirely client-side. Firebase multiplayer works out of the box because the firebase config in `config.json` is the public client config (intended to be exposed; security is enforced by Firebase DB rules).
