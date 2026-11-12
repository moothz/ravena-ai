document.addEventListener('DOMContentLoaded', () => {
    const chatContainer = document.getElementById('chat-container');
    const chatForm = document.getElementById('chat-form');
    const userInput = document.getElementById('user-input');
    const sendBtn = document.getElementById('send-btn');
    const suggestions = document.getElementById('chat-suggestions');

    // Obtém sessionId persistente via cookie ou gera uma nova
    function getHelpSessionId() {
        const match = document.cookie.match(/ravena_help_session=([^;]+)/);
        if (match && match[1]) {
            return decodeURIComponent(match[1].trim());
        }
        const newId = 'web-' + Math.random().toString(36).substr(2, 9);
        document.cookie = `ravena_help_session=${encodeURIComponent(newId)}; path=/; max-age=2592000; SameSite=Lax`;
        return newId;
    }
    const sessionId = getHelpSessionId();

    let isProcessing = false;
    let messageCount = 0;
    let lastResetTime = Date.now();

    function checkRateLimit() {
        const now = Date.now();
        if (now - lastResetTime > 60000) {
            messageCount = 0;
            lastResetTime = now;
        }

        if (messageCount >= 5) {
            return false;
        }
        return true;
    }

    function escapeHtml(text) {
        return String(text ?? '').replace(/[&<>"']/g, (c) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        })[c]);
    }

    /**
     * Converte a resposta (formatação do WhatsApp, que é o que a IA usa) em HTML seguro:
     * o texto é escapado ANTES de qualquer marcação, então nada vindo da resposta vira HTML.
     * Suporta *negrito*, **negrito**, _itálico_, ~riscado~, `código`, ```bloco``` e links.
     */
    function formatWhatsApp(text) {
        const tokens = [];
        const keep = (html) => {
            tokens.push(html);
            return `\u0000${tokens.length - 1}\u0000`;
        };

        let html = escapeHtml(text);

        html = html.replace(/```([\s\S]*?)```/g, (_, code) => keep(`<pre>${code.replace(/^\n/, '')}</pre>`));
        html = html.replace(/`([^`\n]+)`/g, (_, code) => keep(`<code>${code}</code>`));
        html = html.replace(/https?:\/\/(?:(?!&quot;|&#39;|&lt;|&gt;)[^\s<])+/g, (match) => {
            let url = match;
            let tail = '';
            while (/[.,;:!?)\]*_~]$/.test(url)) {
                tail = url.slice(-1) + tail;
                url = url.slice(0, -1);
            }
            return keep(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`) + tail;
        });

        html = html
            .replace(/\*\*(?=\S)([^*\n]+?)\*\*/g, '<strong>$1</strong>')
            .replace(/(^|[\s(>\u0000])\*(?=\S)([^*\n]+?)\*(?=$|[\s).,;:!?<\u0000])/gm, '$1<strong>$2</strong>')
            .replace(/(^|[\s(>\u0000])_(?=\S)([^_\n]+?)_(?=$|[\s).,;:!?<\u0000])/gm, '$1<em>$2</em>')
            .replace(/(^|[\s(>\u0000])~(?=\S)([^~\n]+?)~(?=$|[\s).,;:!?<\u0000])/gm, '$1<del>$2</del>')
            .replace(/\n/g, '<br>');

        return html.replace(/\u0000(\d+)\u0000/g, (_, i) => tokens[Number(i)]);
    }

    function scrollToBottom() {
        chatContainer.scrollTop = chatContainer.scrollHeight;
    }

    function addMessage(content, isBot = false, isError = false) {
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${isBot ? 'bot-message' : 'user-message'}${isError ? ' error-message' : ''}`;

        const messageContent = document.createElement('div');
        messageContent.className = 'message-content';

        if (isBot) {
            messageContent.innerHTML = formatWhatsApp(content);
        } else {
            messageContent.textContent = content;
        }

        messageDiv.appendChild(messageContent);
        chatContainer.appendChild(messageDiv);
        scrollToBottom();
    }

    function addTypingIndicator() {
        const indicatorDiv = document.createElement('div');
        indicatorDiv.className = 'message bot-message typing-indicator-container';
        indicatorDiv.id = 'typing-indicator';
        indicatorDiv.setAttribute('aria-label', 'A assistente está digitando');

        indicatorDiv.innerHTML = `
            <div class="typing-indicator" aria-hidden="true">
                <div class="typing-dot"></div>
                <div class="typing-dot"></div>
                <div class="typing-dot"></div>
            </div>
        `;

        chatContainer.appendChild(indicatorDiv);
        scrollToBottom();
    }

    function removeTypingIndicator() {
        const indicator = document.getElementById('typing-indicator');
        if (indicator) {
            indicator.remove();
        }
    }

    async function handleSend() {
        const message = userInput.value.trim();

        if (message.length < 2 || isProcessing) return;

        if (!checkRateLimit()) {
            addMessage('⚠️ Calma! Você só pode enviar 5 mensagens por minuto. Aguarde um instante.', true, true);
            return;
        }

        messageCount++;

        if (suggestions) suggestions.remove();

        // Clear input and disable
        userInput.value = '';
        userInput.disabled = true;
        sendBtn.disabled = true;
        isProcessing = true;

        // Add user message to UI
        addMessage(message, false);

        // Add typing indicator
        addTypingIndicator();

        try {
            const response = await fetch('/api/ajuda/chat', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    message,
                    sessionId
                })
            });

            let data = null;
            try {
                data = await response.json();
            } catch (_) {
                data = { error: response.status === 429 ? 'Muitas perguntas seguidas, aguarde um pouco.' : `Erro HTTP ${response.status}` };
            }

            removeTypingIndicator();

            if (data.error) {
                addMessage('❌ Desculpe, ocorreu um erro: ' + (data.message || data.error), true, true);
            } else {
                addMessage(data.answer || 'Não consegui gerar uma resposta agora. Tente reformular a pergunta.', true);
            }
        } catch (error) {
            removeTypingIndicator();
            addMessage('❌ Erro de conexão com o servidor. Tente novamente mais tarde.', true, true);
            console.error('Chat error:', error);
        } finally {
            isProcessing = false;
            userInput.disabled = false;
            sendBtn.disabled = false;
            userInput.focus();
        }
    }

    // <form>: Enter no teclado físico e o botão "Enviar" do teclado do celular disparam o submit
    chatForm.addEventListener('submit', (e) => {
        e.preventDefault();
        handleSend();
    });

    if (suggestions) {
        suggestions.querySelectorAll('.suggestion-chip').forEach((chip) => {
            chip.addEventListener('click', () => {
                userInput.value = chip.textContent.trim();
                handleSend();
            });
        });
    }

    // Foco automático só em telas com teclado físico (no celular abriria o teclado cobrindo a tela)
    if (window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
        userInput.focus();
    }
});
