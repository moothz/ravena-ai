// windows/stt.js - Speech-to-Text (Whisper) audio transcriber window

WindowManager.register('stt', {
    title: 'STT — Transcrição de Áudio (Whisper)',
    taskbarIcon: 'fa-microphone',
    width: '560px',
    height: '500px',
    singleton: true,

    render(wb) {
        const body = wb.body;

        body.innerHTML = `
            <div class="ai-tool-view">
                <div style="font-size: 11px; color: var(--light-gray);">
                    Envie um arquivo de áudio ou vídeo para transcrever em texto usando o Whisper.
                </div>

                <div id="stt-dropzone" style="border: 2px dashed var(--bright-blue); border-radius: 6px; padding: 20px; text-align: center; background: #090714; cursor: pointer; transition: all 0.2s ease;">
                    <i class="fas fa-cloud-upload-alt" style="font-size: 32px; color: var(--bright-blue); margin-bottom: 8px;"></i>
                    <p style="font-size: 12px; color: #ffffff; font-weight: 600;">Arraste ou clique para selecionar áudio</p>
                    <p style="font-size: 10px; color: #888; margin-top: 4px;">MP3, WAV, OGG, M4A, MP4 (máx 50MB)</p>
                    <input type="file" id="stt-file-input" accept="audio/*,video/*" style="display: none;">
                </div>

                <div id="stt-file-info" class="hidden" style="font-size: 11px; color: var(--cyan-neon); display: flex; align-items: center; justify-content: space-between; background: #110d29; padding: 8px 12px; border-radius: 4px;">
                    <span id="stt-file-name">arquivo.mp3</span>
                    <button class="os-btn" id="stt-transcribe-btn" style="font-size: 11px; padding: 4px 10px;">
                        <i class="fas fa-play"></i> Iniciar Transcrição
                    </button>
                </div>

                <div id="stt-status-box" class="hidden" style="font-size: 11px; color: var(--light-gray); display: flex; align-items: center; gap: 8px; background: #110d29; padding: 8px 12px; border-radius: 4px;">
                    <i class="fas fa-spinner fa-spin" style="color: var(--bright-blue);"></i>
                    <span id="stt-status-text">Processando áudio...</span>
                </div>

                <div style="display: flex; flex-direction: column; gap: 6px;">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <label style="font-size: 11px; color: var(--bright-blue); font-weight: 600;">Resultado da Transcrição:</label>
                        <button class="os-btn hidden" id="stt-copy-btn" style="font-size: 10px; padding: 3px 8px;">
                            <i class="fas fa-copy"></i> Copiar Texto
                        </button>
                    </div>
                    <textarea class="os-textarea" id="stt-result-text" rows="7" placeholder="O texto transcrito aparecerá aqui..." readonly></textarea>
                </div>
            </div>
        `;

        const dropzone = body.querySelector('#stt-dropzone');
        const fileInput = body.querySelector('#stt-file-input');
        const fileInfo = body.querySelector('#stt-file-info');
        const fileNameEl = body.querySelector('#stt-file-name');
        const transcribeBtn = body.querySelector('#stt-transcribe-btn');
        const statusBox = body.querySelector('#stt-status-box');
        const statusText = body.querySelector('#stt-status-text');
        const resultText = body.querySelector('#stt-result-text');
        const copyBtn = body.querySelector('#stt-copy-btn');

        let selectedFile = null;
        let pollInterval = null;

        dropzone.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', () => {
            if (fileInput.files.length > 0) {
                selectedFile = fileInput.files[0];
                fileNameEl.textContent = `${selectedFile.name} (${(selectedFile.size / 1024 / 1024).toFixed(2)} MB)`;
                fileInfo.classList.remove('hidden');
            }
        });

        dropzone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropzone.style.borderColor = 'var(--cyan-neon)';
            dropzone.style.background = '#141030';
        });

        dropzone.addEventListener('dragleave', () => {
            dropzone.style.borderColor = 'var(--bright-blue)';
            dropzone.style.background = '#090714';
        });

        dropzone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropzone.style.borderColor = 'var(--bright-blue)';
            dropzone.style.background = '#090714';
            if (e.dataTransfer.files.length > 0) {
                selectedFile = e.dataTransfer.files[0];
                fileNameEl.textContent = `${selectedFile.name} (${(selectedFile.size / 1024 / 1024).toFixed(2)} MB)`;
                fileInfo.classList.remove('hidden');
            }
        });

        transcribeBtn.addEventListener('click', async () => {
            if (!selectedFile) return;

            transcribeBtn.disabled = true;
            statusBox.classList.remove('hidden');
            statusText.textContent = 'Enviando arquivo para o servidor...';
            resultText.value = '';
            copyBtn.classList.add('hidden');

            const formData = new FormData();
            formData.append('audio', selectedFile);

            try {
                const res = await Api.post('/api/stt/transcrever', formData);
                const jobId = res.jobId;
                statusText.textContent = 'Transcrevendo áudio com Whisper...';

                pollInterval = setInterval(async () => {
                    try {
                        const job = await Api.get(`/api/stt/status/${jobId}`);
                        if (job.status === 'complete') {
                            clearInterval(pollInterval);
                            statusBox.classList.add('hidden');
                            transcribeBtn.disabled = false;
                            resultText.value = job.result || 'Nenhuma fala detectada.';
                            copyBtn.classList.remove('hidden');
                        } else if (job.status === 'error') {
                            clearInterval(pollInterval);
                            statusBox.classList.remove('hidden');
                            statusText.textContent = `Erro: ${job.error || 'Falha na transcrição'}`;
                            transcribeBtn.disabled = false;
                        } else {
                            statusText.textContent = `Status: ${job.status || 'processando'}...`;
                        }
                    } catch (e) {
                        clearInterval(pollInterval);
                        statusText.textContent = `Erro ao consultar status: ${e.message}`;
                        transcribeBtn.disabled = false;
                    }
                }, 1500);

            } catch (err) {
                statusBox.classList.remove('hidden');
                statusText.textContent = `Erro: ${err.message}`;
                transcribeBtn.disabled = false;
            }
        });

        copyBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(resultText.value);
            copyBtn.innerHTML = '<i class="fas fa-check"></i> Copiado!';
            setTimeout(() => {
                copyBtn.innerHTML = '<i class="fas fa-copy"></i> Copiar Texto';
            }, 2000);
        });

        wb.onclose = () => {
            if (pollInterval) clearInterval(pollInterval);
            return false;
        };
    }
});
