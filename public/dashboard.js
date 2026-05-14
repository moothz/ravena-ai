document.addEventListener('DOMContentLoaded', () => {
    const botsTableBody = document.querySelector('#botsTable tbody');
    const botsTableHeader = document.querySelector('#botsTable thead');
    const addRowBtn = document.getElementById('addRowBtn');
    const saveBtn = document.getElementById('saveBtn');
    const restartBotBtn = document.getElementById('restartBotBtn');
    const logsBtn = document.getElementById('logsBtn');
    const logOverlay = document.getElementById('logOverlay');
    const logContent = document.getElementById('logContent');
    const closeLogBtn = document.getElementById('closeLogBtn');

    let eventSource;
    let allHeaders = new Set(['enabled', 'nome', 'numero']); // Required headers first

    // Fetch initial data and render table
    const fetchAndRenderBots = async () => {
        try {
            const response = await fetch('/api/bots');
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const bots = await response.json();
            
            // Collect all unique keys to build a complete header
            bots.forEach(bot => {
                Object.keys(bot).forEach(key => allHeaders.add(key));
            });

            renderTable(Array.from(allHeaders), bots);
        } catch (error) {
            console.error('Failed to fetch bots:', error);
            alert('Falha ao carregar bots. Verifique o console para mais detalhes.');
        }
    };

    // Render table contents
    const renderTable = (headers, bots) => {
        // Clear existing table
        botsTableHeader.innerHTML = '';
        botsTableBody.innerHTML = '';

        // Render header
        const headerRow = document.createElement('tr');
        headers.forEach(header => {
            const th = document.createElement('th');
            th.textContent = header;
            th.className = header;
            headerRow.appendChild(th);
        });
        const actionTh = document.createElement('th');
        actionTh.textContent = 'Ações';
        headerRow.appendChild(actionTh);
        botsTableHeader.appendChild(headerRow);

        // Render rows
        bots.forEach(bot => {
            const row = createRow(headers, bot);
            botsTableBody.appendChild(row);
        });
    };

    // Create a single row
    const createRow = (headers, botData = {}) => {
        const row = document.createElement('tr');
        headers.forEach(header => {
            const cell = document.createElement('td');
            const value = botData[header];
            let input;

            if (typeof value === 'boolean') {
                input = document.createElement('input');
                input.type = 'checkbox';
                input.checked = value;
            } else {
                input = document.createElement('input');
                input.type = typeof value === 'number' ? 'number' : 'text';
                input.value = value ?? '';
                input.placeholder = header; // Use header as placeholder
            }
            input.dataset.key = header;
            cell.appendChild(input);
            row.appendChild(cell);
        });

        // Actions cell
        const actionCell = document.createElement('td');
        const deleteBtn = document.createElement('button');
        deleteBtn.textContent = 'Excluir';
        deleteBtn.className = 'delete-btn';
        deleteBtn.onclick = () => row.remove();
        actionCell.appendChild(deleteBtn);
        row.appendChild(actionCell);

        return row;
    };

    // Add new row to table
    addRowBtn.addEventListener('click', () => {
        const generateRandomString = (length) => {
            const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ01234TUDO BOM, SEXTA FEIRA?U0123456789';
            let result = '';
            for (let i = 0; i < length; i++) {
                result += chars.charAt(Math.floor(Math.random() * chars.length));
            }
            return result;
        };

        const lastRow = botsTableBody.querySelector('tr:last-child');
        
        if (lastRow) {
            const newRow = lastRow.cloneNode(true);
            newRow.style.backgroundColor = '';

            const inputs = newRow.querySelectorAll('input');
            inputs.forEach(input => {
                const key = input.dataset.key;
                if (key === 'managementPW') {
                    input.value = generateRandomString(15);
                } else if (input.type === 'checkbox') {
                    input.checked = false;
                } else {
                    input.value = '';
                }
            });

            const deleteBtn = newRow.querySelector('.delete-btn');
            if (deleteBtn) {
                deleteBtn.onclick = () => newRow.remove();
            }

            botsTableBody.appendChild(newRow);
        } else {
            // Fallback for an empty table
            const botData = {};
            Array.from(allHeaders).forEach(header => {
                if (header === 'managementPW') {
                    botData[header] = generateRandomString(15);
                } else if (header === 'enabled') {
                    botData[header] = false;
                } else {
                    botData[header] = '';
                }
            });
            const newRow = createRow(Array.from(allHeaders), botData);
            botsTableBody.appendChild(newRow);
        }
    });

    // Save all changes
    saveBtn.addEventListener('click', async () => {
        const botsData = [];
        const rows = botsTableBody.querySelectorAll('tr');
        let validationError = false;

        rows.forEach(row => {
            const bot = {};
            const inputs = row.querySelectorAll('input');
            inputs.forEach(input => {
                const key = input.dataset.key;
                if (input.type === 'checkbox') {
                    bot[key] = input.checked;
                } else if (input.type === 'number') {
                    bot[key] = input.value ? Number(input.value) : null;
                } else {
                    bot[key] = input.value || null;
                }
            });

            // Validate required fields
            if (!bot.nome || !bot.numero) {
                row.style.backgroundColor = '#ffdddd';
                validationError = true;
            } else {
                row.style.backgroundColor = '';
            }

            botsData.push(bot);
        });

        if (validationError) {
            alert('Erro de validação: Os campos \'nome\' e \'numero\' são obrigatórios.');
            return;
        }

        if (!confirm('Tem certeza que deseja salvar as alterações?')) return;

        try {
            const response = await fetch('/api/bots', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(botsData)
            });
            const result = await response.json();
            if (!response.ok) {
                throw new Error(result.message || 'Falha ao salvar.');
            }
            alert('Configuração salva com sucesso!');
            fetchAndRenderBots(); // Refresh table
        } catch (error) {
            console.error('Save failed:', error);
            alert(`Erro ao salvar: ${error.message}`);
        }
    });

    // Restart buttons
    restartBotBtn.addEventListener('click', () => {
        if (!confirm('Tem certeza que deseja reiniciar o bot? O servidor da API cairá temporariamente.')) return;
        fetch('/api/restart-bot', { method: 'POST' })
            .then(handleSimpleApiResponse)
            .catch(handleApiError);
    });

    // Log streaming
    logsBtn.addEventListener('click', () => {
        logContent.textContent = 'Conectando ao stream de logs...';
        logOverlay.style.display = 'flex';
        document.body.style.overflow = 'hidden';

        eventSource = new EventSource('/api/logs');
        eventSource.onopen = () => {
            logContent.textContent = 'Conexão estabelecida. Aguardando logs...\n';
        };
        eventSource.onmessage = (event) => {
            logContent.textContent += event.data + '\n';
            logContent.scrollTop = logContent.scrollHeight;
        };
        eventSource.onerror = () => {
            logContent.textContent += '\nErro na conexão com o stream de logs. Tentando reconectar...\n';
            eventSource.close();
            setTimeout(logsBtn.click, 5000); // Retry connection after 5s
        };
    });

    closeLogBtn.addEventListener('click', () => {
        if (eventSource) {
            eventSource.close();
        }
        logOverlay.style.display = 'none';
        document.body.style.overflow = 'auto';
    });

    // Helper functions for API responses
    const handleSimpleApiResponse = async (response) => {
        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.message || 'Ação falhou.');
        }
        alert(`Sucesso: ${result.message}`);
    };

    const handleApiError = (error) => {
        console.error('API Error:', error);
        alert(`Erro na comunicação com a API: ${error.message}`);
    };

    // Initial load
    fetchAndRenderBots();
});