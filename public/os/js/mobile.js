// mobile.js - Smartphone OS Experience for RavenaBot (< 768px)

const MobileApp = {
    apps: [
        { id: 'status',     label: 'Status',       icon: 'img/icons/status.png',     window: 'status',     iconFa: 'fa-desktop' },
        { id: 'donations',  label: 'Doações',      icon: 'img/icons/donations.png',  window: 'donations',  iconFa: 'fa-heart' },
        { id: 'community',  label: 'Comunidade',   icon: 'img/icons/community.png',  window: 'community',  iconFa: 'fa-users' },
        { id: 'statistics', label: 'Estatísticas', icon: 'img/icons/statistics.png', window: 'statistics', iconFa: 'fa-chart-bar' },
        { id: 'help',       label: 'Ajuda',        icon: 'img/icons/help.png',       window: 'help',       iconFa: 'fa-question-circle' },
        { id: 'imagine',    label: 'Imagine',      icon: 'img/icons/imagine.png',    window: 'imagine',    iconFa: 'fa-palette' },
        { id: 'tts',        label: 'TTS',          icon: 'img/icons/tts.png',        window: 'tts',        iconFa: 'fa-volume-up' },
        { id: 'stt',        label: 'STT',          icon: 'img/icons/stt.png',        window: 'stt',        iconFa: 'fa-microphone' },
        { id: 'fishing',    label: 'Pesca',        icon: 'img/icons/fishing.png',    window: 'fishing',    iconFa: 'fa-fish' },
        { id: 'invite',     label: 'Quero Uma!',   icon: 'img/icons/invite.png',     window: 'invite',     iconFa: 'fa-envelope' },
        { id: 'github',     label: 'GitHub',       icon: 'img/icons/github.png',     url: 'https://github.com/moothz/ravena-ai', iconFa: 'fab fa-github' },
        { id: 'reload',     label: 'Recarregar',   action: 'reload',                 iconFa: 'fa-rotate-right' }
    ],

    appStack: [],
    currentAppId: null,
    currentHost: null,
    hasSubscribed: false,
    autoOpenTimer: null,

    init() {
        const app = document.getElementById('mobile-app');
        if (!app) return;
        app.classList.remove('hidden');

        app.innerHTML = `
            <!-- Top Header (Logo + Title + Rate Widget) -->
            <header class="mobile-header">
                <div class="mobile-header-brand">
                    <img src="/android-chrome-192x192.png" class="mobile-logo" alt="RavenaBot">
                    <div class="mobile-title-group">
                        <span class="mobile-title">RavenaBot</span>
                        <span class="mobile-subtitle">Painel de Monitoramento</span>
                    </div>
                </div>
                <div class="mobile-header-rate" id="mobile-msgs-rate" title="Clique para abrir o mensagímetro">
                    <span class="mobile-rate-number" id="mobile-rate-val">0</span>
                    <span class="mobile-rate-unit">msgs/h</span>
                </div>
            </header>

            <!-- Microservices Status Pills -->
            <div class="mobile-services" id="mobile-services-container">
                <div class="mobile-service-pill"><span class="service-status-dot dot-unknown"></span> WhatsGo</div>
                <div class="mobile-service-pill"><span class="service-status-dot dot-unknown"></span> Imagine</div>
                <div class="mobile-service-pill"><span class="service-status-dot dot-unknown"></span> LLM</div>
                <div class="mobile-service-pill"><span class="service-status-dot dot-unknown"></span> Whisper</div>
                <div class="mobile-service-pill"><span class="service-status-dot dot-unknown"></span> F5-TTS</div>
            </div>

            <!-- Middle Content Area (No page scroll) -->
            <div class="mobile-content-area">
                <!-- Home Screen View -->
                <div class="mobile-home" id="mobile-home">
                    <!-- 4-Column Smartphone App Grid -->
                    <div class="mobile-app-grid" id="mobile-app-grid"></div>

                    <!-- Recent Donations Card Widget -->
                    <div class="mobile-donations-card" id="mobile-donations-card" title="Clique para ver detalhes de doações">
                        <div class="mobile-donations-header">
                            <span class="mobile-donations-title">
                                <i class="fas fa-heart" style="color: #ff4081;"></i> Doações Recentes
                            </span>
                            <a href="https://tipa.ai/moothz" target="_blank" class="mobile-donate-btn" onclick="event.stopPropagation();">
                                <i class="fas fa-heart"></i> Doar
                            </a>
                        </div>
                        <div class="mobile-donations-meta" id="mobile-donations-meta">
                            Carregando meta...
                        </div>
                        <div class="mobile-donors-mini-list" id="mobile-donors-mini-list">
                            <div style="font-size: 10px; color: #888; text-align: center; padding: 4px;">Carregando apoiadores...</div>
                        </div>
                    </div>
                </div>

                <!-- Open App Screen View (Window Aesthetic - Scroll only inside body) -->
                <div class="mobile-app-view hidden" id="mobile-app-view">
                    <div class="mobile-window-card" id="mobile-window-card">
                        <div class="mobile-window-header">
                            <div class="mobile-window-title-wrap">
                                <i class="mobile-window-icon fas fa-window-maximize" id="mobile-win-icon"></i>
                                <span class="mobile-window-title" id="mobile-win-title">Carregando...</span>
                            </div>
                            <button class="mobile-window-close-btn" id="mobile-win-close-btn" title="Fechar Janela" aria-label="Fechar">
                                <i class="fas fa-times"></i>
                            </button>
                        </div>
                        <div class="mobile-window-body" id="mobile-win-body">
                            <!-- App Window Content will be injected here -->
                        </div>
                    </div>

                    <!-- Navigation FAB: Return to Home / Close App -->
                    <div class="mobile-home-bar">
                        <button class="mobile-home-fab" id="mobile-home-fab" title="Retornar para o Início">
                            <i class="fas fa-times"></i>
                            <span>Fechar App</span>
                        </button>
                    </div>
                </div>
            </div>
        `;

        // Render App Grid Icons
        this.renderAppGrid();

        // Attach UI Listeners
        const rateWidget = document.getElementById('mobile-msgs-rate');
        if (rateWidget) {
            rateWidget.addEventListener('click', () => {
                this.openApp('speedometer');
            });
        }

        const donatesCard = document.getElementById('mobile-donations-card');
        if (donatesCard) {
            donatesCard.addEventListener('click', () => {
                this.openApp('donations');
            });
        }

        const closeBtn = document.getElementById('mobile-win-close-btn');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => this.closeApp());
        }

        const homeFab = document.getElementById('mobile-home-fab');
        if (homeFab) {
            homeFab.addEventListener('click', () => this.closeApp());
        }

        // Subscribe to events once
        if (window.RavenaOS && !this.hasSubscribed) {
            this.hasSubscribed = true;
            window.RavenaOS.on('serviceStatusUpdate', (s) => this.renderServices(s));
            window.RavenaOS.on('recentDonationsUpdate', (d) => this.renderDonations(d));
            window.RavenaOS.on('donationsUpdate', () => this.renderDonations(window.RavenaOS.state.recentDonations));
            window.RavenaOS.on('realtimeRate', (rate) => this.updateMsgsWidget(rate));
        }

        // Render initial state if available
        if (window.RavenaOS) {
            if (window.RavenaOS.state.serviceStatus) this.renderServices(window.RavenaOS.state.serviceStatus);
            if (window.RavenaOS.state.recentDonations) this.renderDonations(window.RavenaOS.state.recentDonations);
            const initialRate = window.RavenaOS.state.messageTimestamps ? window.RavenaOS.state.messageTimestamps.length * 60 : 0;
            this.updateMsgsWidget(initialRate || window.RavenaOS.state.averageMsgsHr || 0);
        }

        // Auto-open status app after 1 second
        if (this.autoOpenTimer) clearTimeout(this.autoOpenTimer);
        this.autoOpenTimer = setTimeout(() => {
            if (!this.currentAppId) {
                this.openApp('status');
            }
        }, 1000);
    },

    renderAppGrid() {
        const grid = document.getElementById('mobile-app-grid');
        if (!grid) return;

        grid.innerHTML = this.apps.map(app => {
            const iconContent = app.icon
                ? `<img src="${app.icon}" alt="${app.label}" draggable="false" loading="lazy" onerror="this.onerror=null;this.parentElement.innerHTML='<i class=\\'fas ${app.iconFa || 'fa-cubes'}\\'></i>';">`
                : `<i class="fas ${app.iconFa || 'fa-rotate-right'}" style="font-size: 24px; color: var(--cyan-neon);"></i>`;

            return `
                <button class="mobile-app-icon" data-app-id="${app.id}" data-action="${app.action || ''}" data-window="${app.window || ''}" data-url="${app.url || ''}" title="${app.label}">
                    <div class="mobile-app-img-wrap">
                        ${iconContent}
                    </div>
                    <span class="mobile-app-label">${app.label}</span>
                </button>
            `;
        }).join('');

        grid.querySelectorAll('.mobile-app-icon').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const action = btn.dataset.action;
                const url = btn.dataset.url;
                const win = btn.dataset.window;
                if (action === 'reload') {
                    window.location.reload();
                } else if (url) {
                    window.open(url, '_blank');
                } else if (win) {
                    this.openApp(win);
                }
            });
        });
    },

    openApp(appId, params = {}) {
        if (this.autoOpenTimer) {
            clearTimeout(this.autoOpenTimer);
            this.autoOpenTimer = null;
        }

        // Maintain navigation stack: push only if not already top
        if (this.appStack.length === 0 || this.appStack[this.appStack.length - 1] !== appId) {
            this.appStack.push(appId);
        }

        this._renderAppContent(appId, params);
    },

    _renderAppContent(appId, params = {}) {
        const homeEl = document.getElementById('mobile-home');
        const appViewEl = document.getElementById('mobile-app-view');
        const bodyEl = document.getElementById('mobile-win-body');
        const titleEl = document.getElementById('mobile-win-title');
        const iconEl = document.getElementById('mobile-win-icon');

        if (!appViewEl || !bodyEl) return;

        // Cleanup previous app if open
        if (this.currentHost && typeof this.currentHost.onclose === 'function') {
            try { this.currentHost.onclose(); } catch (err) { console.error('Error in previous app onclose:', err); }
        }

        const config = (window.WindowManager && window.WindowManager.configs[appId]) || {};
        const title = (params && params.title) || config.title || appId;
        const icon = (params && params.taskbarIcon) || config.taskbarIcon || 'fa-window-maximize';

        if (titleEl) titleEl.textContent = title;
        if (iconEl) iconEl.className = `mobile-window-icon fas ${icon}`;

        bodyEl.scrollTop = 0;
        bodyEl.innerHTML = `
            <div style="text-align: center; padding: 30px;">
                <i class="fas fa-spinner fa-spin" style="font-size: 22px; color: var(--bright-blue);"></i>
                <p style="margin-top: 10px; font-size: 11px; color: #888;">Carregando...</p>
            </div>
        `;

        const host = {
            body: bodyEl,
            onclose: null,
            setTitle(t) {
                if (titleEl) titleEl.textContent = t;
            },
            close() {
                MobileApp.closeApp();
            }
        };

        this.currentHost = host;
        this.currentAppId = appId;

        // Render app content
        try {
            if (params && typeof params.customRender === 'function') {
                params.customRender(host);
            } else if (typeof config.render === 'function') {
                config.render(host, params);
            }
        } catch (err) {
            console.error(`Error rendering mobile app ${appId}:`, err);
            bodyEl.innerHTML = `
                <div style="padding: 20px; color: #ff5555; text-align: center;">
                    <p>❌ Erro ao renderizar ${title}</p>
                    <p style="font-size: 11px; color: #aaa; margin-top: 8px;">${err.message}</p>
                </div>
            `;
        }

        // Show app view with slide-up
        if (homeEl) homeEl.classList.add('hidden');
        appViewEl.classList.remove('hidden', 'sliding-down');
    },

    closeApp() {
        const homeEl = document.getElementById('mobile-home');
        const appViewEl = document.getElementById('mobile-app-view');
        const bodyEl = document.getElementById('mobile-win-body');

        if (!appViewEl || appViewEl.classList.contains('hidden')) return;

        // Trigger onclose callback if provided
        if (this.currentHost && typeof this.currentHost.onclose === 'function') {
            try { this.currentHost.onclose(); } catch (err) { console.error('Error closing app:', err); }
        }

        // Pop current app from stack
        this.appStack.pop();

        // If another app is still in the stack (e.g. status was open before status-detail)
        if (this.appStack.length > 0) {
            const prevAppId = this.appStack[this.appStack.length - 1];
            this._renderAppContent(prevAppId);
            return;
        }

        // Stack is empty: Return to Home
        appViewEl.classList.add('sliding-down');

        setTimeout(() => {
            appViewEl.classList.add('hidden');
            appViewEl.classList.remove('sliding-down');
            if (bodyEl) bodyEl.innerHTML = '';
            if (homeEl) {
                homeEl.classList.remove('hidden');
                homeEl.scrollTop = 0;
            }

            this.currentAppId = null;
            this.currentHost = null;
            this.appStack = [];
        }, 200);
    },

    updateMsgsWidget(rate) {
        const valEl = document.getElementById('mobile-rate-val');
        if (!valEl) return;
        const rounded = Math.round(rate || 0);
        valEl.textContent = rounded.toLocaleString('pt-BR');
    },

    renderServices(status) {
        const container = document.getElementById('mobile-services-container');
        if (!container || !status) return;

        const getDotClass = (val) => {
            const state = typeof val === 'object' ? (val.status || 'up') : (val || 'unknown');
            if (state === 'up' || state === 'online' || state === 'ok') return 'dot-up';
            if (state === 'down' || state === 'offline') return 'dot-down';
            if (state === 'backup') return 'dot-backup';
            return 'dot-unknown';
        };

        container.innerHTML = `
            <div class="mobile-service-pill"><span class="service-status-dot ${getDotClass(status.whatsgoapi)}"></span> WhatsGo</div>
            <div class="mobile-service-pill"><span class="service-status-dot ${getDotClass(status.imagine)}"></span> Imagine</div>
            <div class="mobile-service-pill"><span class="service-status-dot ${getDotClass(status.llm)}"></span> LLM</div>
            <div class="mobile-service-pill"><span class="service-status-dot ${getDotClass(status.whisper)}"></span> Whisper</div>
            <div class="mobile-service-pill"><span class="service-status-dot ${getDotClass(status.f5tts)}"></span> F5-TTS</div>
        `;
    },

    renderDonations(recent) {
        const metaEl = document.getElementById('mobile-donations-meta');
        const listEl = document.getElementById('mobile-donors-mini-list');
        if (!recent) return;

        const total = recent.totalRecentAmount || 0;
        const goal = 150;
        const pct = Math.min(100, Math.floor((total / goal) * 100));

        if (metaEl) {
            metaEl.innerHTML = `Meta 3 meses: <strong>${Formatters.currency(total)}</strong> / ${Formatters.currency(goal)} (${pct}%)`;
        }

        if (listEl) {
            const donors = (recent.topRecentDonors || []).slice(0, 3);
            if (donors.length === 0) {
                listEl.innerHTML = `<div style="font-size: 10px; color: #888; text-align: center; padding: 4px;">Nenhuma doação recente.</div>`;
            } else {
                listEl.innerHTML = donors.map((d, i) => {
                    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉';
                    return `
                        <div class="mobile-donor-mini-item">
                            <span>${medal} ${d.nome}</span>
                            <strong style="color: var(--gold-color);">${Formatters.currency(d.valor)}</strong>
                        </div>
                    `;
                }).join('');
            }
        }
    },

    renderBots(data) {
        // Status is handled inside the 'status' window module
    }
};

window.MobileApp = MobileApp;
