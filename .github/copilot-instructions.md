# Copilot Instructions for Suspects

## UI Changes & Screenshots

Every UI change (CSS, HTML, JS affecting visuals) **must** include:
1. Regenerate all affected screenshots in `docs/screenshots/`
2. Update `README.md` if screenshot descriptions no longer match
3. Screenshots should be taken at:
   - **Host screen:** 1920×1080 (TV resolution)
   - **Player screen:** 390×844 (iPhone)
4. Crop screenshots to remove excessive empty space

## E2E Browser Test

There is a Playwright E2E test at `tests/e2e/game-flow.spec.js` that:
- Starts the Rust server, creates a room, joins 6 players, plays through a full game
- Saves **sequential screenshots** to `./tmp/` at every game phase
- Run it with: `npm run test:e2e`
- **Run this test during development** to visually verify UI changes
- **Review the screenshots** in `./tmp/` after each run to check for visual issues
- The test takes ~2 minutes (builds server + runs full game flow)

## Tech Stack

- **Backend:** Rust (Axum) + SQLite (sqlx)
- **Frontend:** Vanilla HTML/CSS/JS — no frameworks, no CDNs
- **Communication:** WebSocket
- **All dependencies vendored** — fonts, JS libs served from `static/shared/`
- **Release binary** embeds all static assets via `rust-embed`
- **E2E tests:** Playwright (Node.js) — `npm run test:e2e`

## Architecture

- Host/TV screen always in **English**
- Player phones are **localized** (EN/PL/DE/CS/KK) — each player picks their own language
- Game is played **IRL** — no in-game chat
- Virtual GM narrates on TV via pre-recorded audio files

## Code Conventions

- Rust edition 2024
- `cargo fmt` and `cargo test` must pass before committing
- i18n: all 5 language files must have the same keys
- Commit messages include `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`
