const params = new URLSearchParams(window.location.search);
const roomCodeFromUrl = params.get('room');
let lang = params.get('lang') || localStorage.getItem('suspects_lang') || 'en';
const ws = new WsClient('/ws/player');

let playerId = null;
let playerRole = null;
let playerFaction = null;
let selectedTarget = null;
let timerInterval = null;
let i18nStrings = {};
let isReady = false;
let countdownInterval = null;

function loadTranslations(langCode) {
    return fetch(`/i18n/${langCode}.json`)
        .then(r => r.ok ? r.json() : {})
        .catch(() => ({}));
}

// Load i18n translations, then initialize the app
loadTranslations(lang).then(strings => {
    i18nStrings = strings;
    applyI18n();
    initApp();

    // Set language selector to current value and listen for changes
    const langSelect = document.getElementById('language-select');
    langSelect.value = lang;
    langSelect.addEventListener('change', () => {
        lang = langSelect.value;
        localStorage.setItem('suspects_lang', lang);
        loadTranslations(lang).then(s => {
            i18nStrings = s;
            applyI18n();
        });
    });
});

function t(key, params = {}) {
    let str = i18nStrings[key] || key;
    for (const [k, v] of Object.entries(params)) {
        str = str.replace(`{${k}}`, v);
    }
    return str;
}

function applyI18n() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        if (i18nStrings[key]) el.textContent = i18nStrings[key];
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.getAttribute('data-i18n-placeholder');
        if (i18nStrings[key]) el.placeholder = i18nStrings[key];
    });
}

function initApp() {

// Restore saved session from localStorage
const savedName = localStorage.getItem('suspects_player_name');
const savedPlayerId = localStorage.getItem('suspects_player_id');
const savedRoomCode = localStorage.getItem('suspects_room_code');

// DOM
const joinScreen = document.getElementById('join-screen');
const waitingScreen = document.getElementById('waiting-screen');
const roleScreen = document.getElementById('role-screen');
const nightScreen = document.getElementById('night-screen');
const dayScreen = document.getElementById('day-screen');
const voteScreen = document.getElementById('vote-screen');
const deadScreen = document.getElementById('dead-screen');
const gameoverScreen = document.getElementById('gameover-player-screen');
const sleepingScreen = document.getElementById('sleeping-screen');
const reconnectOverlay = document.getElementById('reconnect-overlay');

const joinBtn = document.getElementById('join-btn');
const nameInput = document.getElementById('player-name');
const roomCodeInput = document.getElementById('room-code-input');
const readyBtn = document.getElementById('ready-btn');
const countdownDisplay = document.getElementById('countdown-display');
const confirmActionBtn = document.getElementById('confirm-action-btn');
const skipActionBtn = document.getElementById('skip-action-btn');
const castVoteBtn = document.getElementById('cast-vote-btn');
const readyToVoteBtn = document.getElementById('ready-to-vote-btn');
let isReadyToVote = false;

// Auto-fill saved name and room code from URL
if (savedName) {
    nameInput.value = savedName;
}
if (roomCodeFromUrl) {
    roomCodeInput.value = roomCodeFromUrl;
    roomCodeInput.readOnly = true;
    roomCodeInput.style.opacity = '0.7';
    nameInput.focus();
} else {
    roomCodeInput.focus();
}

// Connection state tracking — show/hide reconnecting overlay
ws.onStateChange((state) => {
    if (state === 'disconnected' || state === 'reconnecting') {
        // Only show overlay if player has an active session
        if (playerId || savedPlayerId) {
            reconnectOverlay.classList.remove('hidden');
        }
    } else if (state === 'connected') {
        reconnectOverlay.classList.add('hidden');
    }
});

joinBtn.addEventListener('click', () => {
    const name = nameInput.value.trim();
    if (!name) return;
    const code = (roomCodeInput.value || '').trim().toUpperCase();
    if (!code || code.length < 4) {
        roomCodeInput.classList.add('shake');
        setTimeout(() => roomCodeInput.classList.remove('shake'), 500);
        return;
    }

    localStorage.setItem('suspects_player_name', name);
    localStorage.setItem('suspects_lang', lang);
    ws.send({ type: 'join_room', payload: { room_code: code, player_name: name } });
    joinBtn.disabled = true;
});

nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinBtn.click();
});

readyBtn.addEventListener('click', () => {
    isReady = !isReady;
    readyBtn.textContent = isReady ? `${t('ready')} ✓` : t('not_ready');
    readyBtn.classList.toggle('ready', isReady);
    ws.send({ type: 'player_ready', payload: { ready: isReady } });
});

confirmActionBtn.addEventListener('click', () => {
    if (selectedTarget) {
        ws.send({ type: 'night_action', payload: { target_id: selectedTarget, secondary_target_id: null } });
        ws.send({ type: 'narration_ack' });
        confirmActionBtn.disabled = true;
        confirmActionBtn.innerHTML = `<span class="btn-spinner"></span> ${t('confirming')}`;
        skipActionBtn.disabled = true;
        selectedTarget = null;
    }
});

skipActionBtn.addEventListener('click', () => {
    ws.send({ type: 'night_action', payload: { target_id: null, secondary_target_id: null } });
    ws.send({ type: 'narration_ack' });
    skipActionBtn.disabled = true;
    skipActionBtn.innerHTML = `<span class="btn-spinner"></span> ${t('skipping')}`;
    confirmActionBtn.disabled = true;
});

castVoteBtn.addEventListener('click', () => {
    if (!selectedTarget) return;
    ws.send({ type: 'vote', payload: { target_id: selectedTarget } });
    castVoteBtn.textContent = t('vote_change');
});

readyToVoteBtn.addEventListener('click', () => {
    isReadyToVote = !isReadyToVote;
    readyToVoteBtn.classList.toggle('ready-active', isReadyToVote);
    readyToVoteBtn.textContent = isReadyToVote ? `✓ ${t('ready_to_vote')}` : t('ready_to_vote');
    ws.send({ type: 'ready_to_vote', payload: { ready: isReadyToVote } });
});

ws.onMessage((msg) => {
    switch (msg.type) {
        case 'joined_room':
            handleJoined(msg.payload);
            break;
        case 'reconnect_state':
            handleReconnectState(msg.payload);
            break;
        case 'role_assigned':
            handleRoleAssigned(msg.payload);
            break;
        case 'role_reveal_flip':
            handleRoleRevealFlip(msg.payload);
            break;
        case 'phase_changed':
            handlePhaseChanged(msg.payload);
            break;
        case 'night_action_prompt':
            handleNightPrompt(msg.payload);
            break;
        case 'wake_up':
            handleWakeUp(msg.payload);
            break;
        case 'go_to_sleep':
            handleGoToSleep();
            break;
        case 'investigation_result':
            handleInvestigation(msg.payload);
            break;
        case 'vote_update':
            handleVoteUpdate(msg.payload);
            break;
        case 'auto_start_countdown':
            handleAutoStartCountdown(msg.payload);
            break;
        case 'auto_start_cancelled':
            handleAutoStartCancelled();
            break;
        case 'game_over':
            handleGameOver(msg.payload);
            break;
        case 'mini_game_prompt':
            handleMiniGamePrompt(msg.payload);
            break;
        case 'alive_player_list':
            alivePlayersCache = msg.payload.players || [];
            break;
        case 'all_ready_to_vote':
            // Server auto-transitions to voting, nothing extra needed
            break;
        case 'error':
            handleError(msg.payload);
            break;
    }
});

function showScreen(screen) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    screen.classList.add('active');
}

function handleJoined({ player_id, room_code }) {
    playerId = player_id;
    localStorage.setItem('suspects_player_id', player_id);
    localStorage.setItem('suspects_room_code', room_code);
    document.getElementById('waiting-name').textContent = nameInput.value.trim();
    // Reset ready state on fresh join
    isReady = false;
    readyBtn.textContent = t('not_ready');
    readyBtn.classList.remove('ready');
    countdownDisplay.classList.add('hidden');
    showScreen(waitingScreen);
}

function handleAutoStartCountdown({ seconds }) {
    if (countdownInterval) clearInterval(countdownInterval);
    let remaining = seconds;
    countdownDisplay.textContent = t('game_starting_in', { seconds: remaining });
    countdownDisplay.classList.remove('hidden');
    countdownInterval = setInterval(() => {
        remaining--;
        if (remaining <= 0) {
            clearInterval(countdownInterval);
            countdownInterval = null;
            countdownDisplay.textContent = t('game_starting_in', { seconds: 0 });
        } else {
            countdownDisplay.textContent = t('game_starting_in', { seconds: remaining });
        }
    }, 1000);
}

function handleAutoStartCancelled() {
    if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
    }
    countdownDisplay.classList.add('hidden');
}

function handleReconnectState({ player_id, room_code, phase, round, alive_players, role, description_key, faction, votes }) {
    playerId = player_id;
    localStorage.setItem('suspects_player_id', player_id);
    localStorage.setItem('suspects_room_code', room_code);
    reconnectOverlay.classList.add('hidden');

    // Restore role info if assigned
    if (role) {
        playerRole = role;
        playerFaction = faction ? faction.toLowerCase() : null;
    }

    // Check if player is dead
    const me = alive_players.find(p => p.id === player_id);
    if (role && !me) {
        showScreen(deadScreen);
        return;
    }

    // Route to the correct screen based on current phase
    switch (phase) {
        case 'lobby':
            showScreen(waitingScreen);
            break;
        case 'role_reveal':
            if (role) {
                handleRoleAssigned({ role, description_key: description_key || '', faction: faction || '' });
            } else {
                showScreen(waitingScreen);
            }
            break;
        case 'night':
            // Show sleeping — if server is waiting for us, wake_up + prompt will follow
            showScreen(sleepingScreen);
            break;
        case 'dawn':
        case 'day':
            showScreen(dayScreen);
            break;
        case 'voting':
            showScreen(voteScreen);
            break;
        case 'execution':
            showScreen(dayScreen);
            break;
        case 'game_over':
            showScreen(gameoverScreen);
            break;
        default:
            showScreen(waitingScreen);
    }
}

function handleRoleAssigned({ role, description_key, faction }) {
    playerRole = role;
    playerFaction = faction.toLowerCase();

    const roleIcons = {
        civilian: '👤', doctor: '🏥', detective: '🔍', escort: '💃',
        vigilante: '🔫', mayor: '🎩', spy: '🕵️', mafioso: '🔪',
        godfather: '👑', consort: '💋', janitor: '🧹', jester: '🃏',
        serial_killer: '🗡️', survivor: '🛡️', executioner: '⚖️', witch: '🧙',
    };

    document.getElementById('role-icon').textContent = roleIcons[role] || '❓';
    document.getElementById('role-name').textContent = t(`role_name_${role}`) || formatRole(role);
    document.getElementById('role-description').textContent = t(`role_${role}`);
    
    const factionEl = document.getElementById('role-faction');
    factionEl.textContent = t(`faction_${playerFaction}`) || faction;
    factionEl.className = `role-faction ${playerFaction}`;

    // Show with flip animation
    const flipCard = document.getElementById('flip-card');
    flipCard.classList.remove('flipped');
    showScreen(roleScreen);
    setTimeout(() => flipCard.classList.add('flipped'), 300);
}

function handleRoleRevealFlip({ role, role_name, description, faction, is_you }) {
    const roleIcons = {
        civilian: '👤', doctor: '🏥', detective: '🔍', escort: '💃',
        vigilante: '🔫', mayor: '🎩', spy: '🕵️', mafioso: '🔪',
        godfather: '👑', consort: '💋', janitor: '🧹', jester: '🃏',
        serial_killer: '🗡️', survivor: '🛡️', executioner: '⚖️', witch: '🧙',
    };

    const flipCard = document.getElementById('flip-card');

    if (is_you) {
        // This IS the player's role — store it
        playerRole = role;
        playerFaction = faction.toLowerCase();

        // Set the card back content to their actual role
        document.getElementById('role-icon').textContent = roleIcons[role] || '❓';
        document.getElementById('role-name').textContent = t(`role_name_${role}`) || role_name;
        document.getElementById('role-description').textContent = t(`role_${role}`) || description;
        const factionEl = document.getElementById('role-faction');
        factionEl.textContent = t(`faction_${playerFaction}`) || faction;
        factionEl.className = `role-faction ${playerFaction}`;

        document.getElementById('reveal-your-role-label').textContent = t('your_role') || 'Your Role';
    } else {
        // NOT this player's role — show blank/mystery card
        document.getElementById('role-icon').textContent = '❓';
        document.getElementById('role-name').textContent = '???';
        document.getElementById('role-description').textContent = '';
        const factionEl = document.getElementById('role-faction');
        factionEl.textContent = '';
        factionEl.className = 'role-faction';

        document.getElementById('reveal-your-role-label').textContent = '';
    }

    // Reset card to face-down
    flipCard.classList.remove('flipped');
    showScreen(roleScreen);

    // After a short delay, flip it
    setTimeout(() => {
        flipCard.classList.add('flipped');

        // If NOT the player's role, flip back after 2s
        if (!is_you) {
            setTimeout(() => {
                flipCard.classList.remove('flipped');
            }, 2000);
        }
    }, 500);
}

function handlePhaseChanged({ phase, round, timer_secs }) {
    switch (phase) {
        case 'role_reveal': {
            // Show role screen with card face-down, waiting for flips
            const flipCard = document.getElementById('flip-card');
            flipCard.classList.remove('flipped');
            showScreen(roleScreen);
            break;
        }
        case 'night':
            // Reset action buttons for new night
            confirmActionBtn.disabled = true;
            confirmActionBtn.textContent = t('confirm');
            skipActionBtn.disabled = false;
            skipActionBtn.textContent = t('skip');
            // Show sleeping screen — narration will wake us when it's our turn
            showScreen(sleepingScreen);
            break;
        case 'dawn':
        case 'day':
            isReadyToVote = false;
            readyToVoteBtn.classList.remove('ready-active');
            readyToVoteBtn.textContent = t('ready_to_vote');
            showScreen(dayScreen);
            if (timer_secs > 0) startTimer(timer_secs, document.getElementById('day-timer'));
            break;
        case 'voting':
            // Reset vote state for new voting phase
            castVoteBtn.disabled = true;
            castVoteBtn.textContent = t('vote_btn');
            selectedTarget = null;
            buildVoteTargetList();
            showScreen(voteScreen);
            break;
        case 'execution':
            break;
        case 'game_over':
            // Transition to game over from any screen
            showScreen(gameoverScreen);
            break;
    }
}

function handleNightPrompt({ available_targets }) {
    const container = document.getElementById('target-list');
    container.innerHTML = '';
    selectedTarget = null;
    confirmActionBtn.disabled = true;

    available_targets.forEach(target => {
        const btn = document.createElement('button');
        btn.className = 'target-btn';
        btn.textContent = target.name;
        btn.dataset.id = target.id;
        btn.addEventListener('click', () => {
            container.querySelectorAll('.target-btn').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            selectedTarget = target.id;
            confirmActionBtn.disabled = false;
        });
        container.appendChild(btn);
    });

    showScreen(nightScreen);
}

function handleWakeUp({ role, instruction }) {
    // Use localized instruction based on player's role, fall back to server text
    const localInstruction = t(`night_instruction_${playerRole}`);
    document.getElementById('night-instruction').textContent =
        localInstruction !== `night_instruction_${playerRole}` ? localInstruction : instruction;
    // Reset action buttons
    confirmActionBtn.disabled = true;
    confirmActionBtn.textContent = t('confirm');
    skipActionBtn.disabled = false;
    skipActionBtn.textContent = t('skip');
    selectedTarget = null;
    // Play wake-up animation then show the night action screen
    nightScreen.classList.add('waking-up');
    showScreen(nightScreen);
    // Remove animation class after it completes
    setTimeout(() => nightScreen.classList.remove('waking-up'), 650);
}

function handleGoToSleep() {
    showScreen(sleepingScreen);
}

function handleInvestigation({ target_name, appears_guilty }) {
    const result = appears_guilty
        ? `🔴 ${t('investigation_suspicious')}`
        : `🟢 ${t('investigation_innocent')}`;
    alert(t('investigation_result', { name: target_name, result }));
}

// Track alive players for vote target list
let alivePlayersCache = [];

function buildVoteTargetList() {
    const container = document.getElementById('vote-target-list');
    container.innerHTML = '';
    selectedTarget = null;

    alivePlayersCache.forEach(target => {
        if (target.id === playerId) return; // Can't vote for yourself
        const row = document.createElement('div');
        row.className = 'vote-target-row';
        row.dataset.id = target.id;

        const nameEl = document.createElement('span');
        nameEl.className = 'vote-target-name';
        nameEl.textContent = target.name;

        const votersEl = document.createElement('span');
        votersEl.className = 'vote-target-voters';
        votersEl.dataset.targetId = target.id;

        row.appendChild(nameEl);
        row.appendChild(votersEl);

        row.addEventListener('click', () => {
            container.querySelectorAll('.vote-target-row').forEach(r => r.classList.remove('selected'));
            row.classList.add('selected');
            selectedTarget = target.id;
            castVoteBtn.disabled = false;
            castVoteBtn.textContent = t('vote_btn');
        });

        container.appendChild(row);
    });
}

function handleVoteUpdate({ votes }) {
    // Update voter badges on each target
    const votesByTarget = {};
    votes.forEach(v => {
        const tid = v.target_id;
        if (!tid) return; // abstain
        if (!votesByTarget[tid]) votesByTarget[tid] = [];
        votesByTarget[tid].push(v.voter_name);
    });

    document.querySelectorAll('.vote-target-voters').forEach(el => {
        const tid = el.dataset.targetId;
        const voterNames = votesByTarget[tid] || [];
        el.innerHTML = voterNames.map(n =>
            `<span class="voter-badge">${escapeHtml(n)}</span>`
        ).join('');
        // Highlight rows with votes
        const row = el.closest('.vote-target-row');
        if (row) {
            row.classList.toggle('has-votes', voterNames.length > 0);
            const countEl = row.querySelector('.vote-count');
            if (countEl) countEl.remove();
            if (voterNames.length > 0) {
                const count = document.createElement('span');
                count.className = 'vote-count';
                count.textContent = voterNames.length;
                row.querySelector('.vote-target-name').appendChild(count);
            }
        }
    });

    // Update status bar
    const totalVotes = votes.length;
    const statusEl = document.getElementById('vote-status');
    statusEl.textContent = t('votes_cast_count', { count: totalVotes, total: alivePlayersCache.length });
}

function handleGameOver({ winner, player_roles }) {
    document.getElementById('gameover-player-message').textContent = t('game_over_winner', { winner });
    const myResult = player_roles.find(p => p.player_id === playerId);
    if (myResult) {
        const roleName = t(`role_name_${myResult.role}`) || formatRole(myResult.role);
        const resultText = myResult.alive ? t('survived') : t('eliminated_result');
        document.getElementById('gameover-player-result').textContent =
            t('game_over_role', { role: roleName, result: resultText });
    }
    // Clear stored session — game is over
    localStorage.removeItem('suspects_player_id');
    localStorage.removeItem('suspects_room_code');
    showScreen(gameoverScreen);
}

function handleError({ message }) {
    // Show toast notification for all errors
    showErrorToast(message);

    // Also show in join form if on join screen
    const errEl = document.getElementById('join-error');
    if (errEl && joinScreen.classList.contains('active')) {
        errEl.textContent = message;
        errEl.classList.remove('hidden');
    }

    // Re-enable join button so user can retry
    joinBtn.disabled = false;

    // Re-enable action buttons on error so player can retry
    confirmActionBtn.disabled = false;
    confirmActionBtn.textContent = t('confirm');
    skipActionBtn.disabled = false;
    skipActionBtn.textContent = t('skip');
    castVoteBtn.disabled = false;
    castVoteBtn.textContent = t('vote_btn');
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

function startTimer(secs, el) {
    if (timerInterval) clearInterval(timerInterval);
    let remaining = secs;
    el.textContent = formatTime(remaining);
    timerInterval = setInterval(() => {
        remaining--;
        el.textContent = formatTime(remaining);
        if (remaining <= 0) clearInterval(timerInterval);
    }, 1000);
}

function formatTime(secs) {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatRole(role) {
    return role.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ---------------------------------------------------------------------------
// Mini-game player UI
// ---------------------------------------------------------------------------

let miniGameTimerInterval = null;

function handleMiniGamePrompt({ game_type, prompt }) {
    const screen = getOrCreateMiniGameScreen();
    screen.innerHTML = '';

    switch (game_type) {
        case 'prisoners_dilemma':
            renderPrisonerPrompt(screen, prompt);
            break;
        case 'trust_circle':
            renderTrustCirclePrompt(screen, prompt);
            break;
        case 'alibi_challenge':
            renderAlibiPrompt(screen, prompt);
            break;
        case 'interrogation':
            renderInterrogationPrompt(screen, prompt);
            break;
        default:
            screen.innerHTML = `<p>${t('mg_unknown')}: ${game_type}</p>`;
    }

    showScreen(screen);
}

function getOrCreateMiniGameScreen() {
    let el = document.getElementById('minigame-screen');
    if (!el) {
        el = document.createElement('div');
        el.id = 'minigame-screen';
        el.className = 'screen';
        document.getElementById('app').appendChild(el);
    }
    return el;
}

// --- Prisoner's Dilemma ---

function renderPrisonerPrompt(screen, prompt) {
    const opponentName = prompt.opponent_name || t('mg_another_player');

    screen.innerHTML = `
        <h2 class="mg-player-title">\u{1F91D} ${t('mg_pd_title')}</h2>
        <p class="mg-player-desc">${t('mg_pd_you_face', { name: `<strong>${escapeHtml(opponentName)}</strong>` })}<br>
        ${t('mg_pd_desc')}</p>
        <div class="mg-pd-buttons">
            <button class="mg-btn mg-btn-cooperate" id="mg-cooperate">\u{1F91D}<br>${t('mg_pd_cooperate')}</button>
            <button class="mg-btn mg-btn-betray" id="mg-betray">\u{1F5E1}\uFE0F<br>${t('mg_pd_betray')}</button>
        </div>
        <p class="mg-player-status" id="mg-pd-status"></p>
    `;

    document.getElementById('mg-cooperate').addEventListener('click', () => {
        sendMiniGameAction('prisoners_dilemma', { choice: 'cooperate' });
        disableMgButtons(screen);
        document.getElementById('mg-pd-status').textContent = t('mg_pd_chose_cooperate');
    });

    document.getElementById('mg-betray').addEventListener('click', () => {
        sendMiniGameAction('prisoners_dilemma', { choice: 'betray' });
        disableMgButtons(screen);
        document.getElementById('mg-pd-status').textContent = t('mg_pd_chose_betray');
    });
}

// --- Trust Circle ---

function renderTrustCirclePrompt(screen, prompt) {
    const otherPlayers = prompt.players || [];
    let order = otherPlayers.map((p, i) => ({ ...p, idx: i }));

    screen.innerHTML = `
        <h2 class="mg-player-title">\u{1F535} ${t('mg_tc_title')}</h2>
        <p class="mg-player-desc">${t('mg_tc_desc')}</p>
        <div class="mg-tc-list" id="mg-tc-list"></div>
        <button class="btn-primary mg-submit-btn" id="mg-tc-submit">${t('mg_tc_submit')}</button>
        <p class="mg-player-status" id="mg-tc-status"></p>
    `;

    const renderList = () => {
        const container = document.getElementById('mg-tc-list');
        container.innerHTML = order.map((p, i) => `
            <div class="mg-tc-item" data-index="${i}">
                <span class="mg-tc-rank-num">${i + 1}.</span>
                <span class="mg-tc-item-name">${escapeHtml(p.name)}</span>
                <span class="mg-tc-arrows">
                    <button class="mg-arrow-btn" data-dir="up" data-i="${i}" ${i === 0 ? 'disabled' : ''}>\u25B2</button>
                    <button class="mg-arrow-btn" data-dir="down" data-i="${i}" ${i === order.length - 1 ? 'disabled' : ''}>\u25BC</button>
                </span>
            </div>
        `).join('');

        container.querySelectorAll('.mg-arrow-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const idx = parseInt(btn.dataset.i);
                const dir = btn.dataset.dir;
                if (dir === 'up' && idx > 0) {
                    [order[idx - 1], order[idx]] = [order[idx], order[idx - 1]];
                } else if (dir === 'down' && idx < order.length - 1) {
                    [order[idx], order[idx + 1]] = [order[idx + 1], order[idx]];
                }
                renderList();
            });
        });
    };

    renderList();

    document.getElementById('mg-tc-submit').addEventListener('click', () => {
        const ranked_ids = order.map(p => p.id);
        sendMiniGameAction('trust_circle', { ranked_player_ids: ranked_ids });
        document.getElementById('mg-tc-submit').disabled = true;
        document.getElementById('mg-tc-status').textContent = t('mg_tc_submitted');
    });
}

// --- Alibi Challenge ---

function renderAlibiPrompt(screen, prompt) {
    const isTarget = prompt.is_target || false;
    const targetName = prompt.target_name || t('mg_someone');
    const timerSecs = prompt.timer_secs || 30;

    if (isTarget) {
        screen.innerHTML = `
            <h2 class="mg-player-title">\u{1F526} ${t('mg_alibi_spotlight_title')}</h2>
            <p class="mg-player-desc">${t('mg_alibi_spotlight_desc')}</p>
            <div class="mg-alibi-timer" id="mg-alibi-timer">${timerSecs}</div>
            <p class="mg-player-status">${t('mg_alibi_spotlight_speak')}</p>
        `;
        startMiniGameTimer(timerSecs, document.getElementById('mg-alibi-timer'));
    } else {
        screen.innerHTML = `
            <h2 class="mg-player-title">\u{1F526} ${t('mg_alibi_title')}</h2>
            <p class="mg-player-desc">${t('mg_alibi_defending', { name: `<strong>${escapeHtml(targetName)}</strong>` })}</p>
            <div class="mg-alibi-timer" id="mg-alibi-timer">${timerSecs}</div>
            <p class="mg-player-desc">${t('mg_alibi_believe_question')}</p>
            <div class="mg-alibi-vote-btns">
                <button class="mg-btn mg-btn-thumbsup" id="mg-thumbsup">\u{1F44D}<br>${t('mg_alibi_believe')}</button>
                <button class="mg-btn mg-btn-thumbsdown" id="mg-thumbsdown">\u{1F44E}<br>${t('mg_alibi_doubt')}</button>
            </div>
            <p class="mg-player-status" id="mg-alibi-status"></p>
        `;

        startMiniGameTimer(timerSecs, document.getElementById('mg-alibi-timer'));

        document.getElementById('mg-thumbsup').addEventListener('click', () => {
            sendMiniGameAction('alibi_challenge', { vote: 'thumbs_up' });
            disableMgButtons(screen);
            document.getElementById('mg-alibi-status').textContent = t('mg_alibi_voted_up');
        });

        document.getElementById('mg-thumbsdown').addEventListener('click', () => {
            sendMiniGameAction('alibi_challenge', { vote: 'thumbs_down' });
            disableMgButtons(screen);
            document.getElementById('mg-alibi-status').textContent = t('mg_alibi_voted_down');
        });
    }
}

// --- Interrogation ---

function renderInterrogationPrompt(screen, prompt) {
    const role = prompt.role; // 'interrogator' or 'target'
    const otherName = prompt.other_name || t('mg_another_player');
    const maxQuestions = prompt.max_questions || 3;

    if (role === 'interrogator') {
        let questionsAsked = 0;

        screen.innerHTML = `
            <h2 class="mg-player-title">\u{1F50E} ${t('mg_int_title')}</h2>
            <p class="mg-player-desc">${t('mg_int_ask_desc', { name: `<strong>${escapeHtml(otherName)}</strong>`, count: maxQuestions })}</p>
            <div class="mg-int-input-area">
                <input type="text" class="mg-int-input" id="mg-int-input" placeholder="${t('mg_int_placeholder')}" maxlength="200">
                <button class="btn-primary" id="mg-int-ask">${t('mg_int_ask')}</button>
            </div>
            <p class="mg-player-status" id="mg-int-status">${t('mg_int_questions_remaining', { count: maxQuestions })}</p>
        `;

        document.getElementById('mg-int-ask').addEventListener('click', () => {
            const input = document.getElementById('mg-int-input');
            const question = input.value.trim();
            if (!question) return;
            questionsAsked++;
            sendMiniGameAction('interrogation', { question, question_number: questionsAsked });
            input.value = '';
            const remaining = maxQuestions - questionsAsked;
            document.getElementById('mg-int-status').textContent = remaining > 0
                ? t('mg_int_questions_remaining', { count: remaining })
                : t('mg_int_all_asked');
            if (remaining <= 0) {
                document.getElementById('mg-int-ask').disabled = true;
                input.disabled = true;
            }
        });

        document.getElementById('mg-int-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') document.getElementById('mg-int-ask').click();
        });

    } else {
        // Target role
        screen.innerHTML = `
            <h2 class="mg-player-title">\u{1F3AF} ${t('mg_int_target_title')}</h2>
            <p class="mg-player-desc">${t('mg_int_target_desc', { name: `<strong>${escapeHtml(otherName)}</strong>` })}</p>
            <div class="mg-int-question-display" id="mg-int-question">${t('mg_int_waiting_question')}</div>
            <div class="mg-int-answer-btns hidden" id="mg-int-answer-btns">
                <button class="mg-btn mg-btn-yes" id="mg-int-yes">\u2705<br>${t('mg_int_yes')}</button>
                <button class="mg-btn mg-btn-no" id="mg-int-no">\u274C<br>${t('mg_int_no')}</button>
            </div>
            <p class="mg-player-status" id="mg-int-status">${t('mg_int_waiting_questions')}</p>
        `;

        // The server will send additional prompts for each question via mini_game_prompt
        // with prompt.current_question set
        if (prompt.current_question) {
            showInterrogationQuestion(prompt.current_question, prompt.question_number || 1);
        }
    }
}

function showInterrogationQuestion(question, questionNum) {
    const display = document.getElementById('mg-int-question');
    const btns = document.getElementById('mg-int-answer-btns');
    if (!display || !btns) return;

    display.textContent = t('mg_int_question_format', { num: questionNum, question });
    btns.classList.remove('hidden');

    const yesBtn = document.getElementById('mg-int-yes');
    const noBtn = document.getElementById('mg-int-no');

    const handler = (answer) => {
        sendMiniGameAction('interrogation', { answer, question_number: questionNum });
        btns.classList.add('hidden');
        document.getElementById('mg-int-status').textContent = t('mg_int_answered', { num: questionNum });
    };

    // Clone and replace to remove old listeners
    const newYes = yesBtn.cloneNode(true);
    const newNo = noBtn.cloneNode(true);
    yesBtn.replaceWith(newYes);
    noBtn.replaceWith(newNo);

    newYes.addEventListener('click', () => handler(true));
    newNo.addEventListener('click', () => handler(false));
}

// --- Helpers ---

function sendMiniGameAction(gameType, action) {
    ws.send({ type: 'mini_game_action', payload: { game_type: gameType, action } });
}

function disableMgButtons(container) {
    container.querySelectorAll('.mg-btn').forEach(btn => { btn.disabled = true; });
}

function startMiniGameTimer(secs, el) {
    if (miniGameTimerInterval) clearInterval(miniGameTimerInterval);
    let remaining = secs;
    el.textContent = remaining;
    miniGameTimerInterval = setInterval(() => {
        remaining--;
        el.textContent = remaining;
        if (remaining <= 0) clearInterval(miniGameTimerInterval);
    }, 1000);
}

} // end initApp
