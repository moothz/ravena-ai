// desktop.js - Desktop Icons Grid and Desktop Context Menu

const Desktop = {
    icons: [
        { id: 'status',     label: 'Status',            tooltip: 'Painel de status das instâncias da Ravena',            icon: 'img/icons/status.webp',     window: 'status' },
        { id: 'invite',     label: 'Quero Uma!',        tooltip: 'Instruções para adicionar o bot no seu grupo',          icon: 'img/icons/invite.webp',     window: 'invite' },
        { id: 'commands',   label: 'Comandos',          tooltip: 'Catálogo de comandos e exemplos de uso',                icon: 'img/icons/commands.svg',    window: 'commands' },
        { id: 'community',  label: 'Comunidade',        tooltip: 'Grupos no WhatsApp, Discord e Telegram',                icon: 'img/icons/community.webp',  window: 'community' },
        { id: 'github',     label: 'GitHub',            tooltip: 'Código-fonte oficial da RavenaBot',                     icon: 'img/icons/github.webp',     url: 'https://github.com/moothz/ravena-ai' },
        { id: 'help',       label: 'Ajuda',             tooltip: 'Chatbot de ajuda com IA para dúvidas',                  icon: 'img/icons/help.webp',       window: 'help' },
        { id: 'donations',  label: 'Doações',           tooltip: 'Mural de apoiadores e ranking de doações',              icon: 'img/icons/donations.webp',  window: 'donations' },
        { id: 'ravenabank', label: 'RavenaBank',        tooltip: 'Banco Central, câmbio de moedas e economia de Runas',   icon: 'img/icons/ravenabank.svg',  window: 'ravenabank' },
        { id: 'fishing',    label: 'Pesca',             tooltip: 'Hall da fama dos peixes lendários pescados',            icon: 'img/icons/fishing.webp',    window: 'fishing' },
        { id: 'waifuletes', label: 'Waifuletes',        tooltip: 'Catálogo de waifus, husbandos e personagens',           icon: 'img/icons/waifuletes.svg',  window: 'waifuletes' },
        { id: 'imagine',    label: 'Imagine',           tooltip: 'Gerador de imagens com inteligência artificial',        icon: 'img/icons/imagine.webp',    window: 'imagine' },
        { id: 'tts',        label: 'Gerar Voz',         tooltip: 'Conversor de texto em voz (Kokoro-TTS)',                icon: 'img/icons/tts.webp',        window: 'tts' },
        { id: 'stt',        label: 'Transcrever Áudio', tooltip: 'Transcritor de áudio em texto (Whisper)',               icon: 'img/icons/stt.webp',        window: 'stt' },
        { id: 'nudenet',    label: 'Detector NSFW',     tooltip: 'Detecção e moderação de conteúdo adulto / NSFW',        icon: 'img/icons/nudenet.webp',    window: 'nudenet' },
        { id: 'statistics', label: 'Estatísticas',      tooltip: 'Métricas, fluxo e gráficos de mensagens',               icon: 'img/icons/statistics.webp', window: 'statistics' }
    ],

    tooltipEl: null,
    tooltipTimer: null,

    init() {
        const desktop = document.getElementById('desktop');
        if (!desktop) return;

        this.ensureTooltipElement();

        desktop.innerHTML = '';
        this.icons.forEach((icon) => {
            desktop.appendChild(this.createIcon(icon));
        });

        // Right-click on desktop background
        desktop.addEventListener('contextmenu', (e) => {
            if (!e.target.closest('.desktop-icon') && !e.target.closest('#desktop-donates-widget')) {
                e.preventDefault();
                ContextMenu.show(e, [
                    {
                        label: 'Atualizar Dados',
                        icon: 'fas fa-sync-alt',
                        action: () => {
                            if (window.RavenaOS) {
                                window.RavenaOS.fetchHealth();
                                window.RavenaOS.fetchDonations();
                                window.RavenaOS.fetchRecentDonations();
                            }
                        }
                    },
                    { separator: true },
                    {
                        label: 'Abrir Status das Ravenas',
                        icon: 'fas fa-desktop',
                        action: () => WindowManager.open('status')
                    },
                    {
                        label: 'Abrir Comandos',
                        icon: 'fas fa-terminal',
                        action: () => WindowManager.open('commands')
                    },
                    {
                        label: 'Abrir Mensagímetro',
                        icon: 'fas fa-gauge-high',
                        action: () => WindowManager.open('speedometer')
                    },
                    {
                        label: 'Abrir Estatísticas',
                        icon: 'fas fa-chart-bar',
                        action: () => WindowManager.open('statistics')
                    },
                    {
                        label: 'Abrir Doações',
                        icon: 'fas fa-heart',
                        action: () => WindowManager.open('donations')
                    },
                    {
                        label: 'Abrir Waifuletes',
                        icon: 'fas fa-star',
                        action: () => WindowManager.open('waifuletes')
                    },
                    { separator: true },
                    {
                        label: 'Código no GitHub',
                        icon: 'fab fa-github',
                        action: () => window.open('https://github.com/moothz/ravena-ai', '_blank')
                    }
                ]);
            }
        });

        // Click on desktop unselects icons
        desktop.addEventListener('click', (e) => {
            this.hideTooltip();
            if (!e.target.closest('.desktop-icon')) {
                desktop.querySelectorAll('.desktop-icon').forEach(el => el.classList.remove('selected'));
            }
        });
    },

    ensureTooltipElement() {
        if (!this.tooltipEl || !document.body.contains(this.tooltipEl)) {
            let el = document.getElementById('desktop-tooltip');
            if (!el) {
                el = document.createElement('div');
                el.id = 'desktop-tooltip';
                el.className = 'desktop-tooltip';
                el.setAttribute('role', 'tooltip');
                document.body.appendChild(el);
            }
            this.tooltipEl = el;
        }
        return this.tooltipEl;
    },

    showTooltip(iconEl) {
        const text = iconEl?.dataset?.tooltipText;
        if (!text) return;

        clearTimeout(this.tooltipTimer);
        this.tooltipTimer = setTimeout(() => {
            const tip = this.ensureTooltipElement();
            tip.textContent = text;
            tip.classList.add('visible');

            const iconRect = iconEl.getBoundingClientRect();
            const tipRect = tip.getBoundingClientRect();
            const margin = 8;
            const taskbarClearance = 54;

            let left = iconRect.left + (iconRect.width / 2) - (tipRect.width / 2);
            left = Math.max(margin, Math.min(left, window.innerWidth - tipRect.width - margin));

            let top = iconRect.bottom + 4;
            if (top + tipRect.height > window.innerHeight - taskbarClearance) {
                top = Math.max(margin, iconRect.top - tipRect.height - 4);
            }

            tip.style.left = `${Math.round(left)}px`;
            tip.style.top = `${Math.round(top)}px`;
        }, 50);
    },

    hideTooltip() {
        clearTimeout(this.tooltipTimer);
        if (this.tooltipEl) {
            this.tooltipEl.classList.remove('visible');
        }
    },

    /**
     * Borda direita (px) da área ocupada pelos ícones do desktop, para posicionar janelas sem cobri-los.
     * @returns {number}
     */
    getIconsAreaRight() {
        let right = 0;
        document.querySelectorAll('#desktop .desktop-icon').forEach((el) => {
            const r = el.getBoundingClientRect();
            if (r.width) right = Math.max(right, r.right);
        });
        return right ? Math.round(right + 12) : 250;
    },

    createIcon(config) {
        const el = document.createElement('div');
        el.className = 'desktop-icon';
        el.dataset.id = config.id;
        el.dataset.tooltipText = `${config.label}: ${config.tooltip || ''}`;
        // Acessível por teclado: Tab para focar, Enter/Espaço para abrir
        el.tabIndex = 0;
        el.setAttribute('role', config.url ? 'link' : 'button');
        el.setAttribute('aria-label', `${config.label} — ${config.tooltip || ''}`);

        el.innerHTML = `
            <div class="desktop-icon-img-wrap">
                <img src="${config.icon}" alt="" width="54" height="54" decoding="async" draggable="false">
            </div>
            <span class="desktop-icon-label">${config.label}</span>
        `;

        el.addEventListener('mouseenter', () => this.showTooltip(el));
        el.addEventListener('mouseleave', () => this.hideTooltip());
        el.addEventListener('focus', () => this.showTooltip(el));
        el.addEventListener('blur', () => this.hideTooltip());

        // 1 Click directly opens the program/window
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            this.hideTooltip();
            document.querySelectorAll('.desktop-icon').forEach(i => i.classList.remove('selected'));
            el.classList.add('selected');

            if (config.url) {
                window.open(config.url, '_blank');
            } else if (config.window) {
                WindowManager.open(config.window);
            }
        });

        el.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                el.click();
            }
        });

        // Right click: icon context menu
        el.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.hideTooltip();

            document.querySelectorAll('.desktop-icon').forEach(i => i.classList.remove('selected'));
            el.classList.add('selected');

            const items = [
                {
                    label: 'Abrir',
                    icon: 'fas fa-folder-open',
                    bold: true,
                    action: () => {
                        if (config.url) window.open(config.url, '_blank');
                        else if (config.window) WindowManager.open(config.window);
                    }
                }
            ];

            if (config.url) {
                items.push({
                    label: 'Abrir link no navegador',
                    icon: 'fas fa-external-link-alt',
                    action: () => window.open(config.url, '_blank')
                });
            }

            ContextMenu.show(e, items);
        });

        return el;
    }
};

window.Desktop = Desktop;
