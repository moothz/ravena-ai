document.addEventListener('DOMContentLoaded', () => {
    const groupsContainer = document.getElementById('groups-container');
    const loadingContainer = document.getElementById('loading-container');
    const errorContainer = document.getElementById('error-container');
    const errorMessage = document.getElementById('error-message');
    const dashboardContent = document.getElementById('dashboard-content');
    const retryButton = document.getElementById('retry-button');

    async function fetchDossiers() {
        loadingContainer.classList.remove('hidden');
        dashboardContent.classList.add('hidden');
        errorContainer.classList.add('hidden');

        try {
            const response = await fetch('/api/groups-dossier');
            if (!response.ok) {
                if (response.status === 401) {
                    throw new Error('Não autorizado. Verifique suas credenciais.');
                }
                throw new Error('Erro ao buscar dados da API');
            }

            const data = await response.json();
            renderGroups(data);

            loadingContainer.classList.add('hidden');
            dashboardContent.classList.remove('hidden');
        } catch (error) {
            loadingContainer.classList.add('hidden');
            errorContainer.classList.remove('hidden');
            errorMessage.textContent = error.message;
        }
    }

    function getScoreClass(score) {
        if (score >= 7) return 'score-high';
        if (score >= 4) return 'score-medium';
        return 'score-low';
    }

    // Texto vindo do LLM e dos grupos (nome, resumo, tipo) entra no innerHTML escapado.
    function esc(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function renderGroups(groups) {
        groupsContainer.innerHTML = '';

        if (groups.length === 0) {
            groupsContainer.innerHTML = '<div class="alert alert-info">Nenhum grupo com histórico encontrado.</div>';
            return;
        }

        groups.forEach(group => {
            const section = document.createElement('div');
            section.className = 'group-section';

            // Cálculos no lado do cliente
            const scores = group.history.map(h => h.problematic_score);
            const maxScore = Math.max(...scores);
            const avgScore = (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1);
            
            const maxScoreClass = getScoreClass(maxScore);
            const avgScoreClass = getScoreClass(parseFloat(avgScore));

            // Gerar HTML do histórico
            let historyHtml = '<div class="history-list">';
            group.history.forEach((dossier, index) => {
                const dossierScoreClass = getScoreClass(dossier.problematic_score);
                const isLatest = index === 0;
                const dateHeader = isLatest ? 'ÚLTIMA ANÁLISE' : new Date(dossier.created_at).toLocaleString('pt-BR');

                historyHtml += `
                    <div class="history-item ${isLatest ? 'latest' : ''}">
                        <div class="history-header">
                            <span class="history-date">${esc(dateHeader)}</span>
                            <span class="group-score ${dossierScoreClass}">Nota: ${esc(dossier.problematic_score)}</span>
                        </div>
                        <div class="dossier-grid">
                            <div class="dossier-item">
                                <div class="dossier-label">Tipo</div>
                                <div class="dossier-value"><i class="fas fa-tag"></i> ${esc(dossier.type)}</div>
                            </div>
                            <div class="dossier-item">
                                <div class="dossier-label">Resumo</div>
                                <div class="dossier-value">${esc(dossier.summary)}</div>
                            </div>
                        </div>
                    </div>
                `;
            });
            historyHtml += '</div>';

            section.innerHTML = `
                <div class="group-header">
                    <div class="group-info">
                        <span class="group-name">${esc(group.name)}</span>
                        <span class="bot-badge">${esc(group.bot_id)}</span>
                        <span class="group-score ${maxScoreClass}">Maior: ${esc(maxScore)}</span>
                        <span class="group-score ${avgScoreClass}">Média: ${avgScore}</span>
                        <span class="stats-badge">${group.total_chars.toLocaleString()} chars totais | ${group.pending_chars.toLocaleString()} pnd</span>
                    </div>
                    <div class="toggle-icon"><i class="fas fa-chevron-down"></i></div>
                </div>
                <div class="group-content">
                    ${historyHtml}
                    <div style="margin-top: 15px; font-size: 0.75em; color: #666;">
                        ID: ${esc(group.id)}
                    </div>
                </div>
            `;

            const header = section.querySelector('.group-header');
            header.addEventListener('click', () => {
                section.classList.toggle('active');
            });

            groupsContainer.appendChild(section);
        });
    }

    retryButton.addEventListener('click', fetchDossiers);

    // Initial fetch
    fetchDossiers();
});
