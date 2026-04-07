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
- Saves **sequential screenshots** (PNG) and **animation GIFs** to `./tmp/`
- Generates `./tmp/report.html` — an interactive timeline with step numbers, carousels, and narrator text
- Run it with: `npm run test:e2e`
- **Run this test during development** to visually verify UI changes
- **Use a sub-agent to review screenshots** — analyze `./tmp/` images via an explore agent to save main context
- The report has "Step X/Y" labels — reference these when discussing issues
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

## Parallel Development with Git Worktrees

When fixing multiple independent issue groups (e.g., CSS visual fixes + game logic fixes), use git worktrees to parallelize:

1. **Create a worktree for each independent track:**
   ```bash
   git worktree add ../suspects-<name> -b fix/<branch-name>
   ```

2. **Rules for parallel work:**
   - Each worktree must touch DIFFERENT files — no overlapping edits
   - If E2E tests need to run, use different server ports per worktree (e.g., PORT=8081, PORT=8082)
   - CSS/HTML changes can be safely separated from Rust/logic changes
   - Test file changes should only happen in ONE worktree

3. **Merging back:**
   ```bash
   cd ~/Work/suspects  # main worktree
   git merge fix/<branch-name>
   git worktree remove ../suspects-<name>
   ```

4. **Port allocation for E2E tests:**
   - Main worktree: PORT=8080 (default)
   - Visual fixes worktree: PORT=8081
   - Other worktrees: PORT=8082+

5. **Sub-agent usage:**
   - Use `general-purpose` agents for worktree-isolated tasks (CSS, docs, independent logic)
   - Use `explore` agents for screenshot/report analysis (read-only, no conflicts)
   - Never run two agents that edit the same file
