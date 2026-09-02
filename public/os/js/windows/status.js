// windows/status.js - Status das Ravenas (Disk view)

WindowManager.register('status', {
    title: 'Status das Ravenas — Instâncias',
    taskbarIcon: 'fa-desktop',
    get width() {
        return `${Math.min(1080, Math.max(680, Math.floor((window.innerWidth - 280) * 0.95)))}px`;
    },
    get height() {
        return `${Math.min(840, Math.max(500, Math.floor((window.innerHeight - 50) * 0.85)))}px`;
    },
    x: '250px',
    y: '20px',
    singleton: true,

    render(wb) {
        const body = wb.body;

        const update = () => {
            const data = window.RavenaOS ? window.RavenaOS.state.healthData : null;
            if (!data || !data.bots || data.bots.length === 0) {
                body.innerHTML = `
                    <div style="text-align: center; padding: 40px;">
                        <i class="fas fa-spinner fa-spin" style="font-size: 24px; color: var(--bright-blue);"></i>
                        <p style="margin-top: 12px; font-size: 12px;">Carregando status das ravenas...</p>
                    </div>
                `;
                return;
            }

            const botsNormais = data.bots.filter(b => !b.comunitario && !b.vip);
            const botsComunitarios = data.bots.filter(b => b.comunitario);
            const botsVips = data.bots.filter(b => b.vip);

            let html = '<div class="meu-computador">';

            // Normais
            if (botsNormais.length > 0) {
                html += `
                    <div class="drive-category">
                        <h3 class="drive-category-title"><i class="fas fa-dove"></i> Ravenas Normais</h3>
                        <div class="drive-list">
                            ${botsNormais.map(b => this.renderDriveItem(b)).join('')}
                        </div>
                    </div>
                `;
            }

            // Comunitárias
            if (botsComunitarios.length > 0) {
                html += `<hr class="win-xp-separator">`;
                html += `
                    <div class="drive-category">
                        <h3 class="drive-category-title"><i class="fas fa-users"></i> Ravenas Comunitárias ☭</h3>
                        <div class="drive-list">
                            ${botsComunitarios.map(b => this.renderDriveItem(b)).join('')}
                        </div>
                    </div>
                `;
            }

            // VIPs
            if (botsVips.length > 0) {
                html += `<hr class="win-xp-separator">`;
                html += `
                    <div class="drive-category">
                        <h3 class="drive-category-title"><i class="fas fa-gem" style="color: var(--gold-color);"></i> Ravenas VIP</h3>
                        <div class="drive-list">
                            ${botsVips.map(b => this.renderDriveItem(b)).join('')}
                        </div>
                    </div>
                `;
            }

            html += '</div>';
            body.innerHTML = html;

            this.attachListeners(body, data);
        };

        update();

        // Subscribe to updates
        if (window.RavenaOS) {
            window.RavenaOS.on('healthUpdate', update);
            window.RavenaOS.on('realtimeRate', () => {
                this.updateLiveBarValues(body);
            });
            window.RavenaOS.on('activity', (data) => {
                if (!data || !data.botId) return;
                const iconEl = body.querySelector(`.drive-item[data-bot-id="${data.botId}"] .drive-icon`);
                if (iconEl) {
                    iconEl.classList.remove('avatar-flash');
                    void iconEl.offsetWidth;
                    iconEl.classList.add('avatar-flash');
                }
            });
        }
    },

    renderDriveItem(bot) {
        const isOffline = !bot.connected || bot.banido;
        const isBanned = !!bot.banido;

        // Message rate (0-5000 msgs/hr -> 0-75%)
        let msgsHr = Math.round(bot.msgsHr || 0);
        if (window.RavenaOS && window.RavenaOS.state.botMessageTimestamps[bot.id]) {
            const now = Date.now();
            const recent = window.RavenaOS.state.botMessageTimestamps[bot.id].filter(t => now - t <= 60000);
            if (recent.length > 0) {
                msgsHr = recent.length * 60;
            }
        }

        const msgsPercent = Math.min(75, (msgsHr / 5000) * 75);

        // Delay (0s to 30s -> 0-25%)
        const avgDelay = bot.responseTime ? (bot.responseTime.avg || 0) : 0;
        const delayMs = avgDelay * 1000;
        const delayPercent = Math.min(25, (delayMs / 30000) * 25);

        const totalPercent = Math.min(100, Math.max(5, msgsPercent + delayPercent));

        // Color calculation (0% green -> 50% yellow -> 100% red)
        const hue = Math.max(0, 120 - (totalPercent * 1.2));
        const barColor = `hsl(${hue}, 85%, 45%)`;

        // Status dot calculation
        const minutesSince = Formatters.getTimeSinceLastMessage(bot.lastMessageReceived);
        let statusDotClass = 'status-green';
        if (isBanned) {
            statusDotClass = 'banned';
        } else if (!bot.connected) {
            statusDotClass = 'disconnected';
        } else if (minutesSince > 15) {
            statusDotClass = 'disconnected';
        } else if (minutesSince > 5) {
            statusDotClass = 'status-red';
        } else if (minutesSince > 2) {
            statusDotClass = 'status-yellow';
        }

        const barText = isBanned
            ? 'BANIDA'
            : !bot.connected
            ? 'DESCONECTADO'
            : `${msgsHr} msgs/hr, ${avgDelay.toFixed(1)}s delay`;

        const phone = bot.phoneNumber || '';
        const cleanPhone = phone ? String(phone).replace(/\D/g, '') : '';

        return `
            <div class="drive-item ${isOffline ? 'drive-offline' : ''}" 
                 data-bot-id="${bot.id}" 
                 data-phone="${phone}"
                 title="Clique para mais informações">
                <img src="img/profiles/${bot.id}.jpg" 
                     class="drive-icon" 
                     onerror="this.onerror=null;this.src='/android-chrome-192x192.png';" 
                     alt="${bot.id}"
                     loading="lazy">
                <div class="drive-info">
                    <div class="drive-name">
                        <span class="status-dot ${statusDotClass}"></span>
                        <span>${bot.id}</span>
                    </div>
                    <div class="drive-bar">
                        <div class="drive-bar-fill" style="width: ${isOffline ? 100 : totalPercent}%; background: ${isOffline ? '#2a2a38' : barColor};"></div>
                        <span class="drive-bar-text ${isOffline ? 'bar-text-offline' : ''}">${barText}</span>
                    </div>
                </div>
                ${cleanPhone ? `
                    <a href="https://wa.me/${cleanPhone}" target="_blank" class="drive-wa-btn" title="Chamar no WhatsApp" onclick="event.stopPropagation();">
                        <i class="fab fa-whatsapp"></i>
                    </a>
                ` : ''}
            </div>
        `;
    },

    updateLiveBarValues(body) {
        if (!window.RavenaOS || !window.RavenaOS.state.healthData) return;
        const bots = window.RavenaOS.state.healthData.bots || [];

        bots.forEach(bot => {
            const el = body.querySelector(`.drive-item[data-bot-id="${bot.id}"]`);
            if (!el || !bot.connected || bot.banido) return;

            let msgsHr = Math.round(bot.msgsHr || 0);
            if (window.RavenaOS.state.botMessageTimestamps[bot.id]) {
                const now = Date.now();
                const recent = window.RavenaOS.state.botMessageTimestamps[bot.id].filter(t => now - t <= 60000);
                if (recent.length > 0) msgsHr = recent.length * 60;
            }

            const msgsPercent = Math.min(75, (msgsHr / 5000) * 75);
            const avgDelay = bot.responseTime ? (bot.responseTime.avg || 0) : 0;
            const delayPercent = Math.min(25, ((avgDelay * 1000) / 30000) * 25);
            const totalPercent = Math.min(100, Math.max(5, msgsPercent + delayPercent));

            const hue = Math.max(0, 120 - (totalPercent * 1.2));
            const barColor = `hsl(${hue}, 85%, 45%)`;

            const fillEl = el.querySelector('.drive-bar-fill');
            const textEl = el.querySelector('.drive-bar-text');

            if (fillEl) {
                fillEl.style.width = `${totalPercent}%`;
                fillEl.style.background = barColor;
            }
            if (textEl) {
                textEl.textContent = `${msgsHr} msgs/hr, ${avgDelay.toFixed(1)}s delay`;
            }
        });
    },

    attachListeners(body, data) {
        body.querySelectorAll('.drive-item').forEach(el => {
            const botId = el.dataset.botId;
            const phone = el.dataset.phone;
            const bot = data.bots.find(b => b.id === botId) || { id: botId, phoneNumber: phone };

            // Left Click -> Open detail window
            el.addEventListener('click', (e) => {
                if (e.target.closest('.drive-wa-btn')) return;
                e.stopPropagation();
                WindowManager.open('status-detail', { botId, bot });
            });

            // Right Click -> Context Menu
            el.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const cleanPhone = phone ? phone.replace(/\D/g, '') : '';
                ContextMenu.show(e, [
                    {
                        label: 'Chamar no Whats',
                        icon: 'fab fa-whatsapp',
                        bold: true,
                        action: () => {
                            if (cleanPhone) window.open(`https://wa.me/${cleanPhone}`, '_blank');
                        }
                    },
                    {
                        label: 'Ver detalhes',
                        icon: 'fas fa-info-circle',
                        action: () => {
                            WindowManager.open('status-detail', { botId, bot });
                        }
                    }
                ]);
            });
        });
    }
});
