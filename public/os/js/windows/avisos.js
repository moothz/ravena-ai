// windows/avisos.js - Avisos e comunicados da RavenaBot

WindowManager.register('avisos', {
    title: '📢 Avisos da Comunidade',
    taskbarIcon: 'fa-bullhorn',
    width: '640px',
    height: '460px',
    singleton: true,

    render(wb) {
        const body = wb.body;

        const renderPage = () => {
            const data = window.RavenaOS ? window.RavenaOS.state.healthData : null;
            const announcements = (data && Array.isArray(data.announcements)) ? data.announcements : [];
            const now = Date.now();
            const active = announcements.filter(a => a && Number(a.expires_at) > now);

            if (active.length === 0) {
                body.innerHTML = `
                    <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; text-align: center; color: var(--light-gray); padding: 30px; box-sizing: border-box;">
                        <i class="fas fa-bullhorn" style="font-size: 38px; color: var(--medium-gray); margin-bottom: 14px;"></i>
                        <h3 style="margin-bottom: 6px; color: #fff; font-size: 15px;">Nenhum aviso ativo no momento</h3>
                        <p style="font-size: 12px; max-width: 320px; line-height: 1.4;">Tudo tranquilo por aqui! Quando houver novidades, manutenções ou comunicados, eles aparecerão aqui.</p>
                    </div>
                `;
                return;
            }

            body.innerHTML = `
                <div class="avisos-window-content" style="padding: 14px; display: flex; flex-direction: column; gap: 14px; overflow-y: auto; height: 100%; box-sizing: border-box;">
                    ${active.map(item => `
                        <article class="status-announcement-card" style="background: rgba(22, 22, 32, 0.9); border: 1px solid var(--neon-cyan); border-radius: 8px; padding: 14px 16px; box-shadow: 0 4px 14px rgba(0,0,0,0.4);">
                            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 10px; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 8px;">
                                <i class="fas fa-bullhorn" style="color: var(--neon-cyan); font-size: 14px;"></i>
                                <strong style="color: #fff; font-size: 13px;">Aviso da Equipe</strong>
                                ${item.created_at ? `<span style="font-size: 10px; color: #888; margin-left: auto;">${new Date(Number(item.created_at)).toLocaleString('pt-BR')}</span>` : ''}
                            </div>
                            <div style="font-size: 13px; line-height: 1.55; color: #e5e5e5; word-break: break-word;">
                                ${Formatters.formatWhatsAppMarkup ? Formatters.formatWhatsAppMarkup(item.message) : Formatters.escapeHtml(item.message)}
                            </div>
                        </article>
                    `).join('')}
                </div>
            `;
        };

        renderPage();

        const onHealth = () => renderPage();
        if (window.RavenaOS) {
            window.RavenaOS.on('healthUpdate', onHealth);
        }

        wb.cleanup = () => {
            if (window.RavenaOS) {
                window.RavenaOS.off('healthUpdate', onHealth);
            }
        };
    }
});
