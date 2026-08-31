// windows/fishing.js - Legendary Fishing Gallery window

WindowManager.register('fishing', {
    title: 'Galeria da Pesca Lendária 🎣',
    taskbarIcon: 'fa-fish',
    width: '740px',
    height: '520px',
    singleton: true,

    render(wb) {
        const body = wb.body;

        body.innerHTML = `
            <div class="fishing-window">
                <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
                    <span style="font-size: 11px; color: var(--light-gray);">
                        Hall da fama dos maiores peixes e criaturas lendárias pescadas com o comando <code>!pescar</code>!
                    </span>
                    <div style="display: flex; gap: 6px;">
                        <button class="os-btn btn-fish-sort active" data-sort="weight" style="font-size: 10px; padding: 3px 8px;">
                            <i class="fas fa-weight-hanging"></i> Mais Pesados
                        </button>
                        <button class="os-btn btn-fish-sort" data-sort="date" style="font-size: 10px; padding: 3px 8px;">
                            <i class="fas fa-calendar-alt"></i> Recentes
                        </button>
                    </div>
                </div>

                <div id="fishing-content" style="max-height: 410px; overflow-y: auto; padding-right: 4px;">
                    <div style="text-align: center; padding: 30px;">
                        <i class="fas fa-spinner fa-spin" style="font-size: 24px; color: var(--bright-blue);"></i>
                        <p style="margin-top: 10px; font-size: 11px;">Carregando histórico de pesca lendária...</p>
                    </div>
                </div>
            </div>
        `;

        this.loadCatches(body);
    },

    async loadCatches(body) {
        const container = body.querySelector('#fishing-content');
        const sortButtons = body.querySelectorAll('.btn-fish-sort');

        try {
            let catches = await Api.get('/api/fishing/legendary');
            if (!Array.isArray(catches) || catches.length === 0) {
                container.innerHTML = `
                    <div style="text-align: center; padding: 40px; color: #888;">
                        <i class="fas fa-fish" style="font-size: 36px; margin-bottom: 10px;"></i>
                        <p>Nenhum peixe lendário foi capturado ainda.</p>
                    </div>
                `;
                return;
            }

            let currentSort = 'weight';

            const render = () => {
                const sorted = [...catches].sort((a, b) => {
                    const weightA = typeof a.weight === 'number' ? a.weight : (parseFloat(a.fish_weight) || 0);
                    const weightB = typeof b.weight === 'number' ? b.weight : (parseFloat(b.fish_weight) || 0);
                    if (currentSort === 'weight') return weightB - weightA;
                    return (b.timestamp || 0) - (a.timestamp || 0);
                });

                container.innerHTML = `
                    <div class="fishing-grid">
                        ${sorted.map(item => {
                            const group = (!item.group_name || item.group_name === 'chat privado') ? 'Privado' : item.group_name;
                            const imgSrc = item.image_name ? `/api/fishing/image/${encodeURIComponent(item.image_name)}` : '/public/ravena_fishing.png';
                            const rawWeight = typeof item.weight === 'number' ? item.weight : (parseFloat(item.fish_weight) || 0);
                            const weightStr = rawWeight.toFixed(2);
                            const fisherman = item.user_name || item.fisherman_name || 'Anônimo';

                            return `
                                <div class="fish-card">
                                    <img src="${imgSrc}" onerror="this.onerror=null;this.src='/public/ravena_fishing.png';" alt="${item.fish_name || 'Peixe Lendário'}">
                                    <div class="fish-card-name">${item.fish_name || 'Lendário Desconhecido'}</div>
                                    <div class="fish-card-info" style="color: var(--cyan-neon); font-weight: 600;">
                                        ⚖️ ${weightStr} kg
                                    </div>
                                    <div class="fish-card-info">
                                        🎣 Pescador: <strong>${fisherman}</strong>
                                    </div>
                                    <div class="fish-card-info" style="font-size: 9px; color: #777;">
                                        📅 ${Formatters.formatDateTime(item.timestamp)}
                                    </div>
                                </div>
                            `;
                        }).join('')}
                    </div>
                `;
            };

            render();

            sortButtons.forEach(btn => {
                btn.addEventListener('click', () => {
                    sortButtons.forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    currentSort = btn.dataset.sort;
                    render();
                });
            });

        } catch (err) {
            container.innerHTML = `<div style="text-align: center; color: #ff5555; padding: 20px;">Erro ao carregar pesca: ${err.message}</div>`;
        }
    }
});
