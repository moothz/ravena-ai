// windows/imagine.js - AI Image Generation (Bonsai) window

WindowManager.register('imagine', {
    title: 'Imagine — Gerador de Imagens IA',
    taskbarIcon: 'fa-palette',
    width: '560px',
    height: '520px',
    singleton: true,

    render(wb) {
        const body = wb.body;

        body.innerHTML = `
            <div class="ai-tool-view">
                <div style="display: flex; flex-direction: column; gap: 6px;">
                    <label style="font-size: 11px; color: var(--bright-blue); font-weight: 600;">Prompt da Imagem:</label>
                    <textarea class="os-textarea" id="imagine-prompt" rows="3" placeholder="Ex: corvo cibernético no topo de um arranha-céu neon retrofuturista, 4k..."></textarea>
                </div>

                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <span style="font-size: 10px; color: #888;">Modelo: Bonsai Ternary AI</span>
                    <button class="os-btn" id="imagine-generate-btn">
                        <i class="fas fa-magic"></i> Gerar Imagem
                    </button>
                </div>

                <div class="ai-preview-box" id="imagine-preview-box">
                    <span style="font-size: 11px; color: #555577;">A imagem gerada aparecerá aqui</span>
                </div>

                <div style="display: flex; justify-content: flex-end; gap: 8px;">
                    <a id="imagine-download-btn" class="os-btn hidden" download="imagine-ravena.jpg" href="#">
                        <i class="fas fa-download"></i> Baixar Imagem
                    </a>
                </div>
            </div>
        `;

        const promptInput = body.querySelector('#imagine-prompt');
        const generateBtn = body.querySelector('#imagine-generate-btn');
        const previewBox = body.querySelector('#imagine-preview-box');
        const downloadBtn = body.querySelector('#imagine-download-btn');

        generateBtn.addEventListener('click', async () => {
            const prompt = promptInput.value.trim();
            if (!prompt) {
                alert('Digite um prompt primeiro!');
                return;
            }

            generateBtn.disabled = true;
            generateBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Gerando...';
            previewBox.innerHTML = `
                <div style="display: flex; flex-direction: column; align-items: center; gap: 8px;">
                    <i class="fas fa-spinner fa-spin" style="font-size: 28px; color: var(--bright-blue);"></i>
                    <span style="font-size: 11px; color: var(--light-gray);">Processando com o Bonsai...</span>
                </div>
            `;
            downloadBtn.classList.add('hidden');

            try {
                const blob = await Api.post('/api/imagine/generate', { prompt });
                if (blob instanceof Blob) {
                    const url = URL.createObjectURL(blob);
                    previewBox.innerHTML = `<img src="${url}" alt="Imagem Gerada">`;
                    downloadBtn.href = url;
                    downloadBtn.classList.remove('hidden');
                } else {
                    previewBox.innerHTML = `<span style="color: #ff5555; font-size: 11px;">Resposta inesperada do servidor</span>`;
                }
            } catch (err) {
                previewBox.innerHTML = `<span style="color: #ff5555; font-size: 11px; padding: 15px; text-align: center;">Erro: ${err.message}</span>`;
            } finally {
                generateBtn.disabled = false;
                generateBtn.innerHTML = '<i class="fas fa-magic"></i> Gerar Imagem';
            }
        });
    }
});
