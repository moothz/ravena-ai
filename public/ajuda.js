document.addEventListener('DOMContentLoaded', () => {
    const chatContainer = document.getElementById('chat-container');
    const userInput = document.getElementById('user-input');
    const sendBtn = document.getElementById('send-btn');

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

    function addMessage(content, isBot = false) {
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${isBot ? 'bot-message' : 'user-message'}`;
        
        const messageContent = document.createElement('div');
        messageContent.className = 'message-content';
        
        // Basic markdown-like formatting for bot responses
        if (isBot) {
            // Replace newlines with <br> and **text** with <b>text</b>
            let formattedContent = content
                .replace(/\n/g, '<br>')
                .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
                .replace(/\*(.*?)\*/g, '<i>$1</i>');
            messageContent.innerHTML = formattedContent;
        } else {
            messageContent.textContent = content;
        }
        
        messageDiv.appendChild(messageContent);
        chatContainer.appendChild(messageDiv);
        
        // Scroll to bottom
        chatContainer.scrollTop = chatContainer.scrollHeight;
    }

    function addTypingIndicator() {
        const indicatorDiv = document.createElement('div');
        indicatorDiv.className = 'message bot-message typing-indicator-container';
        indicatorDiv.id = 'typing-indicator';
        
        indicatorDiv.innerHTML = `
            <div class="typing-indicator">
                <div class="typing-dot"></div>
                <div class="typing-dot"></div>
                <div class="typing-dot"></div>
            </div>
        `;
        
        chatContainer.appendChild(indicatorDiv);
        chatContainer.scrollTop = chatContainer.scrollHeight;
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
            addMessage('⚠️ Calma! Você só pode enviar 5 mensagens por minuto. Aguarde um instante.', true);
            return;
        }

        messageCount++;

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

            const data = await response.json();
            
            removeTypingIndicator();

            if (data.error) {
                addMessage('❌ Desculpe, ocorreu um erro: ' + data.error, true);
            } else {
                addMessage(data.answer, true);
            }
        } catch (error) {
            removeTypingIndicator();
            addMessage('❌ Erro de conexão com o servidor. Tente novamente mais tarde.', true);
            console.error('Chat error:', error);
        } finally {
            isProcessing = false;
            userInput.disabled = false;
            sendBtn.disabled = false;
            userInput.focus();
        }
    }

    sendBtn.addEventListener('click', handleSend);

    userInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    });

    // Auto-focus input
    userInput.focus();
});
