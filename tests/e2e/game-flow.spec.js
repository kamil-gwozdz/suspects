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

// Capture an animation as a GIF by taking rapid screenshots
async function snapGif(page, label, meta = {}, durationMs = 1500, fps = 10) {
    const GIFEncoder = require('gif-encoder-2');
    const { createCanvas, Image } = (() => {
        // Use raw PNG buffers — decode with png-js
        return { createCanvas: null, Image: null };
    })();

    const frameInterval = Math.floor(1000 / fps);
    const frameCount = Math.ceil(durationMs / frameInterval);
    const frames = [];

    // Capture frames
    for (let i = 0; i < frameCount; i++) {
        const buf = await page.screenshot({ fullPage: true });
        frames.push(buf);
        if (i < frameCount - 1) await page.waitForTimeout(frameInterval);
    }

    // Get dimensions from first frame
    const PNG = require('png-js');
    const firstPng = new PNG(frames[0]);
    const width = firstPng.width;
    const height = firstPng.height;

    // Encode GIF
    const encoder = new GIFEncoder(width, height, 'neuquant', true);
    encoder.setDelay(frameInterval);
    encoder.setRepeat(0); // loop forever
    encoder.setQuality(20);
    encoder.start();

    for (const frameBuf of frames) {
        const png = new PNG(frameBuf);
        const pixels = await new Promise(resolve => png.decode(resolve));
        encoder.addFrame(pixels);
    }

    encoder.finish();
    const gifBuffer = encoder.out.getData();

    screenshotCounter++;
    const num = String(screenshotCounter).padStart(2, '0');
    const filename = `${num}-${label}.gif`;
    fs.writeFileSync(path.join(SCREENSHOT_DIR, filename), gifBuffer);

    reportEntries.push({
        filename,
        label,
        phase: meta.phase || '',
        narrator: meta.narrator || '',
        device: meta.device || 'tv',
        playerName: meta.playerName || '',
        group: meta.group || label,
    });
}

// Capture GIF for all player phones in parallel
async function snapPlayersGif(playerPages, groupLabel, meta = {}, durationMs = 1500, fps = 10) {
    const GIFEncoder = require('gif-encoder-2');
    const PNG = require('png-js');
    const frameInterval = Math.floor(1000 / fps);
    const frameCount = Math.ceil(durationMs / frameInterval);

    // Capture frames from all players simultaneously
    const allFrames = playerPages.map(() => []);

    for (let f = 0; f < frameCount; f++) {
        const captures = await Promise.all(playerPages.map(p => p.screenshot({ fullPage: true })));
        captures.forEach((buf, i) => allFrames[i].push(buf));
        if (f < frameCount - 1) await playerPages[0].waitForTimeout(frameInterval);
    }

    // Encode GIF for each player
    for (let i = 0; i < playerPages.length; i++) {
        const frames = allFrames[i];
        const firstPng = new PNG(frames[0]);
        const width = firstPng.width;
        const height = firstPng.height;

        const encoder = new GIFEncoder(width, height, 'neuquant', true);
        encoder.setDelay(frameInterval);
        encoder.setRepeat(0);
        encoder.setQuality(20);
        encoder.start();

        for (const frameBuf of frames) {
            const png = new PNG(frameBuf);
            const pixels = await new Promise(resolve => png.decode(resolve));
            encoder.addFrame(pixels);
        }

        encoder.finish();
        const gifBuffer = encoder.out.getData();

        screenshotCounter++;
        const num = String(screenshotCounter).padStart(2, '0');
        const filename = `${num}-player-${PLAYER_NAMES[i]}-${meta.phase || groupLabel}.gif`;
        fs.writeFileSync(path.join(SCREENSHOT_DIR, filename), gifBuffer);

        reportEntries.push({
            filename,
            label: `player-${PLAYER_NAMES[i]}-${meta.phase || groupLabel}`,
            phase: meta.phase || '',
            narrator: meta.narrator || '',
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
        // Click any visible "Next" button — narration or role reveal
        for (const selector of ['#reveal-next-btn:not(.hidden)', '#narration-next-btn:not(.hidden)']) {
            const btn = host.locator(selector);
            if (await btn.isVisible().catch(() => false)) {
                await btn.click();
                await host.waitForTimeout(600);
            }
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

        // Role reveal — capture card flip animations as GIFs
        for (let i = 0; i < PLAYER_COUNT; i++) {
            try { await playerPages[i].waitForSelector('#role-screen.active', { timeout: 8000 }); } catch {}
        }
        await snapPlayersGif(playerPages, 'players-role-flip', { phase: 'RoleReveal' }, 2000, 8);

        // Advance through remaining role reveals to reach Night
        await advanceNarration(host, playerPages, 'night', 30);

        // === NIGHT PHASE ===
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
        await snapPlayers(playerPages, 'players-day', { phase: 'Day' });

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
        await snapPlayers(playerPages, 'players-voted', { phase: 'Voting' });

        // Advance through voting/execution narration
        await advanceNarration(host, playerPages, 'execution', 15);
        await host.waitForTimeout(500);
        await snap(host, 'host-execution', { phase: 'Execution', device: 'tv' });

        // === FINAL ===
        await host.waitForTimeout(1000);
        await snap(host, 'host-final', { phase: 'Final', device: 'tv' });
        await snapPlayers(playerPages, 'players-final', { phase: 'Final' });

        // Generate HTML report
        generateReport(reportEntries, SCREENSHOT_DIR);

        // Cleanup
        await browser.close();

        const screenshots = fs.readdirSync(SCREENSHOT_DIR).filter(f => f.endsWith('.png') || f.endsWith('.gif'));
        console.log(`\n✅ ${screenshots.length} screenshots saved to ./tmp/`);
        expect(screenshots.length).toBeGreaterThan(15);
        expect(fs.existsSync(path.join(SCREENSHOT_DIR, 'report.html'))).toBe(true);
    });
});
