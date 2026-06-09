document.addEventListener('DOMContentLoaded', () => {
    const promptInput = document.getElementById('prompt-input');
    const currentChars = document.getElementById('current-chars');
    const generateBtn = document.getElementById('generate-btn');
    const statusBox = document.getElementById('status-box');
    const statusText = document.getElementById('status-text');
    const resultSection = document.getElementById('result-section');
    const resultImage = document.getElementById('result-image');
    const placeholderIcon = document.getElementById('placeholder-icon');
    const downloadBtn = document.getElementById('download-btn');
    const offlineMessage = document.getElementById('offline-message');

    let imagineAvailable = true;

    // Check Service Status
    async function checkStatus() {
        try {
            const response = await fetch('/api/services/status');
            const services = await response.json();
            imagineAvailable = services.imagine !== 'down';
            updateAvailabilityUI();
        } catch (error) {
            console.error('Status check failed:', error);
        }
    }

    function updateAvailabilityUI() {
        if (!imagineAvailable) {
            offlineMessage.style.display = 'block';
            generateBtn.disabled = true;
            promptInput.disabled = true;
            promptInput.style.opacity = '0.5';
        } else {
            offlineMessage.style.display = 'none';
            promptInput.disabled = false;
            promptInput.style.opacity = '1';
            updateButtonState();
        }
    }

    function updateButtonState() {
        if (!imagineAvailable) return;
        generateBtn.disabled = promptInput.value.trim().length < 4;
    }

    checkStatus();

    // Handle Input
    promptInput.addEventListener('input', () => {
        const length = promptInput.value.length;
        currentChars.textContent = length;
        updateButtonState();
    });

    // Generation Logic
    generateBtn.addEventListener('click', async () => {
        const prompt = promptInput.value.trim();
        if (prompt.length < 4) return;

        // UI Feedback
        generateBtn.disabled = true;
        promptInput.disabled = true;
        statusBox.style.display = 'block';
        statusText.textContent = 'Iniciando geração (pode levar 10-20 segundos)...';
        resultSection.style.display = 'none';
        resultImage.style.display = 'none';
        placeholderIcon.style.display = 'block';

        try {
            const response = await fetch('/api/imagine/generate', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ prompt })
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Erro ao gerar imagem');
            }

            const blob = await response.blob();
            const imageUrl = URL.createObjectURL(blob);

            // Show Result
            statusBox.style.display = 'none';
            resultSection.style.display = 'block';
            resultImage.src = imageUrl;
            resultImage.style.display = 'block';
            placeholderIcon.style.display = 'none';
            downloadBtn.href = imageUrl;
            
            setTimeout(() => {
                resultSection.scrollIntoView({ behavior: 'smooth' });
            }, 100);

        } catch (error) {
            showError(error.message);
        } finally {
            if (imagineAvailable) {
                generateBtn.disabled = false;
                promptInput.disabled = false;
            }
        }
    });

    function showError(error) {
        statusText.textContent = `Erro: ${error}`;
        statusBox.style.background = 'rgba(221, 107, 32, 0.1)';
        statusText.style.color = '#ed8936';
    }
});