// windows/donations.js - Donations window with Explorer details ranking and donor messages dialog

WindowManager.register('donations', {
    title: 'Doações — Contribuidores da Ravena',
    taskbarIcon: 'fa-heart',
    width: '720px',
    height: '520px',
    singleton: true,

    render(wb) {
        const body = wb.body;

        body.innerHTML = `
            <div class="donations-window">
                <div class="donations-header">
                    <div>
                        <p style="font-size: 12px; color: #ffffff; font-weight: 600;">
                            🎉 Apoie os custos de hospedagem e manutenção!
                        </p>
                        <div class="donations-meta" id="donations-meta-text" style="margin-top: 4px;">
                            Carregando meta recente...
                        </div>
                    </div>
                    <a href="https://tipa.ai/moothz" target="_blank" class="os-btn" style="background: linear-gradient(180deg, #ff4081 0%, #c2185b 100%); border-color: #ff80ab;">
                        <i class="fas fa-heart"></i> Fazer Doação (tipa.ai)
                    </a>
                </div>

                <div style="font-size: 10px; color: #8888aa; margin-top: 2px;">
                    💡 Dica: Clique em qualquer doador na lista para ver o histórico e mensagens enviadas.
                </div>

                <div style="overflow-x: auto; border: 1px solid var(--win-border-subtle); border-radius: 6px; background: #110d29; max-height: 340px; overflow-y: auto;">
                    <table class="explorer-table">
                        <thead>
                            <tr>
                                <th class="col-rank">#</th>
                                <th class="col-icon"></th>
                                <th class="col-name">Nome do Doador</th>
                                <th class="col-value">Total Doado</th>
                            </tr>
                        </thead>
                        <tbody id="donations-tbody">
                            <tr>
                                <td colspan="4" style="text-align: center; padding: 20px;">
                                    <i class="fas fa-spinner fa-spin"></i> Carregando doações...
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>
        `;

        this.loadData(body);

        if (window.RavenaOS) {
            window.RavenaOS.on('donationsUpdate', () => this.renderTable(body));
            window.RavenaOS.on('recentDonationsUpdate', () => this.renderMeta(body));
        }
    },

    async loadData(body) {
        try {
            if (window.RavenaOS && window.RavenaOS.state.donationsData && window.RavenaOS.state.recentDonations) {
                this.renderMeta(body);
                this.renderTable(body);
                return;
            }

            const [donations, recent] = await Promise.all([
                Api.get('/top-donates'),
                Api.get('/recent-top-donates')
            ]);

            if (window.RavenaOS) {
                window.RavenaOS.state.donationsData = donations;
                window.RavenaOS.state.recentDonations = recent;
            }

            this.renderMeta(body);
            this.renderTable(body);
        } catch (err) {
            console.error('Error loading donations:', err);
            const tbody = body.querySelector('#donations-tbody');
            if (tbody) {
                tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: #ff5555; padding: 15px;">Erro ao carregar doações: ${err.message}</td></tr>`;
            }
        }
    },

    renderMeta(body) {
        const recent = window.RavenaOS ? window.RavenaOS.state.recentDonations : null;
        const metaEl = body.querySelector('#donations-meta-text');
        if (!metaEl || !recent) return;

        const totalRecent = recent.totalRecentAmount || 0;
        const goal = 150;
        const pct = Math.min(100, Math.floor((totalRecent / goal) * 100));

        metaEl.innerHTML = `
            Meta 3 meses: <strong>${Formatters.currency(totalRecent)}</strong> / ${Formatters.currency(goal)} 
            <span style="color: ${pct >= 100 ? '#48bb78' : '#ffd700'};">(${pct}%)</span>
        `;
    },

    renderTable(body) {
        const donations = window.RavenaOS ? window.RavenaOS.state.donationsData : null;
        const tbody = body.querySelector('#donations-tbody');
        if (!tbody || !donations) return;

        if (donations.length === 0) {
            tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; padding: 20px;">Nenhuma doação registrada ainda.</td></tr>`;
            return;
        }

        const sorted = [...donations].sort((a, b) => (b.valor || 0) - (a.valor || 0));

        tbody.innerHTML = sorted.map((d, index) => {
            let medal = '💰';
            if (index === 0) medal = '🥇';
            else if (index === 1) medal = '🥈';
            else if (index === 2) medal = '🥉';

            return `
                <tr class="donation-row" data-name="${encodeURIComponent(d.nome)}">
                    <td class="col-rank">${index + 1}</td>
                    <td class="col-icon">${medal}</td>
                    <td class="col-name" style="font-weight: 500;">${d.nome}</td>
                    <td class="col-value">${Formatters.currency(d.valor)}</td>
                </tr>
            `;
        }).join('');

        tbody.querySelectorAll('.donation-row').forEach(row => {
            row.addEventListener('click', () => {
                const name = decodeURIComponent(row.dataset.name);
                this.openDonorDialog(name);
            });
        });
    },

    async openDonorDialog(name) {
        try {
            const donor = await Api.get(`/api/donates/detail/${encodeURIComponent(name)}`);
            
            WindowManager.open('donation-detail', {
                title: `Aviso — Doações de ${donor.nome}`,
                taskbarIcon: 'fa-envelope-open-text',
                width: '450px',
                height: '380px',
                singleton: false,
                class: 'dialog-window',
                customRender: (wb) => {
                    const entries = (donor.historico || []).slice().reverse();
                    let entriesHtml = '';

                    if (entries.length === 0) {
                        entriesHtml = '<p style="font-size: 11px; color: #888; text-align: center; padding: 15px;">Sem mensagens registradas.</p>';
                    } else {
                        entriesHtml = entries.map(h => `
                            <div class="donor-entry">
                                <div class="donor-entry-header">
                                    <span>${Formatters.formatDateTime(h.ts)}</span>
                                    <span>${Formatters.currency(h.valor)}</span>
                                </div>
                                ${h.msg ? `<div class="donor-entry-msg">"${h.msg}"</div>` : `<div style="font-size: 10px; color: #666; margin-top: 4px;">(Sem mensagem anexada)</div>`}
                            </div>
                        `).join('');
                    }

                    wb.body.innerHTML = `
                        <div style="display: flex; flex-direction: column; gap: 10px;">
                            <div style="display: flex; justify-content: space-between; align-items: center; padding-bottom: 8px; border-bottom: 1px solid var(--win-border-subtle);">
                                <h3 style="font-size: 14px; color: var(--bright-blue);">${donor.nome}</h3>
                                <span style="font-size: 13px; font-weight: 700; color: var(--gold-color);">Total: ${Formatters.currency(donor.valor)}</span>
                            </div>
                            <div style="font-size: 11px; font-weight: 600; color: #ffffff;">Mensagens & Histórico:</div>
                            <div style="max-height: 230px; overflow-y: auto; padding-right: 4px;">
                                ${entriesHtml}
                            </div>
                        </div>
                    `;
                }
            });
        } catch (err) {
            console.error('Error loading donor details:', err);
            alert(`Não foi possível carregar os detalhes do doador: ${err.message}`);
        }
    }
});
