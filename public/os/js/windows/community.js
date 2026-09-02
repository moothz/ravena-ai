// windows/community.js - Community groups and links window

WindowManager.register('community', {
    title: 'Comunidade — Grupos e Redes',
    taskbarIcon: 'fa-users',
    width: '740px',
    height: '510px',
    singleton: true,

    render(wb) {
        wb.body.innerHTML = `
            <div style="display: flex; flex-direction: column; gap: 12px;">
                <p style="font-size: 11px; color: var(--light-gray);">
                    Conecte-se com outros usuários, participe de eventos, tire dúvidas e acompanhe novidades sobre a RavenaBot!
                </p>

                <div class="community-grid">
                    <a href="https://chat.whatsapp.com/C47W0n3Bp9Z9Ra2ifzDDQe" target="_blank" class="community-card">
                        <img src="img/icons/community.png" alt="Comunidade">
                        <span>Comunidade Ravenabot</span>
                    </a>

                    <a href="https://whatsapp.com/channel/0029VbBwXS7K5cDI4P8okp2f" target="_blank" class="community-card">
                        <img src="img/grupo-avisos-small.jpg" alt="Canal de Avisos" onerror="this.onerror=null;this.src='/public/grupo-avisos-small.jpg';">
                        <span>Canal de Avisos</span>
                    </a>

                    <a href="https://wa.me/555596424307" target="_blank" class="community-card" style="border-color: rgba(37, 211, 102, 0.4);">
                        <i class="fab fa-whatsapp" style="font-size: 36px; color: #25d366;"></i>
                        <span>Falar com Criador (moothz)</span>
                    </a>

                    <a href="https://t.me/ravenosabot" target="_blank" class="community-card">
                        <i class="fab fa-telegram" style="font-size: 36px; color: #0088cc;"></i>
                        <span>Bot no Telegram</span>
                    </a>

                    <a href="https://discord.com/oauth2/authorize?client_id=1434519453416030369&permissions=5136918325222464&integration_type=0&scope=bot+applications.commands" target="_blank" class="community-card">
                        <i class="fab fa-discord" style="font-size: 36px; color: #5865f2;"></i>
                        <span>Bot no Discord</span>
                    </a>

                    <a href="https://github.com/moothz/ravena-ai" target="_blank" class="community-card">
                        <img src="img/icons/github.png" alt="GitHub">
                        <span>Código no GitHub</span>
                    </a>
                </div>
            </div>
        `;
    }
});
