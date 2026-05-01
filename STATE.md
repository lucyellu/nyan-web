# nyan-web — State

## TL;DR

- Live URL **`nyan-web.netlify.app` shows the `main` branch**. Pushes to `dev-1` are NOT visible there.
- All recent feature work is on `dev-1`. To ship: merge `dev-1` → `main`, push, wait ~30s for Netlify rebuild.

## Where things live

- **GitHub:** https://github.com/lucyellu/nyan-web
- **Netlify (live):** https://nyan-web.netlify.app — auto-deploys `main` only. Branch deploys for `dev-1` not enabled.
- **Local:** `C:\Users\lucyl\Desktop\hold\projects\stocks_app\nyan-web`
- **Local server:** double-click `Nyan Web.lnk` on Desktop → `play.bat` → `http://localhost:9100`. Local always shows the currently checked-out branch's working tree.

## Branch model

| Branch | What's there | Where it ships |
|---|---|---|
| `main` | Deployable baseline. Stable. | https://nyan-web.netlify.app (auto on push) |
| `dev-1` | Staging — all in-flight features. | Local only (no branch deploy) |

**Currently in `dev-1` but NOT in `main`** (as of 2026-05-01, head `6ecad39`):
- Level select rework: ticker input + Last Open / Last 60 min buttons (no more BTC/SPY tabs).
- Trade markers: outline on chart, filled on cat trail.
- ESC → pause menu (was: instant end).
- Top-20 leaderboard (was top-5). 10s minimum to qualify.
- Profile onboarding (name + country flag).
- $/sec + annualized projection on game-over screen.
- Penny-rounding everywhere.
- Plush Rush SFX module (procedural, no audio files).
- 25 nyan variant GIFs in `assets/cats/`.
- Race the Rainbow: top-4 ghost replay, rank-based X position, live BUY/SELL flashes in flip-board.
- Skin unlocks Phase 1 (7 skins, 🎨 button in HUD).
- Cat height 60→72.

## Deploy

```bash
cd C:/Users/lucyl/Desktop/hold/projects/stocks_app/nyan-web
git checkout main
git merge --ff-only dev-1     # if dev-1 is just ahead, fast-forward; otherwise resolve
git push
# Wait ~30s, then verify:
curl -sI https://nyan-web.netlify.app/ | head -1
```

Or just say "merge dev-1 to main" and I'll do it.

## Architecture (what to know)

- Single-file HTML5 + JS, no build step. CDN imports only (Firebase modular SDK in `multiplayer.js`, Google Fonts).
- Static publish on Netlify. `netlify.toml` overrides Netlify's old auto-detected Hugo config (`build_command: hugo`, `base: public`) — site settings were also patched via API. Don't re-trigger Hugo detection by adding things that look like Hugo conventions.
- Yahoo Finance v8 chart API via CORS proxy chain: `api.allorigins.win` (primary) → `corsproxy.io` (fallback). No API keys.
- Bar cache: `localStorage[nyan_bars_v2_<TICKER>]`, 24h ring buffer per ticker. Window served from cache when newest expected bar is >3 min old AND ≥70% coverage.
- Race mode (Last Open only) replays top-4 saved sessions' `tradeLog` (frame + side + alloc) on the same bars. Each ghost has its own X position based on current P&L rank (leader on the right ~65% of width, last on the left ~20%) and a fixed Y lane. Cats race horizontally as ranks shuffle. Synthetic "🤖 Hodl Bot" baseline when no real ghosts exist. Each ghost's recent trades show as fading BUY/SELL flashes in the flip-board row.
- Skin unlocks driven by `progress` counters in `localStorage[nyan_progress]`. 7 skins shipped (1 default + 6 unlockable). 25 NYAN.CAT! variants in `assets/cats/` are also used by ghost cats randomly.

## Persistent localStorage keys

| Key | Shape |
|---|---|
| `nyan_profile` | `{name, code, flag, countryName}` |
| `nyan_progress` | `{totalSessions, totalWins, everInTop20, everTopThree, everFirst}` |
| `nyan_unlocks` | `['default', 'tech', ...]` |
| `nyan_active_skin` | id string |
| `nyan_all_sessions` | array (cap 300) — full session entries with tradeLog |
| `nyan_leaderboard` | array (top 20) — derived |
| `nyan_bars_v2_<TICKER>` | bars cache |
| `nyan_seat_secret_*`, `nyan_seat_*` | legacy from Alpaca era; safe to ignore |

## Watch out for

- **Last 60 min** is rolling — every play uses different bars, so it's solo-only (race disabled).
- **Existing leaderboard entries before commit `1f606b6`** don't have `tradeLog` and won't appear as ghosts.
- **Netlify token** `nfp_TRKsN5zKQqrtPdLYnf4JkczVJT4TSu2i39b2` was pasted into chat history — should be rotated.
- **Steam workshop link** for nyan variants (`id=2382032303`) is dead (item removed). Use the local archive at `../nyan-vita/web-port/assets/NYAN.CAT!/`.
- **Audio assets** (`assets/music_2_slowreverb.wav` 60MB, `assets/music_3_piano.wav` 18MB) trigger GitHub's 50MB-file warning but are under the 100MB hard limit. Could be downsized to OGG later.

## Next ideas (not done)

- **Deploy current dev-1 to main** — most-pressing; live site is 10 commits behind.
- Fill out the remaining ~18 skin unlock criteria (current Phase 1 has 6 unlockable).
- Ghost trade markers on chart + trail (currently only player has them; flip-board flashes are the only ghost-trade indicator).
- "Active skin" preview in HUD next to the 🎨 button.
- Enable Netlify branch deploys for `dev-1` so `dev-1--nyan-web.netlify.app` exists for staging review.
- Wick Rider + myspot favicon sync (Phase 2 of the cross-app favicon sync — neither has a local favicon source yet).
- Convert the 60MB + 18MB WAVs to OGG to drop repo size and remove GitHub's >50MB warnings.
