// windows/invite.js - "Quero Uma!" active invite form and rules formatted in retro OS style

WindowManager.register('invite', {
    title: 'Quero Uma! — Como convidar a RavenaBot',
    taskbarIcon: 'fa-envelope',
    width: '740px',
    height: '620px',
    singleton: true,

    render(wb) {
        const body = wb.body;

        const renderPage = () => {
            body.innerHTML = `
                <div class="invite-page">
                    <div class="invite-header">
                        <h2>🐦‍⬛ Então você quer a RavenaBot no seu grupo?</h2>
                        <p style="font-size: 12px; color: var(--light-gray); margin-top: 6px;">
                            Preencha os campos abaixo com o link e os detalhes do seu grupo para enviar a solicitação diretamente à moderação!
                        </p>
                    </div>

                    <!-- Formulário Ativo de Solicitação -->
                    <div class="invite-form-container" style="background: rgba(18, 18, 26, 0.85); border: 1px solid var(--neon-cyan); border-radius: 8px; padding: 16px; margin: 12px 0; box-shadow: 0 4px 14px rgba(0,0,0,0.35);">
                        <form id="invite-form" style="display: flex; flex-direction: column; gap: 12px;">
                            <div>
                                <label for="invite-input-link" style="display: block; font-size: 12px; font-weight: 600; color: #fff; margin-bottom: 4px;">
                                    🔗 Link de Convite do Grupo <span style="color: #ff4b4b;">*</span>
                                </label>
                                <input type="text" id="invite-input-link" placeholder="https://chat.whatsapp.com/..." required style="width: 100%; box-sizing: border-box; padding: 8px 12px; background: rgba(0, 0, 0, 0.5); border: 1px solid var(--medium-gray); border-radius: 4px; color: #fff; font-size: 13px; font-family: inherit;">
                                <span style="font-size: 10px; color: #888; margin-top: 2px; display: block;">Cole o link completo de convite do WhatsApp</span>
                            </div>

                            <div>
                                <label for="invite-input-contact" style="display: block; font-size: 12px; font-weight: 600; color: #fff; margin-bottom: 4px;">
                                    👤 Seu Contato / WhatsApp <span style="color: #ff4b4b;">*</span>
                                </label>
                                <input type="text" id="invite-input-contact" placeholder="Seu nome ou número (ex: 5511999998888)" required style="width: 100%; box-sizing: border-box; padding: 8px 12px; background: rgba(0, 0, 0, 0.5); border: 1px solid var(--medium-gray); border-radius: 4px; color: #fff; font-size: 13px; font-family: inherit;">
                                <span style="font-size: 10px; color: #888; margin-top: 2px; display: block;">Identificação para entrarmos em contato</span>
                            </div>

                            <div>
                                <label for="invite-input-reason" style="display: block; font-size: 12px; font-weight: 600; color: #fff; margin-bottom: 4px;">
                                    💬 Motivo / Descrição do Grupo <span style="color: #ff4b4b;">*</span>
                                </label>
                                <textarea id="invite-input-reason" rows="3" placeholder="Fale um pouco sobre o grupo (tema, membros, finalidade...)" required style="width: 100%; box-sizing: border-box; padding: 8px 12px; background: rgba(0, 0, 0, 0.5); border: 1px solid var(--medium-gray); border-radius: 4px; color: #fff; font-size: 13px; font-family: inherit; resize: vertical;"></textarea>
                                <span style="font-size: 10px; color: #888; margin-top: 2px; display: block;">Explique o propósito do grupo (grupos ativos e organizados têm prioridade)</span>
                            </div>

                            <div id="invite-form-status" style="font-size: 12px; min-height: 18px; transition: all 0.2s;"></div>

                            <button type="submit" id="invite-submit-btn" class="os-btn" style="background: var(--bright-blue); color: #fff; border: none; padding: 10px 18px; border-radius: 6px; font-weight: 700; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 8px; font-family: inherit; font-size: 13px;">
                                <i class="fas fa-paper-plane"></i>
                                <span>Enviar Solicitação</span>
                            </button>
                        </form>
                    </div>

                    <div class="invite-section">
                        <div style="background: rgba(246, 173, 85, 0.15); border: 1px solid var(--status-yellow); padding: 10px 12px; border-radius: 6px; font-size: 12px; color: #ffeb3b;">
                            ⚠️ <strong>Importante:</strong> Não adianta me adicionar manualmente no grupo pelo WhatsApp! Eu não consigo aceitar diretamente no whats — apenas pelo link enviado para meu PV ou submetido pelo formulário acima.
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

            const form = body.querySelector('#invite-form');
            const submitBtn = body.querySelector('#invite-submit-btn');
            const statusDiv = body.querySelector('#invite-form-status');

            if (form) {
                form.addEventListener('submit', async (e) => {
                    e.preventDefault();

                    const linkInput = body.querySelector('#invite-input-link');
                    const contactInput = body.querySelector('#invite-input-contact');
                    const reasonInput = body.querySelector('#invite-input-reason');

                    const link = (linkInput?.value || '').trim();
                    const contato = (contactInput?.value || '').trim();
                    const motivo = (reasonInput?.value || '').trim();

                    if (!link || !contato || !motivo) {
                        if (statusDiv) {
                            statusDiv.innerHTML = '<span style="color: #ff6b6b;"><i class="fas fa-exclamation-circle"></i> Por favor, preencha todos os campos obrigatórios.</span>';
                        }
                        return;
                    }

                    if (submitBtn) {
                        submitBtn.disabled = true;
                        submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> <span>Enviando solicitação...</span>';
                    }
                    if (statusDiv) {
                        statusDiv.innerHTML = '<span style="color: var(--cyan-neon);"><i class="fas fa-spinner fa-spin"></i> Encaminhando para a moderação...</span>';
                    }

                    try {
                        const resp = await fetch('/api/invite', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ link, contato, motivo })
                        });
                        const resData = await resp.json().catch(() => ({}));

                        if (resp.ok && resData.status === 'ok') {
                            if (statusDiv) {
                                statusDiv.innerHTML = `<span style="color: var(--status-green); font-weight: 600;"><i class="fas fa-check-circle"></i> ${resData.message || 'Solicitação enviada com sucesso!'}</span>`;
                            }
                            form.reset();
                        } else {
                            if (statusDiv) {
                                statusDiv.innerHTML = `<span style="color: #ff6b6b;"><i class="fas fa-times-circle"></i> ${resData.message || 'Erro ao enviar solicitação. Verifique os dados e tente novamente.'}</span>`;
                            }
                        }
                    } catch (err) {
                        if (statusDiv) {
                            statusDiv.innerHTML = '<span style="color: #ff6b6b;"><i class="fas fa-times-circle"></i> Falha de conexão ao enviar solicitação. Tente novamente mais tarde.</span>';
                        }
                    } finally {
                        if (submitBtn) {
                            submitBtn.disabled = false;
                            submitBtn.innerHTML = '<i class="fas fa-paper-plane"></i> <span>Enviar Solicitação</span>';
                        }
                    }
                });
            }
        };

        renderPage();
    }
});
