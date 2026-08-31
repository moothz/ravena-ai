// windows/tts.js - Text-to-Speech (F5-TTS) window

WindowManager.register('tts', {
    title: 'TTS — Texto para Voz (F5-TTS)',
    taskbarIcon: 'fa-volume-up',
    width: '540px',
    height: '460px',
    singleton: true,

    render(wb) {
        const body = wb.body;

        body.innerHTML = `
            <div class="ai-tool-view">
                <div style="display: flex; flex-direction: column; gap: 6px;">
                    <label style="font-size: 11px; color: var(--bright-blue); font-weight: 600;">Texto para falar:</label>
                    <textarea class="os-textarea" id="tts-text" rows="4" placeholder="Digite aqui o texto que você quer que a Ravena fale..."></textarea>
                </div>

                <div style="display: flex; gap: 10px; align-items: center; justify-content: space-between; flex-wrap: wrap;">
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <label style="font-size: 11px; color: var(--light-gray);">Voz:</label>
                        <select class="os-select" id="tts-voice" style="width: 140px;">
                            <option value="ravena">Ravena (Padrão)</option>
                            <option value="bot">Assistente</option>
                        </select>
                    </div>

                    <button class="os-btn" id="tts-generate-btn">
                        <i class="fas fa-play"></i> Gerar Áudio
                    </button>
                </div>

                <div class="ai-preview-box" id="tts-player-box" style="min-height: 120px; flex-direction: column; gap: 10px;">
                    <span style="font-size: 11px; color: #555577;">O áudio gerado aparecerá aqui</span>
                </div>
            </div>
        `;

        const textInput = body.querySelector('#tts-text');
        const voiceSelect = body.querySelector('#tts-voice');
        const generateBtn = body.querySelector('#tts-generate-btn');
        const playerBox = body.querySelector('#tts-player-box');

        generateBtn.addEventListener('click', async () => {
            const text = textInput.value.trim();
            const voice = voiceSelect.value;

            if (!text) {
                alert('Digite um texto primeiro!');
                return;
            }

            generateBtn.disabled = true;
            generateBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sintetizando...';
            playerBox.innerHTML = `
                <i class="fas fa-spinner fa-spin" style="font-size: 24px; color: var(--bright-blue);"></i>
                <span style="font-size: 11px; color: var(--light-gray);">Gerando áudio com F5-TTS...</span>
            `;

            try {
                const blob = await Api.post('/api/tts/generate', { text, voice });
                if (blob instanceof Blob) {
                    const url = URL.createObjectURL(blob);
                    playerBox.innerHTML = `
                        <audio controls autoplay style="width: 90%; max-width: 400px;">
                            <source src="${url}" type="audio/mpeg">
                            Seu navegador não suporta áudio HTML5.
                        </audio>
                        <a href="${url}" download="ravena-fala.mp3" class="os-btn" style="margin-top: 6px; font-size: 11px;">
                            <i class="fas fa-download"></i> Baixar MP3
                        </a>
                    `;
                } else {
                    playerBox.innerHTML = `<span style="color: #ff5555; font-size: 11px;">Resposta inesperada do servidor</span>`;
                }
            } catch (err) {
                playerBox.innerHTML = `<span style="color: #ff5555; font-size: 11px; padding: 15px; text-align: center;">Erro: ${err.message}</span>`;
            } finally {
                generateBtn.disabled = false;
                generateBtn.innerHTML = '<i class="fas fa-play"></i> Gerar Áudio';
            }
        });
    }
});
