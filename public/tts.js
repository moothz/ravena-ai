document.addEventListener('DOMContentLoaded', () => {
    const textInput = document.getElementById('text-input');
    const voiceSelect = document.getElementById('voice-select');
    const currentChars = document.getElementById('current-chars');
    const generateBtn = document.getElementById('generate-btn');
    const statusBox = document.getElementById('status-box');
    const statusText = document.getElementById('status-text');
    const resultSection = document.getElementById('result-section');
    const audioPlayer = document.getElementById('audio-player');
    const downloadBtn = document.getElementById('download-btn');
    const offlineMessage = document.getElementById('offline-message');

    let ttsAvailable = true;

    // Check Service Status
    async function checkStatus() {
        try {
            const response = await fetch('/api/services/status');
            const services = await response.json();
            ttsAvailable = services.f5tts !== 'down';
            updateAvailabilityUI();
        } catch (error) {
            console.error('Status check failed:', error);
        }
    }

    function updateAvailabilityUI() {
        if (!ttsAvailable) {
            offlineMessage.style.display = 'block';
            generateBtn.disabled = true;
            textInput.disabled = true;
            voiceSelect.disabled = true;
            textInput.style.opacity = '0.5';
            voiceSelect.style.opacity = '0.5';
        } else {
            offlineMessage.style.display = 'none';
            textInput.disabled = false;
            voiceSelect.disabled = false;
            textInput.style.opacity = '1';
            voiceSelect.style.opacity = '1';
            updateButtonState();
        }
    }

    function updateButtonState() {
        if (!ttsAvailable) return;
        generateBtn.disabled = textInput.value.trim().length < 1;
    }

    checkStatus();

    // Handle Input
    textInput.addEventListener('input', () => {
        const length = textInput.value.length;
        currentChars.textContent = length;
        updateButtonState();
    });

    // Generation Logic
    generateBtn.addEventListener('click', async () => {
        const text = textInput.value.trim();
        const voice = voiceSelect.value;
        if (text.length < 1) return;

        // UI Feedback
        generateBtn.disabled = true;
        textInput.disabled = true;
        voiceSelect.disabled = true;
        statusBox.style.display = 'block';
        statusText.textContent = 'Sintetizando áudio (isso pode levar alguns segundos)...';
        resultSection.style.display = 'none';

        try {
            const response = await fetch('/api/tts/generate', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ text, voice })
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Erro ao gerar áudio');
            }

            const blob = await response.blob();
            const audioUrl = URL.createObjectURL(blob);

            // Show Result
            statusBox.style.display = 'none';
            resultSection.style.display = 'block';
            audioPlayer.src = audioUrl;
            audioPlayer.play().catch(() => {}); // Autoplay if possible
            downloadBtn.href = audioUrl;
            
            setTimeout(() => {
                resultSection.scrollIntoView({ behavior: 'smooth' });
            }, 100);

        } catch (error) {
            showError(error.message);
        } finally {
            if (ttsAvailable) {
                generateBtn.disabled = false;
                textInput.disabled = false;
                voiceSelect.disabled = false;
            }
        }
    });

    function showError(error) {
        statusText.textContent = `Erro: ${error}`;
        statusBox.style.background = 'rgba(221, 107, 32, 0.1)';
        statusText.style.color = '#ed8936';
    }
});