const ws = new WsClient('/ws/host');
let roomCode = null;
let players = [];
let alivePlayers = [];
let timerInterval = null;
let previousVoteCounts = {};
let currentPhase = 'lobby';
let starsGenerated = false;

// Audio manager instance
const audioManager = new AudioManager();

// Narration state
let narrationQueue = [];
let narrationActive = false;

// DOM elements
const lobbyScreen = document.getElementById('lobby-screen');
const gameScreen = document.getElementById('game-screen');
const createRoomBtn = document.getElementById('create-room-btn');
const startGameBtn = document.getElementById('start-game-btn');
const roomInfo = document.getElementById('room-info');
const languageSelect = document.getElementById('language-select');
const phaseOverlay = document.getElementById('phase-overlay');
const starsLayer = document.getElementById('stars-layer');
const volumeSlider = document.getElementById('volume-slider');
const narrationOverlay = document.getElementById('narration-overlay');
const narrationText = document.getElementById('narration-text');
const narrationNextBtn = document.getElementById('narration-next-btn');
const gmAudio = document.getElementById('gm-audio');

// Volume slider wiring
if (volumeSlider) {
    volumeSlider.addEventListener('input', () => {
        audioManager.setVolume(parseFloat(volumeSlider.value));
    });
}

createRoomBtn.addEventListener('click', () => {
    ws.send({ type: 'create_room', payload: { language: languageSelect.value } });
    createRoomBtn.disabled = true;
});

startGameBtn.addEventListener('click', () => {
    ws.send({ type: 'start_game' });
    startGameBtn.disabled = true;
    startGameBtn.innerHTML = '<span class="btn-spinner"></span> Starting…';
});

// Connection lost overlay
ws.onStateChange((state) => {
    if (state === 'disconnected' || state === 'reconnecting') {
        showConnectionLostOverlay();
    } else if (state === 'connected') {
        hideConnectionLostOverlay();
    }
});

ws.onMessage((msg) => {
    switch (msg.type) {
        case 'room_created':
            handleRoomCreated(msg.payload);
            break;
        case 'player_joined':
            handlePlayerJoined(msg.payload);
            break;
        case 'player_left':
            handlePlayerLeft(msg.payload);
            break;
        case 'player_list':
            handlePlayerList(msg.payload);
            break;
        case 'phase_changed':
            handlePhaseChanged(msg.payload);
            break;
        case 'night_results':
            handleNightResults(msg.payload);
            break;
        case 'vote_update':
            handleVoteUpdate(msg.payload);
            break;
        case 'vote_result':
            handleVoteResult(msg.payload);
            break;
        case 'alive_player_list':
            handleAlivePlayerList(msg.payload);
            break;
        case 'game_over':
            handleGameOver(msg.payload);
            break;
        case 'mini_game_start':
            handleMiniGameStart(msg.payload);
            break;
        case 'mini_game_result':
            handleMiniGameResult(msg.payload);
            break;
        case 'narration_step':
            handleNarrationStep(msg.payload);
            break;
        case 'error':
            showErrorToast(msg.payload.message);
            // Re-enable start button on error so host can retry
            startGameBtn.disabled = false;
            startGameBtn.textContent = startGameBtn.getAttribute('data-i18n') === 'start_game' ? 'Start Game' : startGameBtn.textContent;
            if (startGameBtn.querySelector('.btn-spinner')) {
                startGameBtn.innerHTML = 'Start Game';
            }
            break;
    }
});

// ═══════════════════════════════════════
// Stars Generation
// ═══════════════════════════════════════

function generateStars() {
    if (starsGenerated) return;
    starsGenerated = true;
    const frag = document.createDocumentFragment();
    for (let i = 0; i < 80; i++) {
        const star = document.createElement('div');
        star.className = i % 7 === 0 ? 'star bright' : 'star';
        star.style.left = Math.random() * 100 + '%';
        star.style.top = Math.random() * 60 + '%';
        star.style.setProperty('--duration', (2 + Math.random() * 4) + 's');
        star.style.setProperty('--delay', (Math.random() * 5) + 's');
        frag.appendChild(star);
    }
    starsLayer.appendChild(frag);
}

// ═══════════════════════════════════════
// Phase Transition Overlay
// ═══════════════════════════════════════

function playPhaseTransition(phase) {
    const transitionClass = {
        night: 'night-transition',
        dawn: 'dawn-transition',
        voting: 'voting-transition',
        execution: 'execution-transition',
        game_over: 'gameover-transition',
    }[phase];

    if (!transitionClass || !phaseOverlay) return Promise.resolve();

    return new Promise(resolve => {
        phaseOverlay.className = 'phase-overlay ' + transitionClass;
        phaseOverlay.classList.add('active');

        setTimeout(() => {
            phaseOverlay.classList.remove('active');
            setTimeout(() => {
                phaseOverlay.className = 'phase-overlay';
                resolve();
            }, 800);
        }, 1200);
    });
}

// ═══════════════════════════════════════
// Phase Atmosphere
// ═══════════════════════════════════════

function setPhaseAtmosphere(phase) {
    gameScreen.className = gameScreen.className
        .replace(/\bphase-\S+/g, '')
        .trim();
    gameScreen.classList.add('screen', 'active', `phase-${phase}`);

    // Stars: visible during night and dawn
    if (phase === 'night' || phase === 'dawn') {
        generateStars();
        starsLayer.classList.add('visible');
    } else {
        starsLayer.classList.remove('visible');
    }
}

function handleRoomCreated({ room_code, room_url }) {
    roomCode = room_code;
    document.getElementById('room-code-display').textContent = room_code;
    
    const fullUrl = `${window.location.origin}${room_url}`;
    document.getElementById('join-url').textContent = fullUrl;

    // Preload GM audio manifest (non-blocking, graceful on failure)
    audioManager.preloadFromManifest('/audio/gm/manifest.json');

    // Generate QR code
    const qrContainer = document.getElementById('qr-code');
    qrContainer.innerHTML = '';
    const qr = qrcode(0, 'M');
    qr.addData(fullUrl);
    qr.make();
    const canvas = document.createElement('canvas');
    const cellSize = 4;
    const margin = 2;
    const size = qr.getModuleCount() * cellSize + margin * 2;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0a0a0f';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#e74c3c';
    for (let r = 0; r < qr.getModuleCount(); r++) {
        for (let c = 0; c < qr.getModuleCount(); c++) {
            if (qr.isDark(r, c)) {
                ctx.fillRect(c * cellSize + margin, r * cellSize + margin, cellSize, cellSize);
            }
        }
    }
    canvas.style.width = '200px';
    canvas.style.height = '200px';
    canvas.style.imageRendering = 'pixelated';
    qrContainer.appendChild(canvas);

    roomInfo.classList.remove('hidden');
    createRoomBtn.classList.add('hidden');
}

function handlePlayerJoined({ player_name, player_count }) {
    if (player_count >= 6) {
        startGameBtn.classList.remove('hidden');
    }
    document.getElementById('player-count').textContent = player_count;
}

function handlePlayerLeft({ player_id, player_name }) {
    players = players.filter(p => p.id !== player_id);
    updatePlayerListUI();
}

function handlePlayerList({ players: playerList }) {
    players = playerList;
    updatePlayerListUI();
}

function updatePlayerListUI() {
    const ul = document.getElementById('player-list');
    ul.innerHTML = players.map(p => `<li>${escapeHtml(p.name)}</li>`).join('');
    document.getElementById('player-count').textContent = players.length;
}

function handlePhaseChanged({ phase, round, timer_secs }) {
    const previousPhase = currentPhase;
    currentPhase = phase;

    if (phase !== 'lobby' && phase !== 'role_reveal') {
        lobbyScreen.classList.remove('active');
        gameScreen.classList.add('active');
    }

    document.getElementById('round-number').textContent = round;
    document.getElementById('phase-display').textContent = formatPhase(phase);

    // Play transition overlay then finalize atmosphere
    playPhaseTransition(phase).then(() => {
        setPhaseAtmosphere(phase);
    });

    // Set atmosphere immediately (overlay is cosmetic)
    setPhaseAtmosphere(phase);

    // Show appropriate view
    document.querySelectorAll('.phase-view').forEach(el => el.classList.add('hidden'));
    const viewMap = {
        'night': 'night-view',
        'dawn': 'dawn-view',
        'day': 'day-view',
        'voting': 'voting-view',
        'execution': 'execution-view',
        'game_over': 'gameover-view',
    };
    const viewId = viewMap[phase];
    if (viewId) document.getElementById(viewId).classList.remove('hidden');

    // Reset vote state when entering voting phase
    if (phase === 'voting') {
        previousVoteCounts = {};
        document.getElementById('vote-bars').innerHTML = '';
        const counter = document.getElementById('votes-cast-counter');
        if (counter) counter.textContent = '';
    }

    // Hide mini-game overlay when phase changes
    hideMiniGameOverlay();

    // Start timer
    if (timer_secs > 0) startTimer(timer_secs);
}

function handleNightResults({ killed, saved, events }) {
    const container = document.getElementById('death-announcements');
    container.innerHTML = '';

    if (killed.length === 0) {
        const p = document.createElement('p');
        p.className = 'no-deaths';
        p.textContent = 'The town sleeps peacefully. No one was killed last night.';
        container.appendChild(p);
    } else {
        killed.forEach((p, index) => {
            const el = document.createElement('div');
            el.className = 'death-announcement';
            el.style.setProperty('--reveal-delay', (index * 1.2) + 's');
            el.innerHTML = `<span class="death-name">${escapeHtml(p.name)}</span> was found dead.`;
            container.appendChild(el);

            // Mark them in alive list with staggered delay
            setTimeout(() => markPlayerDead(p.id), (index * 1200) + 800);
        });
    }
}

function handleVoteUpdate({ votes }) {
    const container = document.getElementById('vote-bars');

    // Build vote data: count and voter names per target
    const voteData = {};
    const totalVoters = votes.length;
    let votedCount = 0;

    votes.forEach(v => {
        if (v.target_id) {
            votedCount++;
            if (!voteData[v.target_id]) {
                voteData[v.target_id] = { count: 0, voters: [] };
            }
            voteData[v.target_id].count++;
            voteData[v.target_id].voters.push(v.voter_name);
        }
    });

    // Also show alive players with 0 votes as candidates
    const candidates = alivePlayers.length > 0 ? alivePlayers : players.filter(p => p.alive !== false);
    candidates.forEach(p => {
        if (!voteData[p.id]) {
            voteData[p.id] = { count: 0, voters: [] };
        }
    });

    const sorted = Object.entries(voteData).sort((a, b) => b[1].count - a[1].count);
    const maxVotes = Math.max(1, ...sorted.map(([, d]) => d.count));
    const leaderId = sorted.length > 0 && sorted[0][1].count > 0 ? sorted[0][0] : null;

    // Check for ties at the top
    const tiedAtTop = sorted.filter(([, d]) => d.count === maxVotes && d.count > 0);
    const hasUniquLeader = tiedAtTop.length === 1;

    container.innerHTML = sorted.map(([id, data], index) => {
        const player = players.find(p => p.id === id);
        const name = player ? player.name : '???';
        const widthPct = data.count > 0 ? (data.count / maxVotes * 100) : 0;
        const isLeader = hasUniquLeader && id === leaderId;
        const prevCount = previousVoteCounts[id] || 0;
        const justBumped = data.count > prevCount;

        // Heat level for color coding
        const ratio = data.count / Math.max(1, totalVoters);
        let heat;
        if (ratio >= 0.6) heat = 'heat-max';
        else if (ratio >= 0.4) heat = 'heat-high';
        else if (ratio >= 0.2) heat = 'heat-med';
        else heat = 'heat-low';

        const voterChips = data.voters.map(vn =>
            `<span class="voter-chip">${escapeHtml(vn)}</span>`
        ).join('');

        return `<div class="vote-bar entering ${isLeader ? 'leader' : ''}" style="animation-delay:${index * 0.06}s">
            <span class="vote-bar-name">${escapeHtml(name)}</span>
            <div class="vote-bar-track">
                <div class="vote-bar-fill ${heat}" style="width:${widthPct}%"></div>
            </div>
            <span class="vote-bar-count ${justBumped ? 'bumped' : ''}">${data.count}</span>
            ${voterChips ? `<div class="vote-bar-voters">${voterChips}</div>` : ''}
        </div>`;
    }).join('');

    // Update vote counter
    const counter = document.getElementById('votes-cast-counter');
    if (counter) {
        counter.textContent = `${votedCount} / ${totalVoters} votes cast`;
    }

    // Store for next comparison
    previousVoteCounts = {};
    sorted.forEach(([id, data]) => { previousVoteCounts[id] = data.count; });
}

function handleVoteResult({ target, was_lynched }) {
    const reveal = document.getElementById('execution-reveal');
    const countdown = document.getElementById('reveal-countdown');
    const spotlight = document.getElementById('reveal-spotlight');
    const revealLabel = document.getElementById('reveal-label');
    const revealName = document.getElementById('reveal-name');
    const revealSubtitle = document.getElementById('reveal-subtitle');

    // Reset
    countdown.classList.remove('hidden');
    spotlight.classList.add('hidden');
    revealName.className = 'reveal-name';
    revealSubtitle.className = 'reveal-subtitle';

    // Dramatic countdown: 3, 2, 1
    const nums = ['3', '2', '1'];
    let step = 0;

    countdown.textContent = nums[step];
    countdown.style.animation = 'none';
    void countdown.offsetWidth;
    countdown.style.animation = '';

    const countdownTimer = setInterval(() => {
        step++;
        if (step < nums.length) {
            countdown.textContent = nums[step];
            countdown.style.animation = 'none';
            void countdown.offsetWidth;
            countdown.style.animation = '';
        } else {
            clearInterval(countdownTimer);
            countdown.classList.add('hidden');

            // Screen flash
            const flash = document.createElement('div');
            flash.className = 'screen-flash';
            document.body.appendChild(flash);
            flash.addEventListener('animationend', () => flash.remove());

            // Reveal the result
            spotlight.classList.remove('hidden');
            spotlight.style.animation = 'none';
            void spotlight.offsetWidth;
            spotlight.style.animation = '';

            if (was_lynched && target) {
                revealLabel.textContent = 'Eliminated';
                revealName.textContent = target.name;
                revealName.classList.add('eliminated');
                revealSubtitle.textContent = 'The town has spoken.';
                revealSubtitle.classList.add('eliminated');
                markPlayerDead(target.id);
            } else {
                revealLabel.textContent = 'No Majority';
                revealName.textContent = '—';
                revealName.classList.add('safe');
                revealSubtitle.textContent = 'The town could not reach a decision. No one was eliminated.';
                revealSubtitle.classList.add('safe');
            }
        }
    }, 800);
}

function handleAlivePlayerList({ players: aliveList }) {
    const previouslyAlive = new Set(alivePlayers.filter(p => p.alive).map(p => p.id));
    alivePlayers = aliveList;
    updateAliveListUI(previouslyAlive);
}

function updateAliveListUI(previouslyAlive) {
    const ul = document.getElementById('alive-list');
    if (!ul) return;
    ul.innerHTML = '';

    alivePlayers.forEach(p => {
        const li = document.createElement('li');
        li.textContent = p.name;
        li.dataset.playerId = p.id;

        if (!p.alive) {
            if (previouslyAlive && previouslyAlive.has(p.id)) {
                li.className = 'just-died';
                setTimeout(() => { li.className = 'dead'; }, 1000);
            } else {
                li.className = 'dead';
            }
        } else {
            li.className = 'alive-enter';
        }

        ul.appendChild(li);
    });
}

function markPlayerDead(playerId) {
    const li = document.querySelector(`#alive-list li[data-player-id="${playerId}"]`);
    if (li && !li.classList.contains('dead')) {
        li.className = 'just-died';
        setTimeout(() => { li.className = 'dead'; }, 1000);
    }
}

function handleGameOver({ winner, player_roles }) {
    document.getElementById('gameover-message').textContent = `${winner} wins!`;
    const container = document.getElementById('role-reveals');
    container.innerHTML = player_roles.map((p, i) =>
        `<div class="role-reveal-card ${p.alive ? '' : 'dead'}" style="--card-delay: ${i * 0.15}s">
            <div class="player-name">${escapeHtml(p.player_name)}</div>
            <div class="role-name">${p.role}</div>
            <div>${p.alive ? '✓ Alive' : '✗ Dead'}</div>
        </div>`
    ).join('');
}

// ---------------------------------------------------------------------------
// Mini-game host display
// ---------------------------------------------------------------------------

function handleMiniGameStart({ game_type, config, participants }) {
    const overlay = getOrCreateMiniGameOverlay();
    overlay.classList.remove('hidden');
    overlay.classList.add('minigame-enter');
    setTimeout(() => overlay.classList.remove('minigame-enter'), 500);

    const participantNames = participants.map(id => {
        const p = players.find(pl => pl.id === id);
        return p ? p.name : id;
    });

    const titles = {
        prisoners_dilemma: '\u{1F91D} Prisoner\u2019s Dilemma',
        trust_circle: '\u{1F535} Trust Circle',
        alibi_challenge: '\u{1F526} Alibi Challenge',
        interrogation: '\u{1F50E} Interrogation',
    };

    const descriptions = {
        prisoners_dilemma: 'Two players must choose: Cooperate or Betray?',
        trust_circle: 'All players rank each other by trust.',
        alibi_challenge: 'A player is in the spotlight \u2014 defend yourself!',
        interrogation: 'Three yes-or-no questions. Will the truth come out?',
    };

    overlay.innerHTML = `
        <div class="mg-card mg-start">
            <h2 class="mg-title">${titles[game_type] || game_type}</h2>
            <p class="mg-desc">${descriptions[game_type] || ''}</p>
            <div class="mg-participants">
                ${participantNames.map(n => `<span class="mg-participant">${escapeHtml(n)}</span>`).join('')}
            </div>
            <div class="mg-waiting-spinner"></div>
            <p class="mg-waiting-text">Waiting for responses\u2026</p>
        </div>
    `;
}

function handleMiniGameResult({ game_type, result }) {
    const overlay = getOrCreateMiniGameOverlay();
    overlay.classList.remove('hidden');

    switch (game_type) {
        case 'prisoners_dilemma':
            renderPrisonerResult(overlay, result);
            break;
        case 'trust_circle':
            renderTrustCircleResult(overlay, result);
            break;
        case 'alibi_challenge':
            renderAlibiResult(overlay, result);
            break;
        case 'interrogation':
            renderInterrogationResult(overlay, result);
            break;
        default:
            overlay.innerHTML = `<div class="mg-card"><pre>${JSON.stringify(result, null, 2)}</pre></div>`;
    }

    // Auto-dismiss after 12 seconds
    setTimeout(() => hideMiniGameOverlay(), 12000);
}

function renderPrisonerResult(overlay, result) {
    const nameA = playerName(result.player_a.player_id);
    const nameB = playerName(result.player_b.player_id);
    const choiceLabel = c => c === 'cooperate' ? '\u{1F91D} Cooperate' : '\u{1F5E1}\uFE0F Betray';
    const deltaLabel = d => d >= 0 ? `+${d}` : `${d}`;

    overlay.innerHTML = `
        <div class="mg-card mg-prisoner-result">
            <h2 class="mg-title">\u{1F91D} Prisoner's Dilemma \u2014 Result</h2>
            <div class="mg-pd-grid">
                <div class="mg-pd-cell mg-pd-header"></div>
                <div class="mg-pd-cell mg-pd-header">${escapeHtml(nameB)}</div>
                <div class="mg-pd-cell mg-pd-header">${escapeHtml(nameA)}</div>
                <div class="mg-pd-cell mg-pd-outcome">
                    <div class="mg-pd-choices">
                        <span>${choiceLabel(result.player_a.choice)}</span>
                        <span>vs</span>
                        <span>${choiceLabel(result.player_b.choice)}</span>
                    </div>
                </div>
            </div>
            <div class="mg-pd-scores">
                <div class="mg-pd-score ${result.player_a.score_delta >= 0 ? 'positive' : 'negative'}">
                    ${escapeHtml(nameA)}: <strong>${deltaLabel(result.player_a.score_delta)}</strong> trust
                </div>
                <div class="mg-pd-score ${result.player_b.score_delta >= 0 ? 'positive' : 'negative'}">
                    ${escapeHtml(nameB)}: <strong>${deltaLabel(result.player_b.score_delta)}</strong> trust
                </div>
            </div>
        </div>
    `;
}

function renderTrustCircleResult(overlay, result) {
    const scores = result.scores || [];
    const maxRank = scores.length > 0 ? Math.max(...scores.map(s => s.average_rank)) : 1;

    const bars = scores.map(s => {
        const name = playerName(s.player_id);
        const pct = ((maxRank - s.average_rank + 1) / maxRank * 100).toFixed(0);
        return `
            <div class="mg-tc-bar">
                <span class="mg-tc-name">${escapeHtml(name)}</span>
                <div class="mg-tc-fill-track">
                    <div class="mg-tc-fill" style="width:${pct}%"></div>
                </div>
                <span class="mg-tc-rank">${s.average_rank.toFixed(1)}</span>
            </div>
        `;
    }).join('');

    overlay.innerHTML = `
        <div class="mg-card mg-trust-result">
            <h2 class="mg-title">\u{1F535} Trust Circle \u2014 Rankings</h2>
            <p class="mg-subtitle">Lower rank = more trusted</p>
            <div class="mg-tc-chart">${bars}</div>
        </div>
    `;
}

function renderAlibiResult(overlay, result) {
    const name = playerName(result.target_id);
    const total = result.thumbs_up + result.thumbs_down;
    const upPct = total > 0 ? (result.thumbs_up / total * 100).toFixed(0) : 50;
    const downPct = total > 0 ? (result.thumbs_down / total * 100).toFixed(0) : 50;

    overlay.innerHTML = `
        <div class="mg-card mg-alibi-result">
            <h2 class="mg-title">\u{1F526} Alibi Challenge \u2014 Result</h2>
            <p class="mg-spotlight-name">${escapeHtml(name)}</p>
            <div class="mg-alibi-bars">
                <div class="mg-alibi-bar up" style="width:${upPct}%">
                    <span>\u{1F44D} ${result.thumbs_up}</span>
                </div>
                <div class="mg-alibi-bar down" style="width:${downPct}%">
                    <span>\u{1F44E} ${result.thumbs_down}</span>
                </div>
            </div>
            <p class="mg-alibi-verdict">${result.thumbs_up >= result.thumbs_down ? '\u2705 The group leans toward believing this player.' : '\u274C The group is skeptical of this player.'}</p>
        </div>
    `;
}

function renderInterrogationResult(overlay, result) {
    const interrogator = playerName(result.interrogator_id);
    const target = playerName(result.target_id);

    const qaHtml = (result.qa_pairs || []).map((qa, i) => `
        <div class="mg-int-qa">
            <div class="mg-int-q"><span class="mg-int-num">Q${i + 1}.</span> ${escapeHtml(qa.question)}</div>
            <div class="mg-int-a ${qa.answer ? 'yes' : 'no'}">${qa.answer ? '\u2705 Yes' : '\u274C No'}</div>
        </div>
    `).join('');

    overlay.innerHTML = `
        <div class="mg-card mg-interrogation-result">
            <h2 class="mg-title">\u{1F50E} Interrogation \u2014 Transcript</h2>
            <div class="mg-int-players">
                <span class="mg-int-role">\u{1F575}\uFE0F ${escapeHtml(interrogator)}</span>
                <span class="mg-int-vs">interrogates</span>
                <span class="mg-int-role">\u{1F3AF} ${escapeHtml(target)}</span>
            </div>
            <div class="mg-int-transcript">${qaHtml}</div>
        </div>
    `;
}

function getOrCreateMiniGameOverlay() {
    let el = document.getElementById('minigame-overlay');
    if (!el) {
        el = document.createElement('div');
        el.id = 'minigame-overlay';
        el.className = 'minigame-overlay hidden';
        document.getElementById('game-screen').appendChild(el);
    }
    return el;
}

function hideMiniGameOverlay() {
    const el = document.getElementById('minigame-overlay');
    if (el) el.classList.add('hidden');
}

// ---------------------------------------------------------------------------
// Narration Step Handler (GM voice + text)
// ---------------------------------------------------------------------------
// Payload shape:
//   { text, audio_key?, wait_type: "Duration"|"PlayerAction"|"HostAdvance",
//     duration_secs?, subtitle?: bool }
//
// wait_type behaviour after audio finishes:
//   Duration     → auto-advance after max(audio length, duration_secs)
//   PlayerAction → show "Waiting for players…" indicator
//   HostAdvance  → show "Next ▶" button for the host

function handleNarrationStep(payload) {
    // Support both old format (audio_key, wait_type, duration_secs, subtitle)
    // and new script-engine format (key, text, audio_file, wait_for, target_player_id)
    const text = payload.text || '';
    const audioKey = payload.audio_key || null;
    const audioFile = payload.audio_file || null;
    const waitFor = payload.wait_for || payload.wait_type || 'Duration';
    const subtitle = payload.subtitle || false;

    const overlay       = document.getElementById('narration-overlay');
    const narrationText = document.getElementById('narration-text');
    const indicator     = document.getElementById('narration-indicator');
    const nextBtn       = document.getElementById('narration-next-btn');
    const subtitleBar   = document.getElementById('narration-subtitle');
    const subtitleText  = document.getElementById('narration-subtitle-text');
    const gmAudio       = document.getElementById('gm-audio');

    // Reset controls
    indicator.classList.add('hidden');
    nextBtn.classList.add('hidden');

    if (subtitle) {
        // Subtitle mode: non-blocking text at bottom
        overlay.classList.add('hidden');
        subtitleText.textContent = text;
        subtitleBar.classList.remove('hidden');
    } else {
        // Full overlay mode
        subtitleBar.classList.add('hidden');
        narrationText.textContent = text;
        // Re-trigger fade-in animation
        narrationText.style.animation = 'none';
        void narrationText.offsetWidth;
        narrationText.style.animation = '';
        overlay.classList.remove('hidden');
    }

    // Play audio — try audio_file (new format), then audio_key (old format via AudioManager)
    const audioStart = Date.now();
    let audioPromise;

    if (audioFile && gmAudio) {
        audioPromise = new Promise(resolve => {
            gmAudio.src = audioFile;
            gmAudio.onended = resolve;
            gmAudio.onerror = resolve; // resolve even on error (file may not exist yet)
            gmAudio.play().catch(resolve);
        });
    } else if (audioKey) {
        audioPromise = audioManager.play(audioKey);
    } else {
        audioPromise = Promise.resolve();
    }

    audioPromise.then(() => {
        const elapsed = (Date.now() - audioStart) / 1000;

        // Parse wait_for — can be a string like "duration" or an object like { duration: 3 }
        let waitType, waitDuration;
        if (typeof waitFor === 'object' && waitFor !== null) {
            if ('duration' in waitFor) {
                waitType = 'Duration';
                waitDuration = waitFor.duration;
            } else if ('player_action' in waitFor) {
                waitType = 'PlayerAction';
            } else if ('host_advance' in waitFor) {
                waitType = 'HostAdvance';
            } else {
                waitType = Object.keys(waitFor)[0] || 'Duration';
                waitDuration = Object.values(waitFor)[0] || 2;
            }
        } else {
            waitType = waitFor;
            waitDuration = payload.duration_secs || 2;
        }

        const remaining = (waitDuration || 0) - elapsed;

        switch (waitType) {
            case 'Duration':
            case 'duration': {
                const delay = Math.max(0, remaining) * 1000;
                setTimeout(() => {
                    hideNarration();
                    ws.send({ type: 'advance_phase' });
                }, delay);
                break;
            }
            case 'PlayerAction':
            case 'player_action': {
                indicator.textContent = 'Waiting for player…';
                indicator.classList.remove('hidden');
                break;
            }
            case 'HostAdvance':
            case 'host_advance': {
                nextBtn.classList.remove('hidden');
                nextBtn.onclick = () => {
                    nextBtn.classList.add('hidden');
                    hideNarration();
                    ws.send({ type: 'advance_phase' });
                };
                break;
            }
            default: {
                setTimeout(() => hideNarration(), 2000);
            }
        }
    });
}

function hideNarration() {
    const overlay     = document.getElementById('narration-overlay');
    const subtitleBar = document.getElementById('narration-subtitle');
    if (overlay) overlay.classList.add('hidden');
    if (subtitleBar) subtitleBar.classList.add('hidden');
    audioManager.stop();
}

function playerName(id) {
    const p = players.find(pl => pl.id === id);
    return p ? p.name : id;
}

// ---------------------------------------------------------------------------
// Timer & helpers
// ---------------------------------------------------------------------------

function startTimer(secs) {
    if (timerInterval) clearInterval(timerInterval);
    let remaining = secs;
    const display = document.getElementById('timer-display');
    display.textContent = formatTime(remaining);

    timerInterval = setInterval(() => {
        remaining--;
        display.textContent = formatTime(remaining);
        if (remaining <= 0) {
            clearInterval(timerInterval);
            ws.send({ type: 'advance_phase' });
        }
    }, 1000);
}

function formatTime(secs) {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatPhase(phase) {
    const names = {
        'lobby': 'Lobby',
        'role_reveal': 'Role Reveal',
        'night': 'Night',
        'dawn': 'Dawn',
        'day': 'Day',
        'voting': 'Voting',
        'execution': 'Execution',
        'game_over': 'Game Over',
    };
    return names[phase] || phase;
}

function showErrorToast(message) {
    showToast(message, 'error');
}

function showToast(message, type = 'info') {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        container.className = 'toast-container';
        document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    // Trigger entrance animation
    requestAnimationFrame(() => toast.classList.add('toast-visible'));

    setTimeout(() => {
        toast.classList.remove('toast-visible');
        toast.classList.add('toast-exit');
        toast.addEventListener('transitionend', () => toast.remove());
        // Fallback removal
        setTimeout(() => toast.remove(), 500);
    }, 4000);
}

function showConnectionLostOverlay() {
    let overlay = document.getElementById('host-connection-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'host-connection-overlay';
        overlay.className = 'connection-lost-overlay';
        overlay.innerHTML = `
            <div class="connection-lost-content">
                <div class="reconnect-spinner"></div>
                <p>Connection lost</p>
                <p class="connection-sub">Attempting to reconnect…</p>
            </div>
        `;
        document.body.appendChild(overlay);
    }
    overlay.classList.remove('hidden');
}

function hideConnectionLostOverlay() {
    const overlay = document.getElementById('host-connection-overlay');
    if (overlay) overlay.classList.add('hidden');
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
