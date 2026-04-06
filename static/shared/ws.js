class WsClient {
    constructor(path) {
        this.path = path;
        this.handlers = [];
        this.stateHandlers = [];
        this.ws = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.connected = false;
        this._hasConnectedOnce = false;
        this.connect();
    }

    connect() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const url = `${protocol}//${window.location.host}${this.path}`;
        this.ws = new WebSocket(url);

        this.ws.onopen = () => {
            console.log('WebSocket connected');
            this.connected = true;
            this.reconnectAttempts = 0;
            this._notifyState('connected');

            // On reconnect, automatically send Reconnect message if we have stored session
            if (this._hasConnectedOnce) {
                const storedPlayerId = localStorage.getItem('suspects_player_id');
                const storedRoomCode = localStorage.getItem('suspects_room_code');
                if (storedPlayerId && storedRoomCode) {
                    console.log('Attempting reconnect with stored session');
                    this.send({
                        type: 'reconnect',
                        payload: { player_id: storedPlayerId, room_code: storedRoomCode }
                    });
                }
            }
            this._hasConnectedOnce = true;
        };

        this.ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                this.handlers.forEach(fn => fn(msg));
            } catch (e) {
                console.error('Failed to parse message:', e);
            }
        };

        this.ws.onclose = () => {
            console.log('WebSocket disconnected');
            this.connected = false;
            this._notifyState('disconnected');
            this.tryReconnect();
        };

        this.ws.onerror = (err) => {
            console.error('WebSocket error:', err);
        };
    }

    tryReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) return;
        this.reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
        console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
        this._notifyState('reconnecting');
        setTimeout(() => this.connect(), delay);
    }

    send(msg) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(msg));
        } else {
            console.warn('WebSocket not connected, message not sent:', msg);
        }
    }

    onMessage(fn) {
        this.handlers.push(fn);
    }

    onStateChange(fn) {
        this.stateHandlers.push(fn);
    }

    _notifyState(state) {
        this.stateHandlers.forEach(fn => fn(state));
    }
}
