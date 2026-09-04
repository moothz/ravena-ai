// taskbar.js - Taskbar Manager: Start Menu, Window Tabs, Widgets, and Service Traybar

const Taskbar = {
    donatorsIndex: 0,
    donatorsTimer: null,

    init() {
        this.updateClock();
        setInterval(() => this.updateClock(), 1000);

        // Start Menu button toggle
        const startBtn = document.getElementById('start-btn');
        if (startBtn) {
            startBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleStartMenu();
            });
        }

        // Close start menu when clicking outside
        document.addEventListener('click', (e) => {
            if (!e.target.closest('#start-menu') && !e.target.closest('#start-btn')) {
                this.closeStartMenu();
            }
        });

        // Msgs/h widget click -> open speedometer (Mensagímetro)
        const msgsWidget = document.getElementById('widget-msgs');
        if (msgsWidget) {
            msgsWidget.addEventListener('click', (e) => {
                e.stopPropagation();
                WindowManager.open('speedometer');
            });
            msgsWidget.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                ContextMenu.show(e, [
                    {
                        label: 'Abrir Mensagímetro',
                        icon: 'fas fa-gauge-high',
                        bold: true,
                        action: () => WindowManager.open('speedometer')
                    }
                ]);
            });
        }

        // Donate widget click -> open donations window
        const donateWidget = document.getElementById('widget-donates');
        if (donateWidget) {
            donateWidget.addEventListener('click', (e) => {
                e.stopPropagation();
                WindowManager.open('donations');
            });
            donateWidget.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                ContextMenu.show(e, [
                    {
                        label: 'Abrir Doações',
                        icon: 'fas fa-heart',
                        bold: true,
                        action: () => WindowManager.open('donations')
                    },
                    {
                        label: 'Fazer Doação (tipa.ai)',
                        icon: 'fas fa-external-link-alt',
                        action: () => window.open('https://tipa.ai/moothz', '_blank')
                    }
                ]);
            });
        }

        // Prevent browser right-click on taskbar background
        const taskbarEl = document.getElementById('taskbar');
        if (taskbarEl) {
            taskbarEl.addEventListener('contextmenu', (e) => {
                if (e.target === taskbarEl || e.target.classList.contains('taskbar-windows') || e.target.classList.contains('taskbar-widgets')) {
                    e.preventDefault();
                    ContextMenu.show(e, [
                        {
                            label: 'Status das Ravenas',
                            icon: 'fas fa-desktop',
                            action: () => WindowManager.open('status')
                        },
                        {
                            label: 'Mensagímetro',
                            icon: 'fas fa-gauge-high',
                            action: () => WindowManager.open('speedometer')
                        },
                        {
                            label: 'Mural de Doações',
                            icon: 'fas fa-heart',
                            action: () => WindowManager.open('donations')
                        }
                    ]);
                }
            });
        }

        // Initialize Donators Ticker
        this.initDonateWidget();

        // Build Start Menu items
        this.buildStartMenu();

        // Subscribe to events
        if (window.RavenaOS) {
            window.RavenaOS.on('realtimeRate', (rate) => this.updateRealtimeMsgsRate(rate));
            window.RavenaOS.on('serviceStatusUpdate', (status) => this.updateTrayIcons(status));
            window.RavenaOS.on('activity', (data) => this.flashActivityService(data));
            window.RavenaOS.on('healthUpdate', () => this.buildStartMenu());
        }
    },

    updateClock() {
        const now = new Date();
        const timeEl = document.getElementById('clock-time');
        const dateEl = document.getElementById('clock-date');

        if (timeEl) {
            timeEl.textContent = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        }
        if (dateEl) {
            dateEl.textContent = now.toLocaleDateString('pt-BR');
        }
    },

    updateRealtimeMsgsRate(rate) {
        const valEl = document.getElementById('widget-msgs-value');
        if (!valEl) return;
        const avg = window.RavenaOS ? Math.round(window.RavenaOS.state.averageMsgsHr) : 0;
        valEl.textContent = `${rate} msgs/h (méd ${avg})`;
    },

    initDonateWidget() {
        if (this.donatorsTimer) clearInterval(this.donatorsTimer);

        const updateDonor = () => {
            const textEl = document.getElementById('widget-donates-text');
            const widgetEl = document.getElementById('widget-donates');
            if (!textEl || !widgetEl) return;

            const recent = window.RavenaOS ? window.RavenaOS.state.recentDonations : null;
            if (!recent || !recent.topRecentDonors || recent.topRecentDonors.length === 0) {
                textEl.innerHTML = '<i class="fas fa-heart" style="color: #ff4081; margin-right: 4px;"></i> Carregando doadores...';
                return;
            }

            const total = recent.totalRecentAmount || 0;
            widgetEl.classList.toggle('goal-reached', total >= 150);

            const donors = recent.topRecentDonors;
            this.donatorsIndex = (this.donatorsIndex + 1) % donors.length;
            const donor = donors[this.donatorsIndex];

            textEl.style.opacity = '0';
            setTimeout(() => {
                textEl.innerHTML = `<i class="fas fa-heart" style="color: #ff4081; margin-right: 4px;"></i> <strong>${donor.nome}</strong> — ${Formatters.currency(donor.valor)}`;
                textEl.style.opacity = '1';
            }, 250);
        };

        this.donatorsTimer = setInterval(updateDonor, 3000);
        setTimeout(updateDonor, 800);
    },

    updateTrayIcons(status) {
        if (!status) return;

        const serviceMap = {
            'tray-whatsgoapi': { name: 'WhatsGo API (WhatsApp)', st: status.whatsgoapi },
            'tray-imagine':    { name: 'Imagine (Bonsai AI)', st: status.imagine },
            'tray-llm':        { name: 'LLM (IA / Resumos)', st: status.llm },
            'tray-whisper':    { name: 'Whisper (Áudio STT)', st: status.whisper },
            'tray-f5tts':      { name: 'F5-TTS (Voz TTS)', st: status.f5tts }
        };

        for (const [id, s] of Object.entries(serviceMap)) {
            const el = document.getElementById(id);
            if (!el) continue;

            el.classList.remove('tray-up', 'tray-down', 'tray-backup', 'tray-unknown');

            const state = typeof s.st === 'object' ? (s.st.status || 'up') : (s.st || 'unknown');

            if (state === 'up' || state === 'online' || state === 'ok') {
                el.classList.add('tray-up');
                el.title = `${s.name} — ✅ Online`;
            } else if (state === 'down' || state === 'offline' || state === 'error') {
                el.classList.add('tray-down');
                el.title = `${s.name} — ❌ Offline`;
            } else if (state === 'backup') {
                el.classList.add('tray-backup');
                el.title = `${s.name} — ⚠️ Servidor Backup`;
            } else {
                el.classList.add('tray-unknown');
                el.title = `${s.name} — ❓ Verificando...`;
            }
        }
    },

    flashActivityService(data) {
        if (!data || !data.service) return;
        const idMap = {
            whatsgoapi: 'tray-whatsgoapi',
            imagine: 'tray-imagine',
            llm: 'tray-llm',
            whisper: 'tray-whisper',
            f5tts: 'tray-f5tts'
        };
        const elId = idMap[data.service];
        if (elId) {
            const el = document.getElementById(elId);
            if (el) {
                el.classList.remove('flash');
                void el.offsetWidth;
                el.classList.add('flash');
            }
        }
    },

    // Taskbar Open Windows Tab Buttons
    addWindow(id, title, icon) {
        const container = document.getElementById('taskbar-windows');
        if (!container) return;

        let btn = document.getElementById(`tb-btn-${id}`);
        if (!btn) {
            btn = document.createElement('button');
            btn.id = `tb-btn-${id}`;
            btn.className = 'taskbar-win-btn active';
            btn.innerHTML = `<i class="fas ${icon}"></i><span>${title}</span>`;

            // Left click: focus, restore or minimize
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const entry = WindowManager.windows.get(id);
                if (entry && entry.winbox) {
                    if (entry.winbox.min) {
                        entry.winbox.restore();
                    } else if (btn.classList.contains('active')) {
                        entry.winbox.minimize();
                    } else {
                        entry.winbox.focus();
                    }
                }
            });

            // Right click: window control menu
            btn.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();

                const entry = WindowManager.windows.get(id);
                if (!entry || !entry.winbox) return;

                ContextMenu.show(e, [
                    {
                        label: 'Focar / Restaurar',
                        icon: 'fas fa-window-restore',
                        bold: true,
                        action: () => {
                            if (entry.winbox.min) entry.winbox.restore();
                            entry.winbox.focus();
                        }
                    },
                    {
                        label: 'Minimizar',
                        icon: 'fas fa-minus',
                        action: () => entry.winbox.minimize()
                    },
                    {
                        label: 'Maximizar / Restaurar',
                        icon: 'fas fa-square',
                        action: () => entry.winbox.maximize()
                    },
                    { separator: true },
                    {
                        label: 'Fechar Janela',
                        icon: 'fas fa-times',
                        bold: true,
                        action: () => entry.winbox.close()
                    }
                ]);
            });

            container.appendChild(btn);
        }
    },

    removeWindow(id) {
        const btn = document.getElementById(`tb-btn-${id}`);
        if (btn) btn.remove();
    },

    setActive(id) {
        document.querySelectorAll('.taskbar-win-btn').forEach(b => b.classList.remove('active', 'minimized'));
        const btn = document.getElementById(`tb-btn-${id}`);
        if (btn) btn.classList.add('active');
    },

    setInactive(id) {
        const btn = document.getElementById(`tb-btn-${id}`);
        if (btn) btn.classList.remove('active');
    },

    setMinimized(id) {
        const btn = document.getElementById(`tb-btn-${id}`);
        if (btn) {
            btn.classList.remove('active');
            btn.classList.add('minimized');
        }
    },

    // Start Menu Builder
    buildStartMenu() {
        const container = document.getElementById('start-menu-items');
        if (!container) return;

        container.innerHTML = `
            <!-- Folder: Ravenas -->
            <div class="start-menu-item has-submenu" id="start-folder-ravenas">
                <i class="fas fa-server"></i>
                <span>Ravenas</span>
                <i class="fas fa-caret-right menu-arrow"></i>
                <div class="start-submenu" id="start-submenu-ravenas">
                    <div class="submenu-header">Carregando ravenas...</div>
                </div>
            </div>

            <!-- Folder: Serviços (View-only) -->
            <div class="start-menu-item has-submenu" id="start-folder-services">
                <i class="fas fa-network-wired"></i>
                <span>Serviços</span>
                <i class="fas fa-caret-right menu-arrow"></i>
                <div class="start-submenu" id="start-submenu-services">
                    <div class="submenu-header">Status dos Serviços</div>
                    <div class="submenu-item" style="cursor: default;">
                        <span class="service-status-dot dot-up" id="sm-dot-whatsgo"></span>
                        <span>WhatsGo (WhatsApp)</span>
                    </div>
                    <div class="submenu-item" style="cursor: default;">
                        <span class="service-status-dot dot-up" id="sm-dot-imagine"></span>
                        <span>Imagine (Bonsai)</span>
                    </div>
                    <div class="submenu-item" style="cursor: default;">
                        <span class="service-status-dot dot-up" id="sm-dot-llm"></span>
                        <span>LLM (IA)</span>
                    </div>
                    <div class="submenu-item" style="cursor: default;">
                        <span class="service-status-dot dot-up" id="sm-dot-whisper"></span>
                        <span>Whisper (STT)</span>
                    </div>
                    <div class="submenu-item" style="cursor: default;">
                        <span class="service-status-dot dot-up" id="sm-dot-f5tts"></span>
                        <span>F5-TTS (Voz)</span>
                    </div>
                </div>
            </div>

            <div class="start-menu-separator"></div>

            <!-- Regular Desktop Apps -->
            <div class="start-menu-item" data-action="status">
                <i class="fas fa-desktop"></i>
                <span>Status das Ravenas</span>
            </div>

            <div class="start-menu-item" data-action="speedometer">
                <i class="fas fa-gauge-high"></i>
                <span>Mensagímetro</span>
            </div>

            <div class="start-menu-item" data-action="donations">
                <i class="fas fa-heart" style="color: #ff4081;"></i>
                <span>Doações</span>
            </div>

            <div class="start-menu-item" data-action="community">
                <i class="fas fa-users"></i>
                <span>Comunidade</span>
            </div>

            <div class="start-menu-item" data-action="statistics">
                <i class="fas fa-chart-bar"></i>
                <span>Estatísticas</span>
            </div>

            <div class="start-menu-item" data-action="help">
                <i class="fas fa-question-circle"></i>
                <span>Ajuda</span>
            </div>

            <div class="start-menu-item" data-action="imagine">
                <i class="fas fa-palette"></i>
                <span>Imagine</span>
            </div>

            <div class="start-menu-item" data-action="tts">
                <i class="fas fa-volume-up"></i>
                <span>TTS</span>
            </div>

            <div class="start-menu-item" data-action="stt">
                <i class="fas fa-microphone"></i>
                <span>STT</span>
            </div>

            <div class="start-menu-item" data-action="fishing">
                <i class="fas fa-fish"></i>
                <span>Galeria de Pesca</span>
            </div>

            <div class="start-menu-separator"></div>

            <div class="start-menu-item" data-url="https://github.com/moothz/ravena-ai">
                <i class="fab fa-github"></i>
                <span>Código no GitHub</span>
            </div>

            <div class="start-menu-item" data-action="invite">
                <i class="fas fa-envelope"></i>
                <span>Quero Uma!</span>
            </div>
        `;

        // Update Ravenas Submenu dynamically
        this.populateRavenasSubmenu();

        // Update Services Submenu dots
        this.updateServicesSubmenuDots();

        // Attach click actions
        container.querySelectorAll('.start-menu-item[data-action]').forEach(item => {
            item.addEventListener('click', (e) => {
                if (item.classList.contains('has-submenu')) return;
                const action = item.dataset.action;
                this.closeStartMenu();
                WindowManager.open(action);
            });
        });

        container.querySelectorAll('.start-menu-item[data-url]').forEach(item => {
            item.addEventListener('click', () => {
                this.closeStartMenu();
                window.open(item.dataset.url, '_blank');
            });
        });

        // Attach hover delay intent for submenus
        this.initSubmenuHoverDelay();
    },

    populateRavenasSubmenu() {
        const submenu = document.getElementById('start-submenu-ravenas');
        if (!submenu) return;

        const data = window.RavenaOS ? window.RavenaOS.state.healthData : null;
        if (!data || !data.bots || data.bots.length === 0) {
            submenu.innerHTML = '<div class="submenu-header">Nenhum bot carregado</div>';
            return;
        }

        let html = '<div class="submenu-header">Ravenas Ativas</div>';
        data.bots.forEach(bot => {
            let icon = '🐦‍⬛';
            if (bot.privado) icon = '🔒';
            else if (bot.vip) icon = '💎';
            else if (bot.comunitario) icon = '🐓';

            const cleanPhone = bot.phoneNumber ? String(bot.phoneNumber).replace(/\D/g, '') : '';
            const statusDot = !bot.connected ? 'dot-down' : (bot.banido ? 'dot-down' : 'dot-up');

            html += `
                <div class="submenu-item" style="flex-direction: column; align-items: flex-start; gap: 4px;">
                    <div style="display: flex; align-items: center; justify-content: space-between; width: 100%;">
                        <span style="display: flex; align-items: center; gap: 4px; font-weight: 600;">
                            <span class="service-status-dot ${statusDot}"></span>
                            ${icon} ${bot.id}
                        </span>
                    </div>
                    <div style="display: flex; gap: 6px; margin-left: 14px; margin-top: 2px;">
                        ${cleanPhone ? `
                            <a href="https://wa.me/${cleanPhone}" target="_blank" class="os-btn" style="font-size: 9px; padding: 2px 6px; background: #25d366; border-color: #25d366;">
                                <i class="fab fa-whatsapp"></i> Chamar
                            </a>
                        ` : ''}
                        <button class="os-btn btn-sm-bot-status" data-bot-id="${bot.id}" style="font-size: 9px; padding: 2px 6px;">
                            <i class="fas fa-info-circle"></i> Status
                        </button>
                    </div>
                </div>
            `;
        });

        submenu.innerHTML = html;

        submenu.querySelectorAll('.btn-sm-bot-status').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.closeStartMenu();
                WindowManager.open('status-detail', { botId: btn.dataset.botId });
            });
        });
    },

    updateServicesSubmenuDots() {
        const status = window.RavenaOS ? window.RavenaOS.state.serviceStatus : null;
        if (!status) return;

        const updateDot = (dotId, val) => {
            const el = document.getElementById(dotId);
            if (!el) return;
            el.className = 'service-status-dot';
            const state = typeof val === 'object' ? (val.status || 'up') : (val || 'unknown');
            if (state === 'up' || state === 'online' || state === 'ok') el.classList.add('dot-up');
            else if (state === 'down' || state === 'offline') el.classList.add('dot-down');
            else if (state === 'backup') el.classList.add('dot-backup');
            else el.classList.add('dot-unknown');
        };

        updateDot('sm-dot-whatsgo', status.whatsgoapi);
        updateDot('sm-dot-imagine', status.imagine);
        updateDot('sm-dot-llm', status.llm);
        updateDot('sm-dot-whisper', status.whisper);
        updateDot('sm-dot-f5tts', status.f5tts);
    },

    initSubmenuHoverDelay() {
        let activeSubmenuItem = null;
        let closeTimer = null;
        let switchTimer = null;

        const container = document.getElementById('start-menu-items');
        if (!container) return;

        const submenuItems = container.querySelectorAll('.start-menu-item.has-submenu');

        submenuItems.forEach((item) => {
            const submenu = item.querySelector('.start-submenu');
            if (!submenu) return;

            item.addEventListener('mouseenter', () => {
                if (closeTimer) {
                    clearTimeout(closeTimer);
                    closeTimer = null;
                }

                // If another submenu is already open, add a small 350ms switch buffer
                if (activeSubmenuItem && activeSubmenuItem !== item) {
                    if (switchTimer) clearTimeout(switchTimer);
                    switchTimer = setTimeout(() => {
                        if (activeSubmenuItem) activeSubmenuItem.classList.remove('submenu-open');
                        item.classList.add('submenu-open');
                        activeSubmenuItem = item;
                    }, 350);
                } else {
                    item.classList.add('submenu-open');
                    activeSubmenuItem = item;
                }
            });

            item.addEventListener('mouseleave', () => {
                if (switchTimer) {
                    clearTimeout(switchTimer);
                    switchTimer = null;
                }

                closeTimer = setTimeout(() => {
                    item.classList.remove('submenu-open');
                    if (activeSubmenuItem === item) activeSubmenuItem = null;
                }, 450); // 450ms buffer delay so user can easily mouse into submenu
            });

            submenu.addEventListener('mouseenter', () => {
                if (closeTimer) {
                    clearTimeout(closeTimer);
                    closeTimer = null;
                }
                if (switchTimer) {
                    clearTimeout(switchTimer);
                    switchTimer = null;
                }
                item.classList.add('submenu-open');
                activeSubmenuItem = item;
            });

            submenu.addEventListener('mouseleave', () => {
                closeTimer = setTimeout(() => {
                    item.classList.remove('submenu-open');
                    if (activeSubmenuItem === item) activeSubmenuItem = null;
                }, 450);
            });
        });
    },

    toggleStartMenu() {
        const menu = document.getElementById('start-menu');
        const btn = document.getElementById('start-btn');
        if (!menu) return;

        const isOpen = !menu.classList.contains('hidden');
        if (isOpen) {
            this.closeStartMenu();
        } else {
            menu.classList.remove('hidden');
            if (btn) btn.classList.add('active');
            this.populateRavenasSubmenu();
            this.updateServicesSubmenuDots();
        }
    },

    closeStartMenu() {
        const menu = document.getElementById('start-menu');
        const btn = document.getElementById('start-btn');
        if (menu) menu.classList.add('hidden');
        if (btn) btn.classList.remove('active');
    }
};

window.Taskbar = Taskbar;
