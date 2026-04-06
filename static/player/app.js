const params = new URLSearchParams(window.location.search);
const roomCode = params.get('room');
const ws = new WsClient('/ws/player');

let playerId = null;
let playerRole = null;
let playerFaction = null;
let selectedTarget = null;
let timerInterval = null;

// Restore saved name from localStorage
const savedName = localStorage.getItem('suspects_player_name');

// DOM
const joinScreen = document.getElementById('join-screen');
const waitingScreen = document.getElementById('waiting-screen');
const roleScreen = document.getElementById('role-screen');
const nightScreen = document.getElementById('night-screen');
const dayScreen = document.getElementById('day-screen');
const voteScreen = document.getElementById('vote-screen');
const deadScreen = document.getElementById('dead-screen');
const gameoverScreen = document.getElementById('gameover-player-screen');

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
        selectedTarget = null;
    }
});

skipActionBtn.addEventListener('click', () => {
    ws.send({ type: 'night_action', payload: { target_id: null, secondary_target_id: null } });
});

castVoteBtn.addEventListener('click', () => {
    ws.send({ type: 'vote', payload: { target_id: selectedTarget } });
    castVoteBtn.disabled = true;
});

skipVoteBtn.addEventListener('click', () => {
    ws.send({ type: 'vote', payload: { target_id: null } });
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
        case 'error':
            handleError(msg.payload);
            break;
    }
});

function showScreen(screen) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    screen.classList.add('active');
}

function handleJoined({ player_id }) {
    playerId = player_id;
    document.getElementById('waiting-name').textContent = nameInput.value.trim();
    showScreen(waitingScreen);
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
            break; // Vote targets come via alive_player_list
        case 'execution':
            break;
        case 'game_over':
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
    showScreen(gameoverScreen);
}

function handleError({ message }) {
    const errEl = document.getElementById('join-error');
    errEl.textContent = message;
    errEl.classList.remove('hidden');
    joinBtn.disabled = false;
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
