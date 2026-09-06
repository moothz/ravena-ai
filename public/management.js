document.addEventListener('DOMContentLoaded', () => {
    const pathParts = window.location.pathname.split('/');
    const token = pathParts[pathParts.length - 1];
    
    // State
    let groupData = null;
    let originalGroupData = null;
    let customCommands = [];
    let groupId = null;
    let tokenData = null;
    let expiresAt = null;
    let isDirty = false;
    let currentStream = null; // { platform, index, data }
    let pickerMode = 'variable'; // 'variable', 'language', 'start-emoji', 'emoji'
    let lastFocusedInput = null;
    let currentCmdMentions = [];
    let currentEditingCmd = null;
    let activeEmojiTarget = 'cmd-emoji'; // 'cmd-emoji' or 'cmd-start-emoji'

    // Constants
    const API_BASE = '/api';

    const AVAILABLE_LANGUAGES = [
        { code: 'English (EN)', desc: 'Inglês' },
        { code: 'Spanish (ES)', desc: 'Espanhol' },
        { code: 'Russian (RU)', desc: 'Russo' },
        { code: 'French (FR)', desc: 'Francês' },
        { code: 'German (DE)', desc: 'Alemão' },
        { code: 'Italian (IT)', desc: 'Italiano' },
        { code: 'Japanese (JA)', desc: 'Japonês' },
        { code: 'Chinese (ZH)', desc: 'Chinês' },
        { code: 'Korean (KO)', desc: 'Coreano' },
        { code: 'Arabic (AR)', desc: 'Árabe' },
        { code: 'Hindi (HI)', desc: 'Hindi' },
        { code: 'Turkish (TR)', desc: 'Turco' },
        { code: 'Dutch (NL)', desc: 'Holandês' },
        { code: 'Polish (PL)', desc: 'Polonês' },
        { code: 'Indonesian (ID)', desc: 'Indonésio' },
        { code: 'Vietnamese (VI)', desc: 'Vietnamita' },
        { code: 'Thai (TH)', desc: 'Tailandês' }
    ];

    const AVAILABLE_VARIABLES = [
        { code: '{day}', desc: 'Dia da semana (ex: Segunda-feira)' },
        { code: '{date}', desc: 'Data atual (ex: 12/01/2026)' },
        { code: '{time}', desc: 'Hora atual (ex: 14:30:00)' },
        { code: '{data-hora}', desc: 'Hora (HH)' },
        { code: '{data-minuto}', desc: 'Minuto (MM)' },
        { code: '{data-segundo}', desc: 'Segundo (SS)' },
        { code: '{data-dia}', desc: 'Dia (DD)' },
        { code: '{data-mes}', desc: 'Mês (MM)' },
        { code: '{data-ano}', desc: 'Ano (YYYY)' },
        { code: '{randomPequeno}', desc: 'Número aleatório 1-10' },
        { code: '{randomMedio}', desc: 'Número aleatório 1-100' },
        { code: '{randomGrande}', desc: 'Número aleatório 1-1000' },
        { code: '{randomMuitoGrande}', desc: 'Número aleatório 1-10000' },
        { code: '{rndDado-6}', desc: 'Dado de 6 lados (exemplo)' },
        { code: '{rndDadoRange-1-100}', desc: 'Número entre 1 e 100 (exemplo)' },
        { code: '{somaRandoms}', desc: 'Soma dos números gerados anteriormente' },
        { code: '{pessoa}', desc: 'Nome de quem enviou a mensagem' },
        { code: '{group}', desc: 'Nome do grupo' },
        { code: '{contador}', desc: 'Vezes que o comando foi usado' },
        { code: '{membroRandom}', desc: 'Nome de um membro aleatório' },
        { code: '{mention}', desc: 'Menciona usuário (autor/mencionado/aleatório)' },
        { code: '{singleMention}', desc: 'Mesma menção repetida' },
        { code: '{mentionOuEu}', desc: 'Menciona usuário ou autor' },
        { code: '{reddit-memes}', desc: 'Post aleatório do r/memes (exemplo)' },
        { code: '{nomeCanal}', desc: 'Stream: Nome do canal' },
        { code: '{titulo}', desc: 'Stream: Título da live' },
        { code: '{jogo}', desc: 'Stream: Jogo/Categoria' },
        { code: '{author}', desc: 'YouTube: Autor do vídeo' },
        { code: '{title}', desc: 'YouTube: Título do vídeo' },
        { code: '{link}', desc: 'YouTube: Link do vídeo' }
    ];

    const COMMON_EMOJIS = [
        '😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃', '😉', '😊', '😇',
        '🥰', '😍', '🤩', '😘', '😗', '☺️', '😚', '😙', '😋', '😛', '😜', '🤪', '😝',
        '🤑', '🤗', '🤭', '🤫', '🤔', '🤐', '🤨', '😐', '😑', '😶', '😶‍🌫️', '😏', '😒',
        '🙄', '😬', '🤥', '😌', '😔', '😪', '🤤', '😴', '😷', '🤒', '🤕', '🤢', '🤮',
        '🤧', '🥵', '🥶', '🥴', '😵', '😵‍💫', '🤯', '🤠', '🥳', '😎', '🤓', '🧐', '😕',
        '😟', '🙁', '☹️', '😮', '😯', '😲', '😳', '🥺', '😦', '😧', '😨', '😰', '😥',
        '😢', '😭', '😱', '😖', '😣', '😞', '😓', '😩', '😫', '🥱', '😤', '😡', '😠',
        '🤬', '😈', '👿', '💀', '☠️', '💩', '🤡', '👹', '👺', '👻', '👽', '👾', '🤖',
        '👋', '🤚', '🖐', '✋', '🖖', '👌', '🤌', '🤏', '✌️', '🤞', '🤟', '🤘', '🤙',
        '👈', '👉', '👆', '🖕', '👇', '☝️', '👍', '👎', '✊', '👊', '🤛', '🤜', '👏',
        '🙌', '👐', '🤲', '🤝', '🙏', '✍️', '💅', '🤳', '💪', '🦾', '🦵', '🦶', '👂',
        '🦻', '👃', '🧠', '🫀', '🫁', '🦷', '🦴', '👀', '👁', '👅', '👄', '🫦', '👶',
        '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '🔥', '✨', '⭐',
        '⏳', '⌛', '⏰', '🚀', '🎯', '🎉', '🎊', '🎁', '🔔', '📢', '💬', '👀', '💯'
    ];

    const DEFAULT_MSG = {
        twitch: "⚠️ ATENÇÃO!⚠️\n\n🌟 *{canal}* está online jogando {jogo}!\nAssista: {link}",
        kick: "⚠️ ATENÇÃO!⚠️\n\n🌟 *{canal}* iniciou stream na Kick!\nAssista: {link}",
        youtube: "🔴 Novo vídeo no canal *{author}*!\nAssista agora: {link}"
    };

    // UI Elements
    const els = {
        loading: document.getElementById('loading-container'),
        error: document.getElementById('error-container'),
        errorMsg: document.getElementById('error-message'),
        dashboard: document.getElementById('dashboard-content'),
        userName: document.getElementById('user-name'),
        groupName: document.getElementById('group-name'),
        expirationTime: document.getElementById('expiration-time'),
        retryBtn: document.getElementById('retry-button'),
        accordions: document.querySelectorAll('.accordion-item'),
        subAccordions: document.querySelectorAll('.sub-accordion'),
        
        // Hero Status
        heroPauseCard: document.getElementById('hero-pause-card'),
        groupPausedToggle: document.getElementById('group-paused-toggle'),
        heroStatusPill: document.getElementById('hero-status-pill'),
        heroStatusDesc: document.getElementById('hero-status-desc'),

        // Modals
        cmdModal: document.getElementById('command-modal'),
        streamModal: document.getElementById('stream-modal'),
        uploadModal: document.getElementById('upload-modal'),
        variableModal: document.getElementById('variable-modal'),
        emojiModal: document.getElementById('emoji-modal'),
        customDialogModal: document.getElementById('custom-dialog-modal'),
        memberModal: document.getElementById('member-modal'),
        webhookModal: document.getElementById('webhook-modal'),
        
        closeModalBtns: document.querySelectorAll('.close-modal, .close-modal-btn, .close-stream-modal, .close-variable-modal, .close-emoji-modal, .close-dialog, .close-member-modal, .close-webhook-modal'),
        closeUploadBtns: document.querySelectorAll('.close-upload'),
        
        // Sticky Footer
        stickySaveBar: document.getElementById('sticky-save-bar'),
        btnGlobalSave: document.getElementById('btn-global-save'),

        // General
        btnViewMembers: document.getElementById('btn-view-members'),

        // Command Form
        cmdTrigger: document.getElementById('cmd-trigger'),
        cmdActive: document.getElementById('cmd-active'),
        cmdInteract: document.getElementById('cmd-interact'),
        cmdReplyQuote: document.getElementById('cmd-reply-quote'),
        cmdSendAll: document.getElementById('cmd-send-all'),
        cmdAdminOnly: document.getElementById('cmd-admin-only'),
        cmdReplyPrivate: document.getElementById('cmd-reply-private'),
        cmdEmoji: document.getElementById('cmd-emoji'),
        btnEmojiPicker: document.getElementById('btn-emoji-picker'),
        cmdStartEmoji: document.getElementById('cmd-start-emoji'),
        btnStartEmojiPicker: document.getElementById('btn-start-emoji-picker'),
        cmdCooldown: document.getElementById('cmd-cooldown'),
        cmdTimeStart: document.getElementById('cmd-time-start'),
        cmdTimeEnd: document.getElementById('cmd-time-end'),
        cmdResponsesList: document.getElementById('cmd-responses-list'),
        btnSaveCmd: document.getElementById('btn-save-cmd'),
        btnDeleteCmd: document.getElementById('btn-delete-cmd'),
        cmdMetadata: document.getElementById('cmd-metadata'),
        modalTitle: document.getElementById('modal-title'),
        btnAddTag: document.getElementById('btn-add-tag'),
        cmdTagsList: document.getElementById('cmd-tags-list'),

        // Command Simulator
        cmdWaBubble: document.getElementById('cmd-wa-bubble'),
        cmdWaMedia: document.getElementById('cmd-wa-media'),
        cmdWaText: document.getElementById('cmd-wa-text'),
        cmdWaTime: document.getElementById('cmd-wa-time'),

        // Member Modal
        memberModalTitle: document.getElementById('member-modal-title'),
        memberSearch: document.getElementById('member-search'),
        memberTableBody: document.getElementById('member-table-body'),

        // Stream Form
        streamModalTitle: document.getElementById('stream-modal-title'),
        streamChannel: document.getElementById('stream-channel'),
        streamMention: document.getElementById('stream-mention'),
        streamChangeTitle: document.getElementById('stream-change-title'),
        streamAI: document.getElementById('stream-ai'),
        streamUseThumbnail: document.getElementById('stream-use-thumbnail'),
        streamTitlesGroup: document.getElementById('stream-titles-group'),
        streamTitleOn: document.getElementById('stream-title-on'),
        streamTitleOff: document.getElementById('stream-title-off'),
        streamOnMediaList: document.getElementById('stream-on-media-list'),
        streamOffMediaList: document.getElementById('stream-off-media-list'),
        btnSaveStream: document.getElementById('btn-save-stream'),
        btnDeleteStream: document.getElementById('btn-delete-stream'),
        streamHint: document.getElementById('stream-hint'),
        streamWaThumbnail: document.getElementById('stream-wa-thumbnail'),
        streamWaText: document.getElementById('stream-wa-text'),

        // Upload Form
        mediaFileInput: document.getElementById('media-file-input'),
        mediaCaption: document.getElementById('media-caption'),
        convertSticker: document.getElementById('convert-sticker'),
        btnConfirmUpload: document.getElementById('btn-confirm-upload'),
        uploadType: document.getElementById('upload-type'), 
        uploadContext: document.getElementById('upload-context'),
        captionGroup: document.getElementById('caption-group'),
        asStickerGroup: document.getElementById('as-sticker-group'),
        uploadStatus: document.getElementById('upload-status'),

        // Dialog
        dialogTitle: document.getElementById('dialog-title'),
        dialogMessage: document.getElementById('dialog-message'),
        dialogInput: document.getElementById('dialog-input'),
        dialogBtnCancel: document.getElementById('dialog-btn-cancel'),
        dialogBtnOk: document.getElementById('dialog-btn-ok'),
        dossiesHistoryList: document.getElementById('dossies-history-list'),

        // Warnings & Webhooks
        warningsTableBody: document.getElementById('warnings-table-body'),
        noWarningsMsg: document.getElementById('no-warnings-msg'),
        btnClearAllWarnings: document.getElementById('btn-clear-all-warnings'),
        webhooksEndpointUrl: document.getElementById('webhooks-endpoint-url'),
        btnCopyWebhookUrl: document.getElementById('btn-copy-webhook-url'),
        webhooksTableBody: document.getElementById('webhooks-table-body'),
        noWebhooksMsg: document.getElementById('no-webhooks-msg'),
        btnAddWebhook: document.getElementById('btn-add-webhook'),
        btnSaveWebhookConfirm: document.getElementById('btn-save-webhook-confirm'),

        // Backups
        btnExportCmdsZip: document.getElementById('btn-export-cmds-zip'),
        fileImportCmdsZip: document.getElementById('file-import-cmds-zip'),
        btnExportConfigJson: document.getElementById('btn-export-config-json'),
        fileImportConfigJson: document.getElementById('file-import-config-json')
    };

    // --- Custom Dialogs ---

    function showCustomAlert(message, title = 'Aviso') {
        return new Promise((resolve) => {
            els.dialogTitle.textContent = title;
            els.dialogMessage.innerHTML = message;
            els.dialogInput.classList.add('hidden');
            els.dialogBtnCancel.classList.add('hidden');
            els.dialogBtnOk.textContent = 'OK';
            
            els.customDialogModal.classList.remove('hidden');
            
            const handleOk = () => {
                els.customDialogModal.classList.add('hidden');
                els.dialogBtnOk.removeEventListener('click', handleOk);
                resolve();
            };
            
            els.dialogBtnOk.onclick = handleOk;
        });
    }

    function showCustomConfirm(message, title = 'Confirmação') {
        return new Promise((resolve) => {
            els.dialogTitle.textContent = title;
            els.dialogMessage.innerHTML = message;
            els.dialogInput.classList.add('hidden');
            els.dialogBtnCancel.classList.remove('hidden');
            els.dialogBtnOk.textContent = 'Sim';
            
            els.customDialogModal.classList.remove('hidden');
            
            const handleOk = () => {
                els.customDialogModal.classList.add('hidden');
                cleanup();
                resolve(true);
            };

            const handleCancel = () => {
                els.customDialogModal.classList.add('hidden');
                cleanup();
                resolve(false);
            };

            function cleanup() {
                els.dialogBtnOk.removeEventListener('click', handleOk);
                els.dialogBtnCancel.removeEventListener('click', handleCancel);
            }

            els.dialogBtnOk.onclick = handleOk;
            els.dialogBtnCancel.onclick = handleCancel;
        });
    }

    function showCustomPrompt(message, defaultValue = '', title = 'Entrada de Texto') {
        return new Promise((resolve) => {
            els.dialogTitle.textContent = title;
            els.dialogMessage.innerHTML = message;
            els.dialogInput.value = defaultValue;
            els.dialogInput.classList.remove('hidden');
            els.dialogBtnCancel.classList.remove('hidden');
            els.dialogBtnOk.textContent = 'Salvar';
            
            els.customDialogModal.classList.remove('hidden');
            els.dialogInput.focus();

            const handleOk = () => {
                const val = els.dialogInput.value;
                els.customDialogModal.classList.add('hidden');
                cleanup();
                resolve(val);
            };

            const handleCancel = () => {
                els.customDialogModal.classList.add('hidden');
                cleanup();
                resolve(null);
            };

            function cleanup() {
                els.dialogBtnOk.removeEventListener('click', handleOk);
                els.dialogBtnCancel.removeEventListener('click', handleCancel);
            }

            els.dialogBtnOk.onclick = handleOk;
            els.dialogBtnCancel.onclick = handleCancel;
        });
    }

    // --- Init & Data Loading ---

    async function init() {
        if (!token) {
            showError('Token de acesso não fornecido na URL.');
            return;
        }

        try {
            const validation = await fetch(`${API_BASE}/validate-token?token=${token}`).then(r => r.json());
            if (!validation.valid) {
                showError('Token inválido ou expirado. Por favor, gere um novo link usando !g-painel.');
                return;
            }

            tokenData = validation;
            groupId = validation.groupId;
            expiresAt = new Date(validation.expiresAt);
            
            els.userName.textContent = validation.requestNumber || 'Admin';
            startTimer();
            await loadData();
            setupEventListeners();
            loadDossierHistory();

            els.loading.classList.add('hidden');
            els.dashboard.classList.remove('hidden');

        } catch (err) {
            showError('Erro de conexão ao validar sessão: ' + err.message);
        }
    }

    async function loadData() {
        try {
            const resGroup = await fetch(`${API_BASE}/group?id=${groupId}&token=${token}`);
            if (!resGroup.ok) throw new Error('Não foi possível carregar dados do grupo.');
            groupData = await resGroup.json();
            originalGroupData = JSON.parse(JSON.stringify(groupData));

            const resCmds = await fetch(`${API_BASE}/custom-commands/${groupId}?token=${token}`);
            if (resCmds.ok) {
                customCommands = await resCmds.json();
            }

            els.groupName.textContent = groupData.name || 'Sem nome';
            populateFields();
            renderCommandsTable();
            renderWarnings();
            renderWebhooks();
            setupDirtyTracking();

        } catch (e) {
            showError('Erro ao carregar dados: ' + e.message);
        }
    }

    function showError(msg) {
        els.loading.classList.add('hidden');
        els.dashboard.classList.add('hidden');
        els.error.classList.remove('hidden');
        els.errorMsg.textContent = msg;
    }

    function startTimer() {
        const update = () => {
            const now = new Date();
            const diff = expiresAt - now;
            if (diff <= 0) {
                els.expirationTime.textContent = 'Expirado';
                clearInterval(interval);
                showCustomAlert('Sua sessão expirou. O painel será recarregado.', 'Sessão Expirada').then(() => {
                    window.location.reload();
                });
                return;
            }
            const mins = Math.floor(diff / 60000);
            const secs = Math.floor((diff % 60000) / 1000);
            els.expirationTime.textContent = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
        };
        update();
        const interval = setInterval(update, 1000);
    }

    // --- Dirty State & Global Save ---

    function setDirty(state) {
        isDirty = state;
        if (state) {
            els.stickySaveBar.classList.remove('hidden');
        } else {
            els.stickySaveBar.classList.add('hidden');
        }
    }

    function calculateChanges(original, current) {
        const changes = {};
        for (let key in current) {
            if (key === 'participants') continue;
            if (typeof current[key] === 'object' && current[key] !== null) {
                if (JSON.stringify(original[key]) !== JSON.stringify(current[key])) {
                    changes[key] = current[key];
                }
            } else {
                if (original[key] !== current[key]) {
                    changes[key] = current[key];
                }
            }
        }
        return changes;
    }

    function formatChanges(changes) {
        const list = [];
        const labels = {
            name: 'Nome do Grupo',
            prefix: 'Prefixo',
            paused: 'Status do Bot (Pausado/Ativo)',
            customAIPrompt: 'Personalidade da IA',
            customIgnoresPrefix: 'Comandos sem Prefixo',
            filters: 'Filtros (Links / NSFW / Palavras)',
            ignoredNumbers: 'Números Ignorados',
            mutedCategories: 'Categorias Silenciadas',
            mutedCommands: 'Comandos Silenciados',
            additionalAdmins: 'Admins Adicionais',
            autoStt: 'Transcrever Áudios',
            notificaGrupoFechado: 'Notificar Grupo Fechado',
            notificaGrupoAberto: 'Notificar Grupo Aberto',
            interact: 'Interações Automáticas',
            greetings: 'Mensagens de Boas-Vindas',
            farewells: 'Mensagens de Despedida',
            autoTranslateTo: 'Traduzir Respostas',
            twitch: 'Streams Twitch',
            kick: 'Streams Kick',
            youtube: 'Canais YouTube',
            nicks: 'Apelidos dos Membros',
            warnings: 'Advertências do Grupo',
            webhooks: 'Webhooks Externos'
        };

        for (let key in changes) {
            list.push(`<li><b>${labels[key] || key}</b></li>`);
        }
        return `<ul>${list.join('')}</ul>`;
    }

    function setupDirtyTracking() {
        const inputs = els.dashboard.querySelectorAll('input:not([id^="new-"]):not(#variable-search):not(#member-search):not([id^="file-"]), textarea, select');
        inputs.forEach(input => {
            input.addEventListener('change', () => setDirty(true));
            if (input.tagName === 'TEXTAREA' || input.type === 'text') {
                input.addEventListener('input', () => setDirty(true));
            }
        });

        window.onbeforeunload = (e) => {
            if (isDirty) {
                e.preventDefault();
                e.returnValue = '';
            }
        };

        els.btnGlobalSave.onclick = saveAllChanges;
        document.querySelectorAll('.btn-save-section').forEach(btn => {
            btn.onclick = saveAllChanges;
        });
    }

    async function saveAllChanges() {
        try {
            updateGroupDataFromForm();
            const changes = calculateChanges(originalGroupData, groupData);
            
            if (Object.keys(changes).length === 0) {
                setDirty(false);
                return await showCustomAlert('Nenhuma alteração detectada para salvar.');
            }

            const confirmed = await showCustomConfirm(
                `Deseja salvar as seguintes alterações?<br>${formatChanges(changes)}`,
                'Confirmar Alterações'
            );

            if (!confirmed) return;

            els.btnGlobalSave.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Salvando...';
            els.btnGlobalSave.disabled = true;

            const res = await fetch(`${API_BASE}/update-group`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    token,
                    groupId,
                    changes: groupData
                })
            });

            if(!res.ok) {
                const err = await res.json();
                throw new Error(err.message || 'Falha ao salvar');
            }

            originalGroupData = JSON.parse(JSON.stringify(groupData));
            setDirty(false);
            await showCustomAlert('Todas as alterações foram salvas com sucesso!', 'Sucesso');
            
        } catch(e) {
            await showCustomAlert('Erro ao salvar: ' + e.message, 'Erro');
        } finally {
            els.btnGlobalSave.innerHTML = '<i class="fas fa-check"></i> Salvar Tudo';
            els.btnGlobalSave.disabled = false;
        }
    }

    function updateGroupDataFromForm() {
        const nameInput = document.getElementById('group-name-input');
        const nameValue = nameInput.value.trim().toLowerCase();
        nameInput.value = nameValue;
        
        if (!/^[a-zA-Z0-9_\-.]{1,30}$/.test(nameValue)) {
            throw new Error('O nome do grupo deve ser alfanumérico, sem espaços, com no máximo 30 caracteres e podendo conter apenas _, - e .');
        }

        const prefixInput = document.getElementById('group-prefix');
        const prefixValue = prefixInput.value;
        if (prefixValue && prefixValue.length > 1) {
            throw new Error('O prefixo deve ter no máximo 1 caractere.');
        }

        groupData.name = nameValue;
        groupData.prefix = prefixValue;
        
        // Paused logic
        const isPaused = !els.groupPausedToggle.checked;
        groupData.paused = isPaused;
        document.getElementById('bot-enabled').checked = !isPaused;

        groupData.customAIPrompt = document.getElementById('bot-personality').value;
        groupData.customIgnoresPrefix = document.getElementById('custom-ignores-prefix').checked;

        if(!groupData.filters) groupData.filters = {};
        groupData.filters.links = document.getElementById('delete-links').checked;
        groupData.filters.nsfw = document.getElementById('delete-nsfw').checked;
        const nsfwSlider = document.getElementById('nsfw-intensity');
        if (nsfwSlider) {
            const intensity = parseInt(nsfwSlider.value, 10);
            groupData.filters.nsfwIntensity = intensity;
            groupData.filters.nsfwThreshold = parseFloat((0.95 - (intensity / 100) * 0.75).toFixed(4));
        }

        groupData.autoStt = document.getElementById('auto-stt').checked;
        groupData.notificaGrupoFechado = document.getElementById('notifica-grupo-fechado').checked;
        groupData.notificaGrupoAberto = document.getElementById('notifica-grupo-aberto').checked;

        if(!groupData.interact) groupData.interact = {};
        groupData.interact.enabled = document.getElementById('auto-interaction').checked;
        groupData.interact.useCmds = document.getElementById('interact-use-cmds').checked;
        groupData.interact.chance = parseInt(document.getElementById('interaction-chance').value);
        groupData.interact.cooldown = parseInt(document.getElementById('interaction-cooldown').value);
        const proporcaoSlider = document.getElementById('interaction-proporcao');
        if (proporcaoSlider) {
            groupData.interact.proporcao = parseInt(proporcaoSlider.value);
        }
        
        const autoTranslate = document.getElementById('auto-translate').checked;
        const translateLang = document.getElementById('translate-lang').value.trim();
        
        if (autoTranslate && translateLang.length < 5) {
            throw new Error('O idioma de tradução deve ter pelo menos 5 caracteres (Ex: "English (EN)").');
        }
        
        groupData.autoTranslateTo = autoTranslate ? translateLang : false;
    }

    function updateHeroStatusVisuals(isPaused) {
        if (isPaused) {
            els.heroPauseCard.classList.add('paused');
            els.heroStatusPill.className = 'status-pill status-pill-paused';
            els.heroStatusPill.textContent = 'Pausado';
            els.heroStatusDesc.textContent = 'O bot está pausado neste grupo e responderá apenas a comandos de reativação por administradores.';
            els.groupPausedToggle.checked = false;
        } else {
            els.heroPauseCard.classList.remove('paused');
            els.heroStatusPill.className = 'status-pill status-pill-active';
            els.heroStatusPill.textContent = 'Ativo';
            els.heroStatusDesc.textContent = 'O bot está funcionando normalmente e respondendo comandos neste grupo.';
            els.groupPausedToggle.checked = true;
        }
    }

    function populateFields() {
        document.getElementById('group-id').value = groupData.id;
        document.getElementById('group-created-at').value = new Date(groupData.createdAt || Date.now()).toLocaleDateString('pt-BR');
        document.getElementById('group-name-input').value = (groupData.name || '').trim();
        document.getElementById('group-prefix').value = groupData.prefix || '';
        
        const isPaused = !!groupData.paused;
        updateHeroStatusVisuals(isPaused);
        document.getElementById('bot-enabled').checked = !isPaused;

        document.getElementById('bot-personality').value = groupData.customAIPrompt || '';
        document.getElementById('personality-count').textContent = (groupData.customAIPrompt || '').length;
        document.getElementById('custom-ignores-prefix').checked = !!groupData.customIgnoresPrefix;

        renderTags('ignored-numbers-list', groupData.ignoredNumbers || [], (list) => { groupData.ignoredNumbers = list; setDirty(true); });
        
        document.getElementById('delete-links').checked = groupData.filters?.links || false;
        const nsfwActive = !!groupData.filters?.nsfw;
        document.getElementById('delete-nsfw').checked = nsfwActive;

        let nsfwIntensity = 20;
        if (groupData.filters?.nsfwIntensity !== undefined && !isNaN(groupData.filters.nsfwIntensity)) {
            nsfwIntensity = parseInt(groupData.filters.nsfwIntensity, 10);
        } else if (groupData.filters?.nsfwThreshold !== undefined && !isNaN(groupData.filters.nsfwThreshold)) {
            nsfwIntensity = Math.round(((0.95 - groupData.filters.nsfwThreshold) / 0.75) * 100);
            nsfwIntensity = Math.max(0, Math.min(100, nsfwIntensity));
        }

        const nsfwSliderEl = document.getElementById('nsfw-intensity');
        if (nsfwSliderEl) {
            nsfwSliderEl.value = nsfwIntensity;
            document.getElementById('nsfw-intensity-val').textContent = nsfwIntensity;
        }
        toggleNsfwSettings(nsfwActive);

        renderTags('forbidden-words-list', groupData.filters?.words || [], (list) => { 
            if(!groupData.filters) groupData.filters = {};
            groupData.filters.words = list; setDirty(true);
        });

        renderTags('forbidden-users-list', groupData.filters?.people || [], (list) => { 
            if(!groupData.filters) groupData.filters = {};
            groupData.filters.people = list; setDirty(true);
        });

        renderTags('muted-commands-list', groupData.mutedCommands || [], (list) => { groupData.mutedCommands = list; setDirty(true); });
        renderTags('additional-admins-list', groupData.additionalAdmins || [], (list) => { groupData.additionalAdmins = list; setDirty(true); });

        const categories = ["geral","grupo","utilidades","saude","midia","ia","downloaders","jogos","cultura","áudio","tts","busca","listas","arquivos","general","diversao","info","imagens","zoeira"];
        const mutedList = document.getElementById('muted-categories-list');
        mutedList.innerHTML = '';
        const muted = groupData.mutedCategories || [];
        categories.forEach(cat => {
            const div = document.createElement('div');
            div.className = 'checkbox-group toggle-row-compact';
            div.innerHTML = `
                <span class="toggle-label">${cat}</span>
                <label class="switch-toggle">
                    <input type="checkbox" id="mute-cat-${cat}" ${muted.includes(cat) ? 'checked' : ''}>
                    <span class="slider-round"></span>
                </label>
            `;
            div.querySelector('input').addEventListener('change', (e) => {
                if(e.target.checked) {
                    if(!groupData.mutedCategories) groupData.mutedCategories = [];
                    if(!groupData.mutedCategories.includes(cat)) groupData.mutedCategories.push(cat);
                } else {
                    if(groupData.mutedCategories) groupData.mutedCategories = groupData.mutedCategories.filter(c => c !== cat);
                }
                setDirty(true);
            });
            mutedList.appendChild(div);
        });

        document.getElementById('auto-stt').checked = !!groupData.autoStt;
        document.getElementById('notifica-grupo-fechado').checked = !!groupData.notificaGrupoFechado;
        document.getElementById('notifica-grupo-aberto').checked = !!groupData.notificaGrupoAberto;
        
        const interact = groupData.interact || {};
        document.getElementById('auto-interaction').checked = !!interact.enabled;
        document.getElementById('interact-use-cmds').checked = interact.useCmds !== false;
        
        const chanceVal = interact.chance || 1;
        document.getElementById('interaction-chance').value = chanceVal; 
        document.getElementById('chance-val').textContent = (chanceVal / 100).toFixed(2);
        document.getElementById('interaction-chance').max = 1000;

        document.getElementById('interaction-cooldown').value = interact.cooldown || 5;
        document.getElementById('cooldown-val').textContent = interact.cooldown || 5;

        const proporcaoVal = interact.proporcao !== undefined ? interact.proporcao : 50;
        const proporcaoSlider = document.getElementById('interaction-proporcao');
        if (proporcaoSlider) {
            proporcaoSlider.value = proporcaoVal;
            document.getElementById('proporcao-val').textContent = proporcaoVal;
            const iaChance = proporcaoVal;
            const cmdChance = 100 - iaChance;
            const descEl = document.getElementById('proporcao-desc');
            if (descEl) {
                if (iaChance === 100) {
                    descEl.innerHTML = "Usando apenas <b>IA</b> para interagir";
                } else if (iaChance === 0) {
                    descEl.innerHTML = "Usando apenas <b>comandos</b> para interagir";
                } else {
                    descEl.textContent = `${cmdChance}% de chance de usar comandos, ${iaChance}% de chance de usar IA`;
                }
            }
        }

        toggleInteractionSettings(!!interact.enabled);

        renderMediaList('greetings-list', groupData.greetings || {}, 'greetings');
        renderMediaList('farewells-list', groupData.farewells || {}, 'farewells');

        document.getElementById('auto-translate').checked = !!groupData.autoTranslateTo;
        document.getElementById('translate-lang').value = typeof groupData.autoTranslateTo === 'string' ? groupData.autoTranslateTo : '';
        toggleTranslateSettings(!!groupData.autoTranslateTo);

        renderStreamSection('twitch');
        renderStreamSection('kick');
        renderStreamSection('youtube');
    }

    function renderTags(containerId, dataList, updateCallback) {
        const container = document.getElementById(containerId);
        container.innerHTML = '';
        dataList.forEach(item => {
            const tag = document.createElement('span');
            tag.className = 'tag';
            tag.innerHTML = `${item} <span class="remove">&times;</span>`;
            tag.querySelector('.remove').onclick = () => {
                const newList = dataList.filter(i => i !== item);
                updateCallback(newList);
                renderTags(containerId, newList, updateCallback);
            };
            container.appendChild(tag);
        });
    }

    // --- WhatsApp Markdown & Variable Formatter ---

    function formatWhatsAppMarkdown(text) {
        if (!text) return '';
        let escaped = text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');

        // Bold: *text*
        escaped = escaped.replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>');
        // Italic: _text_
        escaped = escaped.replace(/_([^_\n]+)_/g, '<em>$1</em>');
        // Strike: ~text~
        escaped = escaped.replace(/~([^~\n]+)~/g, '<del>$1</del>');
        // Code: `code`
        escaped = escaped.replace(/`([^`\n]+)`/g, '<code class="wa-code">$1</code>');
        // Variables: {var}
        escaped = escaped.replace(/\{([a-zA-Z0-9_\-]+)\}/g, '<span class="wa-var-pill">{$1}</span>');
        // Newlines
        escaped = escaped.replace(/\n/g, '<br>');

        return escaped;
    }

    // --- Inline Media List (Boas-Vindas & Despedidas) ---

    function renderMediaList(containerId, mediaObj, type) {
        const container = document.getElementById(containerId);
        container.innerHTML = '';

        const entries = Object.entries(mediaObj).filter(([k, v]) => !!v);

        if (entries.length === 0) {
            container.innerHTML = '<div class="text-muted text-sm p-2 text-center">Nenhuma mídia ou mensagem cadastrada.</div>';
            return;
        }

        entries.forEach(([key, value]) => {
            const div = document.createElement('div');
            div.className = 'inline-media-card';
            
            if (key === 'text') {
                const textVal = typeof value === 'string' ? value : String(value || '');
                div.innerHTML = `
                    <div class="inline-media-info">
                        <span class="inline-media-badge"><i class="fas fa-font"></i> Mensagem de Texto</span>
                        <div class="inline-media-caption">${formatWhatsAppMarkdown(textVal)}</div>
                    </div>
                    <div class="inline-media-actions">
                        <button type="button" class="btn btn-xs btn-outline btn-edit-text" title="Editar Mensagem"><i class="fas fa-pen"></i></button>
                        <button type="button" class="btn btn-xs btn-danger btn-del-item" title="Remover"><i class="fas fa-trash"></i></button>
                    </div>
                `;

                div.querySelector('.btn-edit-text').onclick = async () => {
                    const newText = await showCustomPrompt('Editar mensagem de texto:', textVal);
                    if (newText !== null && newText.trim()) {
                        mediaObj.text = newText.trim();
                        setDirty(true);
                        renderMediaList(containerId, mediaObj, type);
                    }
                };

            } else {
                const mediaLink = `/media-direct/${value.file}?token=${token}`;
                const captionVal = typeof value.caption === 'string' ? value.caption : '';
                
                let thumbHtml = '';
                if (key === 'image' || key === 'sticker') {
                    thumbHtml = `<img src="${mediaLink}" class="inline-media-thumb" alt="${key}" onerror="this.src='/android-chrome-192x192.png'">`;
                } else if (key === 'video' || key === 'gif') {
                    thumbHtml = `<div class="inline-media-thumb-video"><i class="fas fa-play-circle"></i></div>`;
                } else if (key === 'audio') {
                    thumbHtml = `<div class="inline-media-thumb-video" style="color: #25d366;"><i class="fas fa-microphone"></i></div>`;
                }

                div.innerHTML = `
                    ${thumbHtml}
                    <div class="inline-media-info">
                        <span class="inline-media-badge">${getIcon(key)} ${key}</span>
                        <div class="inline-media-caption">${captionVal ? formatWhatsAppMarkdown(captionVal) : '<span class="text-muted">(Sem legenda)</span>'}</div>
                    </div>
                    <div class="inline-media-actions">
                        ${key === 'image' || key === 'video' || key === 'gif' ? `<button type="button" class="btn btn-xs btn-outline btn-edit-caption" title="Editar Legenda"><i class="fas fa-comment"></i></button>` : ''}
                        <button type="button" class="btn btn-xs btn-danger btn-del-item" title="Remover"><i class="fas fa-trash"></i></button>
                    </div>
                `;

                const editCaptionBtn = div.querySelector('.btn-edit-caption');
                if (editCaptionBtn) {
                    editCaptionBtn.onclick = async () => {
                        const newCap = await showCustomPrompt('Editar legenda da mídia:', captionVal);
                        if (newCap !== null) {
                            value.caption = newCap.trim();
                            setDirty(true);
                            renderMediaList(containerId, mediaObj, type);
                        }
                    };
                }
            }

            div.querySelector('.btn-del-item').onclick = async () => {
                if (await showCustomConfirm(`Remover este item de ${type === 'greetings' ? 'boas-vindas' : 'despedida'}?`)) {
                    delete mediaObj[key];
                    setDirty(true);
                    renderMediaList(containerId, mediaObj, type);
                }
            };

            container.appendChild(div);
        });
    }

    function getIcon(type) {
        const icons = {
            text: '📝',
            image: '🖼️',
            video: '🎥',
            audio: '🎵',
            sticker: '🏷️',
            gif: '🎞️'
        };
        return icons[type] || '📎';
    }

    // --- Accordions & Settings Toggles ---

    els.accordions.forEach(item => {
        const header = item.querySelector('.accordion-header');
        header.addEventListener('click', () => {
            const isActive = item.classList.contains('active');
            item.classList.toggle('active', !isActive);
        });
    });

    els.subAccordions.forEach(sub => {
        const subHeader = sub.querySelector('.sub-accordion-header');
        subHeader.addEventListener('click', () => {
            sub.classList.toggle('active');
        });
    });

    function toggleInteractionSettings(show) {
        document.getElementById('interaction-settings').classList.toggle('hidden', !show);
    }

    function toggleTranslateSettings(show) {
        document.getElementById('translate-settings').classList.toggle('hidden', !show);
    }

    function toggleNsfwSettings(show) {
        const panel = document.getElementById('nsfw-settings');
        if (panel) panel.classList.toggle('hidden', !show);
    }

    function setupListAdder(btnId, inputId, dataPath) {
        const btn = document.getElementById(btnId);
        const input = document.getElementById(inputId);
        if (!btn || !input) return;

        btn.addEventListener('click', () => {
            let val = input.value.trim();
            if (!val) return;
            input.value = '';

            const parts = dataPath.split('.');
            let target = groupData;
            for (let i = 0; i < parts.length - 1; i++) {
                if (!target[parts[i]]) target[parts[i]] = {};
                target = target[parts[i]];
            }
            const lastKey = parts[parts.length - 1];

            if (!target[lastKey]) target[lastKey] = [];
            
            if (btnId === 'add-ignored-number' || btnId === 'add-forbidden-user' || btnId === 'add-additional-admin') {
                val = val.replace(/\D/g, '');
                if (!val) return;
            }

            if (!target[lastKey].includes(val)) {
                target[lastKey].push(val);
                setDirty(true);
                const listId = inputId.replace('new-', '') + 's-list';
                renderTags(listId, target[lastKey], (newList) => {
                    target[lastKey] = newList;
                    setDirty(true);
                });
            }
        });

        input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                btn.click();
            }
        });
    }

    // --- Streams (Twitch, Kick, YouTube) ---

    function renderStreamSection(platform) {
        const tbody = document.querySelector(`#${platform}-table tbody`);
        const noMsg = document.querySelector(`#no-${platform}-msg`);
        tbody.innerHTML = '';

        const streams = groupData[platform] || [];
        if (streams.length === 0) {
            noMsg.classList.remove('hidden');
        } else {
            noMsg.classList.add('hidden');
            streams.forEach((stream, index) => {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td>
                        <strong>${stream.channel}</strong>
                        ${stream.useThumbnail ? ' <span class="badge-soon" style="color: #25d366; border-color: rgba(37,211,102,0.4); background: rgba(37,211,102,0.1);">Thumb</span>' : ''}
                    </td>
                    <td>
                        <button class="btn btn-xs btn-primary btn-edit-stream" data-platform="${platform}" data-index="${index}"><i class="fas fa-edit"></i> Editar</button>
                    </td>
                `;
                tbody.appendChild(tr);
            });
            
            document.querySelectorAll(`.btn-edit-stream[data-platform="${platform}"]`).forEach(btn => {
                btn.addEventListener('click', () => openStreamModal(platform, btn.dataset.index));
            });
        }
    }

    document.querySelectorAll('.btn-add-stream').forEach(btn => {
        btn.addEventListener('click', () => openStreamModal(btn.dataset.platform, null));
    });

    function openStreamModal(platform, index) {
        currentStream = { platform, index, data: null };
        const isEdit = index !== null;
        
        els.streamModalTitle.textContent = isEdit ? `Editar ${platform.toUpperCase()}` : `Adicionar Canal ${platform.toUpperCase()}`;
        els.btnDeleteStream.classList.toggle('hidden', !isEdit);
        els.streamHint.textContent = platform === 'youtube' ? 'ID do canal ou Handle (@nome).' : 'Apenas o nome de usuário, sem URL.';
        
        if (isEdit) {
            const data = groupData[platform][index];
            currentStream.data = JSON.parse(JSON.stringify(data));
        } else {
            currentStream.data = {
                channel: '',
                mentionAllMembers: false,
                changeTitleOnEvent: false,
                onlineTitle: '',
                offlineTitle: '',
                useThumbnail: true,
                useAI: false,
                onConfig: { media: [{ type: 'text', content: DEFAULT_MSG[platform] }] },
                offConfig: { media: [] }
            };
        }

        const d = currentStream.data;
        els.streamChannel.value = d.channel;
        els.streamMention.checked = !!d.mentionAllMembers;
        els.streamChangeTitle.checked = !!d.changeTitleOnEvent;
        els.streamAI.checked = !!d.useAI;
        els.streamUseThumbnail.checked = d.useThumbnail !== false;
        els.streamTitleOn.value = d.onlineTitle || '';
        els.streamTitleOff.value = d.offlineTitle || '';
        
        toggleStreamTitles(d.changeTitleOnEvent);
        renderStreamMediaList('stream-on-media-list', d.onConfig?.media || []);
        renderStreamMediaList('stream-off-media-list', d.offConfig?.media || []);
        updateStreamPreview();

        els.streamModal.classList.remove('hidden');
    }

    function toggleStreamTitles(show) {
        els.streamTitlesGroup.classList.toggle('hidden', !show);
    }

    if(els.streamChangeTitle) {
        els.streamChangeTitle.addEventListener('change', (e) => toggleStreamTitles(e.target.checked));
    }

    if(els.streamUseThumbnail) {
        els.streamUseThumbnail.addEventListener('change', () => updateStreamPreview());
    }

    if(els.streamChannel) {
        els.streamChannel.addEventListener('input', () => updateStreamPreview());
    }

    function updateStreamPreview() {
        const channelName = els.streamChannel.value.trim() || 'streamer';
        const showThumb = els.streamUseThumbnail.checked;
        
        els.streamWaThumbnail.classList.toggle('hidden', !showThumb);
        
        const firstMedia = currentStream?.data?.onConfig?.media?.[0];
        let textContent = firstMedia?.type === 'text' ? firstMedia.content : DEFAULT_MSG[currentStream?.platform || 'twitch'];
        textContent = textContent.replace(/\{canal\}/gi, channelName).replace(/\{link\}/gi, `https://${currentStream?.platform || 'twitch'}.tv/${channelName}`);
        
        els.streamWaText.innerHTML = formatWhatsAppMarkdown(textContent);
    }

    function renderStreamMediaList(containerId, mediaArray) {
        const container = document.getElementById(containerId);
        container.innerHTML = '';
        
        mediaArray.forEach((media, index) => {
            const div = document.createElement('div');
            div.className = 'inline-media-card';
            
            if (media.type === 'text') {
                const textVal = typeof media.content === 'string' ? media.content : String(media.content || '');
                div.innerHTML = `
                    <div class="inline-media-info">
                        <span class="inline-media-badge"><i class="fas fa-font"></i> Mensagem</span>
                        <div class="inline-media-caption">${formatWhatsAppMarkdown(textVal)}</div>
                    </div>
                    <div class="inline-media-actions">
                        <button type="button" class="btn btn-xs btn-outline btn-edit-stream-txt" title="Editar"><i class="fas fa-pen"></i></button>
                        <button type="button" class="btn btn-xs btn-danger btn-remove-media-item" title="Remover"><i class="fas fa-trash"></i></button>
                    </div>
                `;
                div.querySelector('.btn-edit-stream-txt').onclick = async () => {
                    const newText = await showCustomPrompt("Digite a mensagem da stream:", textVal);
                    if (newText !== null && newText.trim()) {
                        media.content = newText.trim();
                        renderStreamMediaList(containerId, mediaArray);
                        updateStreamPreview();
                    }
                };
            } else {
                const mediaLink = `/media-direct/${media.content}?token=${token}`;
                const captionVal = typeof media.caption === 'string' ? media.caption : '';
                
                div.innerHTML = `
                    <img src="${mediaLink}" class="inline-media-thumb" alt="${media.type}" onerror="this.src='/android-chrome-192x192.png'">
                    <div class="inline-media-info">
                        <span class="inline-media-badge">${getIcon(media.type)} ${media.type}</span>
                        <div class="inline-media-caption">${captionVal ? formatWhatsAppMarkdown(captionVal) : '<span class="text-muted">(Sem legenda)</span>'}</div>
                    </div>
                    <div class="inline-media-actions">
                        <button type="button" class="btn btn-xs btn-danger btn-remove-media-item" title="Remover"><i class="fas fa-trash"></i></button>
                    </div>
                `;
            }

            div.querySelector('.btn-remove-media-item').onclick = async () => {
                if(await showCustomConfirm('Remover este item?')) {
                    mediaArray.splice(index, 1);
                    renderStreamMediaList(containerId, mediaArray);
                    updateStreamPreview();
                }
            };

            container.appendChild(div);
        });
    }

    window.addStreamMedia = async function(context, type) {
        const targetArray = context === 'on' ? currentStream.data.onConfig.media : currentStream.data.offConfig.media;
        
        if (type === 'text') {
            const text = await showCustomPrompt("Digite o texto da notificação:");
            if (text) {
                const existingIdx = targetArray.findIndex(m => m.type === 'text');
                if(existingIdx !== -1) targetArray.splice(existingIdx, 1);
                
                targetArray.push({ type: 'text', content: text });
                renderStreamMediaList(`stream-${context}-media-list`, targetArray);
                updateStreamPreview();
            }
        } else {
            els.uploadType.value = type;
            els.uploadContext.value = `stream-${context}`;
            els.mediaFileInput.value = '';
            els.mediaCaption.value = '';

            els.captionGroup.classList.remove('hidden');
            els.asStickerGroup.classList.add('hidden');
            
            const existingVarBtn = els.captionGroup.querySelector('.btn-insert-var');
            if(existingVarBtn) existingVarBtn.remove();
            
            const varBtn = document.createElement('button');
            varBtn.type = 'button';
            varBtn.className = 'btn btn-xs btn-outline mt-1';
            varBtn.innerHTML = '<i class="fas fa-plus-circle"></i> Inserir Variável';
            varBtn.onclick = () => openVariableModal(els.mediaCaption);
            els.captionGroup.appendChild(varBtn);

            setupMediaAccept(type);
            els.uploadModal.classList.remove('hidden');
        }
    };

    window.addDirectMedia = async function(context, type) {
        if (type === 'text') {
            const currentText = (groupData[context] && groupData[context].text) ? groupData[context].text : '';
            const text = await showCustomPrompt("Digite a mensagem:", currentText);
            if(text) {
                if(!groupData[context]) groupData[context] = {};
                groupData[context].text = text;
                renderMediaList(`${context}-list`, groupData[context], context);
                setDirty(true);
            }
        } else {
            els.uploadType.value = type;
            els.uploadContext.value = context;
            els.mediaFileInput.value = '';
            els.mediaCaption.value = '';
            
            els.captionGroup.classList.remove('hidden');
            els.asStickerGroup.classList.add('hidden');
            if(type === 'image' || type === 'video' || type === 'gif') els.asStickerGroup.classList.remove('hidden');
            
            const existingVarBtn = els.captionGroup.querySelector('.btn-insert-var');
            if(existingVarBtn) existingVarBtn.remove();
            
            if(type === 'image' || type === 'video' || type === 'gif') {
                const varBtn = document.createElement('button');
                varBtn.type = 'button';
                varBtn.className = 'btn btn-xs btn-outline mt-1';
                varBtn.innerHTML = '<i class="fas fa-plus-circle"></i> Inserir Variável';
                varBtn.onclick = () => openVariableModal(els.mediaCaption);
                els.captionGroup.appendChild(varBtn);
            }

            setupMediaAccept(type);
            els.uploadModal.classList.remove('hidden');
        }
    };

    function setupMediaAccept(type) {
        if(type === 'image') els.mediaFileInput.setAttribute('accept', 'image/*');
        else if(type === 'video') els.mediaFileInput.setAttribute('accept', 'video/*');
        else if(type === 'audio') els.mediaFileInput.setAttribute('accept', 'audio/*');
        else if(type === 'sticker') els.mediaFileInput.setAttribute('accept', 'image/*,video/*,image/webp');
        else if(type === 'gif') els.mediaFileInput.setAttribute('accept', 'image/gif,image/webp,video/mp4,video/*');
        else els.mediaFileInput.removeAttribute('accept');
    }

    els.btnSaveStream.onclick = async () => {
        const channel = els.streamChannel.value.trim();
        if (!channel) return await showCustomAlert('Nome do canal obrigatório.');
        
        const platform = currentStream.platform;
        if (platform === 'twitch' || platform === 'kick') {
            if (channel.includes('/') || channel.includes('http')) return await showCustomAlert('Digite apenas o usuário, não a URL.');
            if (!/^[a-zA-Z0-9_]{2,50}$/.test(channel)) return await showCustomAlert('Nome de usuário inválido.');
        }

        const d = currentStream.data;
        d.channel = channel;
        d.mentionAllMembers = els.streamMention.checked;
        d.changeTitleOnEvent = els.streamChangeTitle.checked;
        d.useAI = els.streamAI.checked;
        d.useThumbnail = els.streamUseThumbnail.checked;
        d.onlineTitle = els.streamTitleOn.value;
        d.offlineTitle = els.streamTitleOff.value;

        if (!groupData[platform]) groupData[platform] = [];
        
        if (currentStream.index !== null) {
            groupData[platform][currentStream.index] = d;
        } else {
            groupData[platform].push(d);
        }

        setDirty(true);
        renderStreamSection(platform);
        els.streamModal.classList.add('hidden');
    };

    els.btnDeleteStream.onclick = async () => {
        if(!await showCustomConfirm('Tem certeza que deseja remover este canal?')) return;
        const { platform, index } = currentStream;
        groupData[platform].splice(index, 1);
        setDirty(true);
        renderStreamSection(platform);
        els.streamModal.classList.add('hidden');
    };

    // --- Custom Commands & Live WhatsApp Simulator ---

    function renderCommandsTable() {
        const tbody = document.querySelector('#commands-table tbody');
        tbody.innerHTML = '';
        const activeCmds = customCommands.filter(c => !c.deleted);
        
        if (activeCmds.length === 0) {
            document.getElementById('no-commands-msg').classList.remove('hidden');
            return;
        } else {
            document.getElementById('no-commands-msg').classList.add('hidden');
        }

        activeCmds.forEach(cmd => {
            const tr = document.createElement('tr');
            
            const responsesCount = cmd.responses ? cmd.responses.length : 0;
            const firstResp = responsesCount > 0 ? cmd.responses[0] : '';
            let respPreview = firstResp;
            if (firstResp.startsWith('{')) {
                const end = firstResp.indexOf('}');
                const meta = firstResp.substring(1, end).split('-');
                let type = meta[0];
                if (type === 'stickerGif') type = 'sticker';
                respPreview = `${getIcon(type)} Mídia (${type})`;
            } else {
                if (respPreview.length > 30) respPreview = respPreview.substring(0, 30) + '...';
            }
            if (responsesCount > 1) respPreview += ` (+${responsesCount-1})`;

            tr.innerHTML = `
                <td>
                    <button class="btn btn-xs btn-primary btn-edit-cmd"><i class="fas fa-edit"></i></button>
                </td>
                <td>
                    <strong>${cmd.startsWith}</strong>
                    ${!cmd.active ? ' <span class="text-danger text-sm">(Desativado)</span>' : ''}
                    ${cmd.replyInPvivate ? ' <span class="badge-soon" style="color:#04a9f0; border-color:#04a9f0;">PV</span>' : ''}
                </td>
                <td>${respPreview}</td>
            `;
            
            tr.querySelector('.btn-edit-cmd').onclick = () => openCommandModal(cmd);
            tbody.appendChild(tr);
        });
    }

    document.getElementById('btn-add-command').onclick = () => openCommandModal(null);

    function openCommandModal(cmd) {
        currentEditingCmd = cmd;
        els.modalTitle.textContent = cmd ? 'Editar Comando' : 'Novo Comando';
        els.btnDeleteCmd.classList.toggle('hidden', !cmd);
        els.cmdResponsesList.innerHTML = '';

        if (cmd) {
            els.cmdTrigger.value = cmd.startsWith;
            els.cmdActive.checked = cmd.active !== false;
            els.cmdInteract.checked = !cmd.ignoreInteract;
            els.cmdReplyQuote.checked = cmd.reply !== false; 
            els.cmdSendAll.checked = !!cmd.sendAllResponses;
            els.cmdAdminOnly.checked = !!cmd.adminOnly;
            els.cmdReplyPrivate.checked = !!cmd.replyInPvivate;
            els.cmdEmoji.value = cmd.react || '';
            els.cmdStartEmoji.value = cmd.reactions?.before || '';
            els.cmdCooldown.value = cmd.cooldown || 0;
            currentCmdMentions = cmd.mentions || [];
            
            els.cmdTimeStart.value = cmd.allowedTimes?.start || '';
            els.cmdTimeEnd.value = cmd.allowedTimes?.end || '';

            const allowedDays = cmd.allowedDays || [];
            document.querySelectorAll('.btn-day-pill').forEach(btn => {
                btn.classList.toggle('active', allowedDays.includes(btn.dataset.day));
            });

            if (cmd.responses && cmd.responses.length > 0) {
                cmd.responses.forEach(r => addResponseInput('text', r));
            } else {
                addResponseInput('text', '');
            }
            
            els.cmdMetadata.innerHTML = `Criado por: ${cmd.metadata?.createdBy || '?'} em ${new Date(cmd.metadata?.createdAt || Date.now()).toLocaleString('pt-BR')}<br>Usado ${cmd.count || 0} vezes.`;
        } else {
            els.cmdTrigger.value = '';
            els.cmdActive.checked = true;
            els.cmdInteract.checked = true;
            els.cmdReplyQuote.checked = true;
            els.cmdSendAll.checked = false;
            els.cmdAdminOnly.checked = false;
            els.cmdReplyPrivate.checked = false;
            els.cmdEmoji.value = '';
            els.cmdStartEmoji.value = '';
            els.cmdCooldown.value = 0;
            els.cmdTimeStart.value = '';
            els.cmdTimeEnd.value = '';
            document.querySelectorAll('.btn-day-pill').forEach(btn => btn.classList.remove('active'));
            currentCmdMentions = [];
            addResponseInput('text', '');
            els.cmdMetadata.innerHTML = '';
        }

        renderCmdTags();
        updateWhatsAppCmdPreview();
        els.cmdModal.classList.remove('hidden');
    }

    // Days pill toggles
    document.querySelectorAll('.btn-day-pill').forEach(btn => {
        btn.onclick = () => {
            btn.classList.toggle('active');
        };
    });

    // Update WhatsApp Live Preview
    function updateWhatsAppCmdPreview() {
        const inputs = document.querySelectorAll('.cmd-response-input');
        const firstVal = inputs.length > 0 ? inputs[0].value.trim() : '';
        
        const now = new Date();
        const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
        els.cmdWaTime.textContent = timeStr;

        if (!firstVal) {
            els.cmdWaMedia.classList.add('hidden');
            els.cmdWaMedia.innerHTML = '';
            els.cmdWaText.innerHTML = '<em>Digite uma resposta abaixo para ver a simulação...</em>';
            return;
        }

        if (firstVal.startsWith('{') && firstVal.includes('}')) {
            const end = firstVal.indexOf('}');
            const meta = firstVal.substring(1, end).split('-');
            const type = meta[0];
            const filename = meta[1];
            const caption = firstVal.substring(end + 1).trim();

            els.cmdWaMedia.classList.remove('hidden');
            
            if (type === 'image' || type === 'sticker') {
                els.cmdWaMedia.innerHTML = `<img src="/media-direct/${filename}?token=${token}" onerror="this.src='/android-chrome-192x192.png'">`;
            } else if (type === 'video' || type === 'gif') {
                els.cmdWaMedia.innerHTML = `<div class="wa-thumb-placeholder"><i class="fas fa-play"></i> Vídeo / GIF</div>`;
            } else if (type === 'audio') {
                els.cmdWaMedia.innerHTML = `
                    <div class="wa-audio-mock">
                        <div class="wa-audio-btn"><i class="fas fa-play"></i></div>
                        <div class="wa-audio-waveform-container">
                            <div class="wa-waveform">
                                <div class="wa-waveform-bar" style="height: 6px;"></div>
                                <div class="wa-waveform-bar" style="height: 12px;"></div>
                                <div class="wa-waveform-bar" style="height: 18px;"></div>
                                <div class="wa-waveform-bar" style="height: 10px;"></div>
                                <div class="wa-waveform-bar" style="height: 14px;"></div>
                                <div class="wa-waveform-bar" style="height: 8px;"></div>
                                <div class="wa-waveform-bar" style="height: 16px;"></div>
                                <div class="wa-waveform-bar" style="height: 12px;"></div>
                            </div>
                            <div class="wa-audio-info"><span>0:15</span><span><i class="fas fa-microphone"></i></span></div>
                        </div>
                    </div>
                `;
            } else {
                els.cmdWaMedia.innerHTML = `<div class="wa-thumb-placeholder">[Mídia ${type}]</div>`;
            }

            els.cmdWaText.innerHTML = caption ? formatWhatsAppMarkdown(caption) : '';
            if (!caption) els.cmdWaText.classList.add('hidden');
            else els.cmdWaText.classList.remove('hidden');

        } else {
            els.cmdWaMedia.classList.add('hidden');
            els.cmdWaMedia.innerHTML = '';
            els.cmdWaText.classList.remove('hidden');
            els.cmdWaText.innerHTML = formatWhatsAppMarkdown(firstVal);
        }
    }

    // Emoji Grid
    function renderEmojiGrid() {
        const container = document.getElementById('emoji-list');
        container.innerHTML = '';
        COMMON_EMOJIS.forEach(emoji => {
            const span = document.createElement('span');
            span.textContent = emoji;
            span.className = 'emoji-item';
            span.onclick = () => insertEmoji(emoji);
            container.appendChild(span);
        });
    }

    function insertEmoji(emoji) {
        if (activeEmojiTarget === 'cmd-start-emoji') {
            els.cmdStartEmoji.value = emoji;
        } else {
            els.cmdEmoji.value = emoji;
        }
        setDirty(true);
        els.emojiModal.classList.add('hidden');
    }

    if (els.btnEmojiPicker) {
        els.btnEmojiPicker.onclick = () => {
            activeEmojiTarget = 'cmd-emoji';
            renderEmojiGrid();
            els.emojiModal.classList.remove('hidden');
        };
    }

    if (els.btnStartEmojiPicker) {
        els.btnStartEmojiPicker.onclick = () => {
            activeEmojiTarget = 'cmd-start-emoji';
            renderEmojiGrid();
            els.emojiModal.classList.remove('hidden');
        };
    }

    // Variables Picker
    function renderVariables(filter = '') {
        const container = document.getElementById('variable-list');
        container.innerHTML = '';
        
        const filtered = AVAILABLE_VARIABLES.filter(v => 
            v.code.toLowerCase().includes(filter.toLowerCase()) || 
            v.desc.toLowerCase().includes(filter.toLowerCase())
        );

        filtered.forEach(v => {
            const div = document.createElement('div');
            div.className = 'variable-item';
            div.innerHTML = `
                <div class="variable-code">${v.code}</div>
                <div class="variable-desc">${v.desc}</div>
            `;
            div.onclick = () => insertVariable(v.code);
            container.appendChild(div);
        });
    }

    function renderLanguages(filter = '') {
        const container = document.getElementById('variable-list');
        container.innerHTML = '';
        
        const filtered = AVAILABLE_LANGUAGES.filter(l =>
            l.code.toLowerCase().includes(filter.toLowerCase()) ||
            l.desc.toLowerCase().includes(filter.toLowerCase())
        );

        if (filtered.length === 0) {
            container.innerHTML = '<div class="p-3 text-center text-muted">Nenhum idioma encontrado.</div>';
            return;
        }

        filtered.forEach(lang => {
            const div = document.createElement('div');
            div.className = 'variable-item';
            div.innerHTML = `
                <div class="variable-code">${lang.code}</div>
                <div class="variable-desc">${lang.desc}</div>
            `;
            div.onclick = () => {
                const translateLangInput = document.getElementById('translate-lang');
                if (translateLangInput) {
                    translateLangInput.value = lang.code;
                    setDirty(true);
                }
                els.variableModal.classList.add('hidden');
            };
            container.appendChild(div);
        });
    }

    function openVariableModal(targetInput) {
        lastFocusedInput = targetInput;
        document.getElementById('variable-modal-title').textContent = 'Variáveis Disponíveis';
        document.getElementById('variable-search').value = '';
        document.getElementById('variable-search').placeholder = 'Buscar variável...';
        
        pickerMode = 'variable';
        renderVariables();
        els.variableModal.classList.remove('hidden');
        document.getElementById('variable-search').focus();
    }

    function insertVariable(code) {
        if (lastFocusedInput) {
            const start = lastFocusedInput.selectionStart;
            const end = lastFocusedInput.selectionEnd;
            const text = lastFocusedInput.value;
            
            lastFocusedInput.value = text.substring(0, start) + code + text.substring(end);
            lastFocusedInput.selectionStart = lastFocusedInput.selectionEnd = start + code.length;
            lastFocusedInput.focus();
            lastFocusedInput.dispatchEvent(new Event('input')); 
            updateWhatsAppCmdPreview();
        }
        els.variableModal.classList.add('hidden');
    }

    window.addResponseInput = function(type, value = '') {
        const div = document.createElement('div');
        div.className = 'response-item-row';
        
        let isMedia = value && value.startsWith && value.startsWith('{');
        let mediaType = type;
        let mediaContent = value;
        let mediaCaption = '';

        if (isMedia) {
            const end = value.indexOf('}');
            const meta = value.substring(1, end).split('-');
            mediaType = meta[0]; 
            mediaContent = meta[1]; 
            mediaCaption = value.substring(end+1).trim();
        }

        if (mediaType === 'text') {
             div.innerHTML = `
                <div style="flex: 1; display: flex; flex-direction: column;">
                    <textarea class="form-control cmd-response-input" rows="2" placeholder="Texto da resposta..."></textarea>
                    <button type="button" class="btn btn-xs btn-outline btn-insert-var mt-1"><i class="fas fa-plus-circle"></i> Inserir Variável</button>
                </div>
                <button type="button" class="btn btn-xs btn-danger remove-resp" style="align-self: flex-start; margin-top: 5px;"><i class="fas fa-trash"></i></button>
            `;
            const textarea = div.querySelector('textarea');
            textarea.value = value && !isMedia ? value : '';
            textarea.addEventListener('input', () => updateWhatsAppCmdPreview());
            div.querySelector('.btn-insert-var').onclick = () => openVariableModal(textarea);
        } else {
            const isVideo = mediaType === 'video';
            const convertLinkHtml = isVideo ? ` | <a href="#" class="media-link btn-convert-gif">Converter pra GIF</a>` : '';
            const mediaLink = `/media-direct/${mediaContent}?token=${token}`;
            div.innerHTML = `
                <div class="media-preview form-control" style="font-size: 0.88rem;">
                    ${getIcon(mediaType)} <span class="media-type-lbl">${mediaType}</span>: <a href="${mediaLink}" target="_blank" class="media-link">Ver Mídia</a>${convertLinkHtml} 
                    ${mediaCaption ? ` (${mediaCaption})` : ''}
                </div>
                <input type="hidden" class="cmd-response-input" value="${value}">
                <button type="button" class="btn btn-xs btn-danger remove-resp"><i class="fas fa-trash"></i></button>
            `;

            if (isVideo) {
                div.querySelector('.btn-convert-gif').onclick = (e) => {
                    e.preventDefault();
                    const newValue = value.replace(/^\{video-/, '{gif-');
                    div.querySelector('.cmd-response-input').value = newValue;
                    div.querySelector('.media-type-lbl').textContent = 'gif';
                    setDirty(true);
                    updateWhatsAppCmdPreview();
                };
            }
        }

        div.querySelector('.remove-resp').onclick = () => {
            div.remove();
            updateWhatsAppCmdPreview();
        };
        els.cmdResponsesList.appendChild(div);
        updateWhatsAppCmdPreview();
    };

    window.openMediaUpload = function(type) {
        els.uploadType.value = type;
        els.uploadContext.value = 'command';
        els.mediaFileInput.value = '';
        els.mediaCaption.value = '';
        
        els.captionGroup.classList.remove('hidden');
        els.asStickerGroup.classList.add('hidden');
        
        const existingVarBtn = els.captionGroup.querySelector('.btn-insert-var');
        if(existingVarBtn) existingVarBtn.remove();

        if(type === 'sticker') els.captionGroup.classList.add('hidden');
        if(type === 'image' || type === 'video' || type === 'gif') {
            els.asStickerGroup.classList.remove('hidden');
            const varBtn = document.createElement('button');
            varBtn.type = 'button';
            varBtn.className = 'btn btn-xs btn-outline mt-1';
            varBtn.innerHTML = '<i class="fas fa-plus-circle"></i> Inserir Variável';
            varBtn.onclick = () => openVariableModal(els.mediaCaption);
            els.captionGroup.appendChild(varBtn);
        }

        setupMediaAccept(type);
        els.uploadModal.classList.remove('hidden');
    };

    // Upload Execution
    els.btnConfirmUpload.addEventListener('click', () => {
        const file = els.mediaFileInput.files[0];
        if (!file) return showCustomAlert('Selecione um arquivo');

        let type = els.uploadType.value;
        const context = els.uploadContext.value;
        const caption = els.mediaCaption.value;
        const convertToSticker = els.convertSticker.checked;

        if (convertToSticker) type = 'sticker';

        const formData = new FormData();
        formData.append('token', token);
        formData.append('groupId', groupId);
        formData.append('type', context);
        formData.append('name', Date.now());
        formData.append('caption', caption);
        formData.append('file', file);

        els.btnConfirmUpload.disabled = true;
        els.btnConfirmUpload.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Enviando...';
        els.uploadStatus.innerHTML = '<div class="text-sm text-muted">Processando upload...</div>';

        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${API_BASE}/upload-media`);

        xhr.onload = () => {
            if (xhr.status === 200) {
                const data = JSON.parse(xhr.responseText);
                if (data.success) {
                    const finalType = type;
                    const responseStr = `{${finalType}-${data.fileName}} ${caption}`.trim();

                    if (context === 'command') {
                        addResponseInput(finalType, responseStr);
                    } else if (context === 'greetings' || context === 'farewells') {
                        if (!groupData[context]) groupData[context] = {};
                        groupData[context][finalType] = { file: data.fileName, caption: caption };
                        renderMediaList(`${context}-list`, groupData[context], context);
                        setDirty(true);
                    } else if (context === 'stream-on') {
                        currentStream.data.onConfig.media.push({ type: finalType, content: data.fileName, caption });
                        renderStreamMediaList('stream-on-media-list', currentStream.data.onConfig.media);
                        updateStreamPreview();
                    } else if (context === 'stream-off') {
                        currentStream.data.offConfig.media.push({ type: finalType, content: data.fileName, caption });
                        renderStreamMediaList('stream-off-media-list', currentStream.data.offConfig.media);
                    }
                    els.uploadModal.classList.add('hidden');
                } else {
                    showCustomAlert('Erro: ' + data.message);
                }
            } else {
                showCustomAlert('Erro no upload.');
            }
            cleanup();
        };

        xhr.onerror = () => {
            showCustomAlert('Erro de conexão durante o upload.');
            cleanup();
        };

        function cleanup() {
            els.btnConfirmUpload.disabled = false;
            els.btnConfirmUpload.innerHTML = 'Fazer Upload';
            els.uploadStatus.innerHTML = '';
        }

        xhr.send(formData);
    });

    // Save Custom Command
    els.btnSaveCmd.addEventListener('click', async () => {
        let trigger = els.cmdTrigger.value.trim().toLowerCase();
        if (!trigger) return await showCustomAlert('O comando precisa de um gatilho.');

        const prefix = (groupData.prefix || '!').trim();
        if (trigger.startsWith(prefix)) {
            trigger = trigger.substring(prefix.length).trim();
        } else if (prefix !== '!' && trigger.startsWith('!')) {
            trigger = trigger.substring(1).trim();
        }

        if (!trigger) return await showCustomAlert('O comando precisa de um gatilho válido.');

        const inputs = document.querySelectorAll('.cmd-response-input');
        const responses = Array.from(inputs).map(i => i.value).filter(v => v.trim() !== '');
        
        if (responses.length === 0) return await showCustomAlert('Adicione pelo menos uma resposta ao comando.');

        const rawCooldown = parseInt(els.cmdCooldown.value);
        const cooldownValue = isNaN(rawCooldown) || rawCooldown < 0 ? 0 : Math.min(rawCooldown, 60000);

        // Allowed days
        const selectedDays = [];
        document.querySelectorAll('.btn-day-pill.active').forEach(b => selectedDays.push(b.dataset.day));

        // Allowed times
        let allowedTimes = null;
        const timeStart = els.cmdTimeStart.value;
        const timeEnd = els.cmdTimeEnd.value;
        if (timeStart && timeEnd) {
            allowedTimes = { start: timeStart, end: timeEnd };
        }

        // Reactions
        const startEmoji = els.cmdStartEmoji.value.trim();
        let reactions = null;
        if (startEmoji) {
            reactions = { before: startEmoji, error: '❌' };
        }

        const newCmd = {
            startsWith: trigger,
            responses: responses,
            active: els.cmdActive.checked,
            ignoreInteract: !els.cmdInteract.checked,
            reply: els.cmdReplyQuote.checked,
            sendAllResponses: els.cmdSendAll.checked,
            adminOnly: els.cmdAdminOnly.checked,
            replyInPvivate: els.cmdReplyPrivate.checked,
            react: els.cmdEmoji.value.trim() || null,
            reactions: reactions,
            cooldown: cooldownValue,
            allowedTimes: allowedTimes,
            allowedDays: selectedDays.length > 0 ? selectedDays : null,
            mentions: currentCmdMentions,
            count: currentEditingCmd ? currentEditingCmd.count : 0,
            metadata: currentEditingCmd ? currentEditingCmd.metadata : { createdBy: 'Painel Web', createdAt: Date.now() }
        };

        els.btnSaveCmd.textContent = 'Salvando...';
        els.btnSaveCmd.disabled = true;

        try {
            let url = `${API_BASE}/custom-commands/${groupId}`;
            let method = 'POST';
            if (currentEditingCmd) {
                url += `/${encodeURIComponent(currentEditingCmd.startsWith)}`;
                method = 'PUT';
            }

            const res = await fetch(url, {
                method: method,
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ token, command: newCmd })
            });

            if (res.ok) {
                await loadData();
                els.cmdModal.classList.add('hidden');
            } else {
                const err = await res.json();
                await showCustomAlert('Erro ao salvar comando: ' + err.message);
            }
        } catch (e) {
            await showCustomAlert('Erro: ' + e.message);
        } finally {
            els.btnSaveCmd.textContent = 'Salvar Comando';
            els.btnSaveCmd.disabled = false;
        }
    });

    els.btnDeleteCmd.addEventListener('click', async () => {
        if(!await showCustomConfirm(`Tem certeza que deseja apagar o comando "${currentEditingCmd.startsWith}"?`)) return;
        try {
            const url = `${API_BASE}/custom-commands/${groupId}/${encodeURIComponent(currentEditingCmd.startsWith)}?token=${token}`;
            const res = await fetch(url, { method: 'DELETE' });
            if (res.ok) {
                await loadData();
                els.cmdModal.classList.add('hidden');
            } else {
                await showCustomAlert('Erro ao deletar comando.');
            }
        } catch (e) {
            await showCustomAlert('Erro: ' + e.message);
        }
    });

    // --- Member Modal Logic ---

    let onMemberSelect = null; 

    function renderMembers(filter = '') {
        const tbody = els.memberTableBody;
        tbody.innerHTML = '';
        
        const actionHeader = document.getElementById('member-action-header');
        if (actionHeader) {
            actionHeader.textContent = onMemberSelect ? 'Ação' : 'Apelido';
        }

        const participants = groupData.participants || [];
        const filtered = participants.filter(p => {
            const search = filter.toLowerCase();
            const pn = p.pn ? p.pn.split('@')[0] : '';
            const lid = p.lid ? p.lid.split('@')[0] : '';
            return (pn && pn.includes(search)) || (lid && lid.includes(search));
        });

        if (filtered.length === 0) {
            tbody.innerHTML = '<tr><td colspan="3" class="text-center text-muted p-3">Nenhum membro encontrado.</td></tr>';
            return;
        }

        filtered.forEach(p => {
            const tr = document.createElement('tr');
            
            let actionBtn = '';
            if (onMemberSelect) {
                actionBtn = `<button class="btn btn-xs btn-success btn-select-member"><i class="fas fa-check"></i> Selecionar</button>`;
            } else {
                const existingNick = (groupData.nicks || []).find(n => n.numero === p.pn);
                const currentApelido = existingNick ? existingNick.apelido : '';
                actionBtn = `<input type="text" class="form-control text-sm input-nickname" value="${currentApelido}" data-pn="${p.pn}" placeholder="Apelido..." style="min-width: 100px;">`;
            }

            const pn = p.pn ? p.pn.split('@')[0] : '-';
            const lid = p.lid ? p.lid.split('@')[0] : '-';

            tr.innerHTML = `
                <td>${pn} ${p.admin ? '<span class="status-pill status-pill-active text-xs">Admin</span>' : ''}</td>
                <td style="font-family: monospace; font-size: 0.78rem;">${lid}</td>
                <td>${actionBtn}</td>
            `;

            if (onMemberSelect) {
                tr.querySelector('.btn-select-member').onclick = () => {
                    onMemberSelect(p);
                    els.memberModal.classList.add('hidden');
                };
            } else {
                const input = tr.querySelector('.input-nickname');
                if (input) {
                    input.onchange = (e) => {
                        const newNick = e.target.value.trim();
                        const pnVal = e.target.dataset.pn;
                        
                        if (!groupData.nicks) groupData.nicks = [];
                        
                        const idx = groupData.nicks.findIndex(n => n.numero === pnVal);
                        if (idx !== -1) {
                            if (newNick) {
                                groupData.nicks[idx].apelido = newNick.substring(0, 20);
                            } else {
                                groupData.nicks.splice(idx, 1);
                            }
                        } else if (newNick) {
                            groupData.nicks.push({
                                numero: pnVal,
                                apelido: newNick.substring(0, 20)
                            });
                        }
                        setDirty(true);
                    };
                }
            }

            tbody.appendChild(tr);
        });
    }

    if (els.btnViewMembers) {
        els.btnViewMembers.onclick = () => {
            onMemberSelect = null;
            els.memberModalTitle.textContent = 'Membros do Grupo & Apelidos';
            els.memberSearch.value = '';
            renderMembers();
            els.memberModal.classList.remove('hidden');
        };
    }

    // --- Command Mentions ---

    if (els.btnAddTag) {
        els.btnAddTag.onclick = () => {
            onMemberSelect = (member) => {
                const targetNumber = member.pn || member.lid;
                if (!targetNumber) return;
                
                const cleanNumber = targetNumber.split('@')[0];
                const displayName = cleanNumber;
                
                if (!currentCmdMentions.includes(targetNumber)) {
                    currentCmdMentions.push(targetNumber);
                    renderCmdTags();
                    
                    const inputs = document.querySelectorAll('.cmd-response-input');
                    if (inputs.length > 0) {
                        const firstInput = inputs[0];
                        const mentionTag = `{mention-${cleanNumber}}`;
                        if (!firstInput.value.includes(mentionTag)) {
                            firstInput.value = (firstInput.value + ' ' + mentionTag).trim();
                            firstInput.dispatchEvent(new Event('input'));
                        }
                    }
                    updateWhatsAppCmdPreview();
                }
            };
            
            els.memberModalTitle.textContent = 'Selecionar Membro para Marcar';
            els.memberSearch.value = '';
            renderMembers();
            els.memberModal.classList.remove('hidden');
        };
    }

    function renderCmdTags() {
        els.cmdTagsList.innerHTML = '';
        currentCmdMentions.forEach(m => {
            const clean = m.split('@')[0];
            const tag = document.createElement('span');
            tag.className = 'tag';
            tag.innerHTML = `
                <span>${clean}</span>
                <span class="remove" title="Remover">&times;</span>
            `;
            tag.querySelector('.remove').onclick = () => {
                currentCmdMentions = currentCmdMentions.filter(x => x !== m);
                renderCmdTags();
                updateWhatsAppCmdPreview();
            };
            els.cmdTagsList.appendChild(tag);
        });
    }

    // --- Warnings (Advertências) Section ---

    function getWarningEmojis(count) {
        if (count <= 1) return '⚠️';
        if (count === 2) return '🚨';
        return '🚨🚔';
    }

    function renderWarnings() {
        if (!els.warningsTableBody) return;
        els.warningsTableBody.innerHTML = '';
        
        const warnings = groupData.warnings || [];
        if (warnings.length === 0) {
            els.noWarningsMsg.classList.remove('hidden');
            return;
        }
        els.noWarningsMsg.classList.add('hidden');

        warnings.forEach((w, index) => {
            const tr = document.createElement('tr');
            const cleanNum = w.numero || (w.jid ? w.jid.split('@')[0] : 'Desconhecido');
            const emojis = getWarningEmojis(w.count);

            tr.innerHTML = `
                <td><strong>${cleanNum}</strong></td>
                <td><span class="status-pill status-pill-paused">${emojis} ${w.count} aviso(s)</span></td>
                <td>
                    <button type="button" class="btn btn-xs btn-danger btn-del-warn" title="Remover Advertência"><i class="fas fa-trash"></i></button>
                </td>
            `;

            tr.querySelector('.btn-del-warn').onclick = async () => {
                if (await showCustomConfirm(`Remover advertência de ${cleanNum}?`)) {
                    groupData.warnings.splice(index, 1);
                    setDirty(true);
                    renderWarnings();
                }
            };

            els.warningsTableBody.appendChild(tr);
        });
    }

    if (els.btnClearAllWarnings) {
        els.btnClearAllWarnings.onclick = async () => {
            if (!groupData.warnings || groupData.warnings.length === 0) return;
            if (await showCustomConfirm('Tem certeza que deseja zerar TODAS as advertências deste grupo?')) {
                groupData.warnings = [];
                setDirty(true);
                renderWarnings();
            }
        };
    }

    // --- Webhooks Section ---

    function renderWebhooks() {
        if (!els.webhooksTableBody) return;
        els.webhooksTableBody.innerHTML = '';

        const webhooksUrl = `${window.location.origin}/webhook/${tokenData?.botId || 'bot'}/${groupId.split('@')[0]}`;
        if (els.webhooksEndpointUrl) els.webhooksEndpointUrl.value = webhooksUrl;

        const webhooks = groupData.webhooks || [];
        if (webhooks.length === 0) {
            els.noWebhooksMsg.classList.remove('hidden');
            return;
        }
        els.noWebhooksMsg.classList.add('hidden');

        webhooks.forEach((wh, index) => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><strong>${wh.name}</strong></td>
                <td><code class="text-xs">${wh.header?.name}: ${wh.header?.value} (${wh.headerValue || 'match'})</code></td>
                <td><span class="text-sm">${(wh.template || '').substring(0, 30)}...</span></td>
                <td>
                    <button type="button" class="btn btn-xs btn-danger btn-del-webhook"><i class="fas fa-trash"></i></button>
                </td>
            `;

            tr.querySelector('.btn-del-webhook').onclick = async () => {
                if (await showCustomConfirm(`Apagar o webhook "${wh.name}"?`)) {
                    groupData.webhooks.splice(index, 1);
                    setDirty(true);
                    renderWebhooks();
                }
            };

            els.webhooksTableBody.appendChild(tr);
        });
    }

    if (els.btnCopyWebhookUrl) {
        els.btnCopyWebhookUrl.onclick = async () => {
            try {
                await navigator.clipboard.writeText(els.webhooksEndpointUrl.value);
                await showCustomAlert('URL copiada para a área de transferência!', 'Copiado');
            } catch {
                els.webhooksEndpointUrl.select();
                document.execCommand('copy');
                await showCustomAlert('URL copiada!', 'Copiado');
            }
        };
    }

    if (els.btnAddWebhook) {
        els.btnAddWebhook.onclick = () => {
            document.getElementById('webhook-name').value = '';
            document.getElementById('webhook-header-name').value = 'x-token';
            document.getElementById('webhook-header-value').value = '';
            document.getElementById('webhook-header-mode').value = 'match';
            document.getElementById('webhook-template').value = '';
            els.webhookModal.classList.remove('hidden');
        };
    }

    if (els.btnSaveWebhookConfirm) {
        els.btnSaveWebhookConfirm.onclick = async () => {
            const name = document.getElementById('webhook-name').value.trim();
            const headerName = document.getElementById('webhook-header-name').value.trim();
            const headerValue = document.getElementById('webhook-header-value').value.trim();
            const mode = document.getElementById('webhook-header-mode').value;
            const template = document.getElementById('webhook-template').value.trim();

            if (!name || !headerName || !headerValue || !template) {
                return await showCustomAlert('Preencha todos os campos do webhook.');
            }

            if (!groupData.webhooks) groupData.webhooks = [];

            const existingIndex = groupData.webhooks.findIndex(w => w.name === name);
            if (existingIndex === -1 && groupData.webhooks.length >= 10) {
                return await showCustomAlert('Limite máximo de 10 webhooks atingido.');
            }

            const whData = {
                name,
                header: { name: headerName, value: headerValue },
                headerValue: mode,
                template,
                createdAt: Date.now()
            };

            if (existingIndex !== -1) {
                groupData.webhooks[existingIndex] = whData;
            } else {
                groupData.webhooks.push(whData);
            }

            setDirty(true);
            renderWebhooks();
            els.webhookModal.classList.add('hidden');
        };
    }

    // --- Backups Section ---

    // Export Commands as .ZIP
    if (els.btnExportCmdsZip) {
        els.btnExportCmdsZip.onclick = () => {
            window.location.href = `${API_BASE}/custom-commands/${groupId}/export-zip?token=${token}`;
        };
    }

    // Import Commands from .ZIP
    if (els.fileImportCmdsZip) {
        els.fileImportCmdsZip.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;

            const confirmed = await showCustomConfirm(
                `Deseja importar os comandos do arquivo "${file.name}"?<br>Comandos existentes com o mesmo gatilho serão atualizados.`,
                'Importar Comandos (.zip)'
            );
            if (!confirmed) {
                els.fileImportCmdsZip.value = '';
                return;
            }

            const formData = new FormData();
            formData.append('token', token);
            formData.append('file', file);

            els.loading.classList.remove('hidden');
            try {
                const res = await fetch(`${API_BASE}/custom-commands/${groupId}/import-zip`, {
                    method: 'POST',
                    body: formData
                });
                const result = await res.json();
                if (result.success) {
                    await loadData();
                    await showCustomAlert(`Importação concluída!<br><b>${result.importedCount}</b> comando(s) e <b>${result.mediaCount}</b> mídia(s) restauradas.`, 'Sucesso');
                } else {
                    throw new Error(result.message || 'Erro na importação');
                }
            } catch (err) {
                await showCustomAlert('Erro ao importar comandos: ' + err.message, 'Erro');
            } finally {
                els.loading.classList.add('hidden');
                els.fileImportCmdsZip.value = '';
            }
        };
    }

    // Export Configs as .JSON
    if (els.btnExportConfigJson) {
        els.btnExportConfigJson.onclick = () => {
            const backupData = {
                version: 1,
                exportedAt: new Date().toISOString(),
                groupId: groupId,
                groupName: groupData.name || 'grupo',
                config: JSON.parse(JSON.stringify(groupData))
            };

            const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(backupData, null, 2));
            const downloadAnchor = document.createElement('a');
            downloadAnchor.setAttribute("href", dataStr);
            downloadAnchor.setAttribute("download", `${groupData.name || 'grupo'}_config_backup.json`);
            document.body.appendChild(downloadAnchor);
            downloadAnchor.click();
            downloadAnchor.remove();
        };
    }

    // Import Configs from .JSON with ID and Name check
    if (els.fileImportConfigJson) {
        els.fileImportConfigJson.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = async (event) => {
                try {
                    const parsed = JSON.parse(event.target.result);
                    const backupConfig = parsed.config || parsed;
                    const backupGroupId = parsed.groupId || backupConfig.id;

                    // 1. Check Group ID
                    if (backupGroupId && backupGroupId !== groupId) {
                        const allowCrossGroup = await showCustomConfirm(
                            `⚠️ <b>Atenção:</b> Este arquivo de backup foi gerado a partir de outro grupo (<code class="text-xs">${backupGroupId}</code>).<br><br>Aplicar estas configurações sobrescreverá as preferências do grupo atual (<code class="text-xs">${groupId}</code>). Deseja continuar?`,
                            'Grupo Diferente Detectado'
                        );
                        if (!allowCrossGroup) return;
                    }

                    // 2. Check Name Uniqueness
                    let targetName = (backupConfig.name || groupData.name || '').trim().toLowerCase();
                    if (targetName) {
                        const checkRes = await fetch(`${API_BASE}/group/check-import-name`, {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({ token, groupId, name: targetName })
                        }).then(r => r.json());

                        if (!checkRes.available) {
                            const newName = await showCustomPrompt(
                                `O nome "<b>${targetName}</b>" já está em uso por outro grupo no sistema.<br>Por favor, defina um nome único para este grupo:`,
                                targetName + '_novo',
                                'Nome Duplicado'
                            );
                            if (!newName || !newName.trim()) return;
                            targetName = newName.trim().toLowerCase();
                        }
                    }

                    // Apply settings
                    const protectedFields = ['id', 'createdAt', 'participants'];
                    for (let key in backupConfig) {
                        if (!protectedFields.includes(key)) {
                            groupData[key] = backupConfig[key];
                        }
                    }
                    if (targetName) groupData.name = targetName;

                    populateFields();
                    renderWarnings();
                    renderWebhooks();
                    setDirty(true);

                    await showCustomAlert('Configurações importadas com sucesso! Clique em "Salvar Tudo" para consolidar as alterações.', 'Importação Concluída');

                } catch (err) {
                    await showCustomAlert('Erro ao ler arquivo de backup: ' + err.message, 'Arquivo Inválido');
                } finally {
                    els.fileImportConfigJson.value = '';
                }
            };
            reader.readAsText(file);
        };
    }

    // --- Setup Listeners & Modals ---

    function setupEventListeners() {
        els.retryBtn.addEventListener('click', () => window.location.reload());
        
        // Hero Status Switch
        if (els.groupPausedToggle) {
            els.groupPausedToggle.addEventListener('change', (e) => {
                const isPaused = !e.target.checked;
                groupData.paused = isPaused;
                updateHeroStatusVisuals(isPaused);
                document.getElementById('bot-enabled').checked = !isPaused;
                setDirty(true);
            });
        }

        const botEnabledCheckbox = document.getElementById('bot-enabled');
        if (botEnabledCheckbox) {
            botEnabledCheckbox.addEventListener('change', (e) => {
                const isEnabled = e.target.checked;
                groupData.paused = !isEnabled;
                updateHeroStatusVisuals(!isEnabled);
                setDirty(true);
            });
        }

        const interactUseCmdsCheckbox = document.getElementById('interact-use-cmds');
        if (interactUseCmdsCheckbox) {
            interactUseCmdsCheckbox.addEventListener('change', (e) => {
                if (!groupData.interact) groupData.interact = {};
                groupData.interact.useCmds = e.target.checked;
                setDirty(true);
            });
        }

        if (document.getElementById('btn-lang-picker')) {
            document.getElementById('btn-lang-picker').addEventListener('click', () => {
                document.getElementById('variable-modal-title').textContent = 'Idiomas Disponíveis';
                document.getElementById('variable-search').value = '';
                document.getElementById('variable-search').placeholder = 'Buscar idioma...';
                pickerMode = 'language';
                renderLanguages();
                els.variableModal.classList.remove('hidden');
                document.getElementById('variable-search').focus();
            });
        }

        document.getElementById('variable-search').addEventListener('input', (e) => {
            if (pickerMode === 'variable') {
                renderVariables(e.target.value);
            } else {
                renderLanguages(e.target.value);
            }
        });

        els.closeModalBtns.forEach(b => {
            b.onclick = () => {
                els.cmdModal.classList.add('hidden');
                els.streamModal.classList.add('hidden');
                els.variableModal.classList.add('hidden');
                els.emojiModal.classList.add('hidden');
                els.customDialogModal.classList.add('hidden');
                els.memberModal.classList.add('hidden');
                els.webhookModal.classList.add('hidden');
            };
        });
        els.closeUploadBtns.forEach(b => b.onclick = () => els.uploadModal.classList.add('hidden'));

        // Tag inputs
        setupListAdder('add-ignored-number', 'new-ignored-number', 'ignoredNumbers');
        setupListAdder('add-forbidden-word', 'new-forbidden-word', 'filters.words');
        setupListAdder('add-forbidden-user', 'new-forbidden-user', 'filters.people');
        setupListAdder('add-muted-command', 'new-muted-command', 'mutedCommands');
        setupListAdder('add-additional-admin', 'new-additional-admin', 'additionalAdmins');

        const botPersonalityInput = document.getElementById('bot-personality');
        if (botPersonalityInput) {
            botPersonalityInput.addEventListener('input', (e) => {
                document.getElementById('personality-count').textContent = e.target.value.length;
            });
        }

        const deleteNsfwCheckbox = document.getElementById('delete-nsfw');
        if (deleteNsfwCheckbox) {
            deleteNsfwCheckbox.addEventListener('change', (e) => {
                toggleNsfwSettings(e.target.checked);
            });
        }

        const nsfwSlider = document.getElementById('nsfw-intensity');
        if (nsfwSlider) {
            nsfwSlider.addEventListener('input', (e) => {
                document.getElementById('nsfw-intensity-val').textContent = e.target.value;
            });
        }

        const autoInteractionCheckbox = document.getElementById('auto-interaction');
        if (autoInteractionCheckbox) {
            autoInteractionCheckbox.addEventListener('change', (e) => {
                toggleInteractionSettings(e.target.checked);
            });
        }

        const autoTranslateCheckbox = document.getElementById('auto-translate');
        if (autoTranslateCheckbox) {
            autoTranslateCheckbox.addEventListener('change', (e) => {
                toggleTranslateSettings(e.target.checked);
            });
        }

        const chanceSlider = document.getElementById('interaction-chance');
        if(chanceSlider) {
            chanceSlider.addEventListener('input', (e) => {
                document.getElementById('chance-val').textContent = (e.target.value / 100).toFixed(2);
            });
        }

        const cooldownSlider = document.getElementById('interaction-cooldown');
        if(cooldownSlider) {
            cooldownSlider.addEventListener('input', (e) => {
                document.getElementById('cooldown-val').textContent = e.target.value;
            });
        }

        const proporcaoSlider = document.getElementById('interaction-proporcao');
        if (proporcaoSlider) {
            proporcaoSlider.addEventListener('input', (e) => {
                const val = parseInt(e.target.value);
                document.getElementById('proporcao-val').textContent = val;
                const iaChance = val;
                const cmdChance = 100 - val;
                const descEl = document.getElementById('proporcao-desc');
                if (descEl) {
                    if (iaChance === 100) {
                        descEl.innerHTML = "Usando apenas <b>IA</b> para interagir";
                    } else if (iaChance === 0) {
                        descEl.innerHTML = "Usando apenas <b>comandos</b> para interagir";
                    } else {
                        descEl.textContent = `${cmdChance}% de chance de usar comandos, ${iaChance}% de chance de usar IA`;
                    }
                }
            });
        }
    }

    async function loadDossierHistory() {
        if (!els.dossiesHistoryList) return;
        try {
            const res = await fetch(`${API_BASE}/group-dossier-history?groupId=${groupId}&token=${token}`);
            if (!res.ok) throw new Error('Falha ao carregar histórico de dossiês');
            const history = await res.json();
            renderDossierHistory(history);
        } catch (e) {
            console.error(e);
            els.dossiesHistoryList.innerHTML = `<p class="text-danger">Erro ao carregar histórico: ${e.message}</p>`;
        }
    }

    function renderDossierHistory(history) {
        if (!history || history.length === 0) {
            els.dossiesHistoryList.innerHTML = '<p class="text-muted text-center p-4">Nenhum dossiê gerado ainda para este grupo.</p>';
            return;
        }

        els.dossiesHistoryList.innerHTML = '';
        history.forEach((item, index) => {
            const div = document.createElement('div');
            div.className = 'dossie-item';
            if (index === 0) div.classList.add('latest');

            const date = new Date(item.created_at).toLocaleString('pt-BR');
            const scoreClass = item.problematic_score >= 7 ? 'score-high' : (item.problematic_score >= 4 ? 'score-medium' : 'score-low');

            div.innerHTML = `
                <div class="dossie-header">
                    <span class="dossie-date">${date}</span>
                    <span class="dossie-score ${scoreClass}">Nota: ${item.problematic_score}/10</span>
                </div>
                <div class="dossie-type">${item.type}</div>
                <div class="dossie-summary">${item.summary}</div>
            `;
            els.dossiesHistoryList.appendChild(div);
        });
    }

    init();
});