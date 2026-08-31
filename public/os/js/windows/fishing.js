// windows/fishing.js - Legendary Fishing Gallery window with Infinite Scroll / Lazy Chunks

WindowManager.register('fishing', {
    title: 'Galeria da Pesca Lendária 🎣',
    taskbarIcon: 'fa-fish',
    width: '740px',
    height: '520px',
    singleton: true,

    render(wb) {
        const body = wb.body;

        body.innerHTML = `
            <div class="fishing-window" style="display: flex; flex-direction: column; height: 100%; gap: 10px;">
                <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; flex-shrink: 0;">
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

                <div id="fishing-content" style="flex: 1; overflow-y: auto; padding-right: 4px;">
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
            const catches = await Api.get('/api/fishing/legendary');
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
            let sortedList = [];
            let displayedCount = 0;
            const chunkSize = 12;

            const createCardHtml = (item) => {
                const imgSrc = item.image_name ? `/api/fishing/image/${encodeURIComponent(item.image_name)}` : '/public/ravena_fishing.png';
                const rawWeight = typeof item.weight === 'number' ? item.weight : (parseFloat(item.fish_weight) || 0);
                const weightStr = rawWeight.toFixed(2);
                const fisherman = item.user_name || item.fisherman_name || 'Anônimo';

                return `
                    <div class="fish-card">
                        <img src="${imgSrc}" loading="lazy" onerror="this.onerror=null;this.src='/public/ravena_fishing.png';" alt="${item.fish_name || 'Peixe Lendário'}">
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
            };

            const appendNextChunk = () => {
                if (displayedCount >= sortedList.length) return;

                let grid = container.querySelector('.fishing-grid');
                if (!grid) {
                    container.innerHTML = '<div class="fishing-grid"></div><div id="fishing-loading-more" style="text-align: center; padding: 10px; display: none; font-size: 11px; color: #888;">Carregando mais...</div>';
                    grid = container.querySelector('.fishing-grid');
                }

                const nextItems = sortedList.slice(displayedCount, displayedCount + chunkSize);
                displayedCount += nextItems.length;

                const fragment = document.createRange().createContextualFragment(nextItems.map(createCardHtml).join(''));
                grid.appendChild(fragment);
            };

            const render = () => {
                sortedList = [...catches].sort((a, b) => {
                    const weightA = typeof a.weight === 'number' ? a.weight : (parseFloat(a.fish_weight) || 0);
                    const weightB = typeof b.weight === 'number' ? b.weight : (parseFloat(b.fish_weight) || 0);
                    if (currentSort === 'weight') return weightB - weightA;
                    return (b.timestamp || 0) - (a.timestamp || 0);
                });

                displayedCount = 0;
                container.innerHTML = '';
                appendNextChunk();
            };

            render();

            // Infinite scroll listener
            container.addEventListener('scroll', () => {
                if (container.scrollHeight - container.scrollTop - container.clientHeight < 200) {
                    appendNextChunk();
                }
            });

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
