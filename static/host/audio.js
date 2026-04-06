// ═══════════════════════════════════════
// AudioManager — GM narration playback
// ═══════════════════════════════════════

class AudioManager {
    constructor() {
        this._cache = new Map();   // key → HTMLAudioElement
        this._current = null;      // currently playing Audio
        this._volume = 0.8;
        this._fadeDuration = 200;  // ms for fade-in / fade-out
    }

    // Load manifest.json and preload every listed audio file into Audio objects
    async preloadFromManifest(manifestUrl) {
        let manifest;
        try {
            const res = await fetch(manifestUrl);
            if (!res.ok) return;
            manifest = await res.json();
        } catch {
            // Manifest missing or unparseable — text-only mode
            return;
        }

        const files = manifest.files || {};
        const promises = Object.entries(files).map(([key, path]) => this._preload(key, path));
        await Promise.allSettled(promises);
    }

    _preload(key, path) {
        return new Promise((resolve) => {
            const audio = new Audio(path);
            audio.preload = 'auto';
            audio.volume = 0;                   // will fade in on play
            audio.addEventListener('canplaythrough', () => {
                this._cache.set(key, audio);
                resolve();
            }, { once: true });
            audio.addEventListener('error', () => {
                // File missing / undecodable — skip silently
                resolve();
            }, { once: true });
            audio.load();
        });
    }

    // Play a narration line by key. Returns a Promise that resolves when done.
    async play(key) {
        if (!this.has(key)) return;             // graceful text-only fallback

        // Stop anything currently playing
        await this._fadeOut();

        const audio = this._cache.get(key);
        audio.currentTime = 0;
        audio.volume = 0;

        const playPromise = new Promise((resolve) => {
            const onEnd = () => {
                audio.removeEventListener('ended', onEnd);
                this._fadeOut().then(resolve);
            };
            audio.addEventListener('ended', onEnd);
        });

        audio.play().catch(() => {});           // autoplay may be blocked
        await this._fadeIn(audio);
        return playPromise;
    }

    stop() {
        if (this._current) {
            this._current.pause();
            this._current.currentTime = 0;
            this._current.volume = 0;
            this._current = null;
        }
    }

    setVolume(vol) {
        this._volume = Math.max(0, Math.min(1, vol));
        if (this._current) {
            this._current.volume = this._volume;
        }
    }

    has(key) {
        return this._cache.has(key);
    }

    // ── Fade helpers ──

    _fadeIn(audio) {
        this._current = audio;
        return this._fade(audio, 0, this._volume, this._fadeDuration);
    }

    _fadeOut() {
        const audio = this._current;
        if (!audio || audio.paused) {
            this._current = null;
            return Promise.resolve();
        }
        return this._fade(audio, audio.volume, 0, this._fadeDuration).then(() => {
            audio.pause();
            this._current = null;
        });
    }

    _fade(audio, from, to, duration) {
        return new Promise((resolve) => {
            const steps = 20;
            const interval = duration / steps;
            const delta = (to - from) / steps;
            let step = 0;
            audio.volume = from;
            const id = setInterval(() => {
                step++;
                audio.volume = Math.max(0, Math.min(1, from + delta * step));
                if (step >= steps) {
                    clearInterval(id);
                    audio.volume = Math.max(0, Math.min(1, to));
                    resolve();
                }
            }, interval);
        });
    }
}
