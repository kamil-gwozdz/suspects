const ws = new WsClient('/ws/host');
let roomCode = null;
let players = [];
let timerInterval = null;

// DOM elements
const lobbyScreen = document.getElementById('lobby-screen');
const gameScreen = document.getElementById('game-screen');
const createRoomBtn = document.getElementById('create-room-btn');
const startGameBtn = document.getElementById('start-game-btn');
const roomInfo = document.getElementById('room-info');
const languageSelect = document.getElementById('language-select');

createRoomBtn.addEventListener('click', () => {
    ws.send({ type: 'create_room', payload: { language: languageSelect.value } });
    createRoomBtn.disabled = true;
});

startGameBtn.addEventListener('click', () => {
    ws.send({ type: 'start_game' });
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
        case 'game_over':
            handleGameOver(msg.payload);
            break;
        case 'error':
            showError(msg.payload.message);
            break;
    }
});

function handleRoomCreated({ room_code, room_url }) {
    roomCode = room_code;
    document.getElementById('room-code-display').textContent = room_code;
    
    const fullUrl = `${window.location.origin}${room_url}`;
    document.getElementById('join-url').textContent = fullUrl;

    // Generate QR code
    const qrContainer = document.getElementById('qr-code');
    qrContainer.innerHTML = '';
    QRCode.toCanvas(fullUrl, { width: 200, margin: 2, color: { dark: '#e74c3c', light: '#0a0a0f' } }, (err, canvas) => {
        if (!err) qrContainer.appendChild(canvas);
    });

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
    if (phase !== 'lobby' && phase !== 'role_reveal') {
        lobbyScreen.classList.remove('active');
        gameScreen.classList.add('active');
    }

    document.getElementById('round-number').textContent = round;
    document.getElementById('phase-display').textContent = formatPhase(phase);

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

    // Start timer
    if (timer_secs > 0) startTimer(timer_secs);
}

function handleNightResults({ killed, saved, events }) {
    const container = document.getElementById('death-announcements');
    container.innerHTML = '';

    if (killed.length === 0) {
        container.innerHTML = '<p class="no-deaths">No one was killed last night.</p>';
    } else {
        killed.forEach(p => {
            const el = document.createElement('div');
            el.className = 'death-announcement';
            el.innerHTML = `<span class="death-name">${escapeHtml(p.name)}</span> was found dead.`;
            container.appendChild(el);
        });
    }
}

function handleVoteUpdate({ votes }) {
    const container = document.getElementById('vote-bars');
    const voteCounts = {};
    votes.forEach(v => {
        if (v.target_id) {
            voteCounts[v.target_id] = (voteCounts[v.target_id] || 0) + 1;
        }
    });

    const maxVotes = Math.max(1, ...Object.values(voteCounts));
    container.innerHTML = Object.entries(voteCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([id, count]) => {
            const player = players.find(p => p.id === id);
            const name = player ? player.name : '???';
            const width = (count / maxVotes * 100);
            return `<div class="vote-bar">
                <span class="vote-bar-name">${escapeHtml(name)}</span>
                <div class="vote-bar-fill" style="width:${width}%"></div>
                <span class="vote-bar-count">${count}</span>
            </div>`;
        }).join('');
}

function handleVoteResult({ target, was_lynched }) {
    const msg = document.getElementById('execution-message');
    if (was_lynched && target) {
        msg.textContent = `${target.name} has been eliminated by the town.`;
    } else {
        msg.textContent = 'The town could not reach a decision. No one was eliminated.';
    }
}

function handleGameOver({ winner, player_roles }) {
    document.getElementById('gameover-message').textContent = `${winner} wins!`;
    const container = document.getElementById('role-reveals');
    container.innerHTML = player_roles.map(p =>
        `<div class="role-reveal-card ${p.alive ? '' : 'dead'}">
            <div class="player-name">${escapeHtml(p.player_name)}</div>
            <div class="role-name">${p.role}</div>
            <div>${p.alive ? '✓ Alive' : '✗ Dead'}</div>
        </div>`
    ).join('');
}

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

function showError(message) {
    console.error('Server error:', message);
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
