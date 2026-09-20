document.addEventListener('DOMContentLoaded', () => {
    const commandList = document.getElementById('command-list');
    const loading = document.getElementById('loading');
    const toast = document.getElementById('toast');
    const toastText = document.getElementById('toast-text');
    const searchInput = document.getElementById('command-search');
    const clearSearchBtn = document.getElementById('clear-search');
    const noResults = document.getElementById('no-results');
    const searchTermSpan = document.getElementById('search-term');
    const categoryPillsContainer = document.getElementById('category-pills');
    const btnExpandAll = document.getElementById('btn-expand-all');
    const btnCollapseAll = document.getElementById('btn-collapse-all');
    const statTotalCmds = document.getElementById('stat-total-cmds');
    const statTotalCats = document.getElementById('stat-total-cats');

    let allLoadedCommands = [];
    let activeCategoryFilter = 'all';
    let lastTap = 0;
    let toastTimeout = null;

    // Fetch and load public commands
    async function fetchCommands() {
        try {
            const response = await fetch('/api/public-commands');
            if (!response.ok) throw new Error('Falha ao carregar comandos do servidor');
            const data = await response.json();
            renderApp(data);
            startRandomPlaceholder();
        } catch (error) {
            console.error('[cmd.js] Erro ao carregar comandos:', error);
            if (loading) {
                loading.innerHTML = `
                    <div style="color: var(--danger-color); padding: 2rem 1rem;">
                        <i class="fas fa-exclamation-circle" style="font-size: 2rem; margin-bottom: 10px; display: block;"></i>
                        <p><strong>Erro ao carregar comandos:</strong> ${error.message}</p>
                        <button onclick="location.reload()" class="btn-copy" style="margin-top: 15px;">
                            <i class="fas fa-redo"></i> Tentar novamente
                        </button>
                    </div>
                `;
            }
        }
    }

    function renderApp(data) {
        if (loading) loading.remove();

        let totalCmdsCount = 0;
        let totalCatsCount = 0;

        // Limpa lista mantendo banners de aviso e info
        const existingSections = commandList.querySelectorAll('.category-section');
        existingSections.forEach(s => s.remove());

        // 1. Processa Categorias Fixas
        if (Array.isArray(data.categories)) {
            data.categories.forEach((category, index) => {
                if (!category.commands || category.commands.length === 0) return;
                totalCatsCount++;
                totalCmdsCount += category.commands.length;

                // Renderiza seção da categoria (primeira categoria aberta por padrão)
                const section = createCategorySection(category, index === 0);
                commandList.appendChild(section);

                // Armazena comandos para autocomplete/placeholder
                category.commands.forEach(cmd => {
                    allLoadedCommands.push({
                        ...cmd,
                        categoryName: category.name,
                        categoryEmoji: category.emoji
                    });
                });

                // Cria Pill de Categoria
                createCategoryPill(category.name, category.emoji, category.commands.length);
            });
        }

        // 2. Processa Comandos de Gerenciamento
        if (data.management && Object.keys(data.management).length > 0) {
            const mgmtCommands = Object.entries(data.management).map(([key, data]) => {
                return {
                    name: data.name || `g-${key}`,
                    description: data.description || 'Comando de administração do grupo.',
                    aliases: data.aliases || [],
                    usage: data.usage || [`!g-${key}`],
                    examples: data.examples || [`!g-${key}`],
                    about: data.about || 'Configurações e moderação de grupos',
                    isManagement: true
                };
            });

            totalCatsCount++;
            totalCmdsCount += mgmtCommands.length;

            const mgmtCategory = {
                name: 'Gerenciamento',
                emoji: '⚙️',
                commands: mgmtCommands
            };

            const mgmtSection = createCategorySection(mgmtCategory, false);
            commandList.appendChild(mgmtSection);

            mgmtCommands.forEach(cmd => {
                allLoadedCommands.push({
                    ...cmd,
                    categoryName: 'Gerenciamento',
                    categoryEmoji: '⚙️'
                });
            });

            createCategoryPill('Gerenciamento', '⚙️', mgmtCommands.length);
        }

        // Atualiza contadores do Hero
        if (statTotalCmds) statTotalCmds.textContent = totalCmdsCount;
        if (statTotalCats) statTotalCats.textContent = totalCatsCount;
    }

    function createCategoryPill(name, emoji, count) {
        const pill = document.createElement('button');
        pill.className = 'cat-pill';
        pill.dataset.cat = name.toLowerCase();
        pill.innerHTML = `<span>${emoji}</span> ${name} <span class="badge-count">${count}</span>`;

        pill.addEventListener('click', () => {
            document.querySelectorAll('.cat-pill').forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            filterByCategory(name.toLowerCase());
        });

        categoryPillsContainer.appendChild(pill);
    }

    function createCategorySection(category, isOpen) {
        const section = document.createElement('div');
        section.className = `category-section ${isOpen ? 'active' : ''}`;
        section.dataset.catName = category.name.toLowerCase();

        const header = document.createElement('div');
        header.className = 'category-header';
        header.innerHTML = `
            <div class="category-title">
                <span>${category.emoji}</span>
                <span>${category.name}</span>
                <span class="badge-count">${category.commands.length}</span>
            </div>
            <i class="fas fa-chevron-down arrow"></i>
        `;

        header.addEventListener('click', () => {
            section.classList.toggle('active');
        });

        const content = document.createElement('div');
        content.className = 'category-content';

        const list = document.createElement('ul');
        list.className = 'command-list';

        category.commands.forEach(cmd => {
            const item = createCommandItem(cmd, category);
            list.appendChild(item);
        });

        content.appendChild(list);
        section.appendChild(header);
        section.appendChild(content);

        return section;
    }

    function createCommandItem(cmd, category) {
        const li = document.createElement('li');
        li.className = 'command-item';
        
        // Metadados para busca
        const cmdName = cmd.name.toLowerCase();
        const aliases = Array.isArray(cmd.aliases) ? cmd.aliases : [];
        const aliasesStr = aliases.join(',').toLowerCase();
        const desc = (cmd.description || '').toLowerCase();
        const usages = Array.isArray(cmd.usage) ? cmd.usage : (cmd.usage ? [cmd.usage] : [`!${cmd.name}`]);
        const usagesStr = usages.join(' ').toLowerCase();

        li.dataset.name = cmdName;
        li.dataset.aliases = aliasesStr;
        li.dataset.desc = desc;
        li.dataset.usage = usagesStr;
        li.dataset.category = category.name.toLowerCase();

        // Linha de aliases formatados
        let aliasesHtml = '';
        if (aliases.length > 0) {
            aliasesHtml = aliases.map(a => `<span class="alias-badge">!${a}</span>`).join(' ');
        }

        // Badge de Administrador
        const isAdmin = cmd.isManagement || cmd.name.startsWith('g-');
        const adminBadgeHtml = isAdmin ? `<span class="cmd-badge-admin"><i class="fas fa-shield-alt"></i> Admin</span>` : '';

        // Container de reação
        let reactionHtml = '';
        if (cmd.reaction) {
            reactionHtml = `
                <div class="cmd-reaction-pill" title="Reação de atalho no WhatsApp">
                    <span>${cmd.reaction}</span>
                </div>
            `;
        }

        // Linha Principal do Comando (Resumo)
        const summaryRow = document.createElement('div');
        summaryRow.className = 'cmd-summary-row';
        summaryRow.innerHTML = `
            <div class="cmd-main-info">
                <div class="cmd-name-line">
                    <span class="cmd-name">!${cmd.name}</span>
                    ${adminBadgeHtml}
                    ${aliasesHtml}
                </div>
                <div class="cmd-desc">${cmd.description || 'Sem descrição.'}</div>
            </div>
            <div class="cmd-right-info">
                ${reactionHtml}
                <i class="fas fa-chevron-down cmd-expand-icon"></i>
            </div>
        `;

        // Drawer de Detalhes e Usage (Expandível ao Clicar)
        const detailsDrawer = document.createElement('div');
        detailsDrawer.className = 'cmd-details-drawer';

        // Sintaxe principal (primeiro usage ou !nome)
        const mainSyntax = usages[0] || `!${cmd.name}`;

        // Exemplos adicionais
        let examplesHtml = '';
        if (usages.length > 1) {
            examplesHtml = `
                <div>
                    <div class="detail-section-title"><i class="fas fa-list-ul"></i> Outros Exemplos de Uso:</div>
                    <div class="examples-container">
                        ${usages.slice(1).map(u => `
                            <div class="example-row">
                                <span class="example-text">${escapeHtml(u)}</span>
                                <button class="btn-copy-sm" data-copy="${escapeHtml(u)}" title="Copiar este exemplo">
                                    <i class="far fa-copy"></i>
                                </button>
                            </div>
                        `).join('')}
                    </div>
                </div>
            `;
        }

        // Sobre o módulo
        let aboutHtml = '';
        if (cmd.about) {
            aboutHtml = `
                <div class="detail-pill">
                    <i class="fas fa-info-circle"></i>
                    <span><strong>Sobre:</strong> ${escapeHtml(cmd.about)}</span>
                </div>
            `;
        }

        // Reação
        let reactionNoticeHtml = '';
        if (cmd.reaction) {
            reactionNoticeHtml = `
                <div class="detail-pill reaction-pill">
                    <i class="far fa-smile-wink"></i>
                    <span>Atalho: Reaja à mensagem com <strong>${cmd.reaction}</strong> para executar automaticamente.</span>
                </div>
            `;
        }

        // Permissão
        const permissionNoticeHtml = isAdmin ? `
            <div class="detail-pill admin-pill">
                <i class="fas fa-lock"></i>
                <span>Comando restrito aos administradores do grupo (prefixo <code>!g-</code>).</span>
            </div>
        ` : `
            <div class="detail-pill">
                <i class="fas fa-unlock"></i>
                <span>Comando livre para todos os membros do grupo e privado.</span>
            </div>
        `;

        detailsDrawer.innerHTML = `
            <div class="details-card">
                <div>
                    <div class="detail-section-title"><i class="fas fa-terminal"></i> Como Usar (Sintaxe):</div>
                    <div class="code-box">
                        <code>${escapeHtml(mainSyntax)}</code>
                        <button class="btn-copy btn-copy-action" data-copy="${escapeHtml(mainSyntax)}">
                            <i class="far fa-copy"></i> Copiar
                        </button>
                    </div>
                </div>

                ${examplesHtml}

                <div class="detail-notes">
                    ${permissionNoticeHtml}
                    ${reactionNoticeHtml}
                    ${aboutHtml}
                </div>

                <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-top: 4px;">
                    <button class="btn-copy btn-copy-action" data-copy="!${escapeHtml(cmd.name)}" style="background: rgba(255,255,255,0.05); color: var(--text-highlight); border-color: var(--border-color);">
                        <i class="fas fa-hashtag"></i> Copiar <code>!${escapeHtml(cmd.name)}</code>
                    </button>
                    ${mainSyntax !== `!${cmd.name}` ? `
                        <button class="btn-copy btn-copy-action" data-copy="${escapeHtml(mainSyntax)}">
                            <i class="fas fa-play"></i> Copiar Exemplo Completo
                        </button>
                    ` : ''}
                </div>
            </div>
        `;

        // Interação de Clique para Expandir / Recolher
        summaryRow.addEventListener('click', (e) => {
            // Previne disparar se clicou diretamente em algum botão de cópia
            if (e.target.closest('button')) return;

            const now = Date.now();
            if (now - lastTap < 400) {
                // Duplo clique: copia o comando rapidamente
                copyToClipboard(`!${cmd.name}`);
                lastTap = 0;
                return;
            }
            lastTap = now;

            // Toggle expansion
            li.classList.toggle('expanded');
        });

        // Configura eventos de cópia dentro do drawer
        detailsDrawer.querySelectorAll('.btn-copy-action, .btn-copy-sm').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const textToCopy = btn.dataset.copy;
                if (textToCopy) {
                    copyToClipboard(textToCopy);
                }
            });
        });

        li.appendChild(summaryRow);
        li.appendChild(detailsDrawer);

        return li;
    }

    // Filtro por Categoria via Pills
    function filterByCategory(catName) {
        activeCategoryFilter = catName;
        const categories = document.querySelectorAll('.category-section');

        categories.forEach(category => {
            const thisCat = category.dataset.catName;
            if (catName === 'all' || thisCat === catName) {
                category.classList.remove('hidden');
                category.classList.add('active'); // Abre a categoria selecionada
            } else {
                category.classList.add('hidden');
            }
        });

        // Scroll suave para a lista
        commandList.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    // Busca Dinâmica em Tempo Real
    searchInput.addEventListener('input', (e) => {
        const term = e.target.value.toLowerCase().trim();
        handleSearch(term);
    });

    function handleSearch(term) {
        if (term.length > 0) {
            clearSearchBtn.classList.remove('hidden');
        } else {
            clearSearchBtn.classList.add('hidden');
        }

        let totalMatches = 0;
        const categories = document.querySelectorAll('.category-section');

        categories.forEach(category => {
            const thisCatName = category.dataset.catName;
            // Se houver filtro de categoria ativo, respeita-o
            if (activeCategoryFilter !== 'all' && thisCatName !== activeCategoryFilter && term.length === 0) {
                category.classList.add('hidden');
                return;
            }

            const commands = category.querySelectorAll('.command-item');
            let categoryMatches = 0;

            commands.forEach(cmd => {
                const name = cmd.dataset.name;
                const aliases = cmd.dataset.aliases;
                const desc = cmd.dataset.desc;
                const usage = cmd.dataset.usage;

                const isMatch = !term ||
                    name.includes(term) ||
                    aliases.includes(term) ||
                    desc.includes(term) ||
                    usage.includes(term);

                if (isMatch) {
                    cmd.classList.remove('hidden');
                    categoryMatches++;
                    totalMatches++;
                } else {
                    cmd.classList.add('hidden');
                }
            });

            if (categoryMatches > 0) {
                category.classList.remove('hidden');
                if (term.length > 0) {
                    category.classList.add('active'); // Abre categorias com resultados
                }
            } else {
                category.classList.add('hidden');
            }
        });

        if (totalMatches === 0 && term.length > 0) {
            noResults.classList.remove('hidden');
            if (searchTermSpan) searchTermSpan.textContent = term;
        } else {
            noResults.classList.add('hidden');
        }
    }

    // Limpar Busca
    clearSearchBtn.addEventListener('click', () => {
        searchInput.value = '';
        clearSearchBtn.classList.add('hidden');
        handleSearch('');
        searchInput.focus();
    });

    // Expandir e Recolher Todos
    if (btnExpandAll) {
        btnExpandAll.addEventListener('click', () => {
            document.querySelectorAll('.category-section').forEach(sec => sec.classList.add('active'));
            document.querySelectorAll('.command-item').forEach(item => {
                if (!item.classList.contains('hidden')) {
                    item.classList.add('expanded');
                }
            });
        });
    }

    if (btnCollapseAll) {
        btnCollapseAll.addEventListener('click', () => {
            document.querySelectorAll('.command-item').forEach(item => item.classList.remove('expanded'));
            document.querySelectorAll('.category-section').forEach(sec => sec.classList.remove('active'));
        });
    }

    // Atalho de teclado para focar na busca ('/' ou 'Ctrl+K')
    document.addEventListener('keydown', (e) => {
        if (e.target === searchInput) {
            if (e.key === 'Escape') {
                searchInput.value = '';
                handleSearch('');
                searchInput.blur();
            }
            return;
        }

        if (e.key === '/' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k')) {
            e.preventDefault();
            searchInput.focus();
            searchInput.select();
        }
    });

    // Função de Cópia com Toast de Feedback
    function copyToClipboard(text) {
        if (!text) return;
        navigator.clipboard.writeText(text).then(() => {
            showToast(`Copiado: "${text}"`);
        }).catch(err => {
            // Fallback para navegadores legados
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            try {
                document.execCommand('copy');
                showToast(`Copiado: "${text}"`);
            } catch (copyErr) {
                console.error('[cmd.js] Falha ao copiar:', copyErr);
                showToast('Erro ao copiar');
            }
            document.body.removeChild(textarea);
        });
    }

    function showToast(message) {
        if (!toast) return;
        if (toastText) toastText.textContent = message;
        toast.classList.remove('hidden');

        if (toastTimeout) clearTimeout(toastTimeout);
        toastTimeout = setTimeout(() => {
            toast.classList.add('hidden');
        }, 2200);
    }

    // Placeholder Aleatório no Input de Busca
    function startRandomPlaceholder() {
        if (allLoadedCommands.length === 0) return;
        setInterval(() => {
            if (document.activeElement !== searchInput && searchInput.value === '') {
                const randomCmd = allLoadedCommands[Math.floor(Math.random() * allLoadedCommands.length)];
                if (randomCmd && randomCmd.name) {
                    searchInput.setAttribute('placeholder', `Buscar comando... ex: !${randomCmd.name}`);
                }
            }
        }, 3200);
    }

    function escapeHtml(text) {
        if (typeof text !== 'string') return '';
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    // Inicialização
    fetchCommands();
});