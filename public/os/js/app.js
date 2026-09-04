// app.js - Main Application Orchestrator for Ravena Desktop OS

const RavenaOS = {
    state: {
        healthData: null,
        donationsData: null,
        recentDonations: null,
        statsData: null,
        serviceStatus: {
            whatsgoapi: 'unknown',
            imagine: 'unknown',
            llm: 'unknown',
            whisper: 'unknown',
            f5tts: 'unknown'
        },
        messageTimestamps: [],
        botMessageTimestamps: {},
        averageMsgsHr: 0,
        hasInitializedRealtime: false,
        sseSource: null,
        isMobile: false
    },
    listeners: {},

    on(event, callback) {
        if (!this.listeners[event]) this.listeners[event] = [];
        this.listeners[event].push(callback);
    },

    emit(event, data) {
        if (this.listeners[event]) {
            this.listeners[event].forEach(cb => {
                try { cb(data); } catch (e) { console.error(`Error in event listener for ${event}:`, e); }
            });
        }
    },

    async init() {
        this.state.isMobile = window.innerWidth < 768;

        // Initialize UI components
        if (this.state.isMobile) {
            document.getElementById('mobile-app')?.classList.remove('hidden');
            if (window.MobileApp) window.MobileApp.init();
        } else {
            if (window.Desktop) window.Desktop.init();
            if (window.Taskbar) window.Taskbar.init();
            if (window.ContextMenu) window.ContextMenu.init();
            if (window.CursorTrail) window.CursorTrail.init();
            this.initDesktopDonatesWidget();
        }

        // Initialize Canvas Matrix Background
        this.initMatrixBackground();

        // Connect SSE stream for real-time events
        this.connectSSE();

        // Initial Data Fetch
        await Promise.allSettled([
            this.fetchHealth(),
            this.fetchDonations(),
            this.fetchRecentDonations(),
            this.fetchServicesStatus()
        ]);

        // Auto-open windows on desktop: Status (top-left, shifted right) and Mensagímetro (bottom-right)
        if (!this.state.isMobile && window.WindowManager) {
            setTimeout(() => {
                // Open Status das Ravenas
                window.WindowManager.open('status');

                // Open Mensagímetro positioned safely in the bottom-right corner inside the screen
                const screenW = window.innerWidth;
                const screenH = window.innerHeight;
                const speedoW = 420;
                const speedoH = 400;
                const speedoX = Math.max(260, screenW - speedoW - 30);
                const speedoY = Math.max(20, screenH - speedoH - 60);

                window.WindowManager.open('speedometer', {
                    width: `${speedoW}px`,
                    height: `${speedoH}px`,
                    x: `${speedoX}px`,
                    y: `${speedoY}px`
                });
            }, 100);
        }

        // Periodic update timers
        setInterval(() => this.fetchHealth(), 30000);
        setInterval(() => this.fetchDonations(), 300000);
        setInterval(() => this.fetchRecentDonations(), 300000);
        setInterval(() => this.updateRealtimeCounters(), 1000);

        // Window resize handler (handling desktop <-> mobile transitions)
        window.addEventListener('resize', () => {
            const wasMobile = this.state.isMobile;
            this.state.isMobile = window.innerWidth < 768;
            if (wasMobile !== this.state.isMobile) {
                if (this.state.isMobile) {
                    document.getElementById('mobile-app')?.classList.remove('hidden');
                    document.getElementById('desktop')?.classList.add('hidden');
                    document.getElementById('taskbar')?.classList.add('hidden');
                    if (window.MobileApp) window.MobileApp.init();
                } else {
                    document.getElementById('mobile-app')?.classList.add('hidden');
                    document.getElementById('desktop')?.classList.remove('hidden');
                    document.getElementById('taskbar')?.classList.remove('hidden');
                    if (window.Desktop) window.Desktop.init();
                    if (window.Taskbar) window.Taskbar.init();
                    if (window.CursorTrail) window.CursorTrail.init();
                    this.initDesktopDonatesWidget();
                }
            }
        });
    },

    initDesktopDonatesWidget() {
        let el = document.getElementById('desktop-donates-widget');
        if (!el) {
            el = document.createElement('div');
            el.id = 'desktop-donates-widget';
            el.className = 'desktop-widget-donates';
            el.title = 'Clique para abrir o painel completo de doações';
            document.body.appendChild(el);

            el.addEventListener('click', (e) => {
                e.stopPropagation();
                WindowManager.open('donations');
            });
        }

        this.updateDesktopDonatesWidget();
        this.on('recentDonationsUpdate', () => this.updateDesktopDonatesWidget());
        this.on('donationsUpdate', () => this.updateDesktopDonatesWidget());
    },

    updateDesktopDonatesWidget() {
        const el = document.getElementById('desktop-donates-widget');
        if (!el || this.state.isMobile) return;

        const recent = this.state.recentDonations;
        const total = recent ? (recent.totalRecentAmount || 0) : 0;
        const pct = Math.min(100, Math.floor((total / 150) * 100));

        let donors = (recent && recent.topRecentDonors) || this.state.donationsData || [];
        donors = donors.slice(0, 5);

        let listHtml = '';
        if (donors.length === 0) {
            listHtml = '<div style="font-size: 10px; color: #888; text-align: center; padding: 6px;">Carregando doadores...</div>';
        } else {
            listHtml = donors.map((d, i) => {
                const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '•';
                return `
                    <div class="widget-postit-item">
                        <span class="widget-postit-name">
                            <span>${medal}</span>
                            <span title="${d.nome}">${d.nome}</span>
                        </span>
                        <span class="widget-postit-val">${Formatters.currency(d.valor)}</span>
                    </div>
                `;
            }).join('');
        }

        el.innerHTML = `
            <div class="widget-postit-header">
                <span class="widget-postit-title">📌 Top Doadores</span>
                <span style="font-size: 10px; color: var(--gold-color); font-weight: 700;">!doar</span>
            </div>
            <div class="widget-postit-meta">
                Meta 3 Meses: <strong>${Formatters.currency(total)}</strong> (${pct}%)
            </div>
            <div class="widget-postit-list">
                ${listHtml}
            </div>
            <div class="widget-postit-footer">
                <span>Ver ranking completo</span>
                <i class="fas fa-arrow-right"></i>
            </div>
        `;
    },

    connectSSE() {
        if (typeof EventSource === 'undefined') {
            console.warn('SSE not supported on this browser.');
            return;
        }

        try {
            this.state.sseSource = new EventSource('/api/stream');

            this.state.sseSource.addEventListener('service-status', (e) => {
                try {
                    const status = JSON.parse(e.data);
                    this.state.serviceStatus = status;
                    this.emit('serviceStatusUpdate', status);
                } catch (err) {
                    console.error('Error parsing service-status event:', err);
                }
            });

            this.state.sseSource.addEventListener('activity', (e) => {
                try {
                    const data = JSON.parse(e.data);
                    const now = Date.now();

                    this.state.messageTimestamps.push(now);

                    if (data.botId) {
                        if (!this.state.botMessageTimestamps[data.botId]) {
                            this.state.botMessageTimestamps[data.botId] = [];
                        }
                        this.state.botMessageTimestamps[data.botId].push(now);
                    }

                    this.emit('activity', data);
                } catch (err) {
                    console.error('Error parsing activity event:', err);
                }
            });

            this.state.sseSource.onerror = () => {
                // EventSource will automatically retry connecting
            };
        } catch (err) {
            console.error('Failed to initialize EventSource:', err);
        }
    },

    async fetchHealth() {
        try {
            const data = await Api.get('/health');
            this.state.healthData = data;
            this.state.isAdmin = !!data.isAdmin;

            // Compute total msgs/hr
            let totalMsgsHr = 0;
            const now = Date.now();
            if (data.bots && Array.isArray(data.bots)) {
                data.bots.forEach(bot => {
                    const msgs = Math.round(bot.msgsHr || 0);
                    totalMsgsHr += msgs;

                    if (!this.state.botMessageTimestamps[bot.id]) {
                        this.state.botMessageTimestamps[bot.id] = [];
                        const initialCount = Math.round(msgs / 60);
                        for (let i = 0; i < initialCount; i++) {
                            this.state.botMessageTimestamps[bot.id].push(now - Math.floor(Math.random() * 60000));
                        }
                    }
                });
            }

            this.state.averageMsgsHr = totalMsgsHr;

            if (!this.state.hasInitializedRealtime) {
                const initialCount = Math.round(totalMsgsHr / 60);
                this.state.messageTimestamps = [];
                for (let i = 0; i < initialCount; i++) {
                    this.state.messageTimestamps.push(now - Math.floor(Math.random() * 60000));
                }
                this.state.hasInitializedRealtime = true;
            }

            this.emit('healthUpdate', data);
            return data;
        } catch (err) {
            console.error('Error fetching health data:', err);
        }
    },

    async fetchDonations() {
        try {
            const data = await Api.get('/top-donates');
            this.state.donationsData = data;
            this.emit('donationsUpdate', data);
            return data;
        } catch (err) {
            console.error('Error fetching top donates:', err);
        }
    },

    async fetchRecentDonations() {
        try {
            const data = await Api.get('/recent-top-donates');
            this.state.recentDonations = data;
            this.emit('recentDonationsUpdate', data);
            return data;
        } catch (err) {
            console.error('Error fetching recent top donates:', err);
        }
    },

    async fetchServicesStatus() {
        try {
            const data = await Api.get('/api/services/status');
            this.state.serviceStatus = data;
            this.emit('serviceStatusUpdate', data);
            return data;
        } catch (err) {
            console.error('Error fetching services status:', err);
        }
    },

    updateRealtimeCounters() {
        const now = Date.now();
        this.state.messageTimestamps = this.state.messageTimestamps.filter(t => now - t <= 60000);
        const realtimeRate = this.state.messageTimestamps.length * 60;

        for (const [botId, timestamps] of Object.entries(this.state.botMessageTimestamps)) {
            this.state.botMessageTimestamps[botId] = timestamps.filter(t => now - t <= 60000);
        }

        this.emit('realtimeRate', realtimeRate);
    },

    initMatrixBackground() {
        const canvas = document.getElementById('matrix-bg');
        if (!canvas) return;

        const ctx = canvas.getContext('2d');
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;

        const fontSize = 15;
        let columns = Math.ceil(canvas.width / fontSize);

        let codeSnippets = [
            "RAVENA", "SYSTEM", "ONLINE", "010101", "NODEJS",
            "WHATSAPP", "CYBERPUNK", "MATRIX", "BOTAPI", "MOOTHZ"
        ];

        fetch('/code-snippets.json')
            .then(r => r.json())
            .then(data => { if (Array.isArray(data) && data.length > 0) codeSnippets = data; })
            .catch(() => {});

        let columnState = [];
        const initColumns = () => {
            columns = Math.ceil(canvas.width / fontSize);
            columnState = [];
            for (let x = 0; x < columns; x++) {
                columnState[x] = {
                    y: Math.floor(Math.random() * -40),
                    text: codeSnippets[Math.floor(Math.random() * codeSnippets.length)],
                    charIdx: 0
                };
            }
        };

        initColumns();

        ctx.fillStyle = "#05060d";
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        let lastDraw = 0;

        const draw = (timestamp) => {
            const count = this.state.messageTimestamps ? this.state.messageTimestamps.length : 0;
            const currentMsgsHr = count * 60;
            const minMsgs = 500;
            const maxMsgs = 20000;

            let factor = (currentMsgsHr - minMsgs) / (maxMsgs - minMsgs);
            if (factor < 0) factor = 0;
            if (factor > 1) factor = 1;

            const minDelay = 20;
            const maxDelay = 70;
            const delay = maxDelay - (factor * (maxDelay - minDelay));

            if (timestamp - lastDraw < delay) {
                requestAnimationFrame(draw);
                return;
            }
            lastDraw = timestamp;

            ctx.fillStyle = "rgba(5, 6, 13, 0.06)";
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            ctx.fillStyle = "#04a9f0";
            ctx.font = fontSize + "px monospace";

            for (let i = 0; i < columnState.length; i++) {
                const state = columnState[i];
                if (!state) continue;

                const char = state.text.charAt(state.charIdx % state.text.length);
                ctx.fillText(char, i * fontSize, state.y * fontSize);

                if (state.y * fontSize > canvas.height && Math.random() > 0.975) {
                    state.y = 0;
                    state.charIdx = 0;
                    state.text = codeSnippets[Math.floor(Math.random() * codeSnippets.length)];
                }

                state.y++;
                state.charIdx++;
            }

            requestAnimationFrame(draw);
        };

        requestAnimationFrame(draw);

        window.addEventListener('resize', () => {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
            initColumns();
        });
    }
};

window.RavenaOS = RavenaOS;

document.addEventListener('DOMContentLoaded', () => {
    RavenaOS.init();
});
