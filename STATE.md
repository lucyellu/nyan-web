# nyan-web — State

## Where things live

- **GitHub:** https://github.com/lucyellu/nyan-web
- **Netlify (live):** https://nyan-web.netlify.app — auto-deploys `main` only.
- **Local:** `C:\Users\lucyl\Desktop\hold\projects\stocks_app\nyan-web`
- **Local server:** double-click `Nyan Web.lnk` on Desktop → `play.bat` → `http://localhost:9100`.

## Branch model

- `main` — what Netlify serves. Slim virtual-paper game with Yahoo data, $1M default, last-hour replay, last-open replay, top-20 leaderboard, ESC pause menu, profile (name + flag), Race the Rainbow ghost-mode foundation, Plush Rush SFX, CSV export, skin unlocks.
- `dev-1` — staging for new features ahead of `main`. Currently has everything above; merges to `main` when stable. Pushes to `dev-1` do **not** auto-deploy unless branch deploys are enabled in Netlify.

## Architecture (what to know)

- Single-file HTML5 + JS, no build step. CDN imports only (Firebase modular SDK in `multiplayer.js`, Google Fonts).
- Static publish on Netlify. `netlify.toml` overrides Netlify's old auto-detected Hugo config (`build_command: hugo`, `base: public`) — site settings were also patched via API. Don't re-trigger Hugo detection by adding things that look like Hugo conventions.
- Yahoo Finance v8 chart API via CORS proxy chain: `api.allorigins.win` (primary) → `corsproxy.io` (fallback). No API keys.
- Bar cache: `localStorage[nyan_bars_v2_<TICKER>]`, 24h ring buffer per ticker. Window served from cache when newest expected bar is >3 min old AND ≥70% coverage.
- Race mode (Last Open only) replays top-6 saved sessions' `tradeLog` (frame + side + alloc) on the same bars. Synthetic "🤖 Hodl Bot" baseline when no real ghosts exist.
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

- Fill out the remaining ~18 skin unlock criteria (current Phase 1 has 6 unlockable).
- Ghost trade markers on chart + trail (currently only player has them).
- Better unlock toast animation; "active skin" indicator in HUD.
- `dev-1` Netlify branch deploy URL.
- Wick Rider + myspot favicon sync (was Phase 2 of the cross-app favicon sync).
