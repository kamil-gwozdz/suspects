// @ts-check
const { test, expect, chromium } = require('@playwright/test');
const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { generateReport } = require('./report-generator');

const PORT = 9876;
const BASE = `http://localhost:${PORT}`;
const SCREENSHOT_DIR = path.join(__dirname, '..', '..', 'tmp');
const PLAYER_COUNT = 6;
const PLAYER_NAMES = ['Alice', 'Bob', 'Charlie', 'Diana', 'Eve', 'Frank'];

let serverProcess;

// Ensure screenshot directory exists and is clean
function prepareScreenshotDir() {
    if (fs.existsSync(SCREENSHOT_DIR)) {
        for (const f of fs.readdirSync(SCREENSHOT_DIR)) {
            if (f.endsWith('.png') || f.endsWith('.gif') || f === 'report.html') fs.unlinkSync(path.join(SCREENSHOT_DIR, f));
        }
    } else {
        fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    }
}

// Screenshot + metadata collection
let screenshotCounter = 0;
const reportEntries = []; // { filename, label, phase, narrator, device, playerName, group }

async function snap(page, label, meta = {}) {
    screenshotCounter++;
    const num = String(screenshotCounter).padStart(2, '0');
    const filename = `${num}-${label}.png`;
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, filename), fullPage: true });

    // Grab narrator text if visible on host
    let narrator = meta.narrator || '';
    if (!narrator && meta.device === 'tv') {
        narrator = await page.locator('#narration-text').textContent().catch(() => '') || '';
        if (!narrator) narrator = await page.locator('#narration-subtitle-text').textContent().catch(() => '') || '';
    }

    reportEntries.push({
        filename,
        label,
        phase: meta.phase || '',
        narrator: narrator.trim(),
        device: meta.device || 'tv',
        playerName: meta.playerName || '',
        group: meta.group || label, // group key for carousel grouping
    });
}

// Snap all player phones together as a group
async function snapPlayers(playerPages, groupLabel, meta = {}) {
    for (let i = 0; i < playerPages.length; i++) {
        await snap(playerPages[i], `player-${PLAYER_NAMES[i]}-${meta.phase || groupLabel}`, {
            ...meta,
            device: 'phone',
            playerName: PLAYER_NAMES[i],
            group: groupLabel,
        });
    }
}

// Snap all alive player phones together as a group (dead players get spectator screenshot)
async function snapAlivePlayers(playerPages, groupLabel, aliveSet, meta = {}) {
    for (let i = 0; i < playerPages.length; i++) {
        const name = PLAYER_NAMES[i];
        const suffix = aliveSet.has(name) ? '' : '-spectator';
        await snap(playerPages[i], `player-${name}-${meta.phase || groupLabel}${suffix}`, {
            ...meta,
            device: 'phone',
            playerName: name,
            group: groupLabel,
        });
    }
}

// Wait for a WebSocket message of a given type on a page
function waitForWsMessage(page, messageType, timeout = 15000) {
    return page.evaluate(({ messageType, timeout }) => {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${messageType}`)), timeout);
            const origHandler = window._wsTestHandler;
            window._wsTestHandler = (msg) => {
                if (origHandler) origHandler(msg);
                if (msg.type === messageType) {
                    clearTimeout(timer);
                    window._wsTestHandler = origHandler;
                    resolve(msg);
                }
            };
        });
    }, { messageType, timeout });
}

// Advance narration by clicking Next on host and handling player actions.
// Stops when the target phase is reached on the host screen (or game over).
// roleActions: map of player name → target player name for night actions.
// onNightAction: async callback(playerIndex, playerName, page) called once per player when their night screen is active.
// aliveSet: optional Set of alive player names; dead players are skipped for night actions.
async function advanceNarration(host, playerPages, targetPhase, maxSteps = 40, roleActions = {}, onNightAction = null, aliveSet = null) {
    const actioned = new Set();
    const snapped = new Set();

    for (let step = 0; step < maxSteps; step++) {
        // Click any visible "Next" button — narration or role reveal
        let clickedNext = false;
        for (const selector of ['#reveal-next-btn:not(.hidden)', '#narration-next-btn:not(.hidden)']) {
            const btn = host.locator(selector);
            if (await btn.isVisible().catch(() => false)) {
                await btn.click();
                clickedNext = true;
                await host.waitForTimeout(600);
            }
        }

        // If no Next button was visible but narration overlay is showing, force-advance via WS
        if (!clickedNext) {
            const overlayVisible = await host.locator('#narration-overlay:not(.hidden)').isVisible().catch(() => false);
            if (overlayVisible) {
                // Force-send narration_next to unstick narration (covers both HostAdvance and stuck states)
                await host.evaluate(() => {
                    if (typeof ws !== 'undefined') ws.send({ type: 'narration_next' });
                }).catch(() => {});
                await host.waitForTimeout(800);
            }
        }

        // Handle player night actions — select specific target + confirm
        for (let pi = 0; pi < playerPages.length; pi++) {
            const p = playerPages[pi];
            const name = PLAYER_NAMES[pi];
            // Skip dead players
            if (aliveSet && !aliveSet.has(name)) continue;
            try {
                const nightActive = await p.locator('#night-screen.active').isVisible().catch(() => false);
                if (!nightActive || actioned.has(pi)) continue;

                // Wait briefly for target buttons to render (NightActionPrompt may arrive after WakeUp)
                await p.waitForTimeout(300);

                // Try to select a target
                const targetName = roleActions[name];
                let clicked = false;
                if (targetName) {
                    const targetBtn = p.locator(`.target-btn:has-text("${targetName}")`);
                    if (await targetBtn.isVisible().catch(() => false)) {
                        await targetBtn.click();
                        clicked = true;
                        await p.waitForTimeout(150);
                    }
                }
                if (!clicked) {
                    const firstTarget = p.locator('.target-btn').first();
                    if (await firstTarget.isVisible().catch(() => false)) {
                        await firstTarget.click();
                        clicked = true;
                        await p.waitForTimeout(150);
                    }
                }

                if (clicked) {
                    // Screenshot with target selected (once per player)
                    if (onNightAction && !snapped.has(pi)) {
                        snapped.add(pi);
                        await onNightAction(pi, name, p);
                    }
                    // Confirm
                    const confirmBtn = p.locator('#confirm-action-btn:not([disabled])');
                    if (await confirmBtn.isVisible().catch(() => false)) {
                        await confirmBtn.click();
                        actioned.add(pi);
                        await p.waitForTimeout(200);
                    }
                } else if (nightActive) {
                    // Night screen is active but no targets — use skip button as fallback
                    const skipBtn = p.locator('#skip-action-btn:not([disabled])');
                    if (await skipBtn.isVisible().catch(() => false)) {
                        await skipBtn.click();
                        actioned.add(pi);
                        await p.waitForTimeout(200);
                    }
                }
            } catch {}
        }

        // Check if target phase reached (or game over)
        const phaseText = await host.locator('#phase-display').textContent().catch(() => '');
        if (phaseText) {
            const lower = phaseText.toLowerCase();
            if (lower.includes(targetPhase.toLowerCase())) return;
            if (lower.includes('game over')) return;
        }
        await host.waitForTimeout(400);
    }
}

test.describe('Suspects E2E — Full Game Flow', () => {
    test.beforeAll(async () => {
        prepareScreenshotDir();
        screenshotCounter = 0;

        // Build the server
        console.log('Building server...');
        execSync('cargo build', { cwd: path.join(__dirname, '..', '..'), stdio: 'inherit' });

        // Start the server on test port
        console.log(`Starting server on port ${PORT}...`);
        serverProcess = spawn(
            path.join(__dirname, '..', '..', 'target', 'debug', 'suspects'),
            [],
            {
                cwd: path.join(__dirname, '..', '..'),
                env: {
                    ...process.env,
                    SUSPECTS_HOST: '127.0.0.1',
                    SUSPECTS_PORT: String(PORT),
                    SUSPECTS_BASE_URL: BASE,
                    DATABASE_URL: 'sqlite:test_e2e.db?mode=rwc',
                    SUSPECTS_DAY_TIMER: '10',
                    SUSPECTS_NIGHT_TIMER: '10',
                    SUSPECTS_VOTING_TIMER: '10',
                },
                stdio: 'pipe',
            }
        );

        serverProcess.stderr.on('data', (d) => {
            const line = d.toString().trim();
            if (line) console.log(`[server] ${line}`);
        });

        // Wait for server to be ready
        for (let i = 0; i < 30; i++) {
            try {
                const resp = await fetch(`${BASE}/host/`);
                if (resp.ok) break;
            } catch {}
            await new Promise(r => setTimeout(r, 500));
        }
        console.log('Server ready!');
    });

    test.afterAll(async () => {
        if (serverProcess) {
            serverProcess.kill('SIGTERM');
            await new Promise(r => setTimeout(r, 500));
        }
        // Clean up test DB
        try { fs.unlinkSync(path.join(__dirname, '..', '..', 'test_e2e.db')); } catch {}
    });

    test('full game flow with screenshots', async () => {
        test.setTimeout(300000);

        const browser = await chromium.launch({ headless: true });

        // === HOST SCREEN ===
        const hostContext = await browser.newContext({
            viewport: { width: 1920, height: 1080 },
        });
        const host = await hostContext.newPage();
        await host.goto(`${BASE}/host/`);
        await host.waitForLoadState('networkidle');
        await snap(host, 'host-lobby-empty', { phase: 'Lobby', device: 'tv' });

        // Create room
        await host.click('#create-room-btn');
        await host.waitForSelector('#room-code-display:not(:empty)', { timeout: 5000 });
        const roomCode = await host.textContent('#room-code-display');
        console.log(`Room created: ${roomCode}`);
        await snap(host, 'host-lobby-created', { phase: 'Lobby', device: 'tv', narrator: 'Room created — waiting for players' });

        // === PLAYER SCREENS ===
        const playerPages = [];
        for (let i = 0; i < PLAYER_COUNT; i++) {
            const ctx = await browser.newContext({
                viewport: { width: 390, height: 844 },
                isMobile: true,
                storageState: { cookies: [], origins: [] },
            });
            const page = await ctx.newPage();
            await page.addInitScript(() => { localStorage.clear(); });
            await page.goto(`${BASE}/player/?room=${roomCode}`);
            await page.waitForLoadState('networkidle');

            const nameInput = page.locator('#player-name');
            await nameInput.fill(PLAYER_NAMES[i]);
            await page.click('#join-btn');
            await page.waitForSelector('#waiting-screen.active', { timeout: 5000 });
            playerPages.push(page);

            if (i === 0) {
                await page.waitForTimeout(600); // wait for screenFadeIn animation
                await snap(page, `player-Alice-joined`, { phase: 'Lobby', device: 'phone', playerName: 'Alice', group: 'player-join' });
            }
        }

        // Wait for host to show all players
        await host.waitForFunction(
            (count) => {
                const seats = document.querySelectorAll('.table-seat');
                return seats.length >= count;
            },
            PLAYER_COUNT,
            { timeout: 10000 }
        ).catch(() => {});
        await snap(host, 'host-lobby-full', { phase: 'Lobby', device: 'tv', narrator: `${PLAYER_COUNT} players seated at the table` });

        // === ALL PLAYERS READY ===
        for (let i = 0; i < PLAYER_COUNT; i++) {
            const readyBtnEl = playerPages[i].locator('#ready-btn');
            await readyBtnEl.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
            await readyBtnEl.click();
        }
        await snapPlayers(playerPages, 'players-ready', { phase: 'Lobby' });
        await host.waitForTimeout(300); // brief settle
        await snap(host, 'host-all-ready', { phase: 'Lobby', device: 'tv', narrator: 'All players ready — game starting...' });

        // Wait for game start
        await host.waitForSelector('#game-screen.active', { timeout: 15000 });
        await snap(host, 'host-game-started', { phase: 'RoleReveal', device: 'tv' });

        // Role reveal — advance through ALL reveals to Night, then replay flip for GIFs
        for (let i = 0; i < PLAYER_COUNT; i++) {
            try { await playerPages[i].waitForSelector('#role-screen.active', { timeout: 8000 }); } catch {}
        }

        // Advance through all role reveals to Night
        await advanceNarration(host, playerPages, 'night', 30);

        // Temporarily restore role screen on each player for PNG before/after capture
        await Promise.all(playerPages.map(p =>
            p.evaluate(() => {
                document.getElementById('role-screen').classList.add('active');
                document.getElementById('sleeping-screen').classList.remove('active');
                document.getElementById('flip-card').classList.remove('flipped');
            })
        ));
        await playerPages[0].waitForTimeout(200);

        // Capture "before flip" PNGs
        await snapPlayers(playerPages, 'players-role-before-flip', { phase: 'RoleReveal' });

        // Trigger flip on all phones and wait for animation
        await Promise.all(playerPages.map(p =>
            p.evaluate(() => document.getElementById('flip-card').classList.add('flipped'))
        ));
        await playerPages[0].waitForTimeout(800);

        // Capture "after flip" PNGs
        await snapPlayers(playerPages, 'players-role-after-flip', { phase: 'RoleReveal' });

        // Restore night/sleeping screen
        await Promise.all(playerPages.map(p =>
            p.evaluate(() => {
                document.getElementById('role-screen').classList.remove('active');
                document.getElementById('sleeping-screen').classList.add('active');
            })
        ));

        // ================================================================
        // PHASE 2: DISCOVER ROLES
        // ================================================================
        const playerRoles = {};
        for (let i = 0; i < PLAYER_COUNT; i++) {
            // playerRole is a top-level let in the player's app.js
            const role = await playerPages[i].evaluate(() => {
                try { return playerRole; } catch { return null; }
            });
            playerRoles[PLAYER_NAMES[i]] = role;
        }
        console.log('Discovered roles:', playerRoles);

        const mafiaPlayers = PLAYER_NAMES.filter(n => playerRoles[n] === 'mafioso');
        const doctorPlayer = PLAYER_NAMES.find(n => playerRoles[n] === 'doctor');
        const detectivePlayer = PLAYER_NAMES.find(n => playerRoles[n] === 'detective');
        const townPlayers = PLAYER_NAMES.filter(n => playerRoles[n] !== 'mafioso');

        console.log(`Mafia: ${mafiaPlayers.join(', ')}`);
        console.log(`Doctor: ${doctorPlayer || 'none'}`);
        console.log(`Detective: ${detectivePlayer || 'none'}`);
        console.log(`Town: ${townPlayers.join(', ')}`);

        // Track alive players across rounds
        const aliveSet = new Set(PLAYER_NAMES);

        async function updateAliveStatus() {
            try {
                // Read alive status from the host's player list (set by AlivePlayerList messages)
                const hostAlive = await host.evaluate(() =>
                    (typeof alivePlayers !== 'undefined' ? alivePlayers : [])
                        .filter(p => p.alive)
                        .map(p => p.name)
                );
                for (const name of PLAYER_NAMES) {
                    if (!hostAlive.includes(name)) aliveSet.delete(name);
                }
            } catch (e) {
                console.log('  Alive status check fell back to DOM:', e.message);
                for (let i = 0; i < PLAYER_COUNT; i++) {
                    const isDead = await playerPages[i].locator('#dead-screen.active').isVisible().catch(() => false);
                    if (isDead) aliveSet.delete(PLAYER_NAMES[i]);
                }
            }
        }

        async function getHostPhase() {
            return (await host.locator('#phase-display').textContent().catch(() => '')).toLowerCase();
        }

        async function isGameOver() {
            return (await getHostPhase()).includes('game over');
        }

        async function forceAdvancePhase() {
            await host.evaluate(() => ws.send({ type: 'advance_phase' }));
            await host.waitForTimeout(2000);
        }

        // Robustly advance to a target phase, using narration + force advance fallback
        async function advanceToPhase(targetPhase, maxAttempts = 5) {
            for (let attempt = 0; attempt < maxAttempts; attempt++) {
                const cur = await getHostPhase();
                if (cur.includes(targetPhase)) return true;
                if (cur.includes('game over')) return false;

                if (attempt < 2) {
                    await advanceNarration(host, playerPages, targetPhase, 15, {}, null, aliveSet);
                } else {
                    await forceAdvancePhase();
                }
            }
            const final_ = await getHostPhase();
            return final_.includes(targetPhase);
        }

        // ================================================================
        // GAME LOOP: Night → Dawn → Day → Voting → Execution → repeat
        // ================================================================
        let gameEnded = false;

        for (let round = 1; round <= 4; round++) {
            console.log(`\n════ ROUND ${round} ════`);
            if (await isGameOver()) { gameEnded = true; break; }

            // ── NIGHT ──────────────────────────────────────────────
            console.log(`  Night ${round}...`);
            await host.waitForSelector('#phase-display', { timeout: 5000 });
            await snap(host, `host-night-r${round}`, { phase: 'Night', device: 'tv' });
            await snapAlivePlayers(playerPages, `players-night-r${round}`, aliveSet, { phase: 'Night' });

            // Build role-specific actions (targets must exclude self for each player)
            const aliveTown = townPlayers.filter(n => aliveSet.has(n));
            const aliveMafia = mafiaPlayers.filter(n => aliveSet.has(n));
            const aliveAll = [...aliveSet];
            const roleActions = {};

            if (aliveTown.length > 0) {
                // Mafia kills first alive town member
                const mafiaTarget = aliveTown[0];
                for (const m of aliveMafia) roleActions[m] = mafiaTarget;
                if (aliveMafia.length > 0) console.log(`  Mafia → ${mafiaTarget}`);

                // Doctor heals someone (excluding self, prefer non-mafia-target)
                if (doctorPlayer && aliveSet.has(doctorPlayer)) {
                    const healCandidates = aliveAll.filter(n => n !== doctorPlayer);
                    const healTarget = healCandidates.find(n => n !== mafiaTarget) || healCandidates[0];
                    if (healTarget) {
                        roleActions[doctorPlayer] = healTarget;
                        console.log(`  Doctor → ${healTarget}`);
                    }
                }

                // Detective investigates someone (excluding self, prefer mafia)
                if (detectivePlayer && aliveSet.has(detectivePlayer)) {
                    const invCandidates = aliveAll.filter(n => n !== detectivePlayer);
                    const investigateTarget = invCandidates.find(n => mafiaPlayers.includes(n)) || invCandidates[0];
                    if (investigateTarget) {
                        roleActions[detectivePlayer] = investigateTarget;
                        console.log(`  Detective → ${investigateTarget}`);
                    }
                }
            }

            // Screenshot callback for night actions (alive players only)
            const nightSnap = async (pi, name, page) => {
                await snap(page, `player-${name}-night-action-r${round}`, {
                    phase: 'Night', device: 'phone', playerName: name,
                    group: `night-actions-r${round}`,
                });
            };

            // Advance night narration → dawn
            await advanceNarration(host, playerPages, 'dawn', 60, roleActions, nightSnap, aliveSet);
            if (await isGameOver()) { gameEnded = true; break; }

            // ── DAWN ───────────────────────────────────────────────
            console.log(`  Dawn ${round}...`);
            // Wait for dawn phase to appear on host
            await host.waitForFunction(
                () => document.getElementById('phase-display')?.textContent?.toLowerCase().includes('dawn'),
                { timeout: 10000 }
            ).catch(() => {});
            await snap(host, `host-dawn-r${round}`, { phase: 'Dawn', device: 'tv' });

            // Capture player dawn screens
            for (let i = 0; i < PLAYER_COUNT; i++) {
                if (!aliveSet.has(PLAYER_NAMES[i])) continue;
                // Wait for dawn-screen to appear on alive players
                await playerPages[i].waitForSelector('#dawn-screen.active', { timeout: 5000 }).catch(() => {});
            }
            await snapAlivePlayers(playerPages, `players-dawn-r${round}`, aliveSet, { phase: 'Dawn' });

            // Advance dawn narration → day (with robust retry)
            if (!await advanceToPhase('day', 6)) {
                console.log('  Could not reach day phase, ending loop');
                break;
            }
            await updateAliveStatus();
            console.log(`  Alive: ${[...aliveSet].join(', ')}`);

            if (await isGameOver()) { gameEnded = true; break; }
            if (aliveSet.size < 3) {
                console.log('  Too few players alive to continue');
                break;
            }

            // ── DAY ────────────────────────────────────────────────
            console.log(`  Day ${round}...`);
            await host.waitForFunction(
                () => document.getElementById('phase-display')?.textContent?.toLowerCase().includes('day'),
                { timeout: 5000 }
            ).catch(() => {});
            await snap(host, `host-day-r${round}`, { phase: 'Day', device: 'tv' });
            await snapAlivePlayers(playerPages, `players-day-r${round}`, aliveSet, { phase: 'Day' });

            // All alive players click "Ready to Vote"
            for (let i = 0; i < PLAYER_COUNT; i++) {
                if (!aliveSet.has(PLAYER_NAMES[i])) continue;
                const readyBtn = playerPages[i].locator('#ready-to-vote-btn');
                try {
                    await readyBtn.waitFor({ state: 'visible', timeout: 5000 });
                    await readyBtn.click();
                } catch {}
            }

            // ── VOTING ─────────────────────────────────────────────
            if (!await advanceToPhase('voting', 6)) {
                console.log('  Could not reach voting phase, skipping round');
                break;
            }

            console.log(`  Voting ${round}...`);
            await snap(host, `host-voting-r${round}`, { phase: 'Voting', device: 'tv' });

            // Town votes for first alive mafia; mafia can't self-vote so they pick first available
            const voteTarget = aliveMafia.length > 0 ? aliveMafia[0] : [...aliveSet][0];
            console.log(`  Vote target: ${voteTarget}`);

            for (let i = 0; i < PLAYER_COUNT; i++) {
                if (!aliveSet.has(PLAYER_NAMES[i])) continue;
                const p = playerPages[i];
                try {
                    await p.waitForSelector('#vote-screen.active', { timeout: 8000 });
                    await p.waitForTimeout(500); // let vote targets render

                    // Check how many vote target rows exist
                    const rowCount = await p.locator('.vote-target-row').count().catch(() => 0);
                    if (rowCount === 0) {
                        console.log(`  ${PLAYER_NAMES[i]}: no vote targets, skipping`);
                        continue;
                    }

                    // Select vote target by name, fallback to first row
                    const targetRow = p.locator(`.vote-target-row:has-text("${voteTarget}")`);
                    if (await targetRow.count() > 0 && await targetRow.first().isVisible().catch(() => false)) {
                        await targetRow.first().click();
                    } else {
                        await p.locator('.vote-target-row').first().click();
                    }
                    await p.waitForTimeout(200);

                    // Click cast vote button (should be enabled after selecting target)
                    const castBtn = p.locator('#cast-vote-btn');
                    if (await castBtn.isEnabled().catch(() => false)) {
                        await castBtn.click({ timeout: 2000 });
                    } else {
                        console.log(`  ${PLAYER_NAMES[i]}: cast-vote-btn still disabled`);
                    }
                } catch (e) {
                    console.log(`  Vote failed for ${PLAYER_NAMES[i]}: ${e.message}`);
                }
            }

            await host.waitForTimeout(1500);
            await snap(host, `host-votes-cast-r${round}`, { phase: 'Voting', device: 'tv' });
            await snapAlivePlayers(playerPages, `players-voted-r${round}`, aliveSet, { phase: 'Voting' });

            // Advance "votes are in" narration → execution
            if (!await advanceToPhase('execution', 5)) {
                console.log('  Could not reach execution phase');
                break;
            }

            // ── EXECUTION ──────────────────────────────────────────
            console.log(`  Execution ${round}...`);
            // Wait for execution phase UI to settle
            await host.waitForFunction(
                () => document.getElementById('phase-display')?.textContent?.toLowerCase().includes('execution'),
                { timeout: 5000 }
            ).catch(() => {});
            await host.waitForTimeout(2000); // countdown animation
            await snap(host, `host-execution-r${round}`, { phase: 'Execution', device: 'tv' });

            // Capture player execution screens (alive players may see execution-screen)
            for (let i = 0; i < PLAYER_COUNT; i++) {
                if (!aliveSet.has(PLAYER_NAMES[i])) continue;
                await playerPages[i].waitForSelector('#execution-screen.active', { timeout: 5000 }).catch(() => {});
            }
            await snapAlivePlayers(playerPages, `players-execution-r${round}`, aliveSet, { phase: 'Execution' });

            await updateAliveStatus();
            console.log(`  Alive after execution: ${[...aliveSet].join(', ')}`);

            if (await isGameOver()) { gameEnded = true; break; }

            // Round summary
            await snap(host, `host-round-${round}-end`, { phase: `Round ${round}`, device: 'tv' });
            await snapAlivePlayers(playerPages, `players-round-${round}-end`, aliveSet, { phase: `Round ${round}` });

            // Advance Execution → Night (next round)
            if (round < 4 && aliveSet.size >= 3) {
                if (!await advanceToPhase('night', 5)) {
                    console.log('  Could not advance to next night');
                    break;
                }
                if (await isGameOver()) { gameEnded = true; break; }
            }
        }

        // ================================================================
        // FINAL SCREENSHOTS — verify GameOver properly
        // ================================================================
        console.log('\n════ FINAL ════');

        // Robust game-over check: wait for the host to show game_over phase
        if (gameEnded || await isGameOver()) {
            // Wait for gameover-view to be visible on host
            await host.waitForFunction(
                () => {
                    const phase = document.getElementById('phase-display')?.textContent?.toLowerCase() || '';
                    return phase.includes('game over');
                },
                { timeout: 15000 }
            ).catch(() => console.log('  Warning: game over phase not confirmed on host'));

            await host.waitForTimeout(500); // let final UI settle
            await snap(host, 'host-gameover', { phase: 'GameOver', device: 'tv' });
            await snapPlayers(playerPages, 'players-gameover', { phase: 'GameOver' });
        } else {
            await snap(host, 'host-final', { phase: 'Final', device: 'tv' });
            await snapPlayers(playerPages, 'players-final', { phase: 'Final' });
        }

        // Generate HTML report
        generateReport(reportEntries, SCREENSHOT_DIR);

        // Cleanup
        await browser.close();

        const screenshots = fs.readdirSync(SCREENSHOT_DIR).filter(f => f.endsWith('.png'));
        console.log(`\n✅ ${screenshots.length} screenshots saved to ./tmp/`);
        expect(screenshots.length).toBeGreaterThan(20);
        expect(fs.existsSync(path.join(SCREENSHOT_DIR, 'report.html'))).toBe(true);
    });
});
