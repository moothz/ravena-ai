// windows/waifuletes.js - Waifuletes Window Component for Ravena Desktop OS & Mobile

WindowManager.register('waifuletes', {
    title: 'Waifuletes ✨',
    taskbarIcon: 'fa-heart',
    width: '880px',
    height: '620px',
    singleton: true,

    state: {
        search: '',
        gender: '',
        rarity: '',
        maritalStatus: '',
        sortBy: 'ranking',
        page: 1,
        limit: 12,
        total: 0,
        totalPages: 1,
        loading: false,
        activeRequest: null
    },

    RARITY_CONFIG: {
        COMMON:    { emoji: '⚪', label: 'Comum',    color: '#94a3b8' },
        UNCOMMON:  { emoji: '🟢', label: 'Incomum',  color: '#22c55e' },
        RARE:      { emoji: '🔵', label: 'Raro',     color: '#3b82f6' },
        EPIC:      { emoji: '🟣', label: 'Épico',    color: '#a855f7' },
        LEGENDARY: { emoji: '⭐', label: 'Lendário', color: '#ffd700' }
    },

    render(wb) {
        const body = wb.body;

        body.innerHTML = `
            <div class="waifu-window-container">
                <!-- Top Toolbar: Search & Filters -->
                <div class="waifu-toolbar">
                    <div class="waifu-search-group">
                        <i class="fas fa-search waifu-search-icon"></i>
                        <input type="text" id="waifu-search-input" class="waifu-search-input" placeholder="Pesquisar personagem ou série..." autocomplete="off">
                        <button id="waifu-search-clear" class="waifu-clear-btn hidden" title="Limpar busca"><i class="fas fa-times"></i></button>
                    </div>

                    <div class="waifu-filters-row">
                        <!-- Gender Filter -->
                        <div class="waifu-filter-group">
                            <span class="waifu-filter-label"><i class="fas fa-venus-mars"></i> Gênero:</span>
                            <div class="waifu-pill-group" id="waifu-gender-pills">
                                <button class="waifu-pill active" data-gender="">Todos</button>
                                <button class="waifu-pill" data-gender="FEMALE">Feminino</button>
                                <button class="waifu-pill" data-gender="MALE">Masculino</button>
                            </div>
                        </div>

                        <!-- Marital Status Filter -->
                        <div class="waifu-filter-group">
                            <span class="waifu-filter-label"><i class="fas fa-ring"></i> Estado:</span>
                            <div class="waifu-pill-group" id="waifu-status-pills">
                                <button class="waifu-pill active" data-status="">Todos</button>
                                <button class="waifu-pill" data-status="single">Solteiros</button>
                                <button class="waifu-pill" data-status="married">💍 Casados</button>
                            </div>
                        </div>

                        <!-- Rarity Filter -->
                        <div class="waifu-filter-group">
                            <span class="waifu-filter-label"><i class="fas fa-gem"></i> Raridade:</span>
                            <select id="waifu-rarity-select" class="waifu-select">
                                <option value="">Todas</option>
                                <option value="LEGENDARY">⭐ Lendário</option>
                                <option value="EPIC">🟣 Épico</option>
                                <option value="RARE">🔵 Raro</option>
                                <option value="UNCOMMON">🟢 Incomum</option>
                                <option value="COMMON">⚪ Comum</option>
                            </select>
                        </div>

                        <!-- Sort Order -->
                        <div class="waifu-filter-group">
                            <span class="waifu-filter-label"><i class="fas fa-sort"></i> Ordem:</span>
                            <select id="waifu-sort-select" class="waifu-select">
                                <option value="ranking">Ranking (Popular)</option>
                                <option value="name">Nome (A-Z)</option>
                            </select>
                        </div>
                    </div>
                </div>

                <!-- Main Content: Cards Grid -->
                <div class="waifu-grid-wrapper" id="waifu-grid-wrapper">
                    <div class="waifu-grid" id="waifu-grid">
                        <div class="waifu-loading">
                            <i class="fas fa-spinner fa-spin"></i>
                            <span>Carregando waifus e personagens...</span>
                        </div>
                    </div>
                </div>

                <!-- Footer: Pagination Controls -->
                <div class="waifu-pagination-bar" id="waifu-pagination-bar">
                    <div class="waifu-page-info">
                        <span id="waifu-total-count">0 personagens</span>
                    </div>
                    <div class="waifu-page-buttons">
                        <button class="os-btn waifu-nav-btn" id="waifu-first-btn" title="Primeira página" disabled><i class="fas fa-angle-double-left"></i></button>
                        <button class="os-btn waifu-nav-btn" id="waifu-prev-btn" title="Página anterior" disabled><i class="fas fa-angle-left"></i> Anterior</button>
                        <span class="waifu-page-indicator" id="waifu-page-indicator">1 / 1</span>
                        <button class="os-btn waifu-nav-btn" id="waifu-next-btn" title="Próxima página" disabled>Próxima <i class="fas fa-angle-right"></i></button>
                        <button class="os-btn waifu-nav-btn" id="waifu-last-btn" title="Última página" disabled><i class="fas fa-angle-double-right"></i></button>
                    </div>
                </div>

                <!-- Floating Toast Notification -->
                <div class="waifu-toast hidden" id="waifu-toast">
                    <span class="waifu-toast-icon"><i class="fas fa-star" style="color: var(--gold-color);"></i></span>
                    <span id="waifu-toast-msg">Copiado comando! Envie pra ravena ou no seu grupo.</span>
                </div>
            </div>
        `;

        this.bindEvents(body);
        this.setupDynamicPagination(body);
        this.loadCharacters(body);
    },

    bindEvents(body) {
        const searchInput = body.querySelector('#waifu-search-input');
        const clearBtn = body.querySelector('#waifu-search-clear');
        const genderPills = body.querySelectorAll('#waifu-gender-pills .waifu-pill');
        const raritySelect = body.querySelector('#waifu-rarity-select');
        const sortSelect = body.querySelector('#waifu-sort-select');

        const firstBtn = body.querySelector('#waifu-first-btn');
        const prevBtn = body.querySelector('#waifu-prev-btn');
        const nextBtn = body.querySelector('#waifu-next-btn');
        const lastBtn = body.querySelector('#waifu-last-btn');

        // Search input with 350ms debounce
        let searchTimeout = null;
        searchInput.addEventListener('input', (e) => {
            const val = e.target.value.trim();
            if (val.length > 0) {
                clearBtn.classList.remove('hidden');
            } else {
                clearBtn.classList.add('hidden');
            }

            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => {
                this.state.search = val;
                this.state.page = 1;
                this.loadCharacters(body);
            }, 350);
        });

        clearBtn.addEventListener('click', () => {
            searchInput.value = '';
            clearBtn.classList.add('hidden');
            this.state.search = '';
            this.state.page = 1;
            this.loadCharacters(body);
        });

        // Gender filter pills
        genderPills.forEach((pill) => {
            pill.addEventListener('click', () => {
                genderPills.forEach(p => p.classList.remove('active'));
                pill.classList.add('active');
                this.state.gender = pill.dataset.gender;
                this.state.page = 1;
                this.loadCharacters(body);
            });
        });

        // Marital status filter pills (Todos / Solteiros / Casados)
        const statusPills = body.querySelectorAll('#waifu-status-pills .waifu-pill');
        statusPills.forEach((pill) => {
            pill.addEventListener('click', () => {
                if (this.state.maritalStatus === pill.dataset.status) return;
                statusPills.forEach(p => p.classList.remove('active'));
                pill.classList.add('active');
                this.state.maritalStatus = pill.dataset.status;
                this.state.page = 1;
                this.loadCharacters(body);
            });
        });

        // Rarity select
        raritySelect.addEventListener('change', (e) => {
            this.state.rarity = e.target.value;
            this.state.page = 1;
            this.loadCharacters(body);
        });

        // Sort select
        sortSelect.addEventListener('change', (e) => {
            this.state.sortBy = e.target.value;
            this.state.page = 1;
            this.loadCharacters(body);
        });

        // Pagination buttons
        firstBtn.addEventListener('click', () => {
            if (this.state.page > 1) {
                this.state.page = 1;
                this.loadCharacters(body);
            }
        });

        prevBtn.addEventListener('click', () => {
            if (this.state.page > 1) {
                this.state.page--;
                this.loadCharacters(body);
            }
        });

        nextBtn.addEventListener('click', () => {
            if (this.state.page < this.state.totalPages) {
                this.state.page++;
                this.loadCharacters(body);
            }
        });

        lastBtn.addEventListener('click', () => {
            if (this.state.page < this.state.totalPages) {
                this.state.page = this.state.totalPages;
                this.loadCharacters(body);
            }
        });
    },

    setupDynamicPagination(body) {
        const wrapper = body.querySelector('#waifu-grid-wrapper');
        if (!wrapper) return;

        const calculateLimit = () => {
            const w = wrapper.clientWidth;
            const h = wrapper.clientHeight;
            if (w <= 0 || h <= 0) return;

            // Estimated card dimensions with gap
            const isMobile = window.innerWidth < 768;
            const cardMinWidth = isMobile ? 120 : 135;
            const cardEstimatedHeight = 180;
            const gap = 8;

            const cols = Math.max(1, Math.floor((w + gap) / (cardMinWidth + gap)));
            const rows = Math.max(1, Math.floor((h + gap) / (cardEstimatedHeight + gap)));
            const newLimit = Math.max(4, Math.min(60, cols * rows));

            if (newLimit !== this.state.limit) {
                this.state.limit = newLimit;
                this.loadCharacters(body);
            }
        };

        // ResizeObserver to dynamically update page limit based on container dimensions
        if (window.ResizeObserver) {
            let resizeTimer = null;
            const ro = new ResizeObserver(() => {
                clearTimeout(resizeTimer);
                resizeTimer = setTimeout(calculateLimit, 150);
            });
            ro.observe(wrapper);
        }

        setTimeout(calculateLimit, 350);
    },

    async loadCharacters(body) {
        const grid = body.querySelector('#waifu-grid');
        const totalCountEl = body.querySelector('#waifu-total-count');
        const pageIndicatorEl = body.querySelector('#waifu-page-indicator');
        const firstBtn = body.querySelector('#waifu-first-btn');
        const prevBtn = body.querySelector('#waifu-prev-btn');
        const nextBtn = body.querySelector('#waifu-next-btn');
        const lastBtn = body.querySelector('#waifu-last-btn');

        grid.innerHTML = `
            <div class="waifu-loading">
                <i class="fas fa-spinner fa-spin"></i>
                <span>Carregando waifus e personagens...</span>
            </div>
        `;

        try {
            const params = new URLSearchParams({
                page: this.state.page,
                limit: this.state.limit
            });
            if (this.state.search) params.append('search', this.state.search);
            if (this.state.gender) params.append('gender', this.state.gender);
            if (this.state.rarity) params.append('rarity', this.state.rarity);
            if (this.state.maritalStatus) params.append('maritalStatus', this.state.maritalStatus);
            if (this.state.sortBy) params.append('sortBy', this.state.sortBy);

            const res = await Api.get(`/api/waifuletes/characters?${params.toString()}`);
            const resultData = res?.data;
            let characters = resultData?.data || [];

            // Filtro de fallback caso a API ainda não tenha sido reiniciada com o filtro
            if (this.state.maritalStatus === 'married') {
                characters = characters.filter((c) => !!(c.isClaimed || c.marriage || c.owner));
            } else if (this.state.maritalStatus === 'single') {
                characters = characters.filter((c) => !(c.isClaimed || c.marriage || c.owner));
            }

            this.state.total = resultData?.total || 0;
            this.state.totalPages = Math.max(1, resultData?.totalPages || 1);
            this.state.page = resultData?.page || this.state.page;

            // Update pagination UI
            totalCountEl.textContent = `${this.state.total.toLocaleString('pt-BR')} personagens encontrados`;
            pageIndicatorEl.textContent = `${this.state.page} / ${this.state.totalPages}`;

            firstBtn.disabled = this.state.page <= 1;
            prevBtn.disabled = this.state.page <= 1;
            nextBtn.disabled = this.state.page >= this.state.totalPages;
            lastBtn.disabled = this.state.page >= this.state.totalPages;

            if (characters.length === 0) {
                grid.innerHTML = `
                    <div class="waifu-empty">
                        <i class="fas fa-heart-broken" style="font-size: 36px; margin-bottom: 12px; color: #ff5252;"></i>
                        <p>Nenhum personagem encontrado com os filtros selecionados.</p>
                    </div>
                `;
                return;
            }

            grid.innerHTML = '';
            characters.forEach((char) => {
                grid.appendChild(this.createCharacterCard(char, body));
            });
        } catch (err) {
            console.error('Erro ao carregar personagens:', err);
            grid.innerHTML = `
                <div class="waifu-empty">
                    <i class="fas fa-exclamation-triangle" style="font-size: 32px; color: var(--gold-color); margin-bottom: 10px;"></i>
                    <p>Não foi possível carregar os personagens no momento.</p>
                    <button class="os-btn" style="margin-top: 12px;" onclick="WindowManager.open('waifuletes')">Tentar Novamente</button>
                </div>
            `;
        }
    },

    createCharacterCard(char, body) {
        const rarityKey = char.baseRarity || char.rarity || 'COMMON';
        const rarityCfg = this.RARITY_CONFIG[rarityKey] || this.RARITY_CONFIG.COMMON;
        const imgSrc = char.imageUrl || '/ravena-help-small.jpg';
        const spouse = char.marriage?.spouse || char.owner?.name || (typeof char.owner === 'string' ? char.owner : null);
        const groupName = char.marriage?.groupName;
        const isMarried = !!(char.isClaimed || char.marriage || spouse);
        const wishlistCount = char.wishlistCount ?? 0;

        const card = document.createElement('div');
        card.className = `waifu-card rarity-${rarityKey.toLowerCase()}`;
        card.dataset.id = char.id;

        // Married badge tooltip text for desktop hover
        let marriedTooltip = 'Casada(o)';
        if (spouse && groupName) {
            marriedTooltip = `Casada(o) com ${spouse} no grupo ${groupName}`;
        } else if (spouse) {
            marriedTooltip = `Casada(o) com ${spouse}`;
        }

        card.innerHTML = `
            <div class="waifu-img-wrap">
                <img src="${imgSrc}" loading="lazy" alt="${char.name}" onerror="this.onerror=null;this.src='/ravena-help-small.jpg';">
                
                ${isMarried ? `
                    <button class="waifu-married-badge" title="💍 ${marriedTooltip}" aria-label="Casada(o)">
                        💍
                    </button>
                ` : ''}

                <button class="waifu-fav-btn" title="Favoritar / Desejar ${char.name}" aria-label="Favoritar">
                    <i class="far fa-star"></i>
                </button>

                <div class="waifu-rarity-badge" style="border-color: ${rarityCfg.color}; color: ${rarityCfg.color};" title="Raridade: ${rarityCfg.label}">
                    ${rarityCfg.emoji}
                </div>

                <div class="waifu-wishes-badge" title="${wishlistCount} pessoa(s) adicionaram à wishlist" aria-label="${wishlistCount} desejos">
                    <span class="waifu-wishes-icon">✨</span>
                    <span class="waifu-wishes-count">${wishlistCount}</span>
                </div>
            </div>
            <div class="waifu-card-info">
                <div class="waifu-card-name" title="${char.name}">${char.name}</div>
                <div class="waifu-card-series" title="${char.series || ''}">${char.series || 'Sem série'}</div>
            </div>
        `;

        // Star button action: Copies "!mu-desejar <id>" to clipboard and shows mini notification
        const favBtn = card.querySelector('.waifu-fav-btn');
        favBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.handleFavoritar(char.id, favBtn, body);
        });

        // Married badge action: Click/Tap shows toast with spouse and group name
        if (isMarried) {
            const marriedBtn = card.querySelector('.waifu-married-badge');
            if (marriedBtn) {
                marriedBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    await this.handleMarriedClick(char, marriedBtn, body);
                });
            }
        }

        // Wishes badge action: Click/Tap shows toast with wishlist count
        const wishesBadge = card.querySelector('.waifu-wishes-badge');
        if (wishesBadge) {
            wishesBadge.addEventListener('click', (e) => {
                e.stopPropagation();
                const count = char.wishlistCount ?? 0;
                const text = count === 1
                    ? `✨ ${char.name} está na wishlist de 1 pessoa!`
                    : `✨ ${char.name} foi adicionado(a) a ${count} wishlists!`;
                this.showToast(body, text, '✨');
            });
        }

        return card;
    },

    async handleMarriedClick(char, btn, body) {
        let spouse = char.marriage?.spouse || char.owner?.name || (typeof char.owner === 'string' ? char.owner : null);
        let groupName = char.marriage?.groupName;
        const groupId = char.marriage?.groupId || char.claimedInGroup;

        // Se ainda não temos o nome do grupo, busca dinamicamente
        if (groupId && !groupName) {
            try {
                const groupRes = await Api.get(`/api/waifuletes/group?id=${encodeURIComponent(groupId)}`);
                if (groupRes?.data?.name) {
                    groupName = groupRes.data.name;
                    if (!char.marriage) char.marriage = {};
                    char.marriage.groupName = groupName;
                }
            } catch (_) {}
        }

        // Se ainda não temos cônjuge, tenta detalhe individual
        if (!spouse) {
            try {
                const detailRes = await Api.get(`/api/waifuletes/characters/${encodeURIComponent(char.id)}`);
                const data = detailRes?.data?.data;
                if (data?.marriage) {
                    spouse = data.marriage.spouse || spouse;
                    groupName = data.marriage.groupName || groupName;
                    char.marriage = data.marriage;
                } else if (data?.owner?.name) {
                    spouse = data.owner.name;
                }
            } catch (_) {}
        }

        let toastMsg = '💍 Casada(o)';
        if (spouse && groupName) {
            toastMsg = `💍 Casada(o) com ${spouse} no grupo ${groupName}`;
        } else if (spouse) {
            toastMsg = `💍 Casada(o) com ${spouse}`;
        }

        btn.title = toastMsg;
        this.showToast(body, toastMsg, '💍');
    },

    handleFavoritar(charId, btn, body) {
        const cmd = `!mu-desejar ${charId}`;

        const doCopy = () => {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                return navigator.clipboard.writeText(cmd);
            }
            // Fallback for older browsers / non-secure contexts
            const textArea = document.createElement('textarea');
            textArea.value = cmd;
            textArea.style.position = 'fixed';
            textArea.style.opacity = '0';
            document.body.appendChild(textArea);
            textArea.select();
            document.execCommand('copy');
            document.body.removeChild(textArea);
            return Promise.resolve();
        };

        doCopy()
            .then(() => {
                // Button visual pulse
                btn.classList.add('active');
                const icon = btn.querySelector('i');
                if (icon) {
                    icon.className = 'fas fa-star';
                }

                setTimeout(() => {
                    btn.classList.remove('active');
                    if (icon) {
                        icon.className = 'far fa-star';
                    }
                }, 2000);

                this.showToast(body, 'Copiado comando! Envie pra ravena ou no seu grupo.');
            })
            .catch((err) => {
                console.error('Falha ao copiar:', err);
                this.showToast(body, `Comando: ${cmd}`);
            });
    },

    showToast(body, message, iconHtml) {
        const toast = body.querySelector('#waifu-toast');
        const toastMsg = body.querySelector('#waifu-toast-msg');
        if (!toast || !toastMsg) return;

        const iconContainer = toast.querySelector('.waifu-toast-icon') || toast.querySelector('i');
        if (iconContainer) {
            if (iconHtml) {
                if (iconHtml.startsWith('<')) {
                    iconContainer.innerHTML = iconHtml;
                } else {
                    iconContainer.innerHTML = `<span style="font-size: 15px; line-height: 1;">${iconHtml}</span>`;
                }
            } else {
                iconContainer.innerHTML = '<i class="fas fa-star" style="color: var(--gold-color);"></i>';
            }
        }

        toastMsg.textContent = message;
        toast.classList.remove('hidden');
        toast.classList.add('visible');

        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => {
            toast.classList.remove('visible');
            setTimeout(() => toast.classList.add('hidden'), 300);
        }, 3500);
    }
});
