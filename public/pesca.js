document.addEventListener('DOMContentLoaded', () => {
    const loadingList = document.getElementById('loading-list');
    const listContainer = document.getElementById('fishing-list-container');
    const noRecords = document.getElementById('no-records');
    const statsBox = document.getElementById('fishing-stats');
    const sortButtons = document.querySelectorAll('.btn-sort');

    let catches = [];

    // Nomes de peixe, pescador e grupo vêm do WhatsApp (texto livre): sempre escapados
    function escapeHtml(text) {
        return String(text ?? '').replace(/[&<>"']/g, (c) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        })[c]);
    }

    const weightFormatter = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const formatWeight = (w) => `${weightFormatter.format(Number(w) || 0)} kg`;

    // Format timestamp to date string
    function formatDate(timestamp) {
        const date = new Date(timestamp);
        const day = String(date.getDate()).padStart(2, '0');
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const year = date.getFullYear();
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        return `${day}/${month}/${year} ${hours}:${minutes}`;
    }

    function renderStats() {
        if (!statsBox || catches.length === 0) return;
        const record = catches.reduce((best, c) => (c.weight > best.weight ? c : best), catches[0]);
        const byFisher = {};
        catches.forEach((c) => {
            const name = c.user_name || 'Anônimo';
            byFisher[name] = (byFisher[name] || 0) + 1;
        });
        const [topName, topCount] = Object.entries(byFisher).sort((a, b) => b[1] - a[1])[0];

        document.getElementById('stat-total').textContent = catches.length.toLocaleString('pt-BR');
        const recordEl = document.getElementById('stat-record');
        recordEl.textContent = formatWeight(record.weight);
        recordEl.title = `${record.fish_name} — ${record.user_name}`;
        const topEl = document.getElementById('stat-top-fisher');
        topEl.textContent = `${topName} (${topCount})`;
        topEl.title = `${topName}: ${topCount} lendário(s)`;
        statsBox.hidden = false;
    }

    // Fetch catches from API
    async function fetchCatches() {
        try {
            const response = await fetch('/api/fishing/legendary');
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            catches = await response.json();
            if (!Array.isArray(catches)) catches = [];

            // Posição no ranking por peso (fixa, independente da ordenação escolhida)
            [...catches]
                .sort((a, b) => (b.weight || 0) - (a.weight || 0))
                .forEach((item, i) => {
                    item._rank = i + 1;
                });

            loadingList.style.display = 'none';
            if (catches.length === 0) {
                if (statsBox) statsBox.hidden = true;
                const controls = document.querySelector('.controls-section');
                if (controls) controls.style.display = 'none';
                noRecords.style.display = 'block';
                listContainer.style.display = 'none';
            } else {
                noRecords.style.display = 'none';
                listContainer.style.display = 'flex';
                renderStats();
                sortCatches('weight', 'desc');
                renderList();
            }
        } catch (error) {
            console.error('Error fetching catches:', error);
            if (statsBox) statsBox.hidden = true;
            loadingList.innerHTML = `
                <p style="color: #ed8936; text-align: center;">
                    <i class="fas fa-exclamation-triangle" aria-hidden="true"></i>
                    Não foi possível carregar os registros (${escapeHtml(error.message)}).
                </p>
                <button type="button" class="btn-sort" style="margin: 14px auto 0;" onclick="location.reload()">
                    <i class="fas fa-redo" aria-hidden="true"></i> Tentar novamente
                </button>`;
        }
    }

    function rankBadge(rank) {
        const medals = { 1: '🥇', 2: '🥈', 3: '🥉' };
        if (medals[rank]) {
            return `<span class="fish-rank medal" aria-label="${rank}º lugar">${medals[rank]}</span>`;
        }
        return `<span class="fish-rank" aria-label="${rank}º lugar">#${rank}</span>`;
    }

    // Render the list of catches
    function renderList() {
        const fragment = document.createDocumentFragment();

        catches.forEach((item, index) => {
            const groupName = (!item.group_name || item.group_name === 'chat privado') ? 'Privado' : item.group_name;
            const dateStr = formatDate(item.timestamp);
            const contentId = `fish-content-${index}`;

            const fishingItem = document.createElement('div');
            fishingItem.className = 'fishing-item';

            fishingItem.innerHTML = `
                <button type="button" class="fishing-item-header" aria-expanded="false" aria-controls="${contentId}">
                    ${rankBadge(item._rank)}
                    <span class="fish-info">
                        <span class="fish-title-row">
                            <span class="fish-title">${escapeHtml(item.fish_name)}</span>
                            <span class="fish-weight">${formatWeight(item.weight)}</span>
                        </span>
                        <span class="fish-meta">
                            <span><i class="fas fa-user" aria-hidden="true"></i> ${escapeHtml(item.user_name)}</span>
                            <span><i class="fas fa-users" aria-hidden="true"></i> ${escapeHtml(groupName)}</span>
                            <span><i class="fas fa-calendar-alt" aria-hidden="true"></i> ${dateStr}</span>
                        </span>
                    </span>
                    <i class="fas fa-chevron-down expand-icon" aria-hidden="true"></i>
                </button>
                <div class="fishing-item-content" id="${contentId}">
                    <div class="image-wrapper">
                        <div class="image-loader">
                            <i class="fas fa-spinner fa-spin" aria-hidden="true"></i>
                            <span>Carregando imagem...</span>
                        </div>
                        <img class="fish-image" alt="${escapeHtml(item.fish_name)} pescado por ${escapeHtml(item.user_name)}" decoding="async">
                    </div>
                </div>
            `;

            // Toggle accordion expand/collapse
            const header = fishingItem.querySelector('.fishing-item-header');
            header.addEventListener('click', () => {
                const isExpanded = fishingItem.classList.contains('expanded');

                // Collapse all other items
                document.querySelectorAll('.fishing-item.expanded').forEach(openItem => {
                    if (openItem !== fishingItem) {
                        openItem.classList.remove('expanded');
                        openItem.querySelector('.fishing-item-header').setAttribute('aria-expanded', 'false');
                    }
                });

                if (isExpanded) {
                    fishingItem.classList.remove('expanded');
                    header.setAttribute('aria-expanded', 'false');
                } else {
                    fishingItem.classList.add('expanded');
                    header.setAttribute('aria-expanded', 'true');

                    // Lazy-load image if not already loaded
                    const img = fishingItem.querySelector('.fish-image');
                    const loader = fishingItem.querySelector('.image-loader');

                    if (!img.getAttribute('src')) {
                        img.onload = () => {
                            loader.style.display = 'none';
                            img.style.display = 'block';
                        };
                        img.onerror = () => {
                            loader.innerHTML = '<i class="fas fa-exclamation-circle" style="color: #ff6b6b;" aria-hidden="true"></i> <span style="color: #ff6b6b; font-size: 0.9rem;">Imagem não encontrada no servidor</span>';
                        };
                        img.src = `/api/fishing/image/${encodeURIComponent(item.image_name)}`;
                    }

                    // Garante que o item aberto fique visível (útil no celular)
                    requestAnimationFrame(() => {
                        const rect = fishingItem.getBoundingClientRect();
                        if (rect.top < 70 || rect.top > window.innerHeight * 0.6) {
                            fishingItem.scrollIntoView({ block: 'start', behavior: 'smooth' });
                        }
                    });
                }
            });

            fragment.appendChild(fishingItem);
        });

        listContainer.innerHTML = '';
        listContainer.appendChild(fragment);
    }

    // Sort catches
    function sortCatches(field, order) {
        catches.sort((a, b) => {
            let valA, valB;

            switch (field) {
                case 'weight':
                    valA = a.weight;
                    valB = b.weight;
                    break;
                case 'date':
                    valA = a.timestamp;
                    valB = b.timestamp;
                    break;
                case 'name':
                    valA = String(a.fish_name || '').toLowerCase();
                    valB = String(b.fish_name || '').toLowerCase();
                    break;
                case 'user':
                    valA = String(a.user_name || '').toLowerCase();
                    valB = String(b.user_name || '').toLowerCase();
                    break;
                default:
                    valA = a.weight;
                    valB = b.weight;
            }

            if (typeof valA === 'string') {
                return order === 'asc'
                    ? valA.localeCompare(valB, 'pt-BR')
                    : valB.localeCompare(valA, 'pt-BR');
            } else {
                return order === 'asc'
                    ? valA - valB
                    : valB - valA;
            }
        });
    }

    // Sort buttons event listeners
    sortButtons.forEach(button => {
        button.addEventListener('click', () => {
            const sortBy = button.getAttribute('data-sort');
            let order = button.getAttribute('data-order');

            // If already active, toggle order
            if (button.classList.contains('active')) {
                order = order === 'asc' ? 'desc' : 'asc';
                button.setAttribute('data-order', order);
            } else {
                // Remove active class from all
                sortButtons.forEach(btn => {
                    btn.classList.remove('active');
                    btn.setAttribute('aria-pressed', 'false');
                });
                button.classList.add('active');
                button.setAttribute('aria-pressed', 'true');
            }

            // Update icons on all buttons
            sortButtons.forEach(btn => {
                const currentBtnOrder = btn.getAttribute('data-order');
                const sortType = btn.getAttribute('data-sort');
                let iconClass = '';

                if (sortType === 'name' || sortType === 'user') {
                    iconClass = currentBtnOrder === 'asc' ? 'fa-sort-alpha-down' : 'fa-sort-alpha-up';
                } else {
                    iconClass = currentBtnOrder === 'asc' ? 'fa-sort-amount-up' : 'fa-sort-amount-down';
                }

                const icon = btn.querySelector('i');
                if (icon) {
                    icon.className = `fas ${iconClass}`;
                }
            });

            sortCatches(sortBy, order);
            renderList();
        });
    });

    // Start loading
    fetchCatches();
});
