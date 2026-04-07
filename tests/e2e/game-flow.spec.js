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
            if (f.endsWith('.png') || f === 'report.html') fs.unlinkSync(path.join(SCREENSHOT_DIR, f));
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

// Advance narration by clicking Next on host and handling player actions
// Stops when the target phase is reached on the host screen
async function advanceNarration(host, playerPages, targetPhase, maxSteps = 40) {
    for (let step = 0; step < maxSteps; step++) {
        // Click "Next" on host if visible
        const nextBtn = host.locator('#narration-next-btn:not(.hidden)');
        if (await nextBtn.isVisible().catch(() => false)) {
            await nextBtn.click();
            await host.waitForTimeout(600);
        }

        // Handle player night actions — select target + confirm
        for (const p of playerPages) {
            try {
                const nightActive = await p.locator('#night-screen.active').isVisible().catch(() => false);
                if (nightActive) {
                    const firstTarget = p.locator('.target-btn').first();
                    if (await firstTarget.isVisible().catch(() => false)) {
                        await firstTarget.click();
                        await p.waitForTimeout(150);
                    }
                    const confirmBtn = p.locator('#confirm-action-btn:not([disabled])');
                    if (await confirmBtn.isVisible().catch(() => false)) {
                        await confirmBtn.click();
                        await p.waitForTimeout(200);
                    }
                }
            } catch {}
        }

        // Check if target phase reached
        const phaseText = await host.locator('#phase-display').textContent().catch(() => '');
        if (phaseText && phaseText.toLowerCase().includes(targetPhase.toLowerCase())) {
            return;
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

            if (i === 0) await snap(page, `player-Alice-joined`, { phase: 'Lobby', device: 'phone', playerName: 'Alice', group: 'player-join' });
        }

        await host.waitForTimeout(1000);
        await snap(host, 'host-lobby-full', { phase: 'Lobby', device: 'tv', narrator: `${PLAYER_COUNT} players seated at the table` });

        // === ALL PLAYERS READY ===
        for (let i = 0; i < PLAYER_COUNT; i++) {
            await playerPages[i].click('#ready-btn');
            await playerPages[i].waitForTimeout(200);
        }
        await snapPlayers(playerPages, 'players-ready', { phase: 'Lobby' });
        await host.waitForTimeout(500);
        await snap(host, 'host-all-ready', { phase: 'Lobby', device: 'tv', narrator: 'All players ready — game starting...' });

        // Wait for game start
        await host.waitForSelector('#game-screen.active', { timeout: 15000 });
        await host.waitForTimeout(500);
        await snap(host, 'host-game-started', { phase: 'RoleReveal', device: 'tv' });

        // Role reveal — all players
        for (let i = 0; i < PLAYER_COUNT; i++) {
            try { await playerPages[i].waitForSelector('#role-screen.active', { timeout: 8000 }); } catch {}
        }
        await snapPlayers(playerPages, 'players-roles', { phase: 'RoleReveal' });

        // === NIGHT PHASE ===
        try { await host.waitForSelector('#night-view:not(.hidden)', { timeout: 15000 }); } catch {}
        await host.waitForTimeout(1000);
        await snap(host, 'host-night', { phase: 'Night', device: 'tv' });
        await snapPlayers(playerPages, 'players-night', { phase: 'Night' });

        // Advance through night → dawn → day
        await advanceNarration(host, playerPages, 'day', 60);

        // === DAWN ===
        await host.waitForTimeout(500);
        await snap(host, 'host-after-night', { phase: 'Dawn / Day', device: 'tv' });

        const phaseAfterDawn = await host.locator('#phase-display').textContent().catch(() => '');
        if (phaseAfterDawn && phaseAfterDawn.toLowerCase().includes('dawn')) {
            await advanceNarration(host, playerPages, 'day', 20);
        }

        // === DAY PHASE ===
        await host.waitForTimeout(500);
        await snap(host, 'host-day', { phase: 'Day', device: 'tv', narrator: 'Time to discuss. Who is suspicious?' });
        await snapPlayers(playerPages.slice(0, 3), 'players-day', { phase: 'Day' });

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
        await advanceNarration(host, playerPages, 'voting', 10);
        await host.waitForTimeout(500);
        await snap(host, 'host-voting', { phase: 'Voting', device: 'tv', narrator: 'Time to vote.' });

        // Players vote
        for (let i = 0; i < playerPages.length; i++) {
            const p = playerPages[i];
            try {
                await p.waitForSelector('#vote-screen.active', { timeout: 5000 });
                await p.waitForTimeout(300);
                const target = p.locator('.vote-target-row').first();
                if (await target.isVisible().catch(() => false)) {
                    await target.click();
                    await p.waitForTimeout(200);
                    const castBtn = p.locator('#cast-vote-btn:not([disabled])');
                    if (await castBtn.isVisible().catch(() => false)) {
                        await castBtn.click();
                    }
                }
            } catch {}
        }
        await host.waitForTimeout(1000);
        await snap(host, 'host-votes-cast', { phase: 'Voting', device: 'tv', narrator: 'The votes are in.' });
        await snapPlayers(playerPages.slice(0, 3), 'players-voted', { phase: 'Voting' });

        // Advance through voting/execution narration
        await advanceNarration(host, playerPages, 'execution', 15);
        await host.waitForTimeout(500);
        await snap(host, 'host-execution', { phase: 'Execution', device: 'tv' });

        // === FINAL ===
        await host.waitForTimeout(1000);
        await snap(host, 'host-final', { phase: 'Final', device: 'tv' });
        await snapPlayers(playerPages.slice(0, 3), 'players-final', { phase: 'Final' });

        // Generate HTML report
        generateReport(reportEntries, SCREENSHOT_DIR);

        // Cleanup
        await browser.close();

        const screenshots = fs.readdirSync(SCREENSHOT_DIR).filter(f => f.endsWith('.png'));
        console.log(`\n✅ ${screenshots.length} screenshots saved to ./tmp/`);
        expect(screenshots.length).toBeGreaterThan(15);
        expect(fs.existsSync(path.join(SCREENSHOT_DIR, 'report.html'))).toBe(true);
    });
});
