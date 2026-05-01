# CLAUDE.md — nyan-web

Browser-based virtual paper trading game with the Nyan Cat skin. Read **STATE.md** first for current branch / deploys / known gotchas.

## Run locally

```bash
cd C:/Users/lucyl/Desktop/hold/projects/stocks_app/nyan-web
python -m http.server 9100
# open http://localhost:9100
```

Or double-click `Nyan Web.lnk` on the Desktop.

**Server is required** — `file://` blocks the cross-origin Yahoo proxy fetches and ES module imports.

## Branches

- Work in `dev-1`. Merge to `main` only when ready to deploy (Netlify auto-deploys `main`).
- After merging, push `main`; Netlify rebuild happens within ~30s.
- To verify a deploy, curl `https://nyan-web.netlify.app/favicon.ico` (200) or fetch the page.

## File map

| File | Purpose |
|---|---|
| `index.html` | DOM: HUD, canvas, side panel (Time & Sales), level select, game over, pause / profile / skins / multiplayer modals |
| `game.js` | Game loop, rendering, state, ghost replay, skin unlocks, profile, SFX (procedural), exports |
| `multiplayer.js` | Firebase rooms — kept but not actively maintained; foundation for future race-vs-friend |
| `style.css` | All visual styling |
| `config.json` | Public Firebase client config (intentionally exposed; security via DB rules) |
| `assets/` | `nyan1.svg`–`nyan6.svg` (6-frame default cat), `btc.svg`, audio (.mp3/.wav), `cats/*` (25 unlock variants) |
| `favicon.ico` | Same icon used by Netlify, browser tab, and desktop shortcut |
| `ibkr_bridge.py`, `ibkr_dashboard.html`, `bridge/`, `alpaca_reset.py` | Optional standalone IBKR / Alpaca utilities — game does not depend on them |
| `play.bat`, `_make_shortcut.ps1` | Local launcher + Desktop shortcut creator |
| `netlify.toml` | Static publish, no build (overrides Netlify's incorrect Hugo auto-detection) |

## Common operations

```bash
# Sanity check before commit
node -c game.js

# Serve and curl-check (script may be running in background already)
python -m http.server 9100 &
curl -sI http://localhost:9100/

# Test Yahoo proxy works (needs a browser UA)
curl -sL -H "User-Agent: Mozilla/5.0" \
  "https://api.allorigins.win/raw?url=https%3A%2F%2Fquery1.finance.yahoo.com%2Fv8%2Ffinance%2Fchart%2FSPY%3Frange%3D1d%26interval%3D1m" | head -c 200

# Push + wait for Netlify rebuild (when on main)
git push
# Then poll deploy state via Netlify API (token is in user's memory, rotate periodically)
```

## Editing conventions

- No build step → write modern JS that runs in evergreen browsers; no transpilation.
- Single-file HTML/CSS/JS pattern — keep `game.js` cohesive; don't split into modules unless multiplayer.js–style ES module gain is real.
- localStorage is the persistence layer. Add new keys with the `nyan_` prefix and document in STATE.md.
- For new SFX, follow Plush Rush's `playTone(freq, dur, type, gain, freqEnd, delayMs)` pattern. Procedural; no audio files.
- New cat variants: drop GIFs in `assets/cats/` and add to either `GHOST_SPRITES` (random ghost pick) or `SKINS` (player skin with unlock criterion).
