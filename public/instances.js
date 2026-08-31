document.addEventListener('DOMContentLoaded', () => {
    const instancesContainer = document.getElementById('instances-container');
    const loadingContainer = document.getElementById('loading-container');
    const errorContainer = document.getElementById('error-container');
    const errorMessage = document.getElementById('error-message');
    const dashboardContent = document.getElementById('dashboard-content');
    const retryButton = document.getElementById('retry-button');
    const refreshButton = document.getElementById('refresh-button');
    const refreshIcon = document.getElementById('refresh-icon');
    const searchInput = document.getElementById('searchInput');
    const filterButtons = document.querySelectorAll('.filter-btn');
    const lastUpdatedText = document.getElementById('last-updated-text');

    // Elementos de Sumário
    const sumTotal = document.getElementById('sum-total');
    const sumOnline = document.getElementById('sum-online');
    const sumOffline = document.getElementById('sum-offline');
    const sumPrivados = document.getElementById('sum-privados');
    const sumGroups = document.getElementById('sum-groups');
    const sumMsgs = document.getElementById('sum-msgs');

    let allBots = [];
    let currentFilter = 'all';
    let currentSearch = '';
    let autoRefreshTimer = null;

    async function fetchInstances(isBackground = false) {
        if (!isBackground) {
            loadingContainer.classList.remove('hidden');
            dashboardContent.classList.add('hidden');
            errorContainer.classList.add('hidden');
        }

        if (refreshIcon) refreshIcon.classList.add('fa-spin');

        try {
            const response = await fetch('/api/instances');
            if (!response.ok) {
                if (response.status === 401) {
                    throw new Error('Não autorizado. Verifique suas credenciais de acesso.');
                }
                throw new Error(`Erro na requisição: ${response.status} ${response.statusText}`);
            }

            const data = await response.json();
            if (data.status !== 'ok' || !Array.isArray(data.bots)) {
                throw new Error(data.message || 'Dados inválidos recebidos da API');
            }

            allBots = data.bots;
            updateSummary(allBots);
            renderBots();

            lastUpdatedText.textContent = `Atualizado às ${new Date().toLocaleTimeString('pt-BR')}`;
            loadingContainer.classList.add('hidden');
            dashboardContent.classList.remove('hidden');
        } catch (error) {
            console.error('Erro ao buscar instâncias:', error);
            if (!isBackground) {
                loadingContainer.classList.add('hidden');
                errorContainer.classList.remove('hidden');
                errorMessage.textContent = error.message;
            }
        } finally {
            if (refreshIcon) refreshIcon.classList.remove('fa-spin');
        }
    }

    function updateSummary(bots) {
        let total = bots.length;
        let online = 0;
        let offline = 0;
        let privados = 0;
        let totalGroups = 0;
        let totalMsgs = 0;

        bots.forEach(b => {
            if (b.connected && !b.banido) online++;
            else offline++;

            if (b.privado) privados++;
            totalGroups += (b.groupsCount || 0);
            totalMsgs += Math.round(b.msgsHr || 0);
        });

        sumTotal.textContent = total;
        sumOnline.textContent = online;
        sumOffline.textContent = offline;
        sumPrivados.textContent = privados;
        sumGroups.textContent = totalGroups.toLocaleString('pt-BR');
        sumMsgs.textContent = totalMsgs.toLocaleString('pt-BR');
    }

    function formatTimeSince(timestamp) {
        if (!timestamp) return 'Nunca / Sem dados';
        const now = Date.now();
        const diffMs = now - Number(timestamp);
        if (diffMs < 0) return 'Agora mesmo';

        const diffMinutes = Math.floor(diffMs / 60000);
        if (diffMinutes < 1) return 'Há menos de 1 min';
        if (diffMinutes < 60) return `Há ${diffMinutes} min`;

        const diffHours = Math.floor(diffMinutes / 60);
        if (diffHours < 24) return `Há ${diffHours} hora${diffHours > 1 ? 's' : ''}`;

        const diffDays = Math.floor(diffHours / 24);
        return `Há ${diffDays} dia${diffDays > 1 ? 's' : ''}`;
    }

    function formatPhoneNumber(num) {
        if (!num) return '-';
        const clean = String(num).replace(/\D/g, '');
        if (clean.length === 12 || clean.length === 13) {
            // Ex: 55 11 99999-9999
            const ddd = clean.slice(2, 4);
            const part1 = clean.length === 13 ? clean.slice(4, 9) : clean.slice(4, 8);
            const part2 = clean.length === 13 ? clean.slice(9) : clean.slice(8);
            return `+55 (${ddd}) ${part1}-${part2}`;
        }
        return num;
    }

    function getPlatformIcon(platform) {
        if (platform === 'Telegram') return '<i class="fab fa-telegram" style="color: #2AABEE;"></i>';
        if (platform === 'Discord') return '<i class="fab fa-discord" style="color: #5865F2;"></i>';
        return '<i class="fab fa-whatsapp" style="color: #25D366;"></i>';
    }

    function getDelayEmoji(avg) {
        if (!avg || avg <= 0) return '⚡';
        if (avg < 2.5) return '⚡';
        if (avg < 5.0) return '🟢';
        if (avg < 10.0) return '🟡';
        return '🔴';
    }

    function renderBots() {
        instancesContainer.innerHTML = '';

        const searchLower = currentSearch.toLowerCase().trim();

        const filtered = allBots.filter(bot => {
            // Filtro por texto
            const matchesSearch = !searchLower ||
                bot.id.toLowerCase().includes(searchLower) ||
                (bot.name && bot.name.toLowerCase().includes(searchLower)) ||
                (bot.phoneNumber && String(bot.phoneNumber).includes(searchLower));

            if (!matchesSearch) return false;

            // Filtro por botões
            if (currentFilter === 'online') return bot.connected && !bot.banido;
            if (currentFilter === 'offline') return !bot.connected || bot.banido;
            if (currentFilter === 'private') return bot.privado;
            if (currentFilter === 'whatsapp') return bot.platform === 'WhatsApp';
            if (currentFilter === 'telegram') return bot.platform === 'Telegram';
            if (currentFilter === 'discord') return bot.platform === 'Discord';

            return true;
        });

        if (filtered.length === 0) {
            instancesContainer.innerHTML = `
                <div style="text-align: center; padding: 40px 20px; color: #888;">
                    <i class="fas fa-search" style="font-size: 2rem; margin-bottom: 10px; display: block;"></i>
                    Nenhuma instância encontrada para os filtros atuais.
                </div>
            `;
            return;
        }

        filtered.forEach(bot => {
            const isOnline = bot.connected && !bot.banido;
            const isBanned = bot.banido;
            const statusClass = isBanned ? 'banned' : (isOnline ? 'online' : 'offline');

            const statusBadge = isBanned
                ? '<span class="badge badge-banned"><i class="fas fa-ban"></i> Banida</span>'
                : (isOnline
                    ? '<span class="badge badge-online"><i class="fas fa-check-circle"></i> Online</span>'
                    : '<span class="badge badge-offline"><i class="fas fa-times-circle"></i> Offline</span>');

            const platformBadge = `<span class="badge badge-platform">${getPlatformIcon(bot.platform)} ${bot.platform}</span>`;
            const privateBadge = bot.privado ? '<span class="badge badge-private"><i class="fas fa-lock"></i> Privada</span>' : '';
            const vipBadge = bot.vip ? '<span class="badge badge-vip"><i class="fas fa-gem"></i> VIP</span>' : '';
            const comBadge = bot.comunitario ? '<span class="badge badge-community"><i class="fas fa-hands-helping"></i> Comunitária</span>' : '';

            const msgsHr = Math.round(bot.msgsHr || 0);
            const msgsBadge = `<span class="badge badge-stats"><i class="fas fa-envelope"></i> ${msgsHr} msgs/h</span>`;

            const avgDelay = bot.responseTime ? (bot.responseTime.avg || 0) : 0;
            const maxDelay = bot.responseTime ? (bot.responseTime.max || 0) : 0;
            const delayBadge = `<span class="badge badge-stats">${getDelayEmoji(avgDelay)} ${avgDelay.toFixed(1)}s delay</span>`;
            const groupsBadge = `<span class="badge badge-stats"><i class="fas fa-users"></i> ${bot.groupsCount || 0} grupos</span>`;

            const rawPhone = bot.phoneNumber ? String(bot.phoneNumber).replace(/\D/g, '') : '';
            const cleanPhone = formatPhoneNumber(rawPhone);
            const chatUrl = bot.platform === 'Telegram'
                ? `https://t.me/${bot.id}`
                : `https://wa.me/${rawPhone}`;

            const lastMsgStr = formatTimeSince(bot.lastMessageReceived);
            const exactLastMsg = bot.lastMessageReceived ? new Date(bot.lastMessageReceived).toLocaleString('pt-BR') : 'Nenhuma';

            const section = document.createElement('div');
            section.className = `bot-section ${statusClass}`;

            section.innerHTML = `
                <div class="bot-header">
                    <div class="bot-main-info">
                        <span class="bot-name">
                            ${getPlatformIcon(bot.platform)}
                            ${bot.name || bot.id}
                        </span>
                        ${statusBadge}
                        ${privateBadge}
                        ${vipBadge}
                        ${comBadge}
                        ${platformBadge}
                        ${msgsBadge}
                        ${delayBadge}
                        ${groupsBadge}
                    </div>
                    <div class="toggle-icon"><i class="fas fa-chevron-down"></i></div>
                </div>
                <div class="bot-content">
                    <div class="details-grid">
                        <div class="detail-card">
                            <div class="detail-label">Identificador (ID)</div>
                            <div class="detail-val"><code>${bot.id}</code></div>
                        </div>
                        <div class="detail-card">
                            <div class="detail-label">Número / Contato</div>
                            <div class="detail-val">
                                ${rawPhone ? `<a href="${chatUrl}" target="_blank"><i class="fas fa-external-link-alt"></i> ${cleanPhone}</a>` : 'Não configurado'}
                            </div>
                        </div>
                        <div class="detail-card">
                            <div class="detail-label">Última Mensagem</div>
                            <div class="detail-val" title="Data exata: ${exactLastMsg}">
                                <i class="far fa-clock"></i> ${lastMsgStr}
                            </div>
                        </div>
                        <div class="detail-card">
                            <div class="detail-label">Grupos Conectados</div>
                            <div class="detail-val">
                                <strong>${bot.groupsCount || 0}</strong> grupos
                            </div>
                        </div>
                        <div class="detail-card">
                            <div class="detail-label">Desempenho & Delay</div>
                            <div class="detail-val">
                                Médio: <strong>${avgDelay.toFixed(2)}s</strong> | Máx: <strong>${maxDelay.toFixed(2)}s</strong>
                            </div>
                        </div>
                        <div class="detail-card">
                            <div class="detail-label">Prefixo de Comandos</div>
                            <div class="detail-val"><code>${bot.prefix || '!'}</code></div>
                        </div>
                        ${bot.numeroResponsavel ? `
                        <div class="detail-card">
                            <div class="detail-label">Responsável</div>
                            <div class="detail-val">
                                <a href="https://wa.me/${String(bot.numeroResponsavel).replace(/\D/g, '')}" target="_blank">
                                    ${formatPhoneNumber(bot.numeroResponsavel)}
                                </a>
                            </div>
                        </div>
                        ` : ''}
                        ${bot.webhookPort ? `
                        <div class="detail-card">
                            <div class="detail-label">Porta Webhook</div>
                            <div class="detail-val"><code>${bot.webhookPort}</code></div>
                        </div>
                        ` : ''}
                    </div>

                    <div style="margin-bottom: 15px;">
                        <div class="detail-label">Configurações & Flags</div>
                        <div class="tags-cloud">
                            <span class="tag-pill ${bot.privado ? 'active' : ''}"><i class="fas ${bot.privado ? 'fa-check' : 'fa-times'}"></i> Privado</span>
                            <span class="tag-pill ${bot.ignorePV ? 'active' : ''}"><i class="fas ${bot.ignorePV ? 'fa-check' : 'fa-times'}"></i> Ignora PV</span>
                            <span class="tag-pill ${bot.ignoreInvites ? 'active' : ''}"><i class="fas ${bot.ignoreInvites ? 'fa-check' : 'fa-times'}"></i> Ignora Convites</span>
                            <span class="tag-pill ${bot.pvAI ? 'active' : ''}"><i class="fas ${bot.pvAI ? 'fa-check' : 'fa-times'}"></i> IA no PV</span>
                            <span class="tag-pill ${bot.vip ? 'active' : ''}"><i class="fas ${bot.vip ? 'fa-check' : 'fa-times'}"></i> VIP</span>
                            <span class="tag-pill ${bot.comunitario ? 'active' : ''}"><i class="fas ${bot.comunitario ? 'fa-check' : 'fa-times'}"></i> Comunitária</span>
                        </div>
                    </div>

                    <div class="bot-actions-row">
                        <button class="btn-action btn-restart" data-bot-id="${bot.id}">
                            <i class="fas fa-sync-alt"></i> Reiniciar Bot
                        </button>
                        ${bot.platform === 'WhatsApp' ? `
                        <a href="/qrcode/${bot.id}" target="_blank" class="btn-action btn-qr">
                            <i class="fas fa-qrcode"></i> QRCode / Reconectar
                        </a>
                        ` : ''}
                        ${rawPhone ? `
                        <a href="${chatUrl}" target="_blank" class="btn-action btn-chat">
                            <i class="fas fa-comment-dots"></i> Abrir Conversa
                        </a>
                        ` : ''}
                        <button class="btn-action btn-logout" data-bot-id="${bot.id}">
                            <i class="fas fa-sign-out-alt"></i> Desconectar
                        </button>
                    </div>
                </div>
            `;

            // Ações de Toggle Sanfona
            const header = section.querySelector('.bot-header');
            header.addEventListener('click', () => {
                section.classList.toggle('active');
            });

            // Botão de Reiniciar
            const restartBtn = section.querySelector('.btn-restart');
            if (restartBtn) {
                restartBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    if (!confirm(`Deseja realmente reiniciar o bot '${bot.id}'?`)) return;

                    restartBtn.disabled = true;
                    restartBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Reiniciando...';

                    try {
                        const resp = await fetch(`/restart/${bot.id}`);
                        const resJson = await resp.json();
                        if (resJson.status === 'ok') {
                            alert(`Bot '${bot.id}' reiniciado com sucesso!`);
                        } else {
                            alert(`Aviso ao reiniciar '${bot.id}': ${resJson.message || 'Erro desconhecido'}`);
                        }
                        // Recarrega status
                        setTimeout(() => fetchInstances(true), 2000);
                    } catch (err) {
                        alert(`Erro ao reiniciar '${bot.id}': ${err.message}`);
                    } finally {
                        restartBtn.disabled = false;
                        restartBtn.innerHTML = '<i class="fas fa-sync-alt"></i> Reiniciar Bot';
                    }
                });
            }

            // Botão de Logout
            const logoutBtn = section.querySelector('.btn-logout');
            if (logoutBtn) {
                logoutBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    if (!confirm(`ATENÇÃO: Deseja realmente desconectar / deslogar a sessão do bot '${bot.id}'?`)) return;

                    logoutBtn.disabled = true;
                    logoutBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Desconectando...';

                    try {
                        const resp = await fetch(`/logout/${bot.id}`);
                        const resJson = await resp.json();
                        alert(`Resultado do logout para '${bot.id}': ${resJson.message || resJson.status}`);
                        setTimeout(() => fetchInstances(true), 2000);
                    } catch (err) {
                        alert(`Erro ao desconectar '${bot.id}': ${err.message}`);
                    } finally {
                        logoutBtn.disabled = false;
                        logoutBtn.innerHTML = '<i class="fas fa-sign-out-alt"></i> Desconectar';
                    }
                });
            }

            instancesContainer.appendChild(section);
        });
    }

    // Event listeners de filtros e busca
    filterButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            filterButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentFilter = btn.dataset.filter;
            renderBots();
        });
    });

    searchInput.addEventListener('input', (e) => {
        currentSearch = e.target.value;
        renderBots();
    });

    retryButton.addEventListener('click', () => fetchInstances(false));
    refreshButton.addEventListener('click', () => fetchInstances(true));

    // Carregamento inicial
    fetchInstances(false);

    // Auto-refresh a cada 30 segundos em segundo plano
    autoRefreshTimer = setInterval(() => {
        fetchInstances(true);
    }, 30000);
});
