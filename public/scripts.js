// Variáveis globais
let lastHealthData = null;
let isAdminMode = false;
let selectedBots = [];
let activePeriod = 'today';
let messageTimestamps = [];
let botMessageTimestamps = {};
let averageMsgsHr = 0;
let hasInitializedRealtime = false;
const BOT_STATS_CACHE_KEY = 'ravena_bot_stats_v1';
let currentStatsSort = { column: 'day', direction: 'desc' };
let showOnlyConventional = false;
let lastStatsData = null;
let llmStatusData = null;
let llmCountdownInterval = null;

// Function to animate number change
function animateValue(obj, start, end, duration) {
    if (!obj) return;
    if (obj._currentAnimation) cancelAnimationFrame(obj._currentAnimation);
    
    let startTimestamp = null;
    const step = (timestamp) => {
        if (!startTimestamp) startTimestamp = timestamp;
        const progress = Math.min((timestamp - startTimestamp) / duration, 1);
        obj.innerText = Math.floor(progress * (end - start) + start);
        if (progress < 1) {
            obj._currentAnimation = window.requestAnimationFrame(step);
        } else {
             obj.innerText = end;
             delete obj._currentAnimation;
        }
    };
    obj._currentAnimation = window.requestAnimationFrame(step);
}

function updateRealtimeCounter() {
    const now = Date.now();
    // Keep timestamps from the last 60 seconds
    messageTimestamps = messageTimestamps.filter(t => now - t <= 60000);
    
    const count = messageTimestamps.length;
    const realtimeRate = count * 60;
    
    const msgsCounterDiv = document.getElementById('msgsCounter');
    if (msgsCounterDiv) {
        // Find existing value or default to 0
        const countSpan = msgsCounterDiv.querySelector('.count-val');
        let currentVal = 0;
        
        if (countSpan) {
            currentVal = parseInt(countSpan.innerText, 10) || 0;
            if (currentVal !== realtimeRate) {
                 animateValue(countSpan, currentVal, realtimeRate, 950);
            }
        } else {
             msgsCounterDiv.innerHTML = `
                <span>Processando no momento</span>
                <span class="count"><span class="count-val">${realtimeRate}</span> msgs/h (média de ${averageMsgsHr} msgs/h)</span>
            `;
        }
    }
}

function updateBotRealtimeCounters() {
    const now = Date.now();
    
    for (const [botId, timestamps] of Object.entries(botMessageTimestamps)) {
        // Filter timestamps
        botMessageTimestamps[botId] = timestamps.filter(t => now - t <= 60000);
        
        const count = botMessageTimestamps[botId].length;
        const realtimeRate = count * 60;
        
        const element = document.getElementById(`msgs-hr-${botId}`);
        if (element) {
            const currentVal = parseInt(element.innerText, 10) || 0;
            if (currentVal !== realtimeRate) {
                animateValue(element, currentVal, realtimeRate, 950);
            }
        }
    }
}

// Função para formatar a hora
function formatTime(timestamp) {
    if (!timestamp) return 'Nunca';
    const date = new Date(timestamp);
    return date.toLocaleTimeString('pt-BR');
}

// Função para calcular tempo desde a última mensagem
function getTimeSinceLastMessage(timestamp) {
    if (!timestamp) return Infinity;
    
    const now = Date.now();
    const diff = now - timestamp;
    return Math.floor(diff / 1000 / 60); // Minutos
}

// Função para determinar status baseado no tempo (Retorna Classe CSS)
function getStatusClass(minutes, connected, banned) {
    if (banned) return 'banned'; // banida
    if (!connected) return 'disconnected'; // Desconectado
    
    if (minutes < 2) return 'active';
    if (minutes < 5) return 'alert';
    if (minutes < 15) return 'attention';
    return 'inactive';
}

// Função para obter descrição do status
function getStatusDescription(minutes, connected) {
    if (!connected) return 'Desconectado';
    
    if (minutes < 2) return 'Ativo';
    if (minutes < 5) return 'Alerta';
    if (minutes < 15) return 'Atenção';
    return 'Inativo';
}

// Função para classificar o nível de atividade de mensagens
function getMessageActivityClass(msgsHr) {
    if (msgsHr === 0) return 'msgs-badge-low';
    if (msgsHr > 50) return 'msgs-badge-high';
    return '';
}

// Função para classificar o tempo de resposta
function getResponseTimeClass(seconds) {
    if (seconds < 5) return 'response-normal';
    if (seconds < 30) return 'response-warning';
    return 'response-danger';
}

// Função para obter emoji baseado no tempo de resposta
function getResponseTimeEmoji(seconds) {
    if (seconds < 5) return '⚡';
    if (seconds < 30) return '🕐';
    return '🐢';
}

// Função para formatar o tempo desde a última mensagem
function formatTimeSince(minutes) {
    if (minutes === Infinity) return 'Sem atividade registrada';
    
    if (minutes < 1) return 'Ativa agora ✨';
    
    let timeText = '';
    if (minutes < 60) {
        timeText = `${minutes} ${minutes === 1 ? 'minuto' : 'minutos'}`;
    } else {
        const hours = Math.floor(minutes / 60);
        if (hours < 24) {
            timeText = `${hours} ${hours === 1 ? 'hora' : 'horas'}`;
        } else {
            const days = Math.floor(hours / 24);
            timeText = `${days} ${days === 1 ? 'dia' : 'dias'}`;
        }
    }

    if (minutes < 15) {
        return `Ativa há ${timeText}`;
    } else {
        return `Sem atividade há ${timeText}`;
    }
}

// Função para formatar número de telefone para URL do WhatsApp
function formatWhatsAppUrl(phoneNumber) {
    // Remove todos os caracteres não numéricos
    const cleanNumber = phoneNumber ? phoneNumber.replace(/\D/g, '') : '';
    return `https://wa.me/${cleanNumber}`;
}

// Função para extrair número de telefone do bot ID
function extractPhoneFromBotId(botId, bots) {
    // Primeiro, verifica se podemos obter o número a partir dos metadados do bot
    for (const bot of bots) {
        if (bot.id === botId && bot.phoneNumber) {
            return bot.phoneNumber;
        }
    }
    
    // Se não tiver nos metadados, tenta extrair do ID usando expressão regular
    const phoneMatch = botId.match(/(\d{10,15})/);
    if (phoneMatch) {
        return phoneMatch[1];
    }
    
    // Se não conseguir extrair do ID, verifica se temos um mapeamento explícito
    const botPhoneMap = {
        'ravena-testes': '555596424307', // Exemplo
    };
    
    return botPhoneMap[botId] || '';
}

// Função para verificar se estamos em modo admin
function checkAdminMode() {
    const urlParams = new URLSearchParams(window.location.search);
    isAdminMode = urlParams.has('admin');
}

// Função para buscar dados de saúde dos bots
async function fetchHealthData() {
    try {
        const response = await fetch('/health');
        
        if (!response.ok) {
            throw new Error(`Erro ao obter dados: ${response.status}`);
        }
        
        const data = await response.json();
        lastHealthData = data;
        renderBots(data);
        
        // Atualiza timestamp da última atualização
        const lastUpdatedElement = document.getElementById('lastUpdated');
        lastUpdatedElement.textContent = `Última atualização: ${new Date().toLocaleString('pt-BR')}`;
        
        return data;
    } catch (error) {
        console.error('Erro ao buscar dados de saúde:', error);
        
        // Exibe mensagem de erro
        const botContainer = document.getElementById('botContainer');
        botContainer.innerHTML = `
            <div style="text-align: center; padding: 30px;">
                <p style="color: #ff5555; font-size: 1.2rem;">❌ Erro ao carregar dados</p>
                <p>${error.message}</p>
                <button id="retryButton" class="refresh-button" style="margin-top: 20px;">
                    🔄 Tentar Novamente
                </button>
            </div>
        `;
        
        document.getElementById('retryButton').addEventListener('click', fetchHealthData);
    }
}

function formatPhoneNumber(number) {
  if (!number || typeof number !== 'string' || !/^\d+$/.test(number)) {
    return 'Número inválido';
  }

  if (number.length >= 12 && number.startsWith('55')) {
    const countryCode = number.substring(0, 2);
    const areaCode = number.substring(2, 4);
    const prefix = number.substring(4, 9);
    const suffix = number.substring(9);
    
    return `+${countryCode} (${areaCode}) 9${prefix}-${suffix}`;
  } 
  
  return number;
}

// Função para buscar e renderizar doações recentes (3 meses)
async function fetchRecentTopDonates() {
    try {
        const response = await fetch('/recent-top-donates');
        if (!response.ok) {
            throw new Error('Erro ao buscar doações recentes');
        }
        const data = await response.json();
        const { totalRecentAmount, topRecentDonors } = data;
        const recentDonatesTextElement = document.getElementById('recentTopDonatesText');

        const currencyFormatter = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
        const totalText = `💰 TOTAL ÚLTIMOS 3 MESES: ${currencyFormatter.format(totalRecentAmount)}`;
        
        // Meta oculta de 150
        const goalAmount = 150;
        const percentage = Math.min(100, Math.floor((totalRecentAmount / goalAmount) * 100));
        const progressText = `${currencyFormatter.format(totalRecentAmount)} (${percentage}%)`;

        if (topRecentDonors.length > 0) {
            const donorsText = topRecentDonors
                .map(d => `${d.nome}: ${currencyFormatter.format(d.valor)}`)
                .join('  •  ');
            
            recentDonatesTextElement.textContent = `🏆 TOP DONATES (3 MESES): Total ${progressText}  •  ${donorsText}  •`;
        } else {
            recentDonatesTextElement.textContent = `🏆 TOP DONATES (3 MESES): Total ${progressText}  •  Nenhuma doação recente registrada.`;
        }
        
        // Aplica feedback de urgência visual
        updateDonationUrgency(percentage);

    } catch (error) {
        console.error('Erro ao carregar doações recentes:', error);
        const recentDonatesTextElement = document.getElementById('recentTopDonatesText');
        recentDonatesTextElement.textContent = '🏆 TOP DONATES (3 MESES): Erro ao carregar.';
    }
}

// Função para buscar e renderizar top doações
async function fetchTopDonates() {
    try {
        const response = await fetch('/top-donates');
        if (!response.ok) {
            throw new Error('Erro ao buscar doações');
        }
        let donations = await response.json();
        const donatesTextElement = document.getElementById('topDonatesText');

        if (donations.length > 0) {
            // Ordena por valor e pega os top 15
            donations = donations
                .sort((a, b) => b.valor - a.valor)
                .slice(0, 15);

            const text = donations
                .map(d => `${d.nome}: ${new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(d.valor)}`)
                .join('  •  ');
            
            // Repete o texto para garantir o preenchimento do banner
            donatesTextElement.textContent = `🏆 TOP DONATES (GERAL):  •  ${text}  •`;
        } else {
            donatesTextElement.textContent = '🏆 TOP DONATES (GERAL): Nenhuma doação registrada ainda.';
        }
    } catch (error) {
        console.error('Erro ao carregar top doações:', error);
        const donatesTextElement = document.getElementById('topDonatesText');
        donatesTextElement.textContent = '🏆 TOP DONATES (GERAL): Erro ao carregar.';
    }
}

// Função para atualizar a urgência visual baseada na porcentagem de doações
function updateDonationUrgency(percentage) {
    const banner = document.querySelector('.recent-donates-banner');
    if (!banner) return;

    // Calcula cor de urgência (de vermelho para verde)
    let r, g, b;
    if (percentage < 50) {
        // Crítico: Vermelho impactante para Laranja
        // Inicia em vermelho puro (230, 0, 0)
        r = 230;
        g = Math.floor((percentage / 50) * 150);
        b = 30;
    } else {
        // De Laranja para Verde (100% = verde brilhante)
        r = Math.floor(230 - ((percentage - 50) / 50) * 200);
        g = Math.floor(150 + ((percentage - 50) / 50) * 105);
        b = 30 + Math.floor(((percentage - 50) / 50) * 100);
    }
    
    const urgencyColor = `rgb(${r}, ${g}, ${b})`;
    
    // Obtém o roxo escuro das variáveis CSS
    const darkPurple = getComputedStyle(document.documentElement).getPropertyValue('--dark-purple').trim() || '#23066d';

    if (percentage >= 100) {
        // Estilo especial para meta batida 100%: Gradiente vertical roxo levemente esverdeado
        // Remove o efeito de barra de progresso horizontal
        banner.style.background = `linear-gradient(180deg, ${darkPurple} 0%, #1b3d35 100%)`;
    } else {
        // Barra de progresso normal (4 stops)
        // Reduzimos o gap para 3% para aumentar a precisão visual da barra
        const gap = 3; 
        const stop1 = Math.max(0, percentage - gap);
        const stop2 = percentage;
        
        // Aplica o gradiente de 4 pontos no fundo da barra
        banner.style.background = `linear-gradient(90deg, ${darkPurple} 0%, ${darkPurple} ${stop1}%, ${urgencyColor} ${stop2}%, ${urgencyColor} 100%)`;
    }
    
    // Define a variável CSS caso precise ser usada em outros lugares (opcional)
    document.documentElement.style.setProperty('--urgency-color', urgencyColor);
    
    // Classes de estado
    banner.classList.toggle('urgency-critical', percentage < 50);
    banner.classList.toggle('goal-reached', percentage >= 100);
    
    // Pisca especificamente o ícone de doação se estiver abaixo de 70%
    const donateIcon = document.getElementById('donate-icon');
    if (donateIcon) {
        if (percentage < 70) {
            donateIcon.classList.add('pulse');
        } else {
            donateIcon.classList.remove('pulse');
        }
    }
}

/**
 * Função global para simular e testar o progresso das doações
 * Pode ser chamada no console do navegador: testDonationProgress(50)
 */
window.testDonationProgress = function(percent) {
    console.log(`%c [RavenaBot] Simulando progresso de doações: ${percent}%`, "color: #04a9f0; font-weight: bold;");
    
    const percentage = Math.max(0, Math.min(100, percent));
    updateDonationUrgency(percentage);
    
    // Atualiza temporariamente o texto para facilitar a visualização no teste
    const recentDonatesTextElement = document.getElementById('recentTopDonatesText');
    if (recentDonatesTextElement) {
        recentDonatesTextElement.textContent = `🏆 SIMULAÇÃO DE TESTE (${percentage}% batido)  •  Bora bater a meta!`;
    }
    
    return `Teste aplicado: ${percentage}%`;
};

// Função para renderizar os bots
function renderBots(data) {
    const botContainer = document.getElementById('botContainer');
    botContainer.innerHTML = '';
    
    if (!data.bots || data.bots.length === 0) {
        botContainer.innerHTML = '<p style="text-align: center; padding: 20px;">Nenhum bot encontrado</p>';
        return;
    }
    
    // Atualiza os filtros de bots para os gráficos
    // updateBotFilters(data.bots); // UI Hidden
    if (selectedBots.length === 0) {
        selectedBots = data.bots.map(bot => bot.id);
    }
    // Calcula o total de mensagens/hora de todos os bots
    let totalMsgsHr = 0;
    const now = Date.now();
    data.bots.forEach(bot => {
        const msgs = Math.round(bot.msgsHr || 0);
        totalMsgsHr += msgs;

        if (!botMessageTimestamps[bot.id]) {
            botMessageTimestamps[bot.id] = [];
            const initialCount = Math.round(msgs / 60);
            for (let i = 0; i < initialCount; i++) {
                botMessageTimestamps[bot.id].push(now - Math.floor(Math.random() * 60000));
            }
        }
    });
    
    averageMsgsHr = totalMsgsHr;

    // Initialize realtime counter with average data on first load
    if (!hasInitializedRealtime) {
        const initialCount = Math.round(averageMsgsHr / 60);
        const now = Date.now();
        messageTimestamps = [];
        for (let i = 0; i < initialCount; i++) {
            // Distribute randomly over the last 60 seconds
            messageTimestamps.push(now - Math.floor(Math.random() * 60000));
        }
        hasInitializedRealtime = true;
    }

    updateRealtimeCounter();
    
    // Ordena os bots: Normais, comunitarios, VIP
    const botsNormais = data.bots.filter(b => !b.comunitario && !b.vip);
    const botsComunitarios = data.bots.filter(b => b.comunitario);
    const botsVips = data.bots.filter(b =>  b.vip);


    // console.log({botsNormais, botsComunitarios, botsVips});

    // Renderiza os cards de bot
    const tituloNormais = document.createElement('h2');
    tituloNormais.className = 'titulo-tipo-bots';
    tituloNormais.innerHTML = '🐦‍⬛ ravenas';
    botContainer.appendChild(tituloNormais);

    const normalInfoText = document.createElement('p');
    normalInfoText.className = 'normal-info-text';
    normalInfoText.innerHTML = 'As ravenas <b>normais</b>, que você sempre usou! Os chips são comprados e mantidos por mim através das doações.<br><b>Apenas eu, o criador,</b> tenho acesso ao fluxo de dados deste bots.';
    botContainer.appendChild(normalInfoText);
    botsNormais.forEach(bot => {
        renderBotCard(botContainer, data, bot);
    });
    const separator = document.createElement('hr');
    separator.className = 'bot-separator';
    botContainer.appendChild(separator);

    if(botsComunitarios.length > 0){
        const tituloComunitaria = document.createElement('h2');
        tituloComunitaria.className = 'titulo-tipo-bots';
        tituloComunitaria.innerHTML = '🐓 ravenas comunitárias ☭';
        botContainer.appendChild(tituloComunitaria);
        const comInfoText = document.createElement('p');
        comInfoText.className = 'com-info-text';
        comInfoText.innerHTML = 'Estas ravenas são iniciativas de membros que doam seus chips e celulares para rodar a ravena.<br><b>O dono deste chip terá acesso às mensagens e fluxo de dados deste bot, se você não concorda com isso, pode remover o bot livremente.</b>';
        botContainer.appendChild(comInfoText);
        botsComunitarios.forEach(bot => {
            renderBotCard(botContainer, data, bot);
        });
        const separator = document.createElement('hr');
        separator.className = 'bot-separator';
        botContainer.appendChild(separator);
    }

    if(botsVips.length > 0){
        const tituloVip = document.createElement('h2');
        tituloVip.className = 'titulo-tipo-bots';
        tituloVip.innerHTML = '💎 ravenas vip';
        botContainer.appendChild(tituloVip);
        const vipInfoText = document.createElement('p');
        vipInfoText.className = 'vip-info-text';
        vipInfoText.innerHTML = 'Estas são ravenas que hospedo em agradecimento aos primeiros donates que ajudaram a solidificar a ravena, não estão mais disponíveis - estão aqui apenas para que os membros acompanhem o status.<br>⚠️ Os bots <i>vips</i> não recebem convites e nem respondem mensagens no pv!<br><br>';
        botContainer.appendChild(vipInfoText);
        botsVips.forEach(bot => {
            renderBotCard(botContainer, data, bot);
        });
        const separator = document.createElement('hr');
        separator.className = 'bot-separator';
        botContainer.appendChild(separator);
    }
}

function renderBotCard(botContainer, data, bot){
    const minutesSinceLastMessage = getTimeSinceLastMessage(bot.lastMessageReceived);
    const statusClass = getStatusClass(minutesSinceLastMessage, bot.connected, bot.banido);
    const statusDesc = getStatusDescription(minutesSinceLastMessage, bot.connected);
    const phoneNumber = formatPhoneNumber(extractPhoneFromBotId(bot.id, data.bots)).replace("+55","").trim();
    const whatsappUrl = formatWhatsAppUrl(phoneNumber);
    let msgsHr = Math.round(bot.msgsHr || 0);
    if (botMessageTimestamps[bot.id]) {
        const now = Date.now();
        const recent = botMessageTimestamps[bot.id].filter(t => now - t <= 60000);
        msgsHr = recent.length * 60;
    }
    const msgActivityClass = getMessageActivityClass(msgsHr);
    
    const avgResponseTime = bot.responseTime ? bot.responseTime.avg || 0 : 0;
    const maxResponseTime = bot.responseTime ? bot.responseTime.max || 0 : 0;
    const responseTimeClass = getResponseTimeClass(avgResponseTime);
    const responseTimeEmoji = getResponseTimeEmoji(avgResponseTime);
    
    const botCard = document.createElement('div');
    botCard.className = 'bot-card';
    if (bot.vip) {
        botCard.classList.add('vip');
    }
    if (bot.comunitario) {
        botCard.classList.add('comunitario');
    }
    
    let buttonsHtml = '';
    if (isAdminMode) {
        buttonsHtml = `
            <div class="detail-item" style="margin-top: 15px; justify-content: center; gap: 10px;">
                <button class="restart-button" data-bot-id="${bot.id}">
                    🔄 Reiniciar
                </button>
                <button class="qr-button" data-bot-id="${bot.id}">
                    🔳 QRCode
                </button>
            </div>
        `;
    }
    
    // 
    let detalhes = "";
    if(bot.semPV || bot.semConvites){
        const txtDetalhes = [bot.semPV && "PV Desabilitado", bot.semConvites && "Não recebe convites"].filter(Boolean).join(", ");
        detalhes = `<div class="detail-item">
                <span class="detail-label" style="width: 100%; text-align: center; color: #a2a20d">${txtDetalhes}</span>
            </div>`;
    }

    let divResponsavel = "";

    if(bot.numeroResponsavel){
        const rawPhoneResponsavel = extractPhoneFromBotId(bot.numeroResponsavel, []);
        const phoneNumberResponsavel = formatPhoneNumber(rawPhoneResponsavel).replace("+55","").trim();
        const whatsappUrlResponsavel = formatWhatsAppUrl(rawPhoneResponsavel);
        divResponsavel = `             <div class="detail-item">
                <span class="detail-label">Resp.:</span>
                <span class="detail-value"><a href="${whatsappUrlResponsavel}" target="_blank" class="phone-link">${phoneNumberResponsavel}</a></span>
            </div>`;
    }
    
    let divMsgs = `<div class="detail-item"><span class="detail-label label-desconectado">⚠️ Desconectado</span></div>`;
    if(!bot.connected && !bot.banido && isAdminMode){
        divMsgs += `<div class="detail-item" style="justify-content:center">
            <a href="/qrcode/${bot.id}" target="_blank" style="font-size:0.8rem;color:#4f8ef7;text-decoration:none;padding:0.3rem 0.8rem;border:1px solid #4f8ef7;border-radius:0.4rem;display:inline-block">🔗 Reconectar</a>
        </div>`;
    }
    if(bot.banido){
        divMsgs = `<div class="detail-item"><span class="detail-label label-banida">BANIDA</span></div>`;
    }
    if(bot.connected && !bot.banido){
        divMsgs = `<div class="detail-item activity-status-row">
                <span class="activity-phrase tooltip-container">
                    ${formatTimeSince(minutesSinceLastMessage)}
                    <span class="tooltip-text">Última msg recebida em: ${formatTime(bot.lastMessageReceived)}</span>
                </span>
            </div>
            <div class="detail-item">
                <span class="detail-label">Msgs/hora:</span>
                <span class="detail-value-highlight tooltip-container">
                    <span id="msgs-hr-${bot.id}">${msgsHr}</span>
                    <span class="msgs-badge ${msgActivityClass}">
                        ${msgsHr === 0 ? '💤' : msgsHr > 100 ? '🔥' : msgsHr > 50 ? '📊' : '📝'}
                    </span>
                    <span class="tooltip-text">Média: ${Math.round(bot.msgsHr || 0)} msgs/h</span>
                </span>
            </div>
            <div class="detail-item">
                <span class="detail-label">Delay médio:</span>
                <span class="detail-value-highlight tooltip-container">
                    ${avgResponseTime.toFixed(1)}s
                    <span class="response-badge ${responseTimeClass}">
                        ${responseTimeEmoji}
                    </span>
                    <span class="tooltip-text">Delay máximo: ${maxResponseTime}s</span>
                </span>
            </div>`;
    }

    botCard.innerHTML = `
        <div class="bot-card-bg"></div>
        <div class="bot-card-content">
            <div class="bot-header">
                <div class="bot-title">
                    <a href="${whatsappUrl}" target="_blank" title="Abrir chat no WhatsApp">
                        <img src="whatsapp.png" alt="WhatsApp" class="whatsapp-icon">
                    </a>
                    <div class="bot-name">${bot.id}</div>
                </div>
                <div class="status-dot ${statusClass}" id="status-${bot.id}" title="${statusDesc}"></div>
            </div>
            <div class="bot-details">
                <div class="detail-item">
                    <span class="detail-label">Num.:</span>
                    <span class="detail-value">
                        <a href="${whatsappUrl}" target="_blank" class="phone-link">${phoneNumber || 'Não disponível'}</a>
                    </span>
                </div>
                ${divResponsavel}
                ${divMsgs}
                ${detalhes}
                ${buttonsHtml}
            </div>
        </div>
    `;
    
    botContainer.appendChild(botCard);
    
    if (isAdminMode) {
        const restartButton = botCard.querySelector('.restart-button');
        restartButton.addEventListener('click', () => openRestartModal(bot.id));
        const qrButton = botCard.querySelector('.qr-button');
        qrButton.addEventListener('click', () => openQRModal(bot.id));
    }
}

function openQRModal(botId){
    window.open(`/qrcode/${botId}`,"_new");
}

function openRestartModal(botId) {
    const modal = document.getElementById('restartModal');
    const modalBotId = document.getElementById('modalBotId');
    
    modalBotId.textContent = botId;
    modal.style.display = 'flex';
}

function closeRestartModal() {
    const modal = document.getElementById('restartModal');
    modal.style.display = 'none';
    
    document.getElementById('reason').value = '';
    document.getElementById('apiUser').value = '';
    document.getElementById('apiPassword').value = '';
}

async function restartBot() {
    const botId = document.getElementById('modalBotId').textContent;
    const reason = document.getElementById('reason').value || 'Reinicialização pelo painel web';
    const apiUser = document.getElementById('apiUser').value;
    const apiPassword = document.getElementById('apiPassword').value;
    
    if (!apiUser || !apiPassword) {
        alert('Por favor, informe as credenciais de API');
        return;
    }
    
    try {
        const authHeader = 'Basic ' + btoa(`${apiUser}:${apiPassword}`);
        
        const response = await fetch(`/restart/${botId}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': authHeader
            },
            body: JSON.stringify({ reason })
        });
        
        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.message || `Erro ${response.status}`);
        }
        
        const result = await response.json();
        alert(`Bot ${botId} está sendo reiniciado. ${result.message}`);
        
        closeRestartModal();
        setTimeout(fetchHealthData, 5000);
    } catch (error) {
        console.error('Erro ao reiniciar bot:', error);
        alert(`Erro ao reiniciar bot: ${error.message}`);
    }
}

// Funções para a seção de análise de dados
function updateBotFilters(bots) {
    const botFiltersContainer = document.getElementById('botFilters');
    botFiltersContainer.innerHTML = '';
    
    if (!bots || bots.length === 0) {
        botFiltersContainer.innerHTML = '<p>Nenhum bot disponível para filtrar</p>';
        return;
    }
    
    if (selectedBots.length === 0) {
        selectedBots = bots.map(bot => bot.id);
    }
    
    bots.forEach(bot => {
        const isChecked = selectedBots.includes(bot.id);
        
        const filterItem = document.createElement('div');
        filterItem.className = 'bot-filter';
        filterItem.innerHTML = `
            <input type="checkbox" id="filter-${bot.id}" data-bot-id="${bot.id}" ${isChecked ? 'checked' : ''}>
            <label for="filter-${bot.id}">${bot.id}</label>
        `;
        
        botFiltersContainer.appendChild(filterItem);
        
        const checkbox = filterItem.querySelector('input[type="checkbox"]');
        checkbox.addEventListener('change', () => {
            if (checkbox.checked) {
                if (!selectedBots.includes(bot.id)) {
                    selectedBots.push(bot.id);
                }
            } else {
                const index = selectedBots.indexOf(bot.id);
                if (index !== -1) {
                    selectedBots.splice(index, 1);
                }
            }
            fetchAnalyticsData();
        });
    });
}

function processAnalyticsData(data) {
    if (!data || !data.daily || !data.weekly || !data.monthly || !data.yearly) {
        console.error('Dados incompletos ou inválidos');
        return {
            daily: { hours: [], series: [] },
            weekly: { days: [], series: [] },
            monthly: { days: [], series: [] },
            yearly: { dates: [], series: [] }
        };
    }
    
    const processedDaily = {
        hours: data.daily.hours || Array.from({ length: 24 }, (_, i) => i),
        series: data.daily.series || []
    };
    
    const processedWeekly = {
        days: data.weekly.days || ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'],
        series: data.weekly.series || []
    };
    
    const processedMonthly = {
        days: data.monthly.days || Array.from({ length: 31 }, (_, i) => i + 1),
        series: data.monthly.series || []
    };
    
    let yearlyDates = data.yearly.dates;
    if ((!yearlyDates || yearlyDates.length === 0) && data.yearly.series && data.yearly.series.length > 0) {
        const firstSeries = data.yearly.series[0];
        if (firstSeries && firstSeries.data) {
            const dataLength = firstSeries.data.length;
            yearlyDates = Array.from({ length: dataLength }, (_, i) => `Dia ${i+1}`);
        }
    }
    
    const processedYearly = {
        dates: yearlyDates || [],
        series: data.yearly.series || []
    };
    
    return {
        daily: processedDaily,
        weekly: processedWeekly,
        monthly: processedMonthly,
        yearly: processedYearly
    };
}

async function fetchAnalyticsData() {
    try {
        document.querySelectorAll('.chart-container').forEach(container => {
            // Skip the weekly bot chart (monthlyMessageChart) as it's handled by fetchBotDetailedStats
            if (container.id === 'monthlyMessageChart') return;
            
            container.innerHTML = `
                <h3 class="chart-title">${container.querySelector('.chart-title')?.textContent || 'Carregando...'}</h3>
                <div class="loading-container">
                    <div class="loader"></div>
                    <p>Carregando dados...</p>
                </div>
            `;
        });
        
        const params = new URLSearchParams();
        params.append('period', activePeriod);
        selectedBots.forEach(botId => {
            params.append('bots[]', botId);
        });
        
        let data;
        
        try {
            const response = await fetch(`/analytics?${params.toString()}`);
            if (!response.ok) {
                throw new Error(`Erro ao obter dados de análise: ${response.status}`);
            }
            data = await response.json();
        } catch (error) {
            console.error('Erro na chamada principal, tentando fallback:', error);
            const fallbackResponse = await fetch('/analytics_period=today.json');
            if (!fallbackResponse.ok) throw new Error('Arquivo de fallback não encontrado');
            data = await fallbackResponse.json();
            console.log('Usando dados de fallback para visualização');
        }
        
        if (!data) throw new Error('Nenhum dado recebido');
        
        const processedData = processAnalyticsData(data);
        renderCharts(processedData);
        
    } catch (error) {
        console.error('Erro ao buscar dados de análise:', error);
        document.querySelectorAll('.chart-container').forEach(container => {
            if (container.id === 'monthlyMessageChart') return;
            container.innerHTML = `
                <h3 class="chart-title">${container.querySelector('.chart-title')?.textContent || 'Erro'}</h3>
                <div style="text-align: center; padding: 30px;">
                    <p style="color: #ff5555; font-size: 1.2rem;">❌ Erro ao carregar dados</p>
                    <p>${error.message}</p>
                </div>
            `;
        });
    }
}

function renderCharts(data) {
    const commonOptions = {
        chart: { backgroundColor: 'transparent', style: { fontFamily: 'Segoe UI, Tahoma, Geneva, Verdana, sans-serif' } },
        title: { text: null },
        credits: { enabled: false },
        exporting: { enabled: true, buttons: { contextButton: { menuItems: ['downloadPNG', 'downloadJPEG', 'downloadPDF', 'downloadCSV'] } } },
        legend: { itemStyle: { color: '#b7b7c5' }, itemHoverStyle: { color: '#04a9f0' } },
        xAxis: { labels: { style: { color: '#b7b7c5' } }, lineColor: '#47486c', tickColor: '#47486c' },
        yAxis: { title: { text: 'Mensagens', style: { color: '#b7b7c5' } }, labels: { style: { color: '#b7b7c5' } }, gridLineColor: 'rgba(71, 72, 108, 0.3)' },
        plotOptions: { series: { marker: { enabled: false } } },
        colors: ['#04a9f0', '#3e0ea7', '#47486c', '#b7b7c5', '#6a0dad', '#1e90ff']
    };
    
    renderDailyChart(data.daily, commonOptions);
    renderWeeklyChart(data.weekly, commonOptions);
    // renderMonthlyChart removed - handled by fetchBotDetailedStats
    renderYearlyChart(data.yearly, commonOptions);
}

function renderDailyChart(data, commonOptions) {
    const container = document.getElementById('dailyMessageChart');
    if (!data || !data.hours || !data.series || data.series.length === 0) {
        container.innerHTML = `<h3 class="chart-title">Média de Mensagens do Dia</h3><p style="text-align: center; padding: 30px; color: #b7b7c5;">Nenhum dado disponível</p>`;
        return;
    }
    Highcharts.chart(container, { ...commonOptions, chart: { ...commonOptions.chart, type: 'spline' }, xAxis: { ...commonOptions.xAxis, categories: data.hours, title: { text: 'Hora do Dia', style: { color: '#b7b7c5' } } }, tooltip: { formatter: function() { return `<b>${this.x}:00</b><br/>${this.series.name}: <b>${this.y}</b> msgs`; }, backgroundColor: 'rgba(35, 6, 109, 0.9)', style: { color: '#fff' }, borderWidth: 0 }, series: data.series });
}

function renderWeeklyChart(data, commonOptions) {
    const container = document.getElementById('weeklyMessageChart');
    if (!data || !data.days || !data.series || data.series.length === 0) {
        container.innerHTML = `<h3 class="chart-title">Média de Mensagens da Semana</h3><p style="text-align: center; padding: 30px; color: #b7b7c5;">Nenhum dado disponível</p>`;
        return;
    }
    Highcharts.chart(container, { ...commonOptions, chart: { ...commonOptions.chart, type: 'column' }, xAxis: { ...commonOptions.xAxis, categories: data.days, title: { text: 'Dia da Semana', style: { color: '#b7b7c5' } } }, tooltip: { formatter: function() { return `<b>${this.x}</b><br/>${this.series.name}: <b>${this.y}</b> msgs`; }, backgroundColor: 'rgba(35, 6, 109, 0.9)', style: { color: '#fff' }, borderWidth: 0 }, series: data.series });
}

function renderBotWeeklyChartFromStats(botStats) {
    const container = document.getElementById('monthlyMessageChart');
    if (!container) return;

    if (!botStats || botStats.length === 0) {
        container.innerHTML = `<h3 class="chart-title">Msgs/bot (Semanal)</h3><p style="text-align: center; padding: 30px; color: #b7b7c5;">Nenhum dado disponível</p>`;
        return;
    }

    // Filter TOTAL row and ravenavip/ravenaviip from chart
    let filtered = botStats.filter(b => b.id !== 'TOTAL' && b.id !== 'ravenavip' && b.id !== 'ravenaviip');

    if (selectedBots && selectedBots.length > 0) {
        // Apply manual selection if present, but still enforce no vip
        filtered = filtered.filter(b => selectedBots.includes(b.id));
    }
    
    // Fallback if filter removed everything
    if (filtered.length === 0) {
        // Just show non-vips, non-total
        filtered = botStats.filter(b => b.id !== 'TOTAL' && b.id !== 'ravenavip' && b.id !== 'ravenaviip');
    }

    const botColors = {
        'ravenaviip': '#FFD700',
        'ravenavip': '#FFFFE0',
        'ravena2': '#008000',
        'ravena4': '#FFFF00',
        'ravena5': '#FFC0CB',
        'ravena10': '#0000FF',
        'rav-pru': '#CD5C5C',
        'rav-ric': '#B22222',
        'rav-arkanis': '#DC143C',
        'rav-arkaniss': '#8B0000'
    };

    const categories = filtered.map(b => b.id);
    const data = filtered.map(b => ({
        y: b.week || 0,
        color: botColors[b.id] || '#47486c'
    }));

    const commonOptions = {
        chart: { backgroundColor: 'transparent', style: { fontFamily: 'Segoe UI, Tahoma, Geneva, Verdana, sans-serif' } },
        credits: { enabled: false },
        exporting: { enabled: true },
        legend: { enabled: false },
        xAxis: { labels: { style: { color: '#b7b7c5' } }, lineColor: '#47486c', tickColor: '#47486c' },
        yAxis: { title: { text: 'Mensagens', style: { color: '#b7b7c5' } }, labels: { style: { color: '#b7b7c5' } }, gridLineColor: 'rgba(71, 72, 108, 0.3)' },
    };

    Highcharts.chart(container, {
        ...commonOptions,
        chart: { ...commonOptions.chart, type: 'column' },
        title: { text: null },
        xAxis: {
            ...commonOptions.xAxis,
            categories: categories,
            title: { text: null },
            labels: { style: { color: '#b7b7c5', fontSize: '10px' }, rotation: -45 }
        },
        yAxis: {
            ...commonOptions.yAxis,
            title: { text: 'Msgs/Semana', style: { color: '#b7b7c5' } }
        },
        tooltip: {
            formatter: function() {
                return `<b>${this.x}</b><br/>Semana: <b>${this.point.y}</b> msgs`;
            },
            backgroundColor: 'rgba(35, 6, 109, 0.9)',
            style: { color: '#fff' },
            borderWidth: 0
        },
        series: [{
            name: 'Msgs na Semana',
            data: data,
            colorByPoint: true
        }]
    });
}

function renderYearlyChart(data, commonOptions) {
    const container = document.getElementById('yearlyMessageChart');
    if (!data || (!data.dates || data.dates.length === 0) || !data.series || data.series.length === 0) {
        container.innerHTML = `<h3 class="chart-title">Total de Mensagens por Dia do Ano</h3><p style="text-align: center; padding: 30px; color: #b7b7c5;">Nenhum dado disponível</p>`;
        return;
    }
    
    Highcharts.chart(container, {
        ...commonOptions,
        chart: { ...commonOptions.chart, zoomType: 'x' }, 
        xAxis: {
            ...commonOptions.xAxis,
            categories: data.dates, 
            labels: {
                ...commonOptions.xAxis.labels,
                rotation: -45,
                step: 1 
            },
            title: { text: null }
        },
        yAxis: [{ // Primary axis (Eixo Esquerdo - Diário)
            title: { text: 'Mensagens Diárias', style: { color: '#04a9f0' } },
            labels: { style: { color: '#04a9f0' } },
            gridLineColor: 'rgba(71, 72, 108, 0.3)'
        }, { // Secondary axis (Eixo Direito - Mensal)
            title: { text: 'Total Mensal', style: { color: '#3e0ea7' } },
            labels: { style: { color: '#3e0ea7' } },
            opposite: true,
            gridLineWidth: 0 
        }],
        tooltip: {
            shared: false, 
            formatter: function() {
                return `<b>${this.x}</b><br/>${this.series.name}: <b>${new Intl.NumberFormat('pt-BR').format(this.y)}</b> msgs`;
            },
            backgroundColor: 'rgba(35, 6, 109, 0.9)',
            style: { color: '#fff' },
            borderWidth: 0
        },
        series: data.series.map(s => ({
            ...s,
            yAxis: s.type === 'column' ? 1 : 0
        }))
    });
}


async function fetchBotDetailedStats() {
    // 1. Try Load from Cache
    try {
        const cached = localStorage.getItem(BOT_STATS_CACHE_KEY);
        if (cached) {
            const data = JSON.parse(cached);
            if (data && Array.isArray(data)) {
                // console.log("Loaded stats from cache");
                lastStatsData = data;
                renderBotStatsTable(data);
                renderBotWeeklyChartFromStats(data);
            }
        }
    } catch (e) { console.warn("Cache load error", e); }

    try {
        const response = await fetch('/api/bot-stats');
        if (!response.ok) throw new Error('Erro ao buscar estatísticas');
        const data = await response.json();
        
        // 2. Save to Cache
        try {
            localStorage.setItem(BOT_STATS_CACHE_KEY, JSON.stringify(data));
        } catch (e) {}

        // 3. Render Fresh Data
        lastStatsData = data;
        renderBotStatsTable(data);
        renderBotWeeklyChartFromStats(data);

    } catch (error) {
        console.error('Erro:', error);
        // Only show error in table if cache also failed (table empty)
        const tbody = document.querySelector('#botStatsTable tbody');
        if(!tbody.hasChildNodes() || tbody.children.length <= 1) {
             tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: #ff5555;">Erro ao carregar dados</td></tr>`;
        }
    }
}

function renderBotStatsTable(data) {
    const tbody = document.querySelector('#botStatsTable tbody');
    const headers = document.querySelectorAll('#botStatsTable th');
    tbody.innerHTML = '';

    if (!data || data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align: center;">Nenhum dado disponível</td></tr>';
        return;
    }

    // Helper to get bot flags from lastHealthData
    const getBotFlags = (botId) => {
        if (!lastHealthData || !lastHealthData.bots) return { vip: false, comunitario: false };
        const bot = lastHealthData.bots.find(b => b.id === botId);
        if (bot) return { vip: !!bot.vip, comunitario: !!bot.comunitario };
        // Fallback for known VIPs if health data is not yet available
        if (botId === 'ravenavip' || botId === 'ravenaviip') return { vip: true, comunitario: false };
        return { vip: false, comunitario: false };
    };

    // Filter and Sort Data
    let filteredData = data.filter(row => row.id !== 'TOTAL');
    
    if (showOnlyConventional) {
        filteredData = filteredData.filter(row => {
            const flags = getBotFlags(row.id);
            return !flags.vip && !flags.comunitario;
        });
    }

    const columnMap = {
        'Bot': 'id',
        'Grupos': 'groupsCount',
        'Hora (1h)': 'hour',
        'Hoje (24h)': 'day',
        'Semana (7d)': 'week',
        'Mês (30d)': 'month',
        'Ano (365d)': 'year'
    };

    const sortCol = columnMap[currentStatsSort.column] || 'day';
    const sortDir = currentStatsSort.direction === 'asc' ? 1 : -1;

    filteredData.sort((a, b) => {
        let valA = a[sortCol];
        let valB = b[sortCol];
        
        if (typeof valA === 'string') {
            return valA.localeCompare(valB) * sortDir;
        }
        return (valA - valB) * sortDir;
    });

    // Update Header Sort Icons
    headers.forEach(h => {
        h.classList.remove('sort-asc', 'sort-desc');
        if (h.innerText === currentStatsSort.column) {
            h.classList.add(currentStatsSort.direction === 'asc' ? 'sort-asc' : 'sort-desc');
        }
    });

    const formatNum = (num) => new Intl.NumberFormat('pt-BR').format(num);

    filteredData.forEach(row => {
        const flags = getBotFlags(row.id);
        const tr = document.createElement('tr');
        if (flags.vip) tr.classList.add('vip-row');
        if (flags.comunitario) tr.classList.add('comunitario-row');
        
        tr.innerHTML = `
            <td>${row.id}</td>
            <td>${formatNum(row.groupsCount)}</td>
            <td>${formatNum(row.hour)}</td>
            <td>${formatNum(row.day)}</td>
            <td>${formatNum(row.week)}</td>
            <td>${formatNum(row.month)}</td>
            <td>${formatNum(row.year)}</td>
        `;
        tbody.appendChild(tr);
    });

    // Add TOTAL row at the end if not filtering
    if (!showOnlyConventional) {
        const totalRow = data.find(row => row.id === 'TOTAL');
        if (totalRow) {
            const tr = document.createElement('tr');
            tr.style.fontWeight = 'bold';
            tr.classList.add('total-row');
            tr.innerHTML = `
                <td>${totalRow.id}</td>
                <td>${formatNum(totalRow.groupsCount)}</td>
                <td>${formatNum(totalRow.hour)}</td>
                <td>${formatNum(totalRow.day)}</td>
                <td>${formatNum(totalRow.week)}</td>
                <td>${formatNum(totalRow.month)}</td>
                <td>${formatNum(totalRow.year)}</td>
            `;
            tbody.appendChild(tr);
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    checkAdminMode();
    fetchRecentTopDonates();
    fetchTopDonates();
    fetchHealthData();
    fetchBotDetailedStats();

    // Stats Table Sorting
    const statsTableHeaders = document.querySelectorAll('#botStatsTable th');
    statsTableHeaders.forEach(th => {
        th.addEventListener('click', () => {
            const colName = th.innerText;
            if (currentStatsSort.column === colName) {
                currentStatsSort.direction = currentStatsSort.direction === 'asc' ? 'desc' : 'asc';
            } else {
                currentStatsSort.column = colName;
                currentStatsSort.direction = 'desc';
            }
            if (lastStatsData) renderBotStatsTable(lastStatsData);
        });
    });

    // Shift + R Shortcut
    document.addEventListener('keydown', (e) => {
        if (e.shiftKey && e.key.toUpperCase() === 'R') {
            e.preventDefault();
            showOnlyConventional = !showOnlyConventional;
            if (lastStatsData) renderBotStatsTable(lastStatsData);
        }
    });

    const timeFilters = document.querySelectorAll('.time-filter');
    timeFilters.forEach(filter => {
        filter.addEventListener('click', () => {
            timeFilters.forEach(f => f.classList.remove('active'));
            filter.classList.add('active');
            activePeriod = filter.dataset.period;
            fetchAnalyticsData();
        });
    });
    
    setTimeout(fetchAnalyticsData, 1500);
    
    const refreshButton = document.getElementById('refreshButton');
    if (refreshButton) {
        refreshButton.addEventListener('click', fetchHealthData);
    }
    
    const cancelButton = document.getElementById('cancelRestart');
    const confirmButton = document.getElementById('confirmRestart');
    if (cancelButton && confirmButton) {
        cancelButton.addEventListener('click', closeRestartModal);
        confirmButton.addEventListener('click', restartBot);
    }
    
    setInterval(fetchHealthData, 30000);
    setInterval(fetchRecentTopDonates, 5 * 60 * 1000);
    setInterval(fetchTopDonates, 5 * 60 * 1000); // Atualiza doações a cada 5 minutos

    // SSE connection for realtime activity
    if (window.EventSource) {
        const evtSource = new EventSource("/api/stream");
        const overlay = document.getElementById('ws-loading-overlay');
        
        // State variables
        let whatsgoapiStatus = 'unknown'; // 'up', 'down', 'unknown'

        // Status update function for general services
        const updateStatusLight = (elementId, statusData) => {
            const el = document.getElementById(elementId);
            if (!el) return;
            
            // Handle both string status (old) and object status (new/detailed)
            let status = typeof statusData === 'string' ? statusData : statusData.status;

            // Remove existing classes
            el.classList.remove('up', 'down', 'backup', 'backup-dim', 'green', 'red', 'yellow');
            
            if (status === 'up') el.classList.add('up');
            else if (status === 'down') el.classList.add('down');
            else if (status === 'backup') {
                if (elementId === 'api-llm' && typeof statusData === 'object' && !statusData.isPrimary) {
                    el.classList.add('backup-dim');
                } else {
                    el.classList.add('backup');
                }
            }
            else el.classList.add('down'); // Default to down/red

            // Detailed handling for LLM
            if (elementId === 'api-llm' && typeof statusData === 'object') {
                llmStatusData = statusData;
                updateLLMTooltip();
                
                // Reset or start countdown if in backup
                if (status === 'backup' && statusData.resetSeconds > 0) {
                    if (llmCountdownInterval) clearInterval(llmCountdownInterval);
                    llmCountdownInterval = setInterval(() => {
                        if (llmStatusData && llmStatusData.resetSeconds > 0) {
                            llmStatusData.resetSeconds--;
                            updateLLMTooltip();
                        } else {
                            clearInterval(llmCountdownInterval);
                            llmCountdownInterval = null;
                        }
                    }, 1000);
                } else if (llmCountdownInterval) {
                    clearInterval(llmCountdownInterval);
                    llmCountdownInterval = null;
                }
            }
        };

        const updateLLMTooltip = () => {
            const el = document.getElementById('api-llm');
            if (!el || !llmStatusData) return;
            const tooltip = el.querySelector('.tooltip-text');
            if (!tooltip) return;

            let modelInfo = llmStatusData.model || 'Desconhecido';
            if (llmStatusData.status === 'backup' && llmStatusData.resetSeconds > 0) {
                modelInfo += `, ${llmStatusData.resetSeconds}s`;
            }

            tooltip.textContent = `[${modelInfo}] !ia/!resumo/!interagir / Servidor IA de linguagem (LLM)`;
        };

        const blinkIndicator = (id) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.classList.remove('flash');
            void el.offsetWidth; // Force reflow
            el.classList.add('flash');
            
            if (el._flashTimeout) clearTimeout(el._flashTimeout);
            el._flashTimeout = setTimeout(() => {
                el.classList.remove('flash');
                delete el._flashTimeout;
            }, 200);
        };

        evtSource.onopen = () => {
            if (overlay) overlay.style.display = 'none';
        };

        evtSource.onerror = (err) => {
            // Browser automatically tries to reconnect
            if (overlay) overlay.style.display = 'flex';
        };

        evtSource.addEventListener('activity', (e) => {
            const data = JSON.parse(e.data);
            if (!data) return;

            const type = data.type;
            
            // Map activity type to DOM element ID
            const typeMap = {
                'message': 'service-whatsgoapi',
                'imagine': 'api-imagine',
                'llm': 'api-llm',
                'whisper': 'api-whisper',
                'f5tts': 'api-f5tts'
            };

            const targetId = typeMap[type];
            if (targetId) blinkIndicator(targetId);

            // Handle bot-specific activity (card flash and counters)
            if (type === 'message') {
                messageTimestamps.push(Date.now());
                if (data.botId) {
                    if (!botMessageTimestamps[data.botId]) botMessageTimestamps[data.botId] = [];
                    botMessageTimestamps[data.botId].push(Date.now());
                    updateBotRealtimeCounters();
                    
                    // FLASH EFFECT FOR BOT CARD
                    const botStatusDot = document.getElementById(`status-${data.botId}`);
                    if (botStatusDot) {
                        botStatusDot.classList.remove('flash');
                        void botStatusDot.offsetWidth;
                        botStatusDot.classList.add('flash');
                        
                        if (botStatusDot._flashTimeout) clearTimeout(botStatusDot._flashTimeout);
                        botStatusDot._flashTimeout = setTimeout(() => {
                            botStatusDot.classList.remove('flash');
                            delete botStatusDot._flashTimeout;
                        }, 400);
                    }
                }
                updateRealtimeCounter();
            }
        });

        // Update realtime counter every second to decay count
        setInterval(() => {
            updateRealtimeCounter();
            updateBotRealtimeCounters();
        }, 1000);

        evtSource.addEventListener('service-status', (e) => {
            const services = JSON.parse(e.data);
            // Update WhatsGoAPI Status
            whatsgoapiStatus = services.whatsgoapi;
            updateStatusLight('service-whatsgoapi', services.whatsgoapi);
            
            // Update others
            updateStatusLight('api-imagine', services.imagine);
            updateStatusLight('api-llm', services.llm);
            updateStatusLight('api-whisper', services.whisper);
            updateStatusLight('api-f5tts', services.f5tts);
        });
        
    } else {
        console.warn('SSE not supported.');
    }

    // Matrix Background Animation
    const canvas = document.getElementById('matrix-bg');
    if (canvas) {
        const ctx = canvas.getContext('2d');
        
        // Setting the width and height of the canvas
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        
        // Setting up the columns
        const fontSize = 16;
        const columns = Math.ceil(canvas.width / fontSize);
        
        // Code Snippets Storage
        let codeSnippets = ["RAVENA", "SYSTEM", "ONLINE", "CODING", "MATRIX", "NODEJS", "JAVASCRIPT", "MOOTHZ"];
        fetch('code-snippets.json')
            .then(r => r.json())
            .then(data => {
                if(data && data.length > 0) codeSnippets = data;
            })
            .catch(e => console.log("Snippets load error", e));

        // State for each column: { y: number, text: string, charIdx: number }
        const columnState = [];
        for (let x = 0; x < columns; x++) {
            columnState[x] = {
                y: Math.floor(Math.random() * -50),
                text: codeSnippets[Math.floor(Math.random() * codeSnippets.length)],
                charIdx: 0
            };
        }
        
        // Initial solid fill to prevent "all characters" glich
        ctx.fillStyle = "#05060d";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        let lastDraw = 0;
        
        const draw = (timestamp) => {
            const currentMsgsHr = messageTimestamps ? messageTimestamps.length * 60 : 0;
            const minMsgs = 500;
            const maxMsgs = 20000;
            
            let factor = (currentMsgsHr - minMsgs) / (maxMsgs - minMsgs);
            if (factor < 0) factor = 0;
            if (factor > 1) factor = 1;
            
            // Faster settings: Lower delay means faster animation
            const minDelay = 15; 
            const maxDelay = 70;
            const delay = maxDelay - (factor * (maxDelay - minDelay));
            
            if (timestamp - lastDraw < delay) {
                requestAnimationFrame(draw);
                return;
            }
            lastDraw = timestamp;

            // Translucent background to show trail
            ctx.fillStyle = "rgba(5, 6, 13, 0.05)";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            
            ctx.fillStyle = "#85e413"; // Green text
            ctx.font = fontSize + "px monospace";
            
            for (let i = 0; i < columnState.length; i++) {
                const state = columnState[i];
                
                // Get char from current snippet
                // If snippet is shorter than charIdx, loop or use space?
                // Using loop
                const char = state.text.charAt(state.charIdx % state.text.length);
                
                // x = i * fontSize, y = value of drops[i] * fontSize
                ctx.fillText(char, i * fontSize, state.y * fontSize);
                
                // Reset if off screen
                if (state.y * fontSize > canvas.height && Math.random() > 0.975) {
                    state.y = 0;
                    state.charIdx = 0;
                    state.text = codeSnippets[Math.floor(Math.random() * codeSnippets.length)];
                }
                
                // Increment Y coordinate and char index
                state.y++;
                state.charIdx++;
            }
            requestAnimationFrame(draw);
        };
        
        requestAnimationFrame(draw);
        
        // Resize listener
        window.addEventListener('resize', () => {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
            // Simple resize might break columns logic, ideally re-init columns
             // Re-init needed for columns count change
             const newColumns = Math.ceil(canvas.width / fontSize);
             if(newColumns > columnState.length) {
                 for(let i=columnState.length; i<newColumns; i++) {
                     columnState[i] = {
                        y: Math.floor(Math.random() * -50),
                        text: codeSnippets[Math.floor(Math.random() * codeSnippets.length)],
                        charIdx: 0
                     };
                 }
             }
        });
    }
});
