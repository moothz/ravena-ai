document.addEventListener('DOMContentLoaded', () => {
    const loadingContainer = document.getElementById('loading-container');
    const errorContainer = document.getElementById('error-container');
    const dashboardContent = document.getElementById('dashboard-content');
    const categoriesContainer = document.getElementById('categories-container');
    const providerModal = document.getElementById('provider-modal');
    const btnSaveAll = document.getElementById('btn-save-all');
    
    let config = {};
    let costData = {};
    const categories = ['llm', 'whisper', 'comfyui', 'bonsai', 'sdwebui', 'f5tts'];
    const categoryNames = {
        'llm': 'Inteligência Artificial (LLM)',
        'whisper': 'Transcrição de Áudio (Whisper)',
        'comfyui': 'Geração de Imagens (ComfyUI)',
        'bonsai': 'Geração de Imagens (Bonsai)',
        'sdwebui': 'Geração de Imagens (SD WebUI)',
        'f5tts': 'Conversão de Texto em Fala (F5-TTS)'
    };

    // Basic auth is handled by the browser since the page itself is protected.
    // The browser will automatically send the credentials for all subsequent fetch requests to the same origin.

    async function fetchData() {
        showLoading(true);
        try {
            const [configRes, costRes] = await Promise.all([
                fetch('/api/service-providers'),
                fetch('/llm-cost-estimate.json')
            ]);

            if (!configRes.ok) throw new Error('Não autorizado ou erro no servidor');
            config = await configRes.json();
            
            if (costRes.ok) {
                costData = await costRes.json();
                populateCostPickers();
            }

            renderCategories();
            showLoading(false);
        } catch (err) {
            showError(err.message);
        }
    }

    function populateCostPickers() {
        const types = ['text', 'image', 'stt', 'tts'];
        types.forEach(type => {
            const picker = document.getElementById(`cost-picker-${type}`);
            if (!picker) return;
            
            let models = costData[type] || [];
            
            // Sort models by price (cheapest first)
            models.sort((a, b) => {
                const getPrice = (m) => {
                    if (m.price !== undefined) return m.price;
                    if (m.input !== undefined) return (m.input + m.output) / 2;
                    if (m.price_per_minute !== undefined) return m.price_per_minute;
                    if (m.price_per_1m_chars !== undefined) return m.price_per_1m_chars;
                    return 0;
                };
                return getPrice(a) - getPrice(b);
            });

            picker.innerHTML = models.map((m, i) => `<option value="${i}">${m.name}</option>`).join('');
            
            if (picker.options.length > 0) picker.selectedIndex = 0;
        });
    }

    function renderCategories() {
        categoriesContainer.innerHTML = '';
        categories.forEach(cat => {
            const section = document.createElement('div');
            section.className = 'category-section';
            
            const providers = config[cat] || [];
            
            section.innerHTML = `
                <div class="category-header">
                    <h3><i class="fas fa-server"></i> ${categoryNames[cat]}</h3>
                    <button class="btn-add" onclick="openModal('${cat}')"><i class="fas fa-plus"></i> Adicionar</button>
                </div>
                <div class="provider-list" id="list-${cat}">
                    ${providers.map((p, index) => renderProviderCard(cat, p, index)).join('')}
                </div>
            `;
            categoriesContainer.appendChild(section);
        });
    }

    function renderProviderCard(cat, p, index) {
        const isEnabled = p.enabled !== false;
        
        // Determinar status (Verde para o primeiro habilitado, Amarelo para os demais habilitados)
        let statusHtml = '';
        if (isEnabled) {
            const enabledProviders = config[cat].filter(prov => prov.enabled !== false);
            const isFirst = config[cat].findIndex(prov => prov.enabled !== false) === index;
            if (isFirst) {
                statusHtml = '<span class="status-badge status-main">Principal</span>';
            } else {
                statusHtml = '<span class="status-badge status-backup">Backup</span>';
            }
        }

        return `
            <div class="provider-card ${isEnabled ? '' : 'disabled'}">
                <div class="provider-info">
                    <div class="provider-name">${p.name} ${statusHtml}</div>
                    <div class="provider-type">${p.url} ${p.model ? `(${p.model})` : ''}</div>
                </div>
                <div>
                  <input type="checkbox" ${isEnabled ? 'checked' : ''} onchange="toggleProvider('${cat}', ${index})"> Ativo
                </div>
                <div class="provider-actions">
                    <button class="btn btn-sm btn-secondary" onclick="moveProviderUp('${cat}', ${index})" title="Mover para cima"><i class="fas fa-arrow-up"></i></button>
                    <button class="btn btn-sm btn-secondary" onclick="moveProviderDown('${cat}', ${index})" title="Mover para baixo"><i class="fas fa-arrow-down"></i></button>
                    <button class="btn btn-sm btn-info" onclick="openModal('${cat}', ${index})"><i class="fas fa-edit"></i></button>
                    <button class="btn btn-sm btn-danger" onclick="deleteProvider('${cat}', ${index})"><i class="fas fa-trash"></i></button>
                </div>
            </div>
        `;
    }

    window.openModal = (category, index = -1) => {
        document.getElementById('edit-category').value = category;
        document.getElementById('edit-index').value = index;
        
        const isEdit = index !== -1;
        document.getElementById('modal-title').innerText = isEdit ? 'Editar Provedor' : 'Adicionar Provedor';
        document.getElementById('btn-save-prov').innerText = isEdit ? 'Salvar' : 'Adicionar';
        document.getElementById('btn-delete-prov').classList.toggle('hidden', !isEdit);
        
        const llmFields = document.getElementById('llm-extra-fields');
        llmFields.classList.toggle('hidden', category !== 'llm');

        if (isEdit) {
            const p = config[category][index];
            document.getElementById('prov-name').value = p.name || '';
            document.getElementById('prov-url').value = p.url || '';
            document.getElementById('prov-apiKey').value = p.apiKey || '';
            document.getElementById('prov-enabled').checked = p.enabled !== false;
            
            if (category === 'llm') {
                document.getElementById('prov-type').value = p.type || 'ollama';
                document.getElementById('prov-model').value = p.model || '';
                document.getElementById('prov-timeout').value = p.timeout_multiplier || '';
                document.getElementById('prov-text-only').checked = !!p.textOnly;
                document.getElementById('prov-ignore-video').checked = !!p.ignoreVideo;
            }
           } else {
            document.getElementById('prov-name').value = '';
            document.getElementById('prov-url').value = '';
            document.getElementById('prov-apiKey').value = '';
            document.getElementById('prov-enabled').checked = true;
            document.getElementById('prov-type').value = 'ollama';
            document.getElementById('prov-model').value = '';
            document.getElementById('prov-timeout').value = '';
            document.getElementById('prov-text-only').checked = false;
            document.getElementById('prov-ignore-video').checked = false;
           }

        providerModal.classList.remove('hidden');
    };

    window.toggleProvider = (category, index) => {
        config[category][index].enabled = !config[category][index].enabled;
        renderCategories();
    };

    window.moveProviderUp = (category, index) => {
        if (index > 0) {
            const arr = config[category];
            [arr[index - 1], arr[index]] = [arr[index], arr[index - 1]];
            renderCategories();
        }
    };

    window.moveProviderDown = (category, index) => {
        const arr = config[category];
        if (index < arr.length - 1) {
            [arr[index + 1], arr[index]] = [arr[index], arr[index + 1]];
            renderCategories();
        }
    };

    window.deleteProvider = (category, index) => {
        if (confirm('Tem certeza que deseja remover este provedor?')) {
            config[category].splice(index, 1);
            renderCategories();
        }
    };

    document.getElementById('btn-save-prov').onclick = () => {
        const category = document.getElementById('edit-category').value;
        const index = parseInt(document.getElementById('edit-index').value);
        
        const provider = {
            name: document.getElementById('prov-name').value,
            url: document.getElementById('prov-url').value,
            apiKey: document.getElementById('prov-apiKey').value,
            enabled: document.getElementById('prov-enabled').checked
        };

        if (category === 'llm') {
            provider.type = document.getElementById('prov-type').value;
            provider.model = document.getElementById('prov-model').value;
            const timeout = parseFloat(document.getElementById('prov-timeout').value);
            if (!isNaN(timeout)) provider.timeout_multiplier = timeout;
            provider.textOnly = document.getElementById('prov-text-only').checked;
            provider.ignoreVideo = document.getElementById('prov-ignore-video').checked;
        }

        if (index === -1) {
            if (!config[category]) config[category] = [];
            config[category].push(provider);
        } else {
            config[category][index] = provider;
        }

        providerModal.classList.add('hidden');
        renderCategories();
    };

    btnSaveAll.onclick = async () => {
        btnSaveAll.disabled = true;
        btnSaveAll.innerHTML = '<i class="fas fa-spinner fa-spin"></i> SALVANDO...';
        
        try {
            const response = await fetch('/api/service-providers', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(config)
            });
            
            const result = await response.json();
            if (result.status === 'ok') {
                alert('Configurações salvas com sucesso!');
            } else {
                throw new Error(result.message);
            }
        } catch (err) {
            alert('Erro ao salvar: ' + err.message);
        } finally {
            btnSaveAll.disabled = false;
            btnSaveAll.innerHTML = '<i class="fas fa-save"></i> SALVAR TODAS AS ALTERAÇÕES';
        }
    };

    // UI helpers
    function showLoading(show) {
        loadingContainer.classList.toggle('hidden', !show);
        dashboardContent.classList.toggle('hidden', show);
    }

    function showError(msg) {
        showLoading(false);
        errorContainer.classList.remove('hidden');
        document.getElementById('error-message').innerText = msg;
    }

    // NEW: Queue and Stats logic
    async function fetchQueue() {
        try {
            const response = await fetch('/api/llm/queue');
            if (!response.ok) return;
            const data = await response.json();
            
            if (data.status === 'ok' && data.queues) {
                renderQueue(data.queues);
            } else if (data.status === 'ok') {
                // Handle case where queues might be directly sent (legacy or fallback)
                renderQueue(data.queues || data);
            }
            
            document.getElementById('queue-last-update').innerText = 'Última atualização: ' + new Date().toLocaleTimeString();
        } catch (err) {
            console.error('Erro ao buscar fila:', err);
        }
    }

    function renderQueue(queues) {
        const body = document.getElementById('llm-queue-body');
        body.innerHTML = '';
        
        if (!queues || typeof queues !== 'object') {
            body.innerHTML = '<tr><td colspan="4" class="text-center">Formato de dados da fila inválido</td></tr>';
            return;
        }

        const priorities = Object.keys(queues).sort((a, b) => b - a); // Higher priority first
        
        priorities.forEach(p => {
            const q = queues[p];
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>Prioridade ${p}</td>
                <td>${q.pending || 0}</td>
                <td>${q.processing || 0}</td>
                <td>${q.fulfilled || 0}</td>
                <td style="color: ${q.failed > 0 ? '#ff4444' : 'inherit'}">${q.failed || 0}</td>
            `;
            body.appendChild(tr);
        });

        if (priorities.length === 0) {
            body.innerHTML = '<tr><td colspan="4" class="text-center">Nenhuma requisição na fila</td></tr>';
        }
    }

    let currentTimeframe = 3600000; // 1 hour default

    async function fetchStats() {
        try {
            const response = await fetch(`/api/llm/stats?timeframe=${currentTimeframe}`);
            if (!response.ok) return;
            const data = await response.json();
            renderStats(data);
            document.getElementById('stats-last-update').innerText = 'Última atualização: ' + new Date().toLocaleTimeString();
        } catch (err) {
            console.error('Erro ao buscar estatísticas:', err);
        }
    }

    window.openTimeframeModal = () => {
        document.getElementById('timeframe-modal').classList.remove('hidden');
    };

    window.closeTimeframeModal = () => {
        document.getElementById('timeframe-modal').classList.add('hidden');
    };

    window.selectTimeframe = (value, label) => {
        currentTimeframe = value;
        document.getElementById('current-timeframe-label').innerText = label;
        
        // Update active class in buttons
        document.querySelectorAll('.timeframe-option').forEach(btn => {
            btn.classList.toggle('active', parseInt(btn.dataset.value) === value);
        });
        
        closeTimeframeModal();
        fetchStats();
    };

    window.calculateCosts = () => {
        // This will be called by pickers and after renderStats
        if (window.lastStatsData) {
            renderStats(window.lastStatsData);
        }
    };

    function renderStats(data) {
        if (!data) return;
        window.lastStatsData = data;
        
        let totalEstimatedCost = 0;

        // Dynamic header update
        const headerTextEl = document.getElementById('stats-header-text');
        const labelEl = document.getElementById('current-timeframe-label');
        
        if (currentTimeframe === 0 && data.first_record_timestamp) {
            const date = new Date(data.first_record_timestamp);
            const formattedDate = date.toLocaleDateString('pt-BR');
            if (headerTextEl) {
                headerTextEl.innerHTML = `Desempenho desde <span id="current-timeframe-label" class="clickable-period" onclick="openTimeframeModal()">${formattedDate}</span>`;
            }
        } else if (headerTextEl && labelEl) {
            // Restore "na" if not "All Time" but only if we need to reset
            if (headerTextEl.innerText.includes('desde')) {
                headerTextEl.innerHTML = `Desempenho na <span id="current-timeframe-label" class="clickable-period" onclick="openTimeframeModal()">${labelEl.innerText}</span>`;
            }
        }

        const elIn = document.getElementById('stat-total-in');
        const elOut = document.getElementById('stat-total-out');
        const elFailed = document.getElementById('stat-total-failed');
        const elCost = document.getElementById('stat-total-cost');
        
        if (elIn) elIn.innerText = (data.total_input_tokens || 0).toLocaleString();
        if (elOut) elOut.innerText = (data.total_output_tokens || 0).toLocaleString();
        
        if (elFailed) {
            const total = (data.total_requests || 0) + (data.total_failures || 0);
            const percent = total > 0 ? ((data.total_failures || 0) / total * 100).toFixed(1) : 0;
            elFailed.innerText = `${(data.total_failures || 0).toLocaleString()} (${percent}%)`;
        }

        const body = document.getElementById('llm-stats-body');
        body.innerHTML = '';

        const providers = Object.keys(data.by_provider || {});
        if (providers.length === 0) {
            body.innerHTML = '<tr><td colspan="7" class="text-center">Nenhuma requisição no período selecionado</td></tr>';
            return;
        }

        // Get current selected models for cost calculation
        const getModel = (type) => {
            const picker = document.getElementById(`cost-picker-${type.replace('_', '-')}`);
            if (!picker || !costData[type]) return null;
            return costData[type][picker.selectedIndex];
        };

        const activeModels = {
            text: getModel('text'),
            image: getModel('image'),
            stt: getModel('stt'),
            tts: getModel('tts')
        };

        providers.forEach(prov => {
            const pData = data.by_provider[prov];
            if (!pData) return;
            
            // Pre-process types to merge 'video' into 'text'
            const mergedByType = {};
            Object.keys(pData.by_type || {}).forEach(type => {
                const targetType = type === 'video' ? 'text' : type;
                if (!mergedByType[targetType]) {
                    mergedByType[targetType] = { requests: 0, input_tokens: 0, output_tokens: 0, duration_sec: 0 };
                }
                mergedByType[targetType].requests += pData.by_type[type].requests;
                mergedByType[targetType].input_tokens += pData.by_type[type].input_tokens;
                mergedByType[targetType].output_tokens += pData.by_type[type].output_tokens;
                if (pData.by_type[type].duration_sec) mergedByType[targetType].duration_sec += pData.by_type[type].duration_sec;
            });

            const types = Object.keys(mergedByType);
            
            types.forEach((type, index) => {
                const tData = mergedByType[type];
                
                // Calculate Cost for this row
                let rowCost = 0;
                const model = activeModels[type]; 

                if (model) {
                    if (type === 'text') {
                        rowCost = (tData.input_tokens / 1000000 * model.input) + (tData.output_tokens / 1000000 * model.output);
                    } else if (type === 'image') {
                        if (model.price !== undefined) {
                            rowCost = tData.requests * model.price;
                        } else {
                            rowCost = (tData.input_tokens + tData.output_tokens) / 1000000 * (model.price || 1.0);
                        }
                    } else if (type === 'stt') {
                        if (model.price_per_minute) {
                            const durationMin = (tData.duration_sec || (tData.requests * 10)) / 60;
                            rowCost = durationMin * model.price_per_minute;
                        } else if (model.price_per_1m_chars) {
                            rowCost = tData.input_tokens / 1000000 * model.price_per_1m_chars;
                        }
                    } else if (type === 'tts') {
                        if (model.price_per_1m_chars) {
                            rowCost = tData.output_tokens / 1000000 * model.price_per_1m_chars;
                        } else if (model.price !== undefined) {
                            rowCost = tData.requests * model.price;
                        }
                    }
                }

                totalEstimatedCost += rowCost;

                const tr = document.createElement('tr');
                tr.innerHTML = `
                    ${index === 0 ? `<td rowspan="${types.length}" style="vertical-align: middle; font-weight: bold;">${prov}</td>` : ''}
                    <td><span class="status-badge" style="background: #444;">${type.toUpperCase()}</span></td>
                    <td>${tData.requests}</td>
                    <td style="color: ${tData.failures > 0 ? '#ff4444' : 'inherit'}">${tData.failures || 0}</td>
                    <td>${tData.input_tokens.toLocaleString()}</td>
                    <td>${tData.output_tokens.toLocaleString()}</td>
                    <td style="color: #2ecc71; font-weight: bold;">$ ${rowCost.toFixed(4)}</td>
                `;
                body.appendChild(tr);
            });
        });

        const elTotalCost = document.getElementById('stat-total-cost');
        if (elTotalCost) elTotalCost.innerText = '$ ' + totalEstimatedCost.toFixed(2);
    }

    // Auto-refresh stats and queue every 30 seconds
    setInterval(() => {
        fetchQueue();
        fetchStats();
    }, 30000);

    document.querySelectorAll('.close-modal, .close-modal-btn').forEach(btn => {
        btn.onclick = () => providerModal.classList.add('hidden');
    });

    document.getElementById('retry-button').onclick = fetchData;

    fetchData();
    fetchQueue();
    fetchStats();
});
