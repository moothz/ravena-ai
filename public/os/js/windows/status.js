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

    onclose(wb) {
        if (wb && typeof wb.cleanup === 'function') {
            wb.cleanup();
        }
    },

    render(wb) {
        const body = wb.body;
        wb.cemeteryExpanded = wb.cemeteryExpanded ?? false;

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

            const botsPrivados = data.bots.filter(b => b.privado);
            const botsNormais = data.bots.filter(b => !b.comunitario && !b.vip && !b.privado);
            const botsComunitarios = data.bots.filter(b => b.comunitario && !b.privado);
            const botsVips = data.bots.filter(b => b.vip && !b.privado);

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

            // Privadas
            if (botsPrivados.length > 0) {
                html += `<hr class="win-xp-separator">`;
                html += `
                    <div class="drive-category">
                        <h3 class="drive-category-title"><i class="fas fa-lock" style="color: #ff9800;"></i> Ravenas Privadas 🔒</h3>
                        <div class="drive-list">
                            ${botsPrivados.map(b => this.renderDriveItem(b)).join('')}
                        </div>
                    </div>
                `;
            }

            // Cemitério de Banidas
            const cemiterio = (data && Array.isArray(data.cemiterio)) ? [...data.cemiterio] : [];
            if (cemiterio.length > 0) {
                // Ordenação por dataMorte decrescente (a mais recente primeiro)
                cemiterio.sort((a, b) => {
                    const timeA = Formatters.parseDate ? (Formatters.parseDate(a.dataMorte)?.getTime() || 0) : 0;
                    const timeB = Formatters.parseDate ? (Formatters.parseDate(b.dataMorte)?.getTime() || 0) : 0;
                    if (timeB !== timeA) return timeB - timeA;
                    const birthA = Formatters.parseDate ? (Formatters.parseDate(a.dataNascimento)?.getTime() || 0) : 0;
                    const birthB = Formatters.parseDate ? (Formatters.parseDate(b.dataNascimento)?.getTime() || 0) : 0;
                    return birthB - birthA;
                });

                html += `<hr class="win-xp-separator">`;
                html += `
                    <div class="cemetery-section" style="margin-top: 10px;">
                        <button type="button" class="os-btn cemetery-toggle-btn" id="cemetery-toggle-btn" style="width: 100%; display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; background: rgba(30, 24, 34, 0.65); border: 1px solid rgba(255, 75, 75, 0.3); border-radius: 6px; cursor: pointer; color: #ffb4b4; font-weight: 600; font-size: 13px; font-family: inherit;">
                            <span>⚰️ Cemitério - Banidas 🪦 (${cemiterio.length})</span>
                            <i class="fas fa-chevron-${wb.cemeteryExpanded ? 'up' : 'down'}" id="cemetery-chevron" style="transition: transform 0.2s;"></i>
                        </button>
                        <div class="cemetery-container" id="cemetery-list" style="margin-top: 12px; display: ${wb.cemeteryExpanded ? 'grid' : 'none'}; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px;">
                            ${cemiterio.map(b => this.renderCemeteryItem(b)).join('')}
                        </div>
                    </div>
                `;
            }

            html += '</div>';
            body.innerHTML = html;

            this.attachListeners(body, data, wb);
        };

        update();

        // Subscribe to updates with mobile-safe guards
        const onHealth = () => {
            if (window.MobileApp && window.MobileApp.currentAppId && window.MobileApp.currentAppId !== 'status') {
                return;
            }
            update();
        };

        const onRate = () => {
            if (window.MobileApp && window.MobileApp.currentAppId && window.MobileApp.currentAppId !== 'status') {
                return;
            }
            this.updateLiveBarValues(body);
        };

        const onActivity = (data) => {
            if (window.MobileApp && window.MobileApp.currentAppId && window.MobileApp.currentAppId !== 'status') {
                return;
            }
            if (!data || !data.botId) return;
            const iconEl = body.querySelector(`.drive-item[data-bot-id="${CSS.escape(String(data.botId))}"] .drive-icon`);
            if (iconEl) {
                iconEl.classList.remove('avatar-flash');
                void iconEl.offsetWidth;
                iconEl.classList.add('avatar-flash');
            }
        };

        if (window.RavenaOS) {
            window.RavenaOS.on('healthUpdate', onHealth);
            window.RavenaOS.on('realtimeRate', onRate);
            window.RavenaOS.on('activity', onActivity);
        }

        const cleanup = () => {
            if (window.RavenaOS) {
                window.RavenaOS.off('healthUpdate', onHealth);
                window.RavenaOS.off('realtimeRate', onRate);
                window.RavenaOS.off('activity', onActivity);
            }
        };

        wb.cleanup = cleanup;
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

        // Fator 1: Throttle de carga (% do ratelimit) → peso de até 50% da barra
        const throttleLoad = (bot.throttle && bot.throttle.rateLimit > 0)
            ? (bot.throttle.loadPercent || 0)
            : 0;
        const throttlePercent = Math.min(50, (throttleLoad / 100) * 50);

        // Fator 2: Volume msgs/hora (tráfego geral) → peso de até 30% da barra
        // Normalizado para 3000 msgs/hr = 30% da barra
        const msgsPercent = Math.min(30, (msgsHr / 3000) * 30);

        // Fator 3: Delay médio de resposta → peso de até 20% da barra
        // Normalizado para 30s delay = 20% da barra
        const avgDelay = bot.responseTime ? (bot.responseTime.avg || 0) : 0;
        const delayPercent = Math.min(20, ((avgDelay * 1000) / 30000) * 20);

        const totalPercent = Math.min(100, Math.max(5, throttlePercent + msgsPercent + delayPercent));

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

        let barText;
        if (isBanned) {
            barText = 'BANIDA';
        } else if (!bot.connected) {
            barText = 'DESCONECTADO';
        } else if (bot.throttle && bot.throttle.rateLimit > 0) {
            const queueSize = bot.throttle.queueSize || 0;
            barText = `${msgsHr} msgs/hr · ${throttleLoad}% carga${queueSize > 0 ? ` · fila: ${queueSize}` : ''}`;
        } else {
            barText = `${msgsHr} msgs/hr, ${avgDelay.toFixed(1)}s delay`;
        }

        const phone = bot.phoneNumber || '';
        const cleanPhone = phone ? String(phone).replace(/\D/g, '') : '';
        const esc = Formatters.escapeHtml;
        const safeId = esc(bot.id);

        return `
            <div class="drive-item ${isOffline ? 'drive-offline' : ''} ${isBanned ? 'drive-banned' : ''}" 
                 data-bot-id="${safeId}" 
                 data-phone="${esc(phone)}"
                 title="Clique para mais informações">
                <img src="img/profiles/${encodeURIComponent(bot.id)}.jpg" 
                     class="drive-icon" 
                     onerror="this.onerror=null;this.src='/android-chrome-192x192.png';" 
                     alt=""
                     width="44" height="44"
                     loading="lazy" decoding="async">
                <div class="drive-info">
                    <div class="drive-name">
                        <span class="status-dot ${statusDotClass}"></span>
                        <span>${esc(bot.nomeExibir || bot.id)}</span>
                        ${bot.privado ? '<i class="fas fa-lock" style="font-size: 10px; color: #ff9800; margin-left: 4px;" title="Privada"></i>' : ''}
                    </div>
                    <div class="drive-bar">
                        <div class="drive-bar-fill" style="width: ${isOffline ? 100 : totalPercent}%; background: ${isOffline ? '#2a2a38' : barColor};"></div>
                        <span class="drive-bar-text ${isOffline ? 'bar-text-offline' : ''}">${barText}</span>
                    </div>
                </div>
                ${cleanPhone && !isBanned ? `
                    <a href="https://wa.me/${cleanPhone}" target="_blank" rel="noopener noreferrer" class="drive-wa-btn" title="Chamar no WhatsApp" onclick="event.stopPropagation();">
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
            const el = body.querySelector(`.drive-item[data-bot-id="${CSS.escape(String(bot.id))}"]`);
            if (!el || !bot.connected || bot.banido) return;

            let msgsHr = Math.round(bot.msgsHr || 0);
            if (window.RavenaOS.state.botMessageTimestamps[bot.id]) {
                const now = Date.now();
                const recent = window.RavenaOS.state.botMessageTimestamps[bot.id].filter(t => now - t <= 60000);
                if (recent.length > 0) msgsHr = recent.length * 60;
            }

            // Fator 1: Throttle de carga (% do ratelimit) → peso de até 50%
            const throttleLoad = (bot.throttle && bot.throttle.rateLimit > 0)
                ? (bot.throttle.loadPercent || 0)
                : 0;
            const throttlePercent = Math.min(50, (throttleLoad / 100) * 50);

            // Fator 2: Volume msgs/hora (tráfego geral) → peso de até 30%
            const msgsPercent = Math.min(30, (msgsHr / 3000) * 30);

            // Fator 3: Delay médio de resposta → peso de até 20%
            const avgDelay = bot.responseTime ? (bot.responseTime.avg || 0) : 0;
            const delayPercent = Math.min(20, ((avgDelay * 1000) / 30000) * 20);

            const totalPercent = Math.min(100, Math.max(5, throttlePercent + msgsPercent + delayPercent));

            const hue = Math.max(0, 120 - (totalPercent * 1.2));
            const barColor = `hsl(${hue}, 85%, 45%)`;

            const fillEl = el.querySelector('.drive-bar-fill');
            const textEl = el.querySelector('.drive-bar-text');
            const nameEl = el.querySelector('.drive-name span:not(.status-dot)');

            if (nameEl) {
                const displayName = bot.nomeExibir || bot.id;
                if (nameEl.textContent !== displayName) {
                    nameEl.textContent = displayName;
                }
            }

            if (fillEl) {
                fillEl.style.width = `${totalPercent}%`;
                fillEl.style.background = barColor;
            }
            if (textEl) {
                if (bot.throttle && bot.throttle.rateLimit > 0) {
                    const queueSize = bot.throttle.queueSize || 0;
                    textEl.textContent = `${msgsHr} msgs/hr · ${throttleLoad}% carga${queueSize > 0 ? ` · fila: ${queueSize}` : ""}`;
                } else {
                    textEl.textContent = `${msgsHr} msgs/hr, ${avgDelay.toFixed(1)}s delay`;
                }
            }
        });
    },

    renderCemeteryItem(bot) {
        const esc = Formatters.escapeHtml;
        const safeNome = esc(bot.nomeExibir || bot.id);
        const avatar = `img/profiles/${encodeURIComponent(bot.id)}.jpg`;

        let datesText;
        if (bot.dataNascimento || bot.dataMorte) {
            const parts = [];
            if (bot.dataNascimento) parts.push(`★ ${esc(bot.dataNascimento)}`);
            if (bot.dataMorte) parts.push(`✝ ${esc(bot.dataMorte)}`);
            datesText = parts.join(' • ');
        } else {
            datesText = 'In memorian';
        }

        const lifetime = (Formatters.calculateLifetime && bot.dataNascimento && bot.dataMorte)
            ? Formatters.calculateLifetime(bot.dataNascimento, bot.dataMorte)
            : null;

        return `
            <div class="cemetery-card" style="display: flex; align-items: center; gap: 12px; background: rgba(18, 18, 24, 0.85); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 6px; padding: 10px 12px; box-shadow: 0 2px 6px rgba(0,0,0,0.3);">
                <img src="${avatar}" onerror="this.onerror=null;this.src='/android-chrome-192x192.png';" alt="${safeNome}" style="width: 48px; height: 48px; border-radius: 50%; object-fit: cover; filter: grayscale(100%); opacity: 0.75; border: 1px solid #444; flex-shrink: 0;">
                <div style="overflow: hidden; flex: 1; text-align: left;">
                    <div style="font-size: 13px; font-weight: 600; color: #ddd; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${safeNome}">${safeNome}</div>
                    <div style="font-size: 11px; color: #999; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${datesText}">${datesText}</div>
                    ${lifetime ? `<div style="font-size: 11px; color: var(--gold-color, #ffc107); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="Tempo de vida: ${lifetime}">⏳ ${lifetime}</div>` : ''}
                </div>
            </div>
        `;
    },

    attachListeners(body, data, wb) {
        const cemeteryBtn = body.querySelector('#cemetery-toggle-btn');
        if (cemeteryBtn && wb) {
            cemeteryBtn.addEventListener('click', () => {
                wb.cemeteryExpanded = !wb.cemeteryExpanded;
                const list = body.querySelector('#cemetery-list');
                const chevron = body.querySelector('#cemetery-chevron');
                if (list) list.style.display = wb.cemeteryExpanded ? 'grid' : 'none';
                if (chevron) {
                    chevron.className = `fas fa-chevron-${wb.cemeteryExpanded ? 'up' : 'down'}`;
                }
            });
        }

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
