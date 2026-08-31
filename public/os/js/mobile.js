// mobile.js - Simplified Mobile Responsive Experience (< 768px)

const MobileApp = {
    init() {
        const app = document.getElementById('mobile-app');
        if (!app) return;

        app.innerHTML = `
            <header class="mobile-header">
                <img src="/android-chrome-192x192.png" class="mobile-logo" alt="RavenaBot">
                <div>
                    <h1>RavenaBot</h1>
                    <span>Painel de Monitoramento</span>
                </div>
            </header>

            <!-- Service Status Pills -->
            <div class="mobile-services" id="mobile-services-container">
                <div class="mobile-service-pill"><span class="service-status-dot dot-unknown"></span> WhatsGo</div>
                <div class="mobile-service-pill"><span class="service-status-dot dot-unknown"></span> Imagine</div>
                <div class="mobile-service-pill"><span class="service-status-dot dot-unknown"></span> LLM</div>
                <div class="mobile-service-pill"><span class="service-status-dot dot-unknown"></span> Whisper</div>
                <div class="mobile-service-pill"><span class="service-status-dot dot-unknown"></span> F5-TTS</div>
            </div>

            <!-- Quick Navigation Grid -->
            <div class="mobile-grid">
                <a href="/ajuda" target="_blank" class="mobile-grid-item">
                    <i class="fas fa-question-circle"></i>
                    <span>Ajuda</span>
                </a>
                <a href="/imagine" target="_blank" class="mobile-grid-item">
                    <i class="fas fa-palette"></i>
                    <span>Imagine</span>
                </a>
                <a href="/tts" target="_blank" class="mobile-grid-item">
                    <i class="fas fa-volume-up"></i>
                    <span>TTS</span>
                </a>
                <a href="/stt" target="_blank" class="mobile-grid-item">
                    <i class="fas fa-microphone"></i>
                    <span>STT</span>
                </a>
                <a href="/pesca" target="_blank" class="mobile-grid-item">
                    <i class="fas fa-fish"></i>
                    <span>Pesca</span>
                </a>
                <a href="/cmd" target="_blank" class="mobile-grid-item">
                    <i class="fas fa-terminal"></i>
                    <span>Comandos</span>
                </a>
            </div>

            <!-- Donations Card -->
            <div style="background: #110d29; border: 1px solid var(--win-border-subtle); border-radius: 6px; padding: 12px; margin-bottom: 16px;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                    <span style="font-size: 11px; font-weight: 700; color: var(--gold-color);">💰 Doações Recentes</span>
                    <a href="https://tipa.ai/moothz" target="_blank" class="os-btn" style="font-size: 10px; padding: 2px 8px; background: #ff4081;">Doar</a>
                </div>
                <div id="mobile-donations-text" style="font-size: 10px; color: var(--light-gray);">Carregando doações...</div>
            </div>

            <!-- Bots List -->
            <div class="mobile-section-title">🤖 Status das Instâncias</div>
            <div class="mobile-bots-list" id="mobile-bots-list">
                <div style="text-align: center; padding: 20px; font-size: 11px; color: #888;">
                    <i class="fas fa-spinner fa-spin"></i> Carregando ravenas...
                </div>
            </div>

            <!-- Footer -->
            <footer class="mobile-footer">
                <a href="https://chat.whatsapp.com/Cjh9gmf1mo2DGBEOBeKGbw" target="_blank">Comunidade</a>
                <a href="https://tipa.ai/moothz" target="_blank">Doações</a>
                <a href="https://github.com/moothz/ravena-ai" target="_blank">GitHub</a>
            </footer>
        `;

        if (window.RavenaOS) {
            window.RavenaOS.on('healthUpdate', (data) => this.renderBots(data));
            window.RavenaOS.on('serviceStatusUpdate', (s) => this.renderServices(s));
            window.RavenaOS.on('recentDonationsUpdate', (d) => this.renderDonations(d));

            if (window.RavenaOS.state.healthData) this.renderBots(window.RavenaOS.state.healthData);
            if (window.RavenaOS.state.serviceStatus) this.renderServices(window.RavenaOS.state.serviceStatus);
            if (window.RavenaOS.state.recentDonations) this.renderDonations(window.RavenaOS.state.recentDonations);
        }
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
        const textEl = document.getElementById('mobile-donations-text');
        if (!textEl || !recent) return;

        const total = recent.totalRecentAmount || 0;
        const pct = Math.min(100, Math.floor((total / 150) * 100));
        textEl.innerHTML = `Meta 3 meses: <strong>${Formatters.currency(total)}</strong> / ${Formatters.currency(150)} (${pct}%)`;
    },

    renderBots(data) {
        const list = document.getElementById('mobile-bots-list');
        if (!list || !data || !data.bots) return;

        if (data.bots.length === 0) {
            list.innerHTML = `<p style="text-align: center; padding: 15px;">Nenhuma ravena encontrada.</p>`;
            return;
        }

        list.innerHTML = data.bots.map(bot => {
            const isOffline = !bot.connected || bot.banido;
            const minutesSince = Formatters.getTimeSinceLastMessage(bot.lastMessageReceived);
            const phone = bot.phoneNumber ? Formatters.formatPhoneNumber(bot.phoneNumber) : '';
            const cleanPhone = bot.phoneNumber ? String(bot.phoneNumber).replace(/\D/g, '') : '';
            const msgsHr = Math.round(bot.msgsHr || 0);
            const delay = bot.responseTime ? (bot.responseTime.avg || 0).toFixed(1) : '0.0';

            const dotClass = bot.banido ? 'banned' : !bot.connected ? 'disconnected' : minutesSince > 15 ? 'disconnected' : minutesSince > 5 ? 'status-red' : minutesSince > 2 ? 'status-yellow' : 'status-green';

            return `
                <div class="mobile-bot-card ${isOffline ? 'drive-offline' : ''}">
                    <img src="img/profiles/${bot.id}.jpg" 
                         class="mobile-bot-avatar" 
                         onerror="this.onerror=null;this.src='/android-chrome-192x192.png';" 
                         alt="${bot.id}">
                    <div class="mobile-bot-info">
                        <div class="mobile-bot-name">
                            <span class="status-dot ${dotClass}"></span>
                            <span>${bot.id}</span>
                        </div>
                        <div class="mobile-bot-meta">${phone || 'Telefone não informado'}</div>
                        <div class="mobile-bot-meta" style="color: var(--cyan-neon);">
                            ${msgsHr} msgs/h &nbsp;•&nbsp; ${delay}s delay
                        </div>
                    </div>
                    ${cleanPhone ? `
                        <a href="https://wa.me/${cleanPhone}" target="_blank" class="mobile-wa-btn" title="Chamar no WhatsApp">
                            <i class="fab fa-whatsapp"></i>
                        </a>
                    ` : ''}
                </div>
            `;
        }).join('');
    }
};

window.MobileApp = MobileApp;
