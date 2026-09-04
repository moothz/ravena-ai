// windows/status-detail.js - Detailed card view for a single Ravena bot

WindowManager.register('status-detail', {
    title: 'Detalhes da Ravena',
    taskbarIcon: 'fa-info-circle',
    width: '560px',
    height: '495px',
    singleton: false,

    render(wb, params) {
        const botId = params.botId;
        const data = window.RavenaOS ? window.RavenaOS.state.healthData : null;
        const bot = (data && data.bots && data.bots.find(b => b.id === botId)) || params.bot || { id: botId };

        const body = wb.body;
        wb.setTitle(`Detalhes: ${bot.id}`);

        const phoneNumber = bot.phoneNumber ? Formatters.formatPhoneNumber(bot.phoneNumber) : 'Não informado';
        const cleanPhone = bot.phoneNumber ? String(bot.phoneNumber).replace(/\D/g, '') : '';
        const waUrl = cleanPhone ? `https://wa.me/${cleanPhone}` : '#';

        const respPhoneRaw = bot.numeroResponsavel || bot.responsible || bot.owner;
        const cleanRespPhone = respPhoneRaw ? String(respPhoneRaw).replace(/\D/g, '') : '';
        const respPhoneFormatted = respPhoneRaw ? Formatters.formatPhoneNumber(String(respPhoneRaw)) : '';

        const minutesSince = Formatters.getTimeSinceLastMessage(bot.lastMessageReceived);
        const lastSeenText = Formatters.formatTimeSince(minutesSince);

        const avgDelay = bot.responseTime ? (bot.responseTime.avg || 0) : 0;
        const maxDelay = bot.responseTime ? (bot.responseTime.max || 0) : 0;
        const msgsHr = Math.round(bot.msgsHr || 0);

        let typeBadge = '<span style="color: var(--bright-blue);">🐦‍⬛ Oficial</span>';
        if (bot.privado) typeBadge = '<span style="color: #ff9800;">🔒 Privada</span>';
        else if (bot.vip) typeBadge = '<span style="color: var(--gold-color);">💎 VIP</span>';
        else if (bot.comunitario) typeBadge = '<span style="color: #ff6b6b;">🐓 Comunitária ☭</span>';

        let statusText = '<span style="color: var(--status-green);">● Online e Ativa</span>';
        if (bot.banido) statusText = '<span style="color: #ff4d4d;">● Banida</span>';
        else if (!bot.connected) statusText = '<span style="color: var(--status-gray);">● Desconectada</span>';
        else if (minutesSince > 15) statusText = '<span style="color: var(--status-gray);">● Inativa</span>';
        else if (minutesSince > 5) statusText = '<span style="color: var(--status-red);">● Alerta</span>';
        else if (minutesSince > 2) statusText = '<span style="color: var(--status-yellow);">● Atenção</span>';

        let comunitContent = '';
        if (bot.comunitario || cleanRespPhone) {
            const resp = respPhoneFormatted || 'Voluntário';
            comunitContent = `
                <div class="detail-card" style="grid-column: span 2; border-left: 2px solid #ff6b6b;">
                    <div class="detail-card-label">Responsável pela Ravena</div>
                    <div class="detail-card-value" style="font-size: 11px;">${resp}</div>
                    ${bot.supportMsg ? `<p style="font-size: 10px; color: var(--light-gray); margin-top: 4px; font-style: italic;">"${bot.supportMsg}"</p>` : ''}
                </div>
            `;
        }

        body.innerHTML = `
            <div class="bot-detail-view">
                <div class="bot-detail-header">
                    <img src="img/profiles/${bot.id}.jpg" 
                         class="bot-detail-avatar" 
                         onerror="this.onerror=null;this.src='/android-chrome-192x192.png';" 
                         alt="${bot.id}">
                    <div class="bot-detail-title">
                        <h2>${bot.id}</h2>
                        <p>${typeBadge} &nbsp;|&nbsp; ${statusText}</p>
                    </div>
                </div>

                <div class="bot-detail-grid">
                    <div class="detail-card">
                        <div class="detail-card-label">Telefone da Ravena</div>
                        <div class="detail-card-value" style="font-size: 11px;">${phoneNumber}</div>
                    </div>
                    <div class="detail-card">
                        <div class="detail-card-label">Fluxo / Hora</div>
                        <div class="detail-card-value">${msgsHr} msgs/h</div>
                    </div>
                    <div class="detail-card">
                        <div class="detail-card-label">Delay Médio</div>
                        <div class="detail-card-value">${avgDelay.toFixed(2)}s <span style="font-size: 10px; color: #888;">(máx ${maxDelay.toFixed(1)}s)</span></div>
                    </div>
                    <div class="detail-card">
                        <div class="detail-card-label">Última Atividade</div>
                        <div class="detail-card-value" style="font-size: 11px;">${lastSeenText}</div>
                    </div>
                    ${comunitContent}
                </div>

                <div style="display: flex; gap: 8px; margin-top: 8px; justify-content: flex-end; flex-wrap: wrap;">
                    ${cleanRespPhone ? `
                        <a href="https://wa.me/${cleanRespPhone}" target="_blank" class="os-btn" style="background: linear-gradient(180deg, #f6ad55 0%, #d68910 100%); border-color: #f6ad55; color: #000; font-weight: 600;">
                            <i class="fab fa-whatsapp"></i> Chamar Responsável
                        </a>
                    ` : ''}
                    ${cleanPhone ? `
                        <a href="${waUrl}" target="_blank" class="os-btn" style="background: linear-gradient(180deg, #25d366 0%, #128c7e 100%); border-color: #25d366;">
                            <i class="fab fa-whatsapp"></i> Chamar no Whats
                        </a>
                    ` : ''}
                </div>
            </div>
        `;

        if (window.RavenaOS) {
            window.RavenaOS.on('activity', (act) => {
                if (act && act.botId === bot.id) {
                    const avatar = body.querySelector('.bot-detail-avatar');
                    if (avatar) {
                        avatar.classList.remove('avatar-flash');
                        void avatar.offsetWidth;
                        avatar.classList.add('avatar-flash');
                    }
                }
            });
        }
    }
});
