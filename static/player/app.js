const params = new URLSearchParams(window.location.search);
const roomCode = params.get('room');
const ws = new WsClient('/ws/player');

let playerId = null;
let playerRole = null;
let playerFaction = null;
let selectedTarget = null;
let timerInterval = null;

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
const reconnectOverlay = document.getElementById('reconnect-overlay');

const joinBtn = document.getElementById('join-btn');
const nameInput = document.getElementById('player-name');
const confirmActionBtn = document.getElementById('confirm-action-btn');
const skipActionBtn = document.getElementById('skip-action-btn');
const castVoteBtn = document.getElementById('cast-vote-btn');
const skipVoteBtn = document.getElementById('skip-vote-btn');
const chatSendBtn = document.getElementById('chat-send-btn');
const chatInput = document.getElementById('chat-input');

// Auto-fill saved name and focus
if (savedName) {
    nameInput.value = savedName;
}
if (roomCode) {
    nameInput.focus();
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
    const code = roomCode || prompt('Enter room code:');
    if (!code) return;

    localStorage.setItem('suspects_player_name', name);
    ws.send({ type: 'join_room', payload: { room_code: code.toUpperCase(), player_name: name } });
    joinBtn.disabled = true;
});

nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinBtn.click();
});

confirmActionBtn.addEventListener('click', () => {
    if (selectedTarget) {
        ws.send({ type: 'night_action', payload: { target_id: selectedTarget, secondary_target_id: null } });
        confirmActionBtn.disabled = true;
        confirmActionBtn.innerHTML = '<span class="btn-spinner"></span> Confirming…';
        skipActionBtn.disabled = true;
        selectedTarget = null;
    }
});

skipActionBtn.addEventListener('click', () => {
    ws.send({ type: 'night_action', payload: { target_id: null, secondary_target_id: null } });
    skipActionBtn.disabled = true;
    skipActionBtn.innerHTML = '<span class="btn-spinner"></span> Skipping…';
    confirmActionBtn.disabled = true;
});

castVoteBtn.addEventListener('click', () => {
    ws.send({ type: 'vote', payload: { target_id: selectedTarget } });
    castVoteBtn.disabled = true;
    castVoteBtn.innerHTML = '<span class="btn-spinner"></span> Voting…';
    skipVoteBtn.disabled = true;
});

skipVoteBtn.addEventListener('click', () => {
    ws.send({ type: 'vote', payload: { target_id: null } });
    skipVoteBtn.disabled = true;
    skipVoteBtn.innerHTML = '<span class="btn-spinner"></span> Abstaining…';
    castVoteBtn.disabled = true;
});

chatSendBtn.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChat();
});

function sendChat() {
    const msg = chatInput.value.trim();
    if (!msg) return;
    ws.send({ type: 'chat', payload: { message: msg } });
    chatInput.value = '';
}

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
        case 'phase_changed':
            handlePhaseChanged(msg.payload);
            break;
        case 'night_action_prompt':
            handleNightPrompt(msg.payload);
            break;
        case 'investigation_result':
            handleInvestigation(msg.payload);
            break;
        case 'vote_update':
            break; // Player sees their own vote
        case 'chat_message':
            handleChatMessage(msg.payload);
            break;
        case 'game_over':
            handleGameOver(msg.payload);
            break;
        case 'mini_game_prompt':
            handleMiniGamePrompt(msg.payload);
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
    showScreen(waitingScreen);
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
            // Night prompt will follow as a separate message if applicable
            showScreen(nightScreen);
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
    document.getElementById('role-name').textContent = formatRole(role);
    document.getElementById('role-description').textContent = getRoleDescription(role);
    
    const factionEl = document.getElementById('role-faction');
    factionEl.textContent = faction;
    factionEl.className = `role-faction ${playerFaction}`;

    showScreen(roleScreen);
}

function handlePhaseChanged({ phase, round, timer_secs }) {
    switch (phase) {
        case 'night':
            // Reset action buttons for new night
            confirmActionBtn.disabled = true;
            confirmActionBtn.textContent = 'Confirm';
            skipActionBtn.disabled = false;
            skipActionBtn.textContent = 'Skip';
            // Night screen will be shown when prompt arrives
            // Show mafia chat if mafia
            if (playerFaction === 'mafia') {
                document.getElementById('chat-overlay').classList.remove('hidden');
            }
            break;
        case 'dawn':
        case 'day':
            document.getElementById('chat-overlay').classList.add('hidden');
            showScreen(dayScreen);
            if (timer_secs > 0) startTimer(timer_secs, document.getElementById('day-timer'));
            break;
        case 'voting':
            // Reset vote buttons for new voting phase
            castVoteBtn.disabled = true;
            castVoteBtn.textContent = 'Cast Vote';
            skipVoteBtn.disabled = false;
            skipVoteBtn.textContent = 'Abstain';
            selectedTarget = null;
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

function handleInvestigation({ target_name, appears_guilty }) {
    const result = appears_guilty ? '🔴 Suspicious' : '🟢 Innocent';
    alert(`Investigation: ${target_name} appears ${result}`);
}

function handleChatMessage({ sender_name, message }) {
    const container = document.getElementById('chat-messages');
    const p = document.createElement('p');
    p.innerHTML = `<span class="sender">${escapeHtml(sender_name)}:</span> ${escapeHtml(message)}`;
    container.appendChild(p);
    container.scrollTop = container.scrollHeight;
}

function handleGameOver({ winner, player_roles }) {
    document.getElementById('gameover-player-message').textContent = `${winner} wins!`;
    const myResult = player_roles.find(p => p.player_id === playerId);
    if (myResult) {
        document.getElementById('gameover-player-result').textContent =
            `You were ${formatRole(myResult.role)} — ${myResult.alive ? 'Survived!' : 'Eliminated'}`;
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
    confirmActionBtn.textContent = 'Confirm';
    skipActionBtn.disabled = false;
    skipActionBtn.textContent = 'Skip';
    castVoteBtn.disabled = false;
    castVoteBtn.textContent = 'Cast Vote';
    skipVoteBtn.disabled = false;
    skipVoteBtn.textContent = 'Abstain';
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

function getRoleDescription(role) {
    const descriptions = {
        civilian: 'You are an ordinary town member. Use your vote wisely.',
        doctor: 'Each night, choose a player to heal. They will survive if attacked.',
        detective: 'Each night, investigate a player to learn if they are suspicious.',
        escort: 'Each night, block a player\'s night action.',
        vigilante: 'You can shoot a player at night. Use your power carefully.',
        mayor: 'Reveal yourself to gain 3 votes, but you can no longer be healed.',
        spy: 'You can see the mafia\'s night chat.',
        mafioso: 'Each night, vote with your team to eliminate a player.',
        godfather: 'Lead the mafia. You appear innocent to investigations.',
        consort: 'Block a player\'s night action on behalf of the mafia.',
        janitor: 'Clean the crime scene — the victim\'s role stays hidden.',
        jester: 'Win by getting the town to vote you out during the day.',
        serial_killer: 'Kill a player each night. You are immune to the mafia.',
        survivor: 'Stay alive until the end to win. You have limited vests.',
        executioner: 'Get your target lynched by the town to win.',
        witch: 'Redirect a player\'s action to a different target.',
    };
    return descriptions[role] || '';
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
            screen.innerHTML = `<p>Unknown mini-game: ${game_type}</p>`;
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
    const opponentName = prompt.opponent_name || 'another player';

    screen.innerHTML = `
        <h2 class="mg-player-title">\u{1F91D} Prisoner's Dilemma</h2>
        <p class="mg-player-desc">You face <strong>${escapeHtml(opponentName)}</strong>.<br>
        Both cooperate: +2 each. Both betray: -1 each.<br>
        One betrays: betrayer +3, cooperator -1.</p>
        <div class="mg-pd-buttons">
            <button class="mg-btn mg-btn-cooperate" id="mg-cooperate">\u{1F91D}<br>Cooperate</button>
            <button class="mg-btn mg-btn-betray" id="mg-betray">\u{1F5E1}\uFE0F<br>Betray</button>
        </div>
        <p class="mg-player-status" id="mg-pd-status"></p>
    `;

    document.getElementById('mg-cooperate').addEventListener('click', () => {
        sendMiniGameAction('prisoners_dilemma', { choice: 'cooperate' });
        disableMgButtons(screen);
        document.getElementById('mg-pd-status').textContent = 'You chose Cooperate. Waiting\u2026';
    });

    document.getElementById('mg-betray').addEventListener('click', () => {
        sendMiniGameAction('prisoners_dilemma', { choice: 'betray' });
        disableMgButtons(screen);
        document.getElementById('mg-pd-status').textContent = 'You chose Betray. Waiting\u2026';
    });
}

// --- Trust Circle ---

function renderTrustCirclePrompt(screen, prompt) {
    const otherPlayers = prompt.players || [];
    let order = otherPlayers.map((p, i) => ({ ...p, idx: i }));

    screen.innerHTML = `
        <h2 class="mg-player-title">\u{1F535} Trust Circle</h2>
        <p class="mg-player-desc">Rank other players from most trusted (top) to least trusted (bottom).<br>
        Tap \u25B2 \u25BC to reorder.</p>
        <div class="mg-tc-list" id="mg-tc-list"></div>
        <button class="btn-primary mg-submit-btn" id="mg-tc-submit">Submit Rankings</button>
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
        document.getElementById('mg-tc-status').textContent = 'Rankings submitted. Waiting\u2026';
    });
}

// --- Alibi Challenge ---

function renderAlibiPrompt(screen, prompt) {
    const isTarget = prompt.is_target || false;
    const targetName = prompt.target_name || 'Someone';
    const timerSecs = prompt.timer_secs || 30;

    if (isTarget) {
        screen.innerHTML = `
            <h2 class="mg-player-title">\u{1F526} You're in the Spotlight!</h2>
            <p class="mg-player-desc">Defend yourself! Others will judge you.</p>
            <div class="mg-alibi-timer" id="mg-alibi-timer">${timerSecs}</div>
            <p class="mg-player-status">Speak now \u2014 convince them you're innocent!</p>
        `;
        startMiniGameTimer(timerSecs, document.getElementById('mg-alibi-timer'));
    } else {
        screen.innerHTML = `
            <h2 class="mg-player-title">\u{1F526} Alibi Challenge</h2>
            <p class="mg-player-desc"><strong>${escapeHtml(targetName)}</strong> is defending themselves.</p>
            <div class="mg-alibi-timer" id="mg-alibi-timer">${timerSecs}</div>
            <p class="mg-player-desc">Do you believe them?</p>
            <div class="mg-alibi-vote-btns">
                <button class="mg-btn mg-btn-thumbsup" id="mg-thumbsup">\u{1F44D}<br>Believe</button>
                <button class="mg-btn mg-btn-thumbsdown" id="mg-thumbsdown">\u{1F44E}<br>Doubt</button>
            </div>
            <p class="mg-player-status" id="mg-alibi-status"></p>
        `;

        startMiniGameTimer(timerSecs, document.getElementById('mg-alibi-timer'));

        document.getElementById('mg-thumbsup').addEventListener('click', () => {
            sendMiniGameAction('alibi_challenge', { vote: 'thumbs_up' });
            disableMgButtons(screen);
            document.getElementById('mg-alibi-status').textContent = 'You voted \u{1F44D}. Waiting\u2026';
        });

        document.getElementById('mg-thumbsdown').addEventListener('click', () => {
            sendMiniGameAction('alibi_challenge', { vote: 'thumbs_down' });
            disableMgButtons(screen);
            document.getElementById('mg-alibi-status').textContent = 'You voted \u{1F44E}. Waiting\u2026';
        });
    }
}

// --- Interrogation ---

function renderInterrogationPrompt(screen, prompt) {
    const role = prompt.role; // 'interrogator' or 'target'
    const otherName = prompt.other_name || 'a player';
    const maxQuestions = prompt.max_questions || 3;

    if (role === 'interrogator') {
        let questionsAsked = 0;

        screen.innerHTML = `
            <h2 class="mg-player-title">\u{1F50E} Interrogation</h2>
            <p class="mg-player-desc">Ask <strong>${escapeHtml(otherName)}</strong> up to ${maxQuestions} yes/no questions.</p>
            <div class="mg-int-input-area">
                <input type="text" class="mg-int-input" id="mg-int-input" placeholder="Type a yes/no question\u2026" maxlength="200">
                <button class="btn-primary" id="mg-int-ask">Ask</button>
            </div>
            <p class="mg-player-status" id="mg-int-status">Questions remaining: ${maxQuestions}</p>
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
                ? `Questions remaining: ${remaining}`
                : 'All questions asked. Waiting for answers\u2026';
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
            <h2 class="mg-player-title">\u{1F3AF} You're Being Interrogated</h2>
            <p class="mg-player-desc"><strong>${escapeHtml(otherName)}</strong> is questioning you.</p>
            <div class="mg-int-question-display" id="mg-int-question">Waiting for question\u2026</div>
            <div class="mg-int-answer-btns hidden" id="mg-int-answer-btns">
                <button class="mg-btn mg-btn-yes" id="mg-int-yes">\u2705<br>Yes</button>
                <button class="mg-btn mg-btn-no" id="mg-int-no">\u274C<br>No</button>
            </div>
            <p class="mg-player-status" id="mg-int-status">Waiting for questions\u2026</p>
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

    display.textContent = `Q${questionNum}: ${question}`;
    btns.classList.remove('hidden');

    const yesBtn = document.getElementById('mg-int-yes');
    const noBtn = document.getElementById('mg-int-no');

    const handler = (answer) => {
        sendMiniGameAction('interrogation', { answer, question_number: questionNum });
        btns.classList.add('hidden');
        document.getElementById('mg-int-status').textContent = `Answered Q${questionNum}. Waiting\u2026`;
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
