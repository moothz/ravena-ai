// windows/help.js - LLM Help Assistant Chat window

WindowManager.register('help', {
    title: 'Ajuda — Assistente RavenaBot',
    taskbarIcon: 'fa-question-circle',
    width: '600px',
    height: '550px',
    singleton: true,

    render(wb) {
        const sessionId = 'session-' + Math.random().toString(36).substring(2, 9);
        const body = wb.body;

        body.innerHTML = `
            <div class="chat-window">
                <div class="chat-messages" id="help-chat-messages">
                    <div class="chat-msg msg-bot">
                        Olá! Sou o assistente da RavenaBot. Como posso te ajudar hoje? Pergunte sobre comandos, configuração de streams, integração com Discord/Telegram ou regras!
                    </div>
                </div>

                <div class="chat-input-area">
                    <input type="text" class="os-input" id="help-chat-input" placeholder="Digite sua dúvida e aperte Enter..." autocomplete="off">
                    <button class="os-btn" id="help-chat-send">
                        <i class="fas fa-paper-plane"></i>
                    </button>
                </div>
            </div>
        `;

        const messagesContainer = body.querySelector('#help-chat-messages');
        const inputEl = body.querySelector('#help-chat-input');
        const sendBtn = body.querySelector('#help-chat-send');

        const sendMessage = async () => {
            const text = inputEl.value.trim();
            if (!text) return;

            // Add user message
            const userMsg = document.createElement('div');
            userMsg.className = 'chat-msg msg-user';
            userMsg.textContent = text;
            messagesContainer.appendChild(userMsg);
            inputEl.value = '';
            messagesContainer.scrollTop = messagesContainer.scrollHeight;

            // Add loading placeholder
            const loadingMsg = document.createElement('div');
            loadingMsg.className = 'chat-msg msg-bot';
            loadingMsg.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Pensando...';
            messagesContainer.appendChild(loadingMsg);
            messagesContainer.scrollTop = messagesContainer.scrollHeight;

            try {
                const res = await Api.post('/api/ajuda/chat', { message: text, sessionId });
                loadingMsg.innerHTML = (res.answer || 'Sem resposta').replace(/\n/g, '<br>');
            } catch (err) {
                loadingMsg.innerHTML = `<span style="color: #ff5555;">Erro: ${err.message}</span>`;
            }
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
        };

        sendBtn.addEventListener('click', sendMessage);
        inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                sendMessage();
            }
        });
    }
});
