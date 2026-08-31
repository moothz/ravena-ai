// windows/fishing.js - Legendary Fishing Gallery window with Infinite Scroll and Big Image Detail Dialog

WindowManager.register('fishing', {
    title: 'Galeria da Pesca Lendária 🎣',
    taskbarIcon: 'fa-fish',
    width: '850px',
    height: '600px',
    singleton: true,

    render(wb) {
        const body = wb.body;

        body.innerHTML = `
            <div class="fishing-window" style="display: flex; flex-direction: column; height: 100%; gap: 10px;">
                <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; flex-shrink: 0;">
                    <span style="font-size: 11px; color: var(--light-gray);">
                        Hall da fama dos maiores peixes e criaturas lendárias pescadas com o comando <code>!pescar</code>! Clique em um peixe para ampliar.
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

            const createCardElement = (item) => {
                const group = (!item.group_name || item.group_name === 'chat privado') ? 'Privado' : item.group_name;
                const imgSrc = item.image_name ? `/api/fishing/image/${encodeURIComponent(item.image_name)}` : '/public/ravena_fishing.png';
                const rawWeight = typeof item.weight === 'number' ? item.weight : (parseFloat(item.fish_weight) || 0);
                const weightStr = rawWeight.toFixed(2);
                const fisherman = item.user_name || item.fisherman_name || 'Anônimo';

                const card = document.createElement('div');
                card.className = 'fish-card';
                card.style.cursor = 'pointer';
                card.title = 'Clique para ampliar imagem e ver detalhes';

                card.innerHTML = `
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
                `;

                card.addEventListener('click', () => {
                    this.openFishDetail(item, imgSrc, weightStr, fisherman, group);
                });

                return card;
            };

            const appendNextChunk = () => {
                if (displayedCount >= sortedList.length) return;

                let grid = container.querySelector('.fishing-grid');
                if (!grid) {
                    container.innerHTML = '<div class="fishing-grid"></div>';
                    grid = container.querySelector('.fishing-grid');
                }

                const nextItems = sortedList.slice(displayedCount, displayedCount + chunkSize);
                displayedCount += nextItems.length;

                nextItems.forEach(item => {
                    grid.appendChild(createCardElement(item));
                });
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
    },

    openFishDetail(item, imgSrc, weightStr, fisherman, group) {
        const title = `Peixe Lendário: ${item.fish_name || 'Desconhecido'}`;

        const renderContent = (wb) => {
            wb.setTitle(title);
            wb.body.innerHTML = `
                <div style="display: flex; flex-direction: column; gap: 12px; height: 100%; text-align: center;">
                    <div style="flex: 1; min-height: 240px; max-height: 380px; background: #090714; border: 1px solid var(--win-border-subtle); border-radius: 6px; display: flex; align-items: center; justify-content: center; overflow: hidden; padding: 8px;">
                        <img src="${imgSrc}" 
                             onerror="this.onerror=null;this.src='/public/ravena_fishing.png';" 
                             alt="${item.fish_name || 'Peixe Lendário'}"
                             style="max-width: 100%; max-height: 360px; object-fit: contain; border-radius: 4px; filter: drop-shadow(0 0 10px rgba(4, 169, 240, 0.4));">
                    </div>

                    <div style="background: #110d29; border: 1px solid var(--win-border-subtle); border-radius: 6px; padding: 10px; text-align: left; display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
                        <div>
                            <div style="font-size: 10px; color: #8888aa; text-transform: uppercase;">Espécie</div>
                            <div style="font-size: 14px; font-weight: 700; color: var(--gold-color);">${item.fish_name || 'Lendário'}</div>
                        </div>
                        <div>
                            <div style="font-size: 10px; color: #8888aa; text-transform: uppercase;">Peso Registrado</div>
                            <div style="font-size: 14px; font-weight: 700; color: var(--cyan-neon);">⚖️ ${weightStr} kg</div>
                        </div>
                        <div>
                            <div style="font-size: 10px; color: #8888aa; text-transform: uppercase;">Pescador</div>
                            <div style="font-size: 12px; font-weight: 600; color: #ffffff;">🎣 ${fisherman}</div>
                        </div>
                        <div>
                            <div style="font-size: 10px; color: #8888aa; text-transform: uppercase;">Grupo / Origem</div>
                            <div style="font-size: 12px; color: #d0d0e0;">👥 ${group}</div>
                        </div>
                        <div style="grid-column: span 2; font-size: 10px; color: #888;">
                            📅 Capturado em: ${Formatters.formatDateTime(item.timestamp)}
                        </div>
                    </div>

                    <div style="display: flex; gap: 8px; justify-content: flex-end; flex-shrink: 0;">
                        <a href="${imgSrc}" download="${item.fish_name || 'peixe-lendario'}.png" target="_blank" class="os-btn" style="background: linear-gradient(180deg, var(--bright-blue) 0%, var(--medium-purple) 100%);">
                            <i class="fas fa-download"></i> Baixar Imagem
                        </a>
                    </div>
                </div>
            `;
        };

        // If window already exists, update it, restore and focus
        const existing = WindowManager.windows.get('fishing-detail');
        if (existing && existing.winbox) {
            if (existing.winbox.min) existing.winbox.restore();
            existing.winbox.focus();
            renderContent(existing.winbox);
            return;
        }

        WindowManager.open('fishing-detail', {
            title: title,
            taskbarIcon: 'fa-fish',
            width: '580px',
            height: '580px',
            singleton: true,
            customRender: (wb) => renderContent(wb)
        });
    }
});

// Register fishing-detail window so WindowManager knows this window type
WindowManager.register('fishing-detail', {
    title: 'Visualizar Peixe Lendário',
    taskbarIcon: 'fa-fish',
    width: '580px',
    height: '580px',
    singleton: true,
    render(wb, params) {
        if (params && typeof params.customRender === 'function') {
            params.customRender(wb);
        }
    }
});
