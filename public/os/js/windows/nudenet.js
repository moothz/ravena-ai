// windows/nudenet.js - NudeNet NSFW Detection & Content Scanner window

WindowManager.register('nudenet', {
    title: 'Detector NSFW',
    taskbarIcon: 'fa-shield-halved',
    width: '840px',
    height: '760px',
    singleton: true,

    render(wb) {
        const body = wb.body;

        body.innerHTML = `
            <div class="nudenet-tool-view">
                <div style="font-size: 11px; color: var(--light-gray); display: flex; align-items: center; justify-content: space-between;">
                    <span>Envie uma imagem para análise e identificação de conteúdo adulto/sensível (NSFW) via NudeNet.</span>
                    <span style="font-size: 10px; color: #888;">Máx: 3MB</span>
                </div>

                <!-- Dropzone Area (Initial State) -->
                <div id="nudenet-dropzone" class="nudenet-dropzone">
                    <i class="fas fa-cloud-arrow-up nudenet-dropzone-icon"></i>
                    <p style="font-size: 13px; color: #ffffff; font-weight: 600;">Arraste e solte uma imagem aqui ou clique para selecionar</p>
                    <p style="font-size: 11px; color: #888;">Suporta JPG, PNG, WEBP, GIF (máximo 3MB) • Suporta colar (Ctrl+V)</p>
                    <input type="file" id="nudenet-file-input" accept="image/jpeg,image/png,image/webp,image/gif" style="display: none;">
                </div>

                <!-- Preview & Controls Stage (Visible after selecting image) -->
                <div id="nudenet-preview-container" class="hidden" style="display: flex; flex-direction: column; gap: 10px;">
                    <!-- Top Toolbar -->
                    <div style="display: flex; justify-content: space-between; align-items: center; background: #110d29; padding: 6px 12px; border-radius: 6px; font-size: 11px; flex-wrap: wrap; gap: 6px;">
                        <div style="display: flex; align-items: center; gap: 8px; color: var(--cyan-neon); font-weight: 500;">
                            <i class="fas fa-image"></i>
                            <span id="nudenet-file-info">imagem.jpg</span>
                        </div>
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <button class="os-btn" id="nudenet-change-btn" style="font-size: 10px; padding: 3px 8px;">
                                <i class="fas fa-rotate"></i> Trocar Imagem
                            </button>
                            <button class="os-btn" id="nudenet-clear-btn" style="font-size: 10px; padding: 3px 8px; border-color: #ff3366; background: #280816;" title="Remover imagem">
                                <i class="fas fa-trash"></i>
                            </button>
                        </div>
                    </div>

                    <!-- Image Display Stage with Overlaid Bounding Boxes -->
                    <div class="nudenet-preview-wrapper">
                        <div class="nudenet-image-stage" id="nudenet-image-stage">
                            <img id="nudenet-preview-img" class="nudenet-preview-img" src="" alt="Imagem selecionada">
                            <div id="nudenet-boxes-overlay" class="nudenet-boxes-overlay"></div>
                        </div>
                    </div>

                    <!-- Action Bar & Overlay Toggles -->
                    <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
                        <div id="nudenet-overlay-toggles" class="hidden" style="display: flex; align-items: center; gap: 14px; font-size: 11px; color: var(--light-gray);">
                            <label style="display: flex; align-items: center; gap: 5px; cursor: pointer;">
                                <input type="checkbox" id="nudenet-toggle-boxes" checked style="accent-color: var(--cyan-neon);">
                                <span>Mostrar Caixas</span>
                            </label>
                            <label style="display: flex; align-items: center; gap: 5px; cursor: pointer;">
                                <input type="checkbox" id="nudenet-toggle-only-nsfw" style="accent-color: #ff1744;">
                                <span>Apenas NSFW</span>
                            </label>
                        </div>

                        <button class="os-btn" id="nudenet-scan-btn" style="padding: 6px 14px; font-size: 11px; margin-left: auto;">
                            <i class="fas fa-rotate-right"></i> Reanalisar
                        </button>
                    </div>
                </div>

                <!-- Loading State -->
                <div id="nudenet-loading-box" class="hidden" style="font-size: 12px; color: var(--light-gray); display: flex; align-items: center; justify-content: center; gap: 10px; background: #110d29; padding: 14px; border-radius: 6px; border: 1px solid var(--win-border-subtle);">
                    <i class="fas fa-spinner fa-spin" style="font-size: 20px; color: var(--cyan-neon);"></i>
                    <span id="nudenet-loading-text">Analisando imagem com o detector NudeNet...</span>
                </div>

                <!-- Result Box (Formatted Response Container) -->
                <div id="nudenet-result-container" class="hidden"></div>

                <!-- API Info Footer -->
                <div class="nudenet-api-info-card" style="background: #110d29; border: 1px solid rgba(4, 169, 240, 0.25); border-radius: 6px; padding: 10px 14px; display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 4px; flex-wrap: wrap;">
                    <div style="display: flex; align-items: center; gap: 10px; font-size: 11px; color: var(--light-gray);">
                        <i class="fas fa-code" style="font-size: 16px; color: var(--cyan-neon);"></i>
                        <div>
                            <span style="color: #ffffff; font-weight: 600;">Use em seus projetos:</span> Você também pode enviar imagens diretamente para a API pública via <code style="background: #090714; color: var(--cyan-neon); padding: 2px 6px; border-radius: 3px; font-size: 10px; font-family: var(--font-mono);">POST /api/nsfw-detect</code>.
                        </div>
                    </div>
                    <a href="/docs" target="_blank" class="os-btn" style="font-size: 10px; padding: 4px 10px; text-decoration: none; white-space: nowrap;">
                        <i class="fas fa-book-open"></i> Ver Documentação
                    </a>
                </div>
            </div>
        `;

        // DOM Element References
        const dropzone = body.querySelector('#nudenet-dropzone');
        const fileInput = body.querySelector('#nudenet-file-input');
        const previewContainer = body.querySelector('#nudenet-preview-container');
        const previewImg = body.querySelector('#nudenet-preview-img');
        const boxesOverlay = body.querySelector('#nudenet-boxes-overlay');
        const fileInfo = body.querySelector('#nudenet-file-info');
        const changeBtn = body.querySelector('#nudenet-change-btn');
        const clearBtn = body.querySelector('#nudenet-clear-btn');
        const scanBtn = body.querySelector('#nudenet-scan-btn');
        const loadingBox = body.querySelector('#nudenet-loading-box');
        const loadingText = body.querySelector('#nudenet-loading-text');
        const resultContainer = body.querySelector('#nudenet-result-container');
        const overlayToggles = body.querySelector('#nudenet-overlay-toggles');
        const toggleBoxes = body.querySelector('#nudenet-toggle-boxes');
        const toggleOnlyNsfw = body.querySelector('#nudenet-toggle-only-nsfw');

        let currentFile = null;
        let currentDetections = [];
        let naturalWidth = 0;
        let naturalHeight = 0;

        // Helper: Check if label is NSFW
        const isNsfwLabel = (label) => {
            if (!label || typeof label !== 'string') return false;
            const explicitLabels = [
                'FEMALE_BREAST_EXPOSED',
                'FEMALE_GENITALIA_EXPOSED',
                'MALE_GENITALIA_EXPOSED',
                'ANUS_EXPOSED',
                'BUTTOCKS_EXPOSED'
            ];
            if (explicitLabels.includes(label)) return true;
            if (label.includes('EXPOSED') && !['FEET_EXPOSED', 'ARMPITS_EXPOSED', 'BELLY_EXPOSED'].includes(label)) {
                return true;
            }
            return label.includes('GENITALIA') || label.includes('ANUS');
        };

        // Helper: Format file size
        const formatSize = (bytes) => {
            if (!bytes) return '0 B';
            if (bytes < 1024) return `${bytes} B`;
            if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
            return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
        };

        // Render translucent bounding boxes over image
        const renderBoxes = () => {
            boxesOverlay.innerHTML = '';
            if (!toggleBoxes.checked || !currentDetections || currentDetections.length === 0) {
                return;
            }
            if (!naturalWidth || !naturalHeight) return;

            const onlyNsfw = toggleOnlyNsfw.checked;

            currentDetections.forEach((det, idx) => {
                const isNsfw = isNsfwLabel(det.label);
                if (onlyNsfw && !isNsfw) return;

                const box = det.box;
                if (!box) return;

                let x, y, w, h;
                if (typeof box === 'object' && !Array.isArray(box)) {
                    x = box.x ?? box.left ?? box.x_min ?? 0;
                    y = box.y ?? box.top ?? box.y_min ?? 0;
                    w = box.width ?? (box.x_max !== undefined ? box.x_max - x : 0);
                    h = box.height ?? (box.y_max !== undefined ? box.y_max - y : 0);
                } else if (Array.isArray(box) && box.length >= 4) {
                    x = box[0];
                    y = box[1];
                    w = box[2];
                    h = box[3];
                }

                if (!w || !h || w <= 0 || h <= 0) return;

                // Scale coordinates as percentages of original image dimensions
                const leftPct = (x / naturalWidth) * 100;
                const topPct = (y / naturalHeight) * 100;
                const widthPct = (w / naturalWidth) * 100;
                const heightPct = (h / naturalHeight) * 100;

                const boxEl = document.createElement('div');
                boxEl.className = `nudenet-box ${isNsfw ? 'nsfw' : 'neutral'}`;
                boxEl.dataset.idx = idx;
                boxEl.style.left = `${leftPct}%`;
                boxEl.style.top = `${topPct}%`;
                boxEl.style.width = `${widthPct}%`;
                boxEl.style.height = `${heightPct}%`;

                const pct = det.confidence ? Math.round(det.confidence * 100) : null;
                const labelText = `${isNsfw ? '🔞 ' : ''}${det.label}${pct !== null ? ` (${pct}%)` : ''}`;

                const labelEl = document.createElement('div');
                labelEl.className = 'nudenet-box-label';
                labelEl.textContent = labelText;
                boxEl.appendChild(labelEl);

                boxesOverlay.appendChild(boxEl);
            });
        };

        // Scan Action Trigger
        const executeScan = async () => {
            if (!currentFile) return;

            scanBtn.disabled = true;
            loadingBox.classList.remove('hidden');
            loadingText.textContent = 'Enviando imagem para análise NudeNet...';
            resultContainer.classList.add('hidden');
            boxesOverlay.innerHTML = '';
            overlayToggles.classList.add('hidden');

            const formData = new FormData();
            formData.append('image', currentFile);

            try {
                loadingText.textContent = 'Processando detecção de conteúdo com NudeNet AI...';
                const res = await Api.post('/api/nsfw-detect', formData);
                loadingBox.classList.add('hidden');
                scanBtn.disabled = false;
                renderResult(res);
            } catch (err) {
                loadingBox.classList.add('hidden');
                scanBtn.disabled = false;
                resultContainer.classList.remove('hidden');
                resultContainer.innerHTML = `
                    <div class="nudenet-result-card warning">
                        <div class="nudenet-result-header">
                            <span class="nudenet-status-title" style="color: #ff3366;">
                                <i class="fas fa-circle-exclamation"></i>
                                <span>❌ Erro na Verificação</span>
                            </span>
                        </div>
                        <p style="font-size: 11px; color: #ff88a0; margin-top: 4px;">
                            ${err.message || 'Falha ao processar a imagem no servidor NudeNet.'}
                        </p>
                    </div>
                `;
            }
        };

        // Display selected image and auto-dispatch analysis immediately
        const handleFileSelect = (file) => {
            if (!file) return;

            if (!file.type || !file.type.startsWith('image/')) {
                alert('Por favor, selecione um arquivo de imagem válido (JPG, PNG, WEBP ou GIF).');
                return;
            }

            if (file.size > 3 * 1024 * 1024) {
                alert('A imagem excede o limite máximo permitido de 3MB.');
                return;
            }

            currentFile = file;
            currentDetections = [];
            boxesOverlay.innerHTML = '';
            resultContainer.classList.add('hidden');
            resultContainer.innerHTML = '';
            overlayToggles.classList.add('hidden');

            const reader = new FileReader();
            reader.onload = (e) => {
                previewImg.src = e.target.result;
                previewImg.onload = () => {
                    naturalWidth = previewImg.naturalWidth;
                    naturalHeight = previewImg.naturalHeight;
                    fileInfo.textContent = `${file.name} • ${formatSize(file.size)} • ${naturalWidth}×${naturalHeight}px`;
                    // Auto-dispara a busca imediatamente ao selecionar o arquivo
                    executeScan();
                };

                dropzone.classList.add('hidden');
                previewContainer.classList.remove('hidden');
            };
            reader.readAsDataURL(file);
        };

        // Reset to initial dropzone state
        const resetView = () => {
            currentFile = null;
            currentDetections = [];
            naturalWidth = 0;
            naturalHeight = 0;
            previewImg.src = '';
            boxesOverlay.innerHTML = '';
            resultContainer.classList.add('hidden');
            resultContainer.innerHTML = '';
            overlayToggles.classList.add('hidden');
            previewContainer.classList.add('hidden');
            dropzone.classList.remove('hidden');
            fileInput.value = '';
        };

        // Format and render analysis result box
        const renderResult = (data) => {
            resultContainer.classList.remove('hidden');

            if (data.skipped) {
                resultContainer.innerHTML = `
                    <div class="nudenet-result-card warning">
                        <div class="nudenet-result-header">
                            <span class="nudenet-status-title" style="color: #ffb300;">
                                <i class="fas fa-triangle-exclamation"></i>
                                <span>⚠️ VERIFICAÇÃO INDISPONÍVEL</span>
                            </span>
                            <span class="nudenet-chip neutral">${data.reason || 'Serviço indisponível'}</span>
                        </div>
                        <p style="font-size: 11px; color: var(--light-gray); margin-top: 4px;">
                            O detector NudeNet não pôde processar a imagem no momento. Verifique se o serviço está online.
                        </p>
                    </div>
                `;
                return;
            }

            const isNSFW = Boolean(data.isNSFW);
            const detections = data.detections || [];
            currentDetections = detections;

            // Calculate overall certainty (confidence)
            const nsfwDetections = detections.filter(d => isNsfwLabel(d.label));
            let certaintyPct = null;
            if (isNSFW) {
                const confList = nsfwDetections.length > 0
                    ? nsfwDetections.map(d => d.confidence || 0)
                    : detections.map(d => d.confidence || 0);
                const maxConf = confList.length > 0 ? Math.max(...confList) : 0.8;
                certaintyPct = Math.round(maxConf * 100);
            }

            // Render translucent boxes on the image
            renderBoxes();
            if (detections.length > 0) {
                overlayToggles.classList.remove('hidden');
            }

            if (isNSFW) {
                // NSFW DETECTED: Bold, Red, +18 Emoji, Motivo, Certeza, Badges
                const chipsHtml = detections.map((det, i) => {
                    const isN = isNsfwLabel(det.label);
                    const pct = det.confidence ? Math.round(det.confidence * 100) : null;
                    return `
                        <span class="nudenet-chip ${isN ? 'nsfw' : 'neutral'}" data-det-idx="${i}" style="cursor: pointer;" title="Destaque na imagem">
                            <i class="${isN ? 'fas fa-triangle-exclamation' : 'fas fa-info-circle'}"></i>
                            <strong>${det.label}</strong>${pct !== null ? ` • Certeza: ${pct}%` : ''}
                        </span>
                    `;
                }).join('');

                resultContainer.innerHTML = `
                    <div class="nudenet-result-card danger">
                        <div class="nudenet-result-header">
                            <span class="nudenet-status-title">
                                <span style="font-size: 18px;">🔞</span>
                                <span>CONTEÚDO ADULTO DETECTADO (NSFW)</span>
                            </span>
                            <div style="display: flex; align-items: center; gap: 8px;">
                                ${certaintyPct !== null ? `
                                    <div class="nudenet-certainty-badge nsfw">
                                        <i class="fas fa-bullseye"></i> Certeza: <strong>${certaintyPct}%</strong>
                                    </div>
                                ` : ''}
                                <span class="nudenet-chip nsfw" style="font-size: 10px;">
                                    <i class="fas fa-ban"></i> BLOQUEADO NOS GRUPOS
                                </span>
                            </div>
                        </div>

                        <div style="font-size: 12px; margin-top: 4px; line-height: 1.5;">
                            <span style="color: #ff3366; font-weight: 700;">⚠️ Motivo:</span>
                            <strong style="color: #ffffff; margin-left: 4px;">${data.reason || 'Conteúdo impróprio detectado'}</strong>
                        </div>

                        ${detections.length > 0 ? `
                            <div style="margin-top: 4px;">
                                <div style="font-size: 10px; color: var(--light-gray); margin-bottom: 4px;">
                                    Classes detectadas com nível de certeza (clique para destacar na imagem):
                                </div>
                                <div class="nudenet-chips-container">
                                    ${chipsHtml}
                                </div>
                            </div>
                        ` : ''}

                        <div style="font-size: 10px; color: #ff88a0; margin-top: 6px; display: flex; align-items: center; gap: 6px; border-top: 1px solid rgba(255, 51, 102, 0.2); padding-top: 6px;">
                            <i class="fas fa-shield-cat"></i>
                            <span>Esta mídia seria automaticamente removida pela moderação da Ravena em grupos com filtro ativado.</span>
                        </div>

                        <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 6px;">
                            <button class="os-btn" id="nudenet-copy-report-btn" style="font-size: 10px; padding: 3px 8px;">
                                <i class="fas fa-copy"></i> Copiar Relatório
                            </button>
                        </div>
                    </div>
                `;
            } else {
                // SAFE (SFW): Bold, Green, Positive Confirmation, 100% Certainty
                const chipsHtml = detections.length > 0 ? detections.map((det, i) => {
                    const pct = det.confidence ? Math.round(det.confidence * 100) : null;
                    return `
                        <span class="nudenet-chip neutral" data-det-idx="${i}" style="cursor: pointer;" title="Destaque na imagem">
                            <i class="fas fa-check-circle"></i>
                            <strong>${det.label}</strong>${pct !== null ? ` • Certeza: ${pct}%` : ''}
                        </span>
                    `;
                }).join('') : '';

                resultContainer.innerHTML = `
                    <div class="nudenet-result-card safe">
                        <div class="nudenet-result-header">
                            <span class="nudenet-status-title">
                                <span style="font-size: 18px;">✅</span>
                                <span>CONTEÚDO SEGURO (LIVRE / SFW)</span>
                            </span>
                            <div style="display: flex; align-items: center; gap: 8px;">
                                <div class="nudenet-certainty-badge safe">
                                    <i class="fas fa-shield-check"></i> Certeza: <strong>100% Livre</strong>
                                </div>
                                <span class="nudenet-chip" style="background: rgba(0, 230, 118, 0.2); border: 1px solid #00e676; color: #00e676; font-size: 10px;">
                                    <i class="fas fa-circle-check"></i> LIBERADO
                                </span>
                            </div>
                        </div>

                        <div style="font-size: 12px; margin-top: 4px;">
                            <strong style="color: #ffffff;">Nenhum conteúdo adulto ou explícito foi detectado na imagem.</strong>
                        </div>

                        <div style="font-size: 11px; color: var(--light-gray); margin-top: 2px;">
                            Status: Imagem livre para circulação em todos os grupos e públicos.
                        </div>

                        ${detections.length > 0 ? `
                            <div style="margin-top: 6px;">
                                <div style="font-size: 10px; color: var(--light-gray); margin-bottom: 4px;">
                                    Classes neutras detectadas:
                                </div>
                                <div class="nudenet-chips-container">
                                    ${chipsHtml}
                                </div>
                            </div>
                        ` : ''}

                        <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 6px;">
                            <button class="os-btn" id="nudenet-copy-report-btn" style="font-size: 10px; padding: 3px 8px;">
                                <i class="fas fa-copy"></i> Copiar Relatório
                            </button>
                        </div>
                    </div>
                `;
            }

            // Attach interactive chip hover to highlight boxes
            resultContainer.querySelectorAll('[data-det-idx]').forEach(chip => {
                const idx = chip.dataset.detIdx;
                chip.addEventListener('mouseenter', () => {
                    const targetBox = boxesOverlay.querySelector(`.nudenet-box[data-idx="${idx}"]`);
                    if (targetBox) {
                        targetBox.style.transform = 'scale(1.04)';
                        targetBox.style.zIndex = '30';
                        targetBox.style.borderColor = '#ffffff';
                    }
                });
                chip.addEventListener('mouseleave', () => {
                    const targetBox = boxesOverlay.querySelector(`.nudenet-box[data-idx="${idx}"]`);
                    if (targetBox) {
                        targetBox.style.transform = '';
                        targetBox.style.zIndex = '';
                        targetBox.style.borderColor = '';
                    }
                });
            });

            // Copy Report button
            const copyReportBtn = resultContainer.querySelector('#nudenet-copy-report-btn');
            if (copyReportBtn) {
                copyReportBtn.addEventListener('click', () => {
                    const reportText = `[Detector NSFW]\nStatus: ${isNSFW ? '🔞 NSFW (Conteúdo Adulto)' : '✅ SEGURO (SFW)'}\nCerteza: ${certaintyPct !== null ? `${certaintyPct}%` : '100% Livre'}\nMotivo: ${data.reason || 'Nenhum'}\nArquivo: ${currentFile ? currentFile.name : 'imagem'}\nData: ${new Date().toLocaleString('pt-BR')}`;
                    navigator.clipboard.writeText(reportText);
                    copyReportBtn.innerHTML = '<i class="fas fa-check"></i> Copiado!';
                    setTimeout(() => {
                        copyReportBtn.innerHTML = '<i class="fas fa-copy"></i> Copiar Relatório';
                    }, 2000);
                });
            }
        };

        // UI Event Listeners
        dropzone.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', () => {
            if (fileInput.files.length > 0) {
                handleFileSelect(fileInput.files[0]);
            }
        });

        // Drag & Drop
        dropzone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropzone.classList.add('dragover');
        });

        dropzone.addEventListener('dragleave', () => {
            dropzone.classList.remove('dragover');
        });

        dropzone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropzone.classList.remove('dragover');
            if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                handleFileSelect(e.dataTransfer.files[0]);
            }
        });

        // Clipboard Paste Support (Ctrl+V)
        const pasteHandler = (e) => {
            if (e.clipboardData && e.clipboardData.files && e.clipboardData.files.length > 0) {
                const file = e.clipboardData.files[0];
                if (file.type.startsWith('image/')) {
                    e.preventDefault();
                    handleFileSelect(file);
                }
            }
        };
        body.addEventListener('paste', pasteHandler);

        // Buttons
        changeBtn.addEventListener('click', () => fileInput.click());
        clearBtn.addEventListener('click', resetView);
        scanBtn.addEventListener('click', executeScan);

        // Overlay Toggles
        toggleBoxes.addEventListener('change', renderBoxes);
        toggleOnlyNsfw.addEventListener('change', renderBoxes);

        // Cleanup on window close
        wb.onclose = () => {
            body.removeEventListener('paste', pasteHandler);
            return false;
        };
    }
});
