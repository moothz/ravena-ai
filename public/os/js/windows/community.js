// windows/community.js - Community groups and links window

WindowManager.register('community', {
    title: 'Comunidade — Grupos e Redes',
    taskbarIcon: 'fa-users',
    width: '600px',
    height: '420px',
    singleton: true,

    render(wb) {
        wb.body.innerHTML = `
            <div style="display: flex; flex-direction: column; gap: 12px;">
                <p style="font-size: 11px; color: var(--light-gray);">
                    Conecte-se com outros usuários, participe de eventos, tire dúvidas e acompanhe novidades sobre a RavenaBot!
                </p>

                <div class="community-grid">
                    <a href="https://chat.whatsapp.com/Cjh9gmf1mo2DGBEOBeKGbw" target="_blank" class="community-card">
                        <img src="img/icons/community.png" alt="Comunidade">
                        <span>Grupo Geral WhatsApp</span>
                    </a>

                    <a href="https://whatsapp.com/channel/0029VbBwXS7K5cDI4P8okp2f" target="_blank" class="community-card">
                        <i class="fas fa-bullhorn" style="font-size: 36px; color: #f6ad55;"></i>
                        <span>Canal de Avisos</span>
                    </a>

                    <div class="community-card" id="com-open-fishing" style="cursor: pointer;">
                        <img src="img/icons/fishing.png" alt="Pesca">
                        <span>Galeria da Pesca</span>
                    </div>

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

        const fishingBtn = wb.body.querySelector('#com-open-fishing');
        if (fishingBtn) {
            fishingBtn.addEventListener('click', () => {
                WindowManager.open('fishing');
            });
        }
    }
});
