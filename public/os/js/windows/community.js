// windows/community.js - Community groups and links window

WindowManager.register('community', {
    title: 'Comunidade — Grupos e Redes',
    taskbarIcon: 'fa-users',
    width: '740px',
    height: '510px',
    singleton: true,

    render(wb) {
        const links = window.RavenaOS?.state?.healthData?.communityLinks || {
            community: '/comunidade',
            grupao: '/grupao',
            channel: '/canal',
            telegramCommunity: '/telegram-grupo',
            telegramBot: '/telegram',
            discordCommunity: '/discord-server',
            discordBot: '/discord',
            creator: '/criador',
            github: '/github',
            donation: '/doar'
        };

        wb.body.innerHTML = `
            <div style="display: flex; flex-direction: column; gap: 12px;">
                <p style="font-size: 11px; color: var(--light-gray);">
                    Conecte-se com outros usuários, participe de eventos, tire dúvidas e acompanhe novidades sobre a RavenaBot!
                </p>

                <div class="community-grid">
                    <a href="${links.community || '/comunidade'}" target="_blank" class="community-card">
                        <img src="img/icons/community.webp" alt="" width="96" height="96" decoding="async">
                        <span>Comunidade WhatsApp</span>
                    </a>

                    <a href="${links.grupao || '/grupao'}" target="_blank" class="community-card">
                        <img src="/grupo-geral-small.jpg" alt="" width="96" height="96" decoding="async" onerror="this.onerror=null;this.src='img/icons/community.webp';">
                        <span>Grupão (Interação)</span>
                    </a>

                    <a href="${links.channel || '/canal'}" target="_blank" class="community-card">
                        <img src="img/grupo-avisos-small.jpg" alt="" width="96" height="96" decoding="async" onerror="this.onerror=null;this.src='/public/grupo-avisos-small.jpg';">
                        <span>Canal de Avisos</span>
                    </a>

                    <a href="${links.telegramCommunity || '/telegram-grupo'}" target="_blank" class="community-card">
                        <i class="fab fa-telegram" style="font-size: 36px; color: #0088cc;"></i>
                        <span>Grupo no Telegram</span>
                    </a>

                    <a href="${links.telegramBot || '/telegram'}" target="_blank" class="community-card">
                        <i class="fab fa-telegram-plane" style="font-size: 36px; color: #29b6f6;"></i>
                        <span>Bot no Telegram</span>
                    </a>

                    <a href="${links.discordCommunity || '/discord-server'}" target="_blank" class="community-card">
                        <i class="fab fa-discord" style="font-size: 36px; color: #5865f2;"></i>
                        <span>Servidor Discord</span>
                    </a>

                    <a href="${links.discordBot || '/discord'}" target="_blank" class="community-card">
                        <i class="fas fa-robot" style="font-size: 36px; color: #7289da;"></i>
                        <span>Bot no Discord</span>
                    </a>

                    <a href="${links.creator || '/criador'}" target="_blank" class="community-card" style="border-color: rgba(37, 211, 102, 0.4);">
                        <i class="fab fa-whatsapp" style="font-size: 36px; color: #25d366;"></i>
                        <span>Falar com Criador</span>
                    </a>

                    <a href="${links.github || '/github'}" target="_blank" class="community-card">
                        <img src="img/icons/github.webp" alt="" width="96" height="96" decoding="async">
                        <span>Código no GitHub</span>
                    </a>

                    <a href="${links.donation || '/doar'}" target="_blank" class="community-card" style="border-color: rgba(255, 64, 129, 0.4);">
                        <i class="fas fa-heart" style="font-size: 36px; color: #ff4081;"></i>
                        <span>Apoiar Projeto (Tipa.ai)</span>
                    </a>
                </div>
            </div>
        `;
    }
});
