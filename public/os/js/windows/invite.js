// windows/invite.js - "Quero Uma!" invite rules and guide formatted in retro OS style

WindowManager.register('invite', {
    title: 'Quero Uma! — Como convidar a RavenaBot',
    taskbarIcon: 'fa-envelope',
    width: '740px',
    height: '600px',
    singleton: true,

    render(wb) {
        const body = wb.body;

        const renderPage = () => {
            const data = window.RavenaOS ? window.RavenaOS.state.healthData : null;
            const bots = (data && data.bots) ? data.bots : [];
            const normalBots = bots.filter(b => !b.vip && !b.comunitario);

            let normalBotsHtml = '';
            if (normalBots.length > 0) {
                normalBotsHtml = normalBots.map(b => {
                    const cleanPhone = b.phoneNumber ? String(b.phoneNumber).replace(/\D/g, '') : '';
                    const waUrl = cleanPhone ? `https://wa.me/${cleanPhone}` : '#';

                    return `
                        <a href="${waUrl}" target="_blank" class="invite-bot-avatar-btn" title="Chamar ${b.id} no WhatsApp">
                            <div class="invite-bot-avatar-wrap">
                                <img src="img/profiles/${b.id}.jpg" onerror="this.onerror=null;this.src='/android-chrome-192x192.png';" alt="${b.id}">
                                <span class="invite-whatsapp-badge">
                                    <i class="fab fa-whatsapp"></i>
                                </span>
                            </div>
                            <span class="invite-bot-label">${b.id}</span>
                        </a>
                    `;
                }).join('');
            } else {
                normalBotsHtml = '<span style="font-size: 11px; color: #888;">Carregando ravenas normais...</span>';
            }

            body.innerHTML = `
                <div class="invite-page">
                    <div class="invite-header">
                        <h2>🐦‍⬛ Então você quer a RavenaBot no seu grupo?</h2>
                        <p style="font-size: 12px; color: var(--light-gray); margin-top: 6px;">
                            Para começar, envie <strong>apenas o LINK</strong> do seu grupo para uma das ravenas normais!
                        </p>
                        <p style="font-size: 12px; color: var(--cyan-neon); margin-top: 8px; font-weight: 600;">
                            Clique em uma abaixo pra conversar com ela no WhatsApp!
                        </p>
                        <div class="invite-bots-row">
                            ${normalBotsHtml}
                        </div>
                    </div>

                    <div class="invite-section">
                        <div style="background: rgba(246, 173, 85, 0.15); border: 1px solid var(--status-yellow); padding: 10px 12px; border-radius: 6px; font-size: 12px; color: #ffeb3b;">
                            ⚠️ <strong>Importante:</strong> Não adianta me adicionar manualmente no grupo pelo WhatsApp! Eu não consigo aceitar diretamente no whats — apenas pelo link enviado para meu PV.
                        </div>
                    </div>

                    <div class="invite-section">
                        <h3>🏆 Critérios de Prioridade</h3>
                        <div class="invite-cards">
                            <div class="invite-card">
                                <i class="fas fa-heart" style="color: #ff4081;"></i>
                                <strong style="color: #ffffff;">Doadores</strong>
                                <p style="color: var(--light-gray);">Pessoas que contribuem com os custos da Ravena (!doar)</p>
                            </div>
                            <div class="invite-card">
                                <i class="fas fa-video" style="color: var(--bright-blue);"></i>
                                <strong style="color: #ffffff;">Criadores & Streamers</strong>
                                <p style="color: var(--light-gray);">Grupos que usam integrações com Twitch, Kick e YouTube</p>
                            </div>
                            <div class="invite-card">
                                <i class="fas fa-tasks" style="color: var(--status-green);"></i>
                                <strong style="color: #ffffff;">Organização</strong>
                                <p style="color: var(--light-gray);">Grupos ativos, com boa descrição e regras claras</p>
                            </div>
                        </div>
                    </div>

                    <div class="invite-section">
                        <h3>🙅 O que evitamos ou recusamos</h3>
                        <ul class="invite-avoid-list">
                            <li>
                                <span class="invite-badge badge-never">Jamais Aceito</span>
                                <span>Conteúdo racista, xenofóbico, homofóbico, machista ou tóxico.</span>
                            </li>
                            <li>
                                <span class="invite-badge badge-never">Underage</span>
                                <span>Grupos claramente infantis / adolescentes com fontes estranhas.</span>
                            </li>
                            <li>
                                <span class="invite-badge badge-rare">Casos Específicos</span>
                                <span>Grupos apenas de figurinhas ou turmas escolares.</span>
                            </li>
                            <li>
                                <span class="invite-badge badge-rare">Pensamos Bem</span>
                                <span>Grupos de teste, convites com mensagens geradas por IA ou sem explicação.</span>
                            </li>
                        </ul>
                    </div>

                    <div class="invite-warning-box">
                        <i class="fas fa-exclamation-triangle" style="font-size: 20px; flex-shrink: 0;"></i>
                        <div>
                            <strong>Atenção:</strong> Se o bot for removido logo após entrar, o número do solicitante será bloqueado permanentemente.
                        </div>
                    </div>
                </div>
            `;
        };

        renderPage();

        if (window.RavenaOS) {
            window.RavenaOS.on('healthUpdate', renderPage);
        }
    }
});
