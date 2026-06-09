document.addEventListener('DOMContentLoaded', () => {
    const dropZone = document.getElementById('drop-zone');
    const audioFile = document.getElementById('audio-file');
    const fileNameDisplay = document.getElementById('file-name');
    const transcribeBtn = document.getElementById('transcribe-btn');
    const statusBox = document.getElementById('status-box');
    const statusText = document.getElementById('status-text');
    
    const uploadProgressSection = document.getElementById('upload-progress-section');
    const uploadProgressFill = document.getElementById('upload-progress-fill');
    const uploadProgressText = document.getElementById('upload-progress-text');
    const uploadSpeedDisplay = document.getElementById('upload-speed');
    
    const transcribeProgressSection = document.getElementById('transcribe-progress-section');
    const transcribeProgressFill = document.getElementById('transcribe-progress-fill');
    const transcribeProgressText = document.getElementById('transcribe-progress-text');
    
    const resultSection = document.getElementById('result-section');
    const transcriptionOutput = document.getElementById('transcription-output');
    const copyBtn = document.getElementById('copy-btn');
    const offlineMessage = document.getElementById('offline-message');

    let selectedFile = null;
    let pollingTimeout = null;
    let currentPollingDelay = 1500;
    let whisperAvailable = true;
    
    // Progress Bar State
    let transcribeTimer = null;
    let estimatedDuration = 0;
    let transcribeStartTime = 0;

    // Check Service Status (Single Fetch)
    async function checkStatus() {
        try {
            const response = await fetch('/api/services/status');
            const services = await response.json();
            whisperAvailable = services.whisper !== 'down';
            updateAvailabilityUI();
        } catch (error) {
            console.error('Status check failed:', error);
            // Default to available if check fails but assume we'll catch errors on submit
        }
    }

    function updateAvailabilityUI() {
        if (!whisperAvailable) {
            offlineMessage.style.display = 'block';
            transcribeBtn.disabled = true;
            dropZone.style.opacity = '0.5';
            dropZone.style.pointerEvents = 'none';
        } else {
            offlineMessage.style.display = 'none';
            if (selectedFile) transcribeBtn.disabled = false;
            dropZone.style.opacity = '1';
            dropZone.style.pointerEvents = 'auto';
        }
    }

    checkStatus();

    // Handle File Selection
    dropZone.addEventListener('click', () => audioFile.click());

    audioFile.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            handleFileSelect(e.target.files[0]);
        }
    });

    // Drag and Drop
    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.style.borderColor = '#04a9f0';
    });

    dropZone.addEventListener('dragleave', () => {
        dropZone.style.borderColor = '#2f304d';
    });

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.style.borderColor = '#2f304d';
        if (e.dataTransfer.files.length > 0) {
            handleFileSelect(e.dataTransfer.files[0]);
        }
    });

    function handleFileSelect(file) {
        if (!file.type.startsWith('audio/') && !file.type.startsWith('video/') && !file.name.match(/\.(mp3|wav|ogg|m4a|aac|mp4|webm|avi|mov|mkv)$/i)) {
            alert('Por favor, selecione um arquivo de áudio ou vídeo válido.');
            return;
        }
        
        if (file.size > 50 * 1024 * 1024) {
            alert('O arquivo é muito grande! O limite máximo é 50MB.');
            return;
        }

        selectedFile = file;
        fileNameDisplay.textContent = `Arquivo: ${file.name} (${formatSize(file.size)})`;
        transcribeBtn.disabled = !whisperAvailable;
        resultSection.style.display = 'none';
        statusBox.style.display = 'none';
        uploadProgressSection.style.display = 'none';
        transcribeProgressSection.style.display = 'none';
    }

    function formatSize(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    // Transcription Logic with Upload Progress
    transcribeBtn.addEventListener('click', () => {
        if (!selectedFile) return;

        const formData = new FormData();
        formData.append('audio', selectedFile);

        transcribeBtn.disabled = true;
        statusBox.style.display = 'block';
        statusText.textContent = 'Iniciando upload...';
        resultSection.style.display = 'none';
        uploadProgressSection.style.display = 'block';
        transcribeProgressSection.style.display = 'none';
        
        resetBars();

        const xhr = new XMLHttpRequest();
        let startTime = Date.now();

        xhr.upload.addEventListener('progress', (e) => {
            if (e.lengthComputable) {
                const percent = (e.loaded / e.total) * 100;
                uploadProgressFill.style.width = percent + '%';
                uploadProgressText.textContent = Math.round(percent) + '%';
                
                // Calculate speed
                const elapsed = (Date.now() - startTime) / 1000;
                if (elapsed > 0) {
                    const speed = e.loaded / elapsed;
                    uploadSpeedDisplay.textContent = formatSize(speed) + '/s';
                }
            }
        });

        xhr.addEventListener('load', () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                const data = JSON.parse(xhr.responseText);
                statusText.textContent = 'Upload concluído! Aguardando processamento...';
                startPolling(data.jobId);
            } else {
                let errorMsg = 'Erro no upload';
                try {
                    const data = JSON.parse(xhr.responseText);
                    errorMsg = data.error || errorMsg;
                } catch(e) {}
                showError(errorMsg);
            }
        });

        xhr.addEventListener('error', () => showError('Erro de conexão com o servidor'));
        
        xhr.open('POST', '/api/stt/transcrever');
        xhr.send(formData);
    });

    function startPolling(jobId) {
        transcribeProgressSection.style.display = 'block';
        currentPollingDelay = 1500; // Reset to default
        
        const poll = async () => {
            try {
                const response = await fetch(`/api/stt/status/${jobId}`);
                if (!response.ok) throw new Error('Erro ao buscar status');

                const job = await response.json();

                if (job.status === 'complete') {
                    stopPolling();
                    completeBars();
                    showResult(job.result);
                    return; // Stop recursion
                } else if (job.status === 'error') {
                    stopPolling();
                    stopBars();
                    showError(job.error);
                    return; // Stop recursion
                } else {
                    // Update status text
                    if (job.status === 'transcribing') {
                        statusText.textContent = 'Transcrição em andamento pelo Whisper...';
                    } else if (job.status === 'starting' || job.status === 'queued') {
                        statusText.textContent = 'Aguardando na fila do servidor...';
                    } else if (job.status === 'processing') {
                        statusText.textContent = 'Preparando áudio...';
                    }

                    // Start/Update transcribe progress bar if we have an estimated time
                    if (job.estimatedTime) {
                        if (!transcribeTimer) {
                            startTranscribeBar(job.estimatedTime);
                        }
                        // Dynamic Polling: ~10 requests total, min 1s
                        currentPollingDelay = Math.max(1000, (job.estimatedTime * 1000) / 10);
                    }
                }

                // Schedule next poll
                pollingTimeout = setTimeout(poll, currentPollingDelay);

            } catch (error) {
                console.error('Polling error:', error);
                // Retry in 2s on error
                pollingTimeout = setTimeout(poll, 2000);
            }
        };

        poll();
    }

    function stopPolling() {
        if (pollingTimeout) {
            clearTimeout(pollingTimeout);
            pollingTimeout = null;
        }
    }

    // Progress Bar Logic
    function startTranscribeBar(seconds) {
        estimatedDuration = seconds;
        transcribeStartTime = Date.now();
        
        transcribeTimer = setInterval(() => {
            const elapsed = (Date.now() - transcribeStartTime) / 1000;
            const remaining = Math.max(0, estimatedDuration - elapsed);
            
            let percent = (elapsed / estimatedDuration) * 100;
            if (percent > 98) percent = 98;
            
            transcribeProgressFill.style.width = `${percent}%`;
            transcribeProgressText.textContent = `${Math.round(percent)}% - Restam aprox. ${Math.round(remaining)}s`;
            
            if (elapsed >= estimatedDuration * 1.5) {
                transcribeProgressText.textContent = `Finalizando transcrição...`;
            }
        }, 250);
    }

    function resetBars() {
        stopBars();
        uploadProgressFill.style.width = '0%';
        uploadProgressText.textContent = '0%';
        uploadSpeedDisplay.textContent = '0 KB/s';
        
        transcribeProgressFill.style.width = '0%';
        transcribeProgressText.textContent = 'Aguardando ETA...';
    }

    function stopBars() {
        if (transcribeTimer) {
            clearInterval(transcribeTimer);
            transcribeTimer = null;
        }
    }

    function completeBars() {
        stopBars();
        uploadProgressFill.style.width = '100%';
        uploadProgressText.textContent = '100%';
        
        transcribeProgressFill.style.width = '100%';
        transcribeProgressText.textContent = 'Transcrição Concluída!';
        
        setTimeout(() => {
            uploadProgressSection.style.display = 'none';
            transcribeProgressSection.style.display = 'none';
        }, 3000);
    }

    function showResult(text) {
        statusBox.style.display = 'none';
        resultSection.style.display = 'block';
        transcriptionOutput.value = text;
        transcribeBtn.disabled = false;
        
        setTimeout(() => {
            resultSection.scrollIntoView({ behavior: 'smooth' });
        }, 100);
    }

    function showError(error) {
        statusText.textContent = `Erro: ${error}`;
        statusBox.style.background = 'rgba(221, 107, 32, 0.1)';
        statusText.style.color = '#ed8936';
        transcribeBtn.disabled = false;
    }

    // Copy to Clipboard
    copyBtn.addEventListener('click', () => {
        transcriptionOutput.select();
        document.execCommand('copy');
        
        const originalText = copyBtn.innerHTML;
        copyBtn.innerHTML = '<i class="fas fa-check"></i> Copiado!';
        setTimeout(() => {
            copyBtn.innerHTML = originalText;
        }, 2000);
    });
});