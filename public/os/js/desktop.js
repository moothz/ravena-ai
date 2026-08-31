// desktop.js - Desktop Icons Grid and Desktop Context Menu

const Desktop = {
    icons: [
        { id: 'status',     label: 'Status',        tooltip: 'Painel de status das instâncias da Ravena',  icon: 'img/icons/status.png',     window: 'status' },
        { id: 'donations',  label: 'Doações',       tooltip: 'Mural de apoiadores e ranking de doações',    icon: 'img/icons/donations.png',  window: 'donations' },
        { id: 'community',  label: 'Comunidade',    tooltip: 'Grupos no WhatsApp, Discord e Telegram',     icon: 'img/icons/community.png',  window: 'community' },
        { id: 'statistics', label: 'Estatísticas',  tooltip: 'Métricas, fluxo e gráficos de mensagens',    icon: 'img/icons/statistics.png', window: 'statistics' },
        { id: 'help',       label: 'Ajuda',         tooltip: 'Chatbot de ajuda com IA para dúvidas',       icon: 'img/icons/help.png',       window: 'help' },
        { id: 'imagine',    label: 'Imagine',       tooltip: 'Gerador de imagens com inteligência artificial', icon: 'img/icons/imagine.png', window: 'imagine' },
        { id: 'tts',        label: 'TTS',           tooltip: 'Conversor de texto em voz (F5-TTS)',          icon: 'img/icons/tts.png',        window: 'tts' },
        { id: 'stt',        label: 'STT',           tooltip: 'Transcritor de áudio em texto (Whisper)',     icon: 'img/icons/stt.png',        window: 'stt' },
        { id: 'fishing',    label: 'Pesca',         tooltip: 'Hall da fama dos peixes lendários pescados',  icon: 'img/icons/fishing.png',    window: 'fishing' },
        { id: 'github',     label: 'GitHub',        tooltip: 'Código-fonte oficial da RavenaBot',           icon: 'img/icons/github.png',     url: 'https://github.com/moothz/ravena-ai' },
        { id: 'invite',     label: 'Quero Uma!',    tooltip: 'Instruções para adicionar o bot no seu grupo', icon: 'img/icons/invite.png',     window: 'invite' }
    ],

    init() {
        const desktop = document.getElementById('desktop');
        if (!desktop) return;

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
            if (!e.target.closest('.desktop-icon')) {
                desktop.querySelectorAll('.desktop-icon').forEach(el => el.classList.remove('selected'));
            }
        });
    },

    createIcon(config) {
        const el = document.createElement('div');
        el.className = 'desktop-icon';
        el.dataset.id = config.id;
        el.title = `${config.label} — ${config.tooltip || ''}`;

        el.innerHTML = `
            <div class="desktop-icon-img-wrap">
                <img src="${config.icon}" alt="${config.label}" draggable="false" loading="lazy">
            </div>
            <span class="desktop-icon-label">${config.label}</span>
        `;

        // 1 Click directly opens the program/window
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            document.querySelectorAll('.desktop-icon').forEach(i => i.classList.remove('selected'));
            el.classList.add('selected');

            if (config.url) {
                window.open(config.url, '_blank');
            } else if (config.window) {
                WindowManager.open(config.window);
            }
        });

        // Right click: icon context menu
        el.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();

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
