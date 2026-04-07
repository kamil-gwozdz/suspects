// @ts-check
const { test, expect, chromium } = require('@playwright/test');
const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

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
            if (f.endsWith('.png')) fs.unlinkSync(path.join(SCREENSHOT_DIR, f));
        }
    } else {
        fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    }
}

// Screenshot helper — saves to tmp/ with sequential naming
let screenshotCounter = 0;
async function snap(page, label) {
    screenshotCounter++;
    const num = String(screenshotCounter).padStart(2, '0');
    const filename = `${num}-${label}.png`;
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, filename), fullPage: true });
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
        test.setTimeout(120000);

        const browser = await chromium.launch({ headless: true });

        // === HOST SCREEN ===
        const hostContext = await browser.newContext({
            viewport: { width: 1920, height: 1080 },
        });
        const host = await hostContext.newPage();
        await host.goto(`${BASE}/host/`);
        await host.waitForLoadState('networkidle');
        await snap(host, 'host-lobby-empty');

        // Create room
        await host.click('#create-room-btn');
        await host.waitForSelector('#room-code-display:not(:empty)', { timeout: 5000 });
        const roomCode = await host.textContent('#room-code-display');
        console.log(`Room created: ${roomCode}`);
        await snap(host, 'host-lobby-created');

        // === PLAYER SCREENS ===
        const playerPages = [];
        for (let i = 0; i < PLAYER_COUNT; i++) {
            // Each player gets a fully isolated browser context (separate localStorage, cookies, WS)
            const ctx = await browser.newContext({
                viewport: { width: 390, height: 844 },
                isMobile: true,
                storageState: { cookies: [], origins: [] },
            });
            const page = await ctx.newPage();
            // Clear any stale state before navigating
            await page.addInitScript(() => {
                localStorage.clear();
            });
            await page.goto(`${BASE}/player/?room=${roomCode}`);
            await page.waitForLoadState('networkidle');

            // Fill in name
            const nameInput = page.locator('#player-name');
            await nameInput.fill(PLAYER_NAMES[i]);

            // Room code should be pre-filled from URL
            await page.click('#join-btn');

            // Wait for joined confirmation (waiting screen appears)
            await page.waitForSelector('#waiting-screen.active', { timeout: 5000 });
            playerPages.push(page);

            if (i === 0) await snap(page, `player-${PLAYER_NAMES[i]}-joined`);
        }

        // Take host screenshot with all players
        await host.waitForTimeout(1000);
        await snap(host, 'host-lobby-full');

        // === ALL PLAYERS READY ===
        for (let i = 0; i < PLAYER_COUNT; i++) {
            await playerPages[i].click('#ready-btn');
            await playerPages[i].waitForTimeout(200);
        }
        await snap(playerPages[0], 'player-ready');
        await host.waitForTimeout(500);
        await snap(host, 'host-all-ready');

        // Wait for auto-start countdown (5 seconds) + game start
        // Phase should change to RoleReveal then Night
        await host.waitForSelector('#game-screen.active', { timeout: 15000 });
        await host.waitForTimeout(500);
        await snap(host, 'host-game-started');

        // Take role reveal screenshots for first two players
        for (let i = 0; i < 2; i++) {
            try {
                await playerPages[i].waitForSelector('#role-screen.active', { timeout: 8000 });
                await snap(playerPages[i], `player-${PLAYER_NAMES[i]}-role`);
            } catch {
                await snap(playerPages[i], `player-${PLAYER_NAMES[i]}-current`);
            }
        }

        // === NIGHT PHASE ===
        // Wait for night phase on host
        try {
            await host.waitForSelector('#night-view:not(.hidden)', { timeout: 15000 });
        } catch {
            // might already be on night
        }
        await host.waitForTimeout(1000);
        await snap(host, 'host-night');

        // Players should see sleeping screen or night action
        for (let i = 0; i < PLAYER_COUNT; i++) {
            await playerPages[i].waitForTimeout(500);
            await snap(playerPages[i], `player-${PLAYER_NAMES[i]}-night`);
        }

        // Handle narration — advance through night narration steps
        // Click "Next" on host if narration overlay appears
        for (let step = 0; step < 30; step++) {
            const nextVisible = await host.locator('#narration-next-btn:not(.hidden)').isVisible().catch(() => false);
            if (nextVisible) {
                await host.click('#narration-next-btn');
                await host.waitForTimeout(800);
            }

            // Check if any player has night action screen — auto-confirm
            for (const p of playerPages) {
                const hasNightAction = await p.locator('#night-screen.active #confirm-action-btn').isVisible().catch(() => false);
                if (hasNightAction) {
                    // Try to select first target and confirm
                    const firstTarget = p.locator('.target-btn').first();
                    if (await firstTarget.isVisible().catch(() => false)) {
                        await firstTarget.click();
                        await p.waitForTimeout(200);
                    }
                    const confirmBtn = p.locator('#confirm-action-btn');
                    if (await confirmBtn.isEnabled()) {
                        await confirmBtn.click();
                        await p.waitForTimeout(300);
                    }
                }
                // If player has a "Done" narration ack button visible, click it
                const doneBtn = p.locator('#narration-ack-btn:not(.hidden)');
                if (await doneBtn.isVisible().catch(() => false)) {
                    await doneBtn.click();
                    await p.waitForTimeout(300);
                }
            }

            // Check if we've moved past Night
            const phaseText = await host.locator('#phase-display').textContent().catch(() => '');
            if (phaseText && !phaseText.toLowerCase().includes('night') && phaseText !== '') {
                break;
            }
            await host.waitForTimeout(500);
        }

        // === DAWN PHASE ===
        await host.waitForTimeout(1000);
        await snap(host, 'host-dawn');

        // Advance through dawn narration
        for (let step = 0; step < 10; step++) {
            const nextVisible = await host.locator('#narration-next-btn:not(.hidden)').isVisible().catch(() => false);
            if (nextVisible) {
                await host.click('#narration-next-btn');
                await host.waitForTimeout(800);
            }
            const phaseText = await host.locator('#phase-display').textContent().catch(() => '');
            if (phaseText && phaseText.toLowerCase().includes('day')) break;
            await host.waitForTimeout(500);
        }

        // === DAY PHASE ===
        await host.waitForTimeout(500);
        await snap(host, 'host-day');

        // Player day screen
        for (let i = 0; i < 2; i++) {
            await playerPages[i].waitForTimeout(500);
            await snap(playerPages[i], `player-${PLAYER_NAMES[i]}-day`);
        }

        // All alive players click "Ready to Vote"
        for (const p of playerPages) {
            const readyToVoteBtn = p.locator('#ready-to-vote-btn');
            if (await readyToVoteBtn.isVisible().catch(() => false)) {
                await readyToVoteBtn.click();
                await p.waitForTimeout(200);
            }
        }
        await host.waitForTimeout(1000);

        // === VOTING PHASE ===
        // Wait for voting or advance manually
        try {
            await host.waitForSelector('#vote-screen.active, #voting-view:not(.hidden)', { timeout: 10000 });
        } catch {}
        await host.waitForTimeout(500);
        await snap(host, 'host-voting');

        // Players vote — each votes for a different target
        for (let i = 0; i < playerPages.length; i++) {
            const p = playerPages[i];
            try {
                await p.waitForSelector('#vote-screen.active', { timeout: 5000 });
                // Select first available target
                const target = p.locator('.vote-target-row').first();
                if (await target.isVisible().catch(() => false)) {
                    await target.click();
                    await p.waitForTimeout(200);
                    await p.click('#cast-vote-btn');
                }
            } catch {}
        }
        await host.waitForTimeout(1000);
        await snap(host, 'host-votes-cast');
        await snap(playerPages[0], `player-${PLAYER_NAMES[0]}-voted`);

        // Advance through voting narration
        for (let step = 0; step < 10; step++) {
            const nextVisible = await host.locator('#narration-next-btn:not(.hidden)').isVisible().catch(() => false);
            if (nextVisible) {
                await host.click('#narration-next-btn');
                await host.waitForTimeout(800);
            }
            await host.waitForTimeout(500);
        }

        // === FINAL SCREENSHOTS ===
        await host.waitForTimeout(1000);
        await snap(host, 'host-final');
        for (let i = 0; i < 2; i++) {
            await snap(playerPages[i], `player-${PLAYER_NAMES[i]}-final`);
        }

        // Cleanup
        await browser.close();

        // Verify screenshots were created
        const screenshots = fs.readdirSync(SCREENSHOT_DIR).filter(f => f.endsWith('.png'));
        console.log(`\n✅ ${screenshots.length} screenshots saved to ./tmp/`);
        console.log(screenshots.map(f => `  ${f}`).join('\n'));
        expect(screenshots.length).toBeGreaterThan(10);
    });
});
