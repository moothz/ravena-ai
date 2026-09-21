/**
 * Gerenciador de Instâncias e Bots da Ravena
 * Layout Moderno, Sanfonas Múltiplas, Controles Coerentes e Sincronização em Tempo Real
 */
document.addEventListener('DOMContentLoaded', () => {
    // Referências DOM
    const instancesContainer = document.getElementById('instances-container');
    const loadingBox = document.getElementById('loading-box');
    const errorBox = document.getElementById('error-box');
    const errorMessage = document.getElementById('error-message');
    const emptyState = document.getElementById('empty-state');
    const toastContainer = document.getElementById('toast-container');
    
    // Controles & Botões
    const searchInput = document.getElementById('search-input');
    const btnClearSearch = document.getElementById('btn-clear-search');
    const filterPills = document.querySelectorAll('.filter-pills .cat-pill');
    const btnExpandAll = document.getElementById('btn-expand-all');
    const btnCollapseAll = document.getElementById('btn-collapse-all');
    const btnRefresh = document.getElementById('btn-refresh');
    const refreshIcon = document.getElementById('refresh-icon');
    const btnSaveAll = document.getElementById('btn-save-all');
    const btnNewInstance = document.getElementById('btn-new-instance');
    const btnRetry = document.getElementById('btn-retry');

    // Sumário
    const sumTotal = document.getElementById('sum-total');
    const sumEnabled = document.getElementById('sum-enabled');
    const sumDisabled = document.getElementById('sum-disabled');
    const sumOnline = document.getElementById('sum-online');
    const sumOffline = document.getElementById('sum-offline');
    const sumPrivate = document.getElementById('sum-private');
    const sumGroups = document.getElementById('sum-groups');
    const sumMsgs = document.getElementById('sum-msgs');

    // Estado da Aplicação
    let allBots = [];
    let currentFilter = 'all';
    let currentSearch = '';
    let openBotIds = new Set(); // Preserva quais sanfonas estão abertas
    let isSaving = false;

    // Toast Notification
    function showToast(message, type = 'info', duration = 4000) {
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        
        const iconClass = type === 'success' ? 'fa-check-circle' : (type === 'error' ? 'fa-exclamation-triangle' : 'fa-info-circle');
        toast.innerHTML = `<i class="fas ${iconClass}"></i><span>${message}</span>`;
        
        toastContainer.appendChild(toast);
        // Animação de entrada
        setTimeout(() => toast.classList.add('show'), 10);

        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, duration);
    }

    // Gerador de senha aleatória segura
    function generateSecurePassword(length = 16) {
        const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%&*';
        let res = '';
        for (let i = 0; i < length; i++) {
            res += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return res;
    }

    // Formatação de telefone
    function formatPhoneNumber(num) {
        if (!num) return '-';
        const clean = String(num).replace(/\D/g, '');
        if (clean.length === 12 || clean.length === 13) {
            const ddd = clean.slice(2, 4);
            const part1 = clean.length === 13 ? clean.slice(4, 9) : clean.slice(4, 8);
            const part2 = clean.length === 13 ? clean.slice(9) : clean.slice(8);
            return `+55 (${ddd}) ${part1}-${part2}`;
        }
        return num;
    }

    // Formatação de tempo decorrido
    function formatTimeSince(timestamp) {
        if (!timestamp) return 'Sem dados';
        const diffMs = Date.now() - Number(timestamp);
        if (diffMs < 0) return 'Agora mesmo';
        const mins = Math.floor(diffMs / 60000);
        if (mins < 1) return 'Menos de 1 min';
        if (mins < 60) return `${mins} min atrás`;
        const hrs = Math.floor(mins / 60);
        if (hrs < 24) return `${hrs}h atrás`;
        const days = Math.floor(hrs / 24);
        return `${days}d atrás`;
    }

    // Carregamento dos dados dos bots
    async function fetchBots(isBackground = false) {
        if (!isBackground) {
            loadingBox.style.display = 'block';
            errorBox.style.display = 'none';
            emptyState.style.display = 'none';
        }

        if (refreshIcon) refreshIcon.classList.add('fa-spin');

        try {
            const response = await fetch('/api/bots');
            if (!response.ok) {
                throw new Error(`Erro na API (${response.status}): ${response.statusText}`);
            }

            const data = await response.json();
            if (!Array.isArray(data)) {
                throw new Error('Formato inválido retornado pela API.');
            }

            allBots = data;
            updateSummaryCounters();
            renderBotAccordions();

            loadingBox.style.display = 'none';
        } catch (err) {
            console.error('Erro ao carregar bots:', err);
            if (!isBackground) {
                loadingBox.style.display = 'none';
                errorBox.style.display = 'block';
                errorMessage.textContent = err.message || 'Falha na conexão com o servidor.';
            }
            showToast(`Erro ao carregar bots: ${err.message}`, 'error');
        } finally {
            if (refreshIcon) refreshIcon.classList.remove('fa-spin');
        }
    }

    // Atualização dos contadores do Hero
    function updateSummaryCounters() {
        let total = allBots.length;
        let enabledCount = 0;
        let disabledCount = 0;
        let onlineCount = 0;
        let offlineCount = 0;
        let privateCount = 0;
        let totalGroups = 0;
        let totalMsgs = 0;

        allBots.forEach(bot => {
            const isEnabled = bot.enabled !== false;
            const isOnline = Boolean(bot.connected && !bot.banido && isEnabled);

            if (isEnabled) enabledCount++;
            else disabledCount++;

            if (isOnline) onlineCount++;
            else offlineCount++;

            if (bot.privado) privateCount++;
            totalGroups += (bot.groupsCount || 0);
            totalMsgs += Math.round(bot.msgsHr || 0);
        });

        sumTotal.textContent = total;
        sumEnabled.textContent = enabledCount;
        sumDisabled.textContent = disabledCount;
        sumOnline.textContent = onlineCount;
        sumOffline.textContent = offlineCount;
        sumPrivate.textContent = privateCount;
        sumGroups.textContent = totalGroups.toLocaleString('pt-BR');
        sumMsgs.textContent = totalMsgs.toLocaleString('pt-BR');
    }

    // Renderização das Sanfonas
    function renderBotAccordions() {
        instancesContainer.innerHTML = '';
        const searchLower = currentSearch.toLowerCase().trim();

        const filtered = allBots.filter(bot => {
            // Filtro por texto
            const matchesSearch = !searchLower ||
                (bot.nome && bot.nome.toLowerCase().includes(searchLower)) ||
                (bot.nomeExibir && bot.nomeExibir.toLowerCase().includes(searchLower)) ||
                (bot.numero && String(bot.numero).includes(searchLower)) ||
                (bot.telegramBotName && bot.telegramBotName.toLowerCase().includes(searchLower));

            if (!matchesSearch) return false;

            // Filtro por botões
            const isEnabled = bot.enabled !== false;
            const isOnline = Boolean(bot.connected && !bot.banido && isEnabled);
            const isOffline = !isOnline;

            if (currentFilter === 'enabled') return isEnabled;
            if (currentFilter === 'disabled') return !isEnabled;
            if (currentFilter === 'online') return isOnline;
            if (currentFilter === 'offline') return isOffline;
            if (currentFilter === 'whatsapp') return !bot.useTelegram && !bot.useDiscord;
            if (currentFilter === 'telegram') return Boolean(bot.useTelegram);
            if (currentFilter === 'discord') return Boolean(bot.useDiscord);

            return true;
        });

        if (filtered.length === 0) {
            emptyState.style.display = 'block';
            return;
        } else {
            emptyState.style.display = 'none';
        }

        filtered.forEach(bot => {
            const accordion = createBotAccordionElement(bot);
            instancesContainer.appendChild(accordion);
        });
    }

    // Criação do elemento de sanfona para uma instância
    function createBotAccordionElement(bot) {
        const isEnabled = bot.enabled !== false;
        const isOnline = Boolean(bot.connected && !bot.banido && isEnabled);
        const isBanned = Boolean(bot.banido);
        const platform = bot.useTelegram ? 'Telegram' : (bot.useDiscord ? 'Discord' : 'WhatsApp');
        
        let statusClass = 'status-offline';
        let statusBadge = '<span class="badge badge-offline"><i class="fas fa-times-circle"></i> Offline</span>';

        if (!isEnabled) {
            statusClass = 'status-disabled';
            statusBadge = '<span class="badge badge-disabled"><i class="fas fa-power-off"></i> Desativada</span>';
        } else if (isBanned) {
            statusClass = 'status-banned';
            statusBadge = '<span class="badge badge-banned"><i class="fas fa-ban"></i> Banida</span>';
        } else if (isOnline) {
            statusClass = 'status-online';
            statusBadge = '<span class="badge badge-online"><i class="fas fa-check-circle"></i> Online</span>';
        }

        const platformIcon = platform === 'Telegram' 
            ? '<i class="fab fa-telegram" style="color:#2AABEE;"></i>' 
            : (platform === 'Discord' ? '<i class="fab fa-discord" style="color:#5865F2;"></i>' : '<i class="fab fa-whatsapp" style="color:#25D366;"></i>');

        const isOpen = openBotIds.has(bot.nome);

        const card = document.createElement('div');
        card.className = `bot-accordion ${statusClass} ${isOpen ? 'active' : ''}`;
        card.dataset.botName = bot.nome;

        const rawPhone = bot.numero ? String(bot.numero).replace(/\D/g, '') : '';
        const cleanPhone = formatPhoneNumber(rawPhone);
        const chatUrl = platform === 'Telegram' 
            ? `https://t.me/${bot.telegramBotName || bot.nome}`
            : `https://wa.me/${rawPhone}`;

        const msgsHr = Math.round(bot.msgsHr || 0);
        const groupsCount = bot.groupsCount || 0;
        const avgDelay = bot.responseTime ? (bot.responseTime.avg || 0) : 0;

        card.innerHTML = `
            <div class="bot-accordion-header">
                <div class="bot-header-main">
                    <span class="bot-title">
                        ${platformIcon}
                        <span>${bot.nomeExibir || bot.nome}</span>
                        ${bot.nomeExibir && bot.nomeExibir !== bot.nome ? `<small style="font-size:0.75rem; color:var(--text-muted);">(${bot.nome})</small>` : ''}
                    </span>
                    ${statusBadge}
                    ${bot.privado ? '<span class="badge badge-private"><i class="fas fa-lock"></i> Privada</span>' : ''}
                    ${bot.vip ? '<span class="badge badge-vip"><i class="fas fa-gem"></i> VIP</span>' : ''}
                    ${bot.comunitario ? '<span class="badge badge-community"><i class="fas fa-hands-helping"></i> Comunitária</span>' : ''}
                    <span class="badge badge-platform">${platform}</span>
                    <span class="badge badge-stat" title="Mensagens por hora"><i class="fas fa-envelope"></i> ${msgsHr} msgs/h</span>
                    <span class="badge badge-stat" title="Grupos conectados"><i class="fas fa-users"></i> ${groupsCount} grupos</span>
                    ${avgDelay > 0 ? `<span class="badge badge-stat" title="Delay médio de resposta">⚡ ${avgDelay.toFixed(1)}s</span>` : ''}
                </div>
                <i class="fas fa-chevron-down bot-arrow"></i>
            </div>

            <div class="bot-accordion-body">
                <!-- Seção 1: Identificação & Acesso -->
                <div class="form-section">
                    <div class="form-section-title"><i class="fas fa-id-card"></i> Identificação & Acesso ao Painel</div>
                    <div class="form-grid">
                        <div class="form-group">
                            <label>Identificador Único (nome) *</label>
                            <input type="text" class="form-control field-nome" value="${bot.nome || ''}" placeholder="ex: ravena1" ${bot.isNew ? '' : 'readonly'}>
                            <div class="field-hint">Nome único da instância no bots.json (não editável após criada).</div>
                        </div>
                        <div class="form-group">
                            <label>Nome de Exibição (nomeExibir)</label>
                            <input type="text" class="form-control field-nome-exibir" value="${bot.nomeExibir || ''}" placeholder="ex: Ravena VIP">
                            <div class="field-hint">Nome amigável exibido nas saudações e menus.</div>
                        </div>
                        <div class="form-group">
                            <label>Número de Telefone (numero)</label>
                            <input type="text" class="form-control field-numero" value="${bot.numero || ''}" placeholder="ex: 5511999999999">
                            <div class="field-hint">Número internacional do WhatsApp sem símbolos.</div>
                        </div>
                        <div class="form-group">
                            <label>Prefixo Customizado (customPrefix)</label>
                            <input type="text" class="form-control field-custom-prefix" value="${bot.customPrefix || '!'}" placeholder="ex: ! ou /" maxlength="3">
                            <div class="field-hint">Símbolo que aciona comandos nesta instância.</div>
                        </div>
                        <div class="form-group">
                            <label>Usuário do Painel (managementUser)</label>
                            <input type="text" class="form-control field-mgmt-user" value="${bot.managementUser || ''}" placeholder="ex: admin">
                            <div class="field-hint">Usuário para acesso administrativo a /manage.</div>
                        </div>
                        <div class="form-group">
                            <label>Senha do Painel (managementPW)</label>
                            <div class="input-with-actions">
                                <input type="password" class="form-control field-mgmt-pw" value="${bot.managementPW || ''}" placeholder="Senha de acesso">
                                <button type="button" class="btn btn-secondary btn-sm btn-toggle-pw" title="Mostrar/Ocultar"><i class="fas fa-eye"></i></button>
                                <button type="button" class="btn btn-secondary btn-sm btn-gen-pw" title="Gerar Senha Segura"><i class="fas fa-dice"></i></button>
                            </div>
                            <div class="field-hint">Senha segura para acesso ao painel do grupo.</div>
                        </div>
                    </div>
                </div>

                <!-- Seção 2: Comportamento & Flags -->
                <div class="form-section">
                    <div class="form-section-title"><i class="fas fa-sliders-h"></i> Flags de Comportamento</div>
                    <div class="toggle-grid">
                        <div class="toggle-card" style="border-left: 3px solid var(--primary-color);">
                            <div class="toggle-info">
                                <span class="toggle-title">Instância Ativa</span>
                                <span class="toggle-desc">Habilita ou desativa a leitura e respostas</span>
                            </div>
                            <label class="switch-toggle">
                                <input type="checkbox" class="field-enabled" ${isEnabled ? 'checked' : ''}>
                                <span class="slider-round"></span>
                            </label>
                        </div>

                        <div class="toggle-card">
                            <div class="toggle-info">
                                <span class="toggle-title">Instância Privada</span>
                                <span class="toggle-desc">Restrita a grupos do proprietário</span>
                            </div>
                            <label class="switch-toggle">
                                <input type="checkbox" class="field-privado" ${bot.privado ? 'checked' : ''}>
                                <span class="slider-round"></span>
                            </label>
                        </div>

                        <div class="toggle-card">
                            <div class="toggle-info">
                                <span class="toggle-title">Bot VIP</span>
                                <span class="toggle-desc">Atributos prioritários e limites VIP</span>
                            </div>
                            <label class="switch-toggle">
                                <input type="checkbox" class="field-vip" ${bot.vip ? 'checked' : ''}>
                                <span class="slider-round"></span>
                            </label>
                        </div>

                        <div class="toggle-card">
                            <div class="toggle-info">
                                <span class="toggle-title">Comunitária</span>
                                <span class="toggle-desc">Mantida por membro da comunidade</span>
                            </div>
                            <label class="switch-toggle">
                                <input type="checkbox" class="field-comunitario" ${bot.comunitario ? 'checked' : ''}>
                                <span class="slider-round"></span>
                            </label>
                        </div>

                        <div class="toggle-card">
                            <div class="toggle-info">
                                <span class="toggle-title">Ignorar PV</span>
                                <span class="toggle-desc">Não responde mensagens privadas</span>
                            </div>
                            <label class="switch-toggle">
                                <input type="checkbox" class="field-ignore-pv" ${bot.ignorePV ? 'checked' : ''}>
                                <span class="slider-round"></span>
                            </label>
                        </div>

                        <div class="toggle-card">
                            <div class="toggle-info">
                                <span class="toggle-title">Download Auto no PV</span>
                                <span class="toggle-desc">Baixa mídias de links enviados no PV</span>
                            </div>
                            <label class="switch-toggle">
                                <input type="checkbox" class="field-auto-download-pv" ${bot.autoDownloadPV ? 'checked' : ''}>
                                <span class="slider-round"></span>
                            </label>
                        </div>

                        <div class="toggle-card">
                            <div class="toggle-info">
                                <span class="toggle-title">IA no Privado (pvAI)</span>
                                <span class="toggle-desc">Conversa com IA em mensagens privadas</span>
                            </div>
                            <label class="switch-toggle">
                                <input type="checkbox" class="field-pv-ai" ${bot.pvAI ? 'checked' : ''}>
                                <span class="slider-round"></span>
                            </label>
                        </div>

                        <div class="toggle-card">
                            <div class="toggle-info">
                                <span class="toggle-title">Ignorar Convites</span>
                                <span class="toggle-desc">Não entra automaticamente via links</span>
                            </div>
                            <label class="switch-toggle">
                                <input type="checkbox" class="field-ignore-invites" ${bot.ignoreInvites ? 'checked' : ''}>
                                <span class="slider-round"></span>
                            </label>
                        </div>

                        <div class="toggle-card">
                            <div class="toggle-info">
                                <span class="toggle-title">Notificar Doação</span>
                                <span class="toggle-desc">Envia avisos de doações recebidas</span>
                            </div>
                            <label class="switch-toggle">
                                <input type="checkbox" class="field-notificar-donate" ${bot.notificarDonate ? 'checked' : ''}>
                                <span class="slider-round"></span>
                            </label>
                        </div>

                        <div class="toggle-card">
                            <div class="toggle-info">
                                <span class="toggle-title">Atualizar Status</span>
                                <span class="toggle-desc">Atualiza recado do perfil no scheduler</span>
                            </div>
                            <label class="switch-toggle">
                                <input type="checkbox" class="field-update-status" ${bot.updateStatus !== false ? 'checked' : ''}>
                                <span class="slider-round"></span>
                            </label>
                        </div>

                        <div class="toggle-card">
                            <div class="toggle-info">
                                <span class="toggle-title">Enviar Info ao Entrar</span>
                                <span class="toggle-desc">Manda mensagem de boas-vindas ao grupo</span>
                            </div>
                            <label class="switch-toggle">
                                <input type="checkbox" class="field-send-join-info" ${bot.sendJoinInfo ? 'checked' : ''}>
                                <span class="slider-round"></span>
                            </label>
                        </div>

                        <div class="toggle-card">
                            <div class="toggle-info">
                                <span class="toggle-title">Marcada Banida</span>
                                <span class="toggle-desc">Identifica instância com bloqueio oficial</span>
                            </div>
                            <label class="switch-toggle">
                                <input type="checkbox" class="field-banido" ${bot.banido ? 'checked' : ''}>
                                <span class="slider-round"></span>
                            </label>
                        </div>
                    </div>
                </div>

                <!-- Seção 3: Personalidade & Mensagens -->
                <div class="form-section">
                    <div class="form-section-title"><i class="fas fa-brain"></i> Personalidade da IA & Mensagens de Suporte</div>
                    <div class="form-grid">
                        <div class="form-group" style="grid-column: 1 / -1;">
                            <label>Personalidade da IA (aiPersonality)</label>
                            <textarea class="form-control field-ai-personality" placeholder="Defina a personalidade customizada desta Ravena (ex: bem-humorada, debochada, formal, etc.)...">${bot.aiPersonality || ''}</textarea>
                            <div class="field-hint">Injetada como contexto de sistema em comandos de IA para este bot.</div>
                        </div>
                        <div class="form-group">
                            <label>Mensagem de Suporte (msgSuporte)</label>
                            <textarea class="form-control field-msg-suporte" placeholder="Mensagem padrão enviada ao pedir suporte...">${bot.msgSuporte || bot.supportMsg || ''}</textarea>
                            <div class="field-hint">Texto explicativo de contato para suporte com o administrador.</div>
                        </div>
                        <div class="form-group">
                            <label>Número do Responsável (numeroResponsavel)</label>
                            <input type="text" class="form-control field-numero-responsavel" value="${bot.numeroResponsavel || ''}" placeholder="ex: 5511999998888">
                            <div class="field-hint">Contato do ADM ou dono desta ravena comunitária.</div>
                        </div>
                    </div>
                </div>

                <!-- Seção 4: Canais & Grupos JID -->
                <div class="form-section">
                    <div class="form-section-title"><i class="fas fa-hashtag"></i> Grupos & Canais Notificadores</div>
                    <div class="form-grid-3">
                        <div class="form-group">
                            <label>Grupo de Logs (grupoLogs)</label>
                            <input type="text" class="form-control field-grupo-logs" value="${bot.grupoLogs || ''}" placeholder="ex: 1203634...@g.us">
                            <div class="field-hint">JID do grupo para envio de logs.</div>
                        </div>
                        <div class="form-group">
                            <label>Grupo de Avisos (grupoAvisos)</label>
                            <input type="text" class="form-control field-grupo-avisos" value="${bot.grupoAvisos || ''}" placeholder="ex: 1203634...@g.us">
                            <div class="field-hint">JID do grupo para comunicados.</div>
                        </div>
                        <div class="form-group">
                            <label>Grupo de Convites (grupoInvites)</label>
                            <input type="text" class="form-control field-grupo-invites" value="${bot.grupoInvites || ''}" placeholder="ex: 1203634...@g.us">
                            <div class="field-hint">JID do grupo de triagem de convites.</div>
                        </div>
                        <div class="form-group">
                            <label>Grupo de Dossiês (dossieGroups)</label>
                            <input type="text" class="form-control field-dossie-groups" value="${bot.dossieGroups || ''}" placeholder="ex: 1203634...@g.us">
                            <div class="field-hint">JID para envio de dossiês automáticos.</div>
                        </div>
                        <div class="form-group">
                            <label>Grupo Estabilidade (grupoEstabilidade)</label>
                            <input type="text" class="form-control field-grupo-estabilidade" value="${bot.grupoEstabilidade || ''}" placeholder="ex: 1203634...@g.us">
                            <div class="field-hint">JID para monitoramento de estabilidade.</div>
                        </div>
                        <div class="form-group">
                            <label>Porta Webhook (webhookPort)</label>
                            <input type="number" class="form-control field-webhook-port" value="${bot.webhookPort || ''}" placeholder="ex: 6200">
                            <div class="field-hint">Porta HTTP para eventos do Whatsmeow Go.</div>
                        </div>
                    </div>
                </div>

                <!-- Seção 5: Integração Externa (Telegram / Discord) -->
                <div class="form-section">
                    <div class="form-section-title"><i class="fas fa-network-wired"></i> Conexão Multiplataforma (Telegram / Discord)</div>
                    <div class="form-grid">
                        <div class="form-group">
                            <label>Usar Telegram (useTelegram)</label>
                            <label class="switch-toggle">
                                <input type="checkbox" class="field-use-telegram" ${bot.useTelegram ? 'checked' : ''}>
                                <span class="slider-round"></span>
                            </label>
                        </div>
                        <div class="form-group">
                            <label>Telegram Bot Token</label>
                            <input type="password" class="form-control field-telegram-token" value="${bot.telegramBotToken || ''}" placeholder="Token do BotFather">
                        </div>
                        <div class="form-group">
                            <label>Telegram Bot Name</label>
                            <input type="text" class="form-control field-telegram-name" value="${bot.telegramBotName || ''}" placeholder="ex: ravenosabot">
                        </div>
                        <div class="form-group">
                            <label>Usar Discord (useDiscord)</label>
                            <label class="switch-toggle">
                                <input type="checkbox" class="field-use-discord" ${bot.useDiscord ? 'checked' : ''}>
                                <span class="slider-round"></span>
                            </label>
                        </div>
                        <div class="form-group" style="grid-column: 1 / -1;">
                            <label>Discord Bot Token</label>
                            <input type="password" class="form-control field-discord-token" value="${bot.discordToken || ''}" placeholder="Token da aplicação no Discord Developer Portal">
                        </div>
                    </div>
                </div>

                <!-- Seção 6: Construtor Dinâmico de Extras (3 Níveis) -->
                <div class="form-section">
                    <div class="form-section-title">
                        <span><i class="fas fa-cubes"></i> Parâmetros Extras (3 Níveis: extras &rarr; categoria &rarr; propriedade)</span>
                    </div>
                    <div class="extras-container" id="extras-container-${bot.nome}">
                        <!-- Categorias de extras renderizadas aqui -->
                    </div>
                    <div class="extras-actions-bar">
                        <button type="button" class="btn btn-secondary btn-sm btn-add-extra-cat">
                            <i class="fas fa-folder-plus"></i> Adicionar Categoria de Extras
                        </button>
                    </div>
                </div>

                <!-- Seção 7: Ações da Instância -->
                <div class="bot-card-actions">
                    <div class="bot-actions-left">
                        <button type="button" class="btn btn-primary btn-save-instance">
                            <i class="fas fa-save"></i> Salvar Esta Instância
                        </button>
                        <button type="button" class="btn btn-secondary btn-restart-bot">
                            <i class="fas fa-sync-alt"></i> Reiniciar Bot
                        </button>
                        ${platform === 'WhatsApp' ? `
                            <a href="/qrcode/${bot.nome}" target="_blank" class="btn btn-secondary">
                                <i class="fas fa-qrcode"></i> QRCode / Reconectar
                            </a>
                        ` : ''}
                        ${rawPhone ? `
                            <a href="${chatUrl}" target="_blank" class="btn btn-secondary">
                                <i class="fas fa-comment-dots"></i> Abrir Conversa
                            </a>
                        ` : ''}
                    </div>
                    <div class="bot-actions-right">
                        <button type="button" class="btn btn-danger-outline btn-logout-bot">
                            <i class="fas fa-sign-out-alt"></i> Desconectar Sessão
                        </button>
                    </div>
                </div>
            </div>
        `;

        // Evento de Toggle da Sanfona
        const header = card.querySelector('.bot-accordion-header');
        header.addEventListener('click', () => {
            const willOpen = !card.classList.contains('active');
            card.classList.toggle('active', willOpen);
            if (willOpen) {
                openBotIds.add(bot.nome);
            } else {
                openBotIds.delete(bot.nome);
            }
        });

        // Toggle Mostrar/Ocultar Senha
        const togglePwBtn = card.querySelector('.btn-toggle-pw');
        const pwInput = card.querySelector('.field-mgmt-pw');
        if (togglePwBtn && pwInput) {
            togglePwBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const isPassword = pwInput.type === 'password';
                pwInput.type = isPassword ? 'text' : 'password';
                togglePwBtn.innerHTML = isPassword ? '<i class="fas fa-eye-slash"></i>' : '<i class="fas fa-eye"></i>';
            });
        }

        // Gerar Senha Segura
        const genPwBtn = card.querySelector('.btn-gen-pw');
        if (genPwBtn && pwInput) {
            genPwBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const newPass = generateSecurePassword(16);
                pwInput.value = newPass;
                pwInput.type = 'text';
                if (togglePwBtn) togglePwBtn.innerHTML = '<i class="fas fa-eye-slash"></i>';
                showToast(`Nova senha gerada para '${bot.nome}'! Lembre-se de salvar.`, 'info');
            });
        }

        // Construtor de Extras
        const extrasContainer = card.querySelector(`#extras-container-${bot.nome}`);
        renderExtrasBuilder(extrasContainer, bot.extras || {});

        const addExtraCatBtn = card.querySelector('.btn-add-extra-cat');
        if (addExtraCatBtn) {
            addExtraCatBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const catName = prompt('Digite o nome da nova categoria de extras (ex: stickers, jogos, ai):');
                if (!catName) return;
                const cleanCat = catName.trim().replace(/[^a-zA-Z0-9_-]/g, '');
                if (!cleanCat) {
                    alert('Nome de categoria inválido. Use apenas letras, números, _ ou -.');
                    return;
                }
                if (!bot.extras) bot.extras = {};
                if (bot.extras[cleanCat]) {
                    alert(`A categoria '${cleanCat}' já existe.`);
                    return;
                }
                bot.extras[cleanCat] = {};
                renderExtrasBuilder(extrasContainer, bot.extras);
                showToast(`Categoria '${cleanCat}' adicionada aos extras!`, 'info');
            });
        }

        // Salvar Esta Instância
        const saveInstanceBtn = card.querySelector('.btn-save-instance');
        if (saveInstanceBtn) {
            saveInstanceBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                updateBotDataFromCard(card, bot);
                await saveAllBotsToServer(bot.nome);
            });
        }

        // Reiniciar Bot
        const restartBtn = card.querySelector('.btn-restart-bot');
        if (restartBtn) {
            restartBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (!confirm(`Deseja reiniciar o bot '${bot.nome}'?`)) return;
                restartBtn.disabled = true;
                restartBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Reiniciando...';
                try {
                    const resp = await fetch(`/restart/${bot.nome}`);
                    const resJson = await resp.json();
                    showToast(`Reinício de '${bot.nome}': ${resJson.message || 'Sucesso'}`, 'success');
                    setTimeout(() => fetchBots(true), 2500);
                } catch (err) {
                    showToast(`Erro ao reiniciar '${bot.nome}': ${err.message}`, 'error');
                } finally {
                    restartBtn.disabled = false;
                    restartBtn.innerHTML = '<i class="fas fa-sync-alt"></i> Reiniciar Bot';
                }
            });
        }

        // Desconectar Bot
        const logoutBtn = card.querySelector('.btn-logout-bot');
        if (logoutBtn) {
            logoutBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (!confirm(`ATENÇÃO: Deseja realmente desconectar a sessão do bot '${bot.nome}'?`)) return;
                logoutBtn.disabled = true;
                logoutBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Desconectando...';
                try {
                    const resp = await fetch(`/logout/${bot.nome}`);
                    const resJson = await resp.json();
                    showToast(`Logout '${bot.nome}': ${resJson.message || resJson.status}`, 'info');
                    setTimeout(() => fetchBots(true), 2500);
                } catch (err) {
                    showToast(`Erro ao desconectar '${bot.nome}': ${err.message}`, 'error');
                } finally {
                    logoutBtn.disabled = false;
                    logoutBtn.innerHTML = '<i class="fas fa-sign-out-alt"></i> Desconectar Sessão';
                }
            });
        }

        return card;
    }

    // Renderizador do Construtor de Extras (3 níveis)
    function renderExtrasBuilder(container, extrasObj) {
        container.innerHTML = '';

        const categories = Object.keys(extrasObj || {});
        if (categories.length === 0) {
            container.innerHTML = `
                <div style="font-size:0.8rem; color:var(--text-muted); font-style:italic; padding: 6px 0;">
                    Nenhum parâmetro extra configurado. Clique em "Adicionar Categoria de Extras" abaixo se precisar configurar regras extras (ex: stickers.maxFiga).
                </div>
            `;
            return;
        }

        categories.forEach(catKey => {
            const catCard = document.createElement('div');
            catCard.className = 'extras-cat-card';
            catCard.dataset.catKey = catKey;

            const propsObj = extrasObj[catKey] || {};
            const propKeys = Object.keys(propsObj);

            catCard.innerHTML = `
                <div class="extras-cat-header">
                    <span class="extras-cat-title"><i class="fas fa-folder-open"></i> ${catKey}</span>
                    <div style="display:flex; gap:6px;">
                        <button type="button" class="btn btn-secondary btn-sm btn-add-prop" title="Adicionar Propriedade"><i class="fas fa-plus"></i> Propriedade</button>
                        <button type="button" class="btn btn-danger-outline btn-sm btn-del-cat" title="Remover Categoria"><i class="fas fa-trash"></i></button>
                    </div>
                </div>
                <div class="extras-props-list">
                    <!-- Linhas de propriedades -->
                </div>
            `;

            const propsList = catCard.querySelector('.extras-props-list');

            if (propKeys.length === 0) {
                propsList.innerHTML = `<div style="font-size:0.75rem; color:var(--text-muted); font-style:italic;">Nenhuma propriedade nesta categoria.</div>`;
            } else {
                propKeys.forEach(propKey => {
                    const propVal = propsObj[propKey];
                    const propRow = createPropertyRowElement(catKey, propKey, propVal, extrasObj);
                    propsList.appendChild(propRow);
                });
            }

            // Botão Adicionar Propriedade
            const addPropBtn = catCard.querySelector('.btn-add-prop');
            addPropBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const newPropKey = prompt(`Digite o nome da propriedade para '${catKey}':`);
                if (!newPropKey) return;
                const cleanKey = newPropKey.trim().replace(/[^a-zA-Z0-9_-]/g, '');
                if (!cleanKey) {
                    alert('Nome de propriedade inválido.');
                    return;
                }
                if (extrasObj[catKey][cleanKey] !== undefined) {
                    alert(`A propriedade '${cleanKey}' já existe nesta categoria.`);
                    return;
                }
                extrasObj[catKey][cleanKey] = '';
                renderExtrasBuilder(container, extrasObj);
            });

            // Botão Remover Categoria
            const delCatBtn = catCard.querySelector('.btn-del-cat');
            delCatBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!confirm(`Deseja remover a categoria de extras '${catKey}' e todas as suas propriedades?`)) return;
                delete extrasObj[catKey];
                renderExtrasBuilder(container, extrasObj);
            });

            container.appendChild(catCard);
        });
    }

    // Criação de uma linha de propriedade no construtor de extras
    function createPropertyRowElement(catKey, propKey, propVal, extrasObj) {
        const row = document.createElement('div');
        row.className = 'extras-prop-row';

        let detectedType = 'string';
        if (typeof propVal === 'number') detectedType = 'number';
        else if (typeof propVal === 'boolean') detectedType = 'boolean';

        row.innerHTML = `
            <input type="text" class="form-control extras-prop-key" value="${propKey}" placeholder="Chave (propriedade)">
            <select class="form-control extras-prop-type">
                <option value="string" ${detectedType === 'string' ? 'selected' : ''}>Texto</option>
                <option value="number" ${detectedType === 'number' ? 'selected' : ''}>Número</option>
                <option value="boolean" ${detectedType === 'boolean' ? 'selected' : ''}>Booleano</option>
            </select>
            <div class="extras-val-container" style="flex: 1.5; min-width: 150px; display:flex;">
                <!-- Campo de valor dinâmico baseado no tipo -->
            </div>
            <button type="button" class="btn btn-danger-outline btn-sm btn-del-prop" title="Excluir propriedade"><i class="fas fa-times"></i></button>
        `;

        const valContainer = row.querySelector('.extras-val-container');
        const typeSelect = row.querySelector('.extras-prop-type');
        const keyInput = row.querySelector('.extras-prop-key');

        function renderValInput(type, currentVal) {
            valContainer.innerHTML = '';
            if (type === 'boolean') {
                const sel = document.createElement('select');
                sel.className = 'form-control extras-prop-val';
                sel.innerHTML = `
                    <option value="true" ${Boolean(currentVal) === true ? 'selected' : ''}>true (Verdadeiro)</option>
                    <option value="false" ${Boolean(currentVal) === false ? 'selected' : ''}>false (Falso)</option>
                `;
                valContainer.appendChild(sel);
            } else if (type === 'number') {
                const num = document.createElement('input');
                num.type = 'number';
                num.className = 'form-control extras-prop-val';
                num.value = currentVal !== undefined ? Number(currentVal) : 0;
                valContainer.appendChild(num);
            } else {
                const txt = document.createElement('input');
                txt.type = 'text';
                txt.className = 'form-control extras-prop-val';
                txt.value = currentVal !== undefined ? String(currentVal) : '';
                valContainer.appendChild(txt);
            }
        }

        renderValInput(detectedType, propVal);

        typeSelect.addEventListener('change', () => {
            const newType = typeSelect.value;
            let currentVal = row.querySelector('.extras-prop-val').value;
            if (newType === 'number') currentVal = Number(currentVal) || 0;
            else if (newType === 'boolean') currentVal = currentVal === 'true';
            renderValInput(newType, currentVal);
        });

        // Excluir Propriedade
        const delPropBtn = row.querySelector('.btn-del-prop');
        delPropBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            delete extrasObj[catKey][propKey];
            row.remove();
        });

        return row;
    }

    // Leitura e atualização dos dados da instância a partir do seu Card Accordion
    function updateBotDataFromCard(card, bot) {
        const getVal = (selector) => {
            const el = card.querySelector(selector);
            return el ? el.value.trim() : '';
        };
        const getBool = (selector) => {
            const el = card.querySelector(selector);
            return el ? Boolean(el.checked) : false;
        };

        bot.nome = getVal('.field-nome') || bot.nome;
        bot.nomeExibir = getVal('.field-nome-exibir') || bot.nome;
        bot.numero = getVal('.field-numero');
        bot.customPrefix = getVal('.field-custom-prefix') || '!';
        bot.managementUser = getVal('.field-mgmt-user');
        bot.managementPW = getVal('.field-mgmt-pw');

        bot.enabled = getBool('.field-enabled');
        bot.privado = getBool('.field-privado');
        bot.vip = getBool('.field-vip');
        bot.comunitario = getBool('.field-comunitario');
        bot.banido = getBool('.field-banido');
        bot.ignorePV = getBool('.field-ignore-pv');
        bot.autoDownloadPV = getBool('.field-auto-download-pv');
        bot.ignoreInvites = getBool('.field-ignore-invites');
        bot.pvAI = getBool('.field-pv-ai');
        bot.notificarDonate = getBool('.field-notificar-donate');
        bot.updateStatus = getBool('.field-update-status');
        bot.sendJoinInfo = getBool('.field-send-join-info');

        bot.aiPersonality = getVal('.field-ai-personality');
        bot.msgSuporte = getVal('.field-msg-suporte');
        bot.numeroResponsavel = getVal('.field-numero-responsavel');

        bot.grupoLogs = getVal('.field-grupo-logs') || null;
        bot.grupoAvisos = getVal('.field-grupo-avisos') || null;
        bot.grupoInvites = getVal('.field-grupo-invites') || null;
        bot.dossieGroups = getVal('.field-dossie-groups') || null;
        bot.grupoEstabilidade = getVal('.field-grupo-estabilidade') || null;
        
        const whPortVal = getVal('.field-webhook-port');
        bot.webhookPort = whPortVal ? parseInt(whPortVal, 10) : null;

        bot.useTelegram = getBool('.field-use-telegram');
        bot.telegramBotToken = getVal('.field-telegram-token');
        bot.telegramBotName = getVal('.field-telegram-name');

        bot.useDiscord = getBool('.field-use-discord');
        bot.discordToken = getVal('.field-discord-token');

        // Extrai o objeto extras reconstruído a partir do DOM
        const extrasContainer = card.querySelector(`#extras-container-${bot.nome}`);
        if (extrasContainer) {
            const newExtras = {};
            const catCards = extrasContainer.querySelectorAll('.extras-cat-card');
            catCards.forEach(cCard => {
                const catKey = cCard.dataset.catKey;
                if (!catKey) return;
                newExtras[catKey] = {};

                const propRows = cCard.querySelectorAll('.extras-prop-row');
                propRows.forEach(pRow => {
                    const pKey = pRow.querySelector('.extras-prop-key').value.trim();
                    const pType = pRow.querySelector('.extras-prop-type').value;
                    const pValEl = pRow.querySelector('.extras-prop-val');
                    if (!pKey || !pValEl) return;

                    let finalVal = pValEl.value;
                    if (pType === 'number') finalVal = Number(finalVal) || 0;
                    else if (pType === 'boolean') finalVal = pValEl.value === 'true';

                    newExtras[catKey][pKey] = finalVal;
                });
            });
            bot.extras = newExtras;
        }

        delete bot.isNew;
    }

    // Salvar todas as instâncias no servidor
    async function saveAllBotsToServer(specificBotTarget = null) {
        if (isSaving) return;

        // Atualiza os dados de todos os cards atualmente renderizados
        const cards = instancesContainer.querySelectorAll('.bot-accordion');
        cards.forEach(card => {
            const bName = card.dataset.botName;
            const targetBot = allBots.find(b => b.nome === bName);
            if (targetBot) {
                updateBotDataFromCard(card, targetBot);
            }
        });

        // Validação básica
        for (const b of allBots) {
            if (!b.nome || b.nome.trim().length === 0) {
                alert('Erro de validação: Toda instância deve possuir um identificador único (nome).');
                return;
            }
            if (!b.useDiscord && (!b.numero || String(b.numero).trim().length === 0)) {
                alert(`Erro de validação: O número de WhatsApp é obrigatório para a instância '${b.nome}'.`);
                return;
            }
        }

        isSaving = true;
        btnSaveAll.disabled = true;
        btnSaveAll.innerHTML = '<i class="fas fa-spinner fa-spin"></i> <span>Salvando...</span>';

        try {
            const response = await fetch('/api/bots', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(allBots)
            });

            const result = await response.json();
            if (!response.ok) {
                throw new Error(result.message || 'Falha ao salvar no servidor.');
            }

            const targetMsg = specificBotTarget 
                ? `Instância '${specificBotTarget}' salva e refletida em tempo real!` 
                : 'Todas as instâncias foram salvas e sincronizadas em tempo real!';

            showToast(targetMsg, 'success');
            await fetchBots(true);
        } catch (err) {
            console.error('Falha ao salvar:', err);
            showToast(`Erro ao salvar: ${err.message}`, 'error', 6000);
            alert(`Erro ao salvar alterações: ${err.message}`);
        } finally {
            isSaving = false;
            btnSaveAll.disabled = false;
            btnSaveAll.innerHTML = '<i class="fas fa-save"></i> <span>Salvar Tudo</span>';
        }
    }

    // Adicionar Nova Instância
    btnNewInstance.addEventListener('click', () => {
        const randId = 'rav-' + Math.floor(1000 + Math.random() * 9000);
        const newBot = {
            enabled: false,
            nome: randId,
            nomeExibir: 'Nova Ravena',
            numero: '',
            customPrefix: '!',
            managementUser: 'admin',
            managementPW: generateSecurePassword(16),
            privado: false,
            vip: false,
            comunitario: false,
            ignorePV: false,
            autoDownloadPV: false,
            ignoreInvites: false,
            pvAI: true,
            notificarDonate: false,
            updateStatus: true,
            sendJoinInfo: false,
            aiPersonality: '',
            msgSuporte: '',
            extras: {},
            isNew: true
        };

        // Adiciona no início da lista
        allBots.unshift(newBot);
        openBotIds.add(newBot.nome);
        updateSummaryCounters();
        renderBotAccordions();

        // Rola até a nova sanfona
        const firstCard = instancesContainer.querySelector('.bot-accordion');
        if (firstCard) {
            firstCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
            const nomeField = firstCard.querySelector('.field-nome');
            if (nomeField) nomeField.focus();
        }

        showToast(`Nova instância criada como desativada. Preencha os campos e salve!`, 'info');
    });

    // Salvar Tudo
    btnSaveAll.addEventListener('click', () => {
        if (!confirm('Deseja salvar as configurações de todas as instâncias? As alterações refletirão imediatamente.')) return;
        saveAllBotsToServer();
    });

    // Filtros por Pills
    filterPills.forEach(pill => {
        pill.addEventListener('click', () => {
            filterPills.forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            currentFilter = pill.dataset.filter;
            renderBotAccordions();
        });
    });

    // Busca por Texto
    searchInput.addEventListener('input', (e) => {
        currentSearch = e.target.value;
        btnClearSearch.style.display = currentSearch.length > 0 ? 'block' : 'none';
        renderBotAccordions();
    });

    btnClearSearch.addEventListener('click', () => {
        searchInput.value = '';
        currentSearch = '';
        btnClearSearch.style.display = 'none';
        renderBotAccordions();
    });

    // Expandir Todas / Recolher Todas
    btnExpandAll.addEventListener('click', () => {
        const cards = instancesContainer.querySelectorAll('.bot-accordion');
        cards.forEach(c => {
            c.classList.add('active');
            if (c.dataset.botName) openBotIds.add(c.dataset.botName);
        });
    });

    btnCollapseAll.addEventListener('click', () => {
        const cards = instancesContainer.querySelectorAll('.bot-accordion');
        cards.forEach(c => c.classList.remove('active'));
        openBotIds.clear();
    });

    // Atualizar manual
    btnRefresh.addEventListener('click', () => fetchBots(false));
    btnRetry.addEventListener('click', () => fetchBots(false));

    // Carregamento inicial
    fetchBots(false);

    // Auto-refresh suave a cada 30 segundos em segundo plano (mantém sanfonas abertas)
    setInterval(() => {
        if (!isSaving) {
            fetchBots(true);
        }
    }, 30000);
});
