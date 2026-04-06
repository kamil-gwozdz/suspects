const ws = new WsClient('/ws/host');
let roomCode = null;
let players = [];
let alivePlayers = [];
let timerInterval = null;
let previousVoteCounts = {};

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
        case 'alive_player_list':
            handleAlivePlayerList(msg.payload);
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

    // Reset vote state when entering voting phase
    if (phase === 'voting') {
        previousVoteCounts = {};
        document.getElementById('vote-bars').innerHTML = '';
        const counter = document.getElementById('votes-cast-counter');
        if (counter) counter.textContent = '';
    }

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
    alivePlayers = aliveList;
    const ul = document.getElementById('alive-list');
    if (ul) {
        ul.innerHTML = aliveList.map(p =>
            `<li${p.alive ? '' : ' class="dead"'}>${escapeHtml(p.name)}</li>`
        ).join('');
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
