// window-manager.js - Central Window Manager wrapper for WinBox

const WindowManager = {
    windows: new Map(), // id -> { winbox, config, params }
    configs: {},        // type -> config object
    cascadeCount: 0,

    init() {
        // Tab / Alt+Tab keyboard cycle through windows
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Tab') {
                const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
                if (activeTag === 'input' || activeTag === 'textarea' || activeTag === 'select') {
                    return; // Don't intercept when user is typing
                }

                if (this.windows.size > 1) {
                    e.preventDefault();
                    this.cycleFocus(e.shiftKey ? -1 : 1);
                }
            }
        });
    },

    register(type, config) {
        this.configs[type] = config;
    },

    open(type, params = {}) {
        const config = this.configs[type];
        if (!config) {
            console.error(`Unknown window type: ${type}`);
            return null;
        }

        // Singleton check: if already open, focus it
        if (config.singleton && this.windows.has(type)) {
            const entry = this.windows.get(type);
            if (entry && entry.winbox) {
                if (entry.winbox.min) {
                    entry.winbox.restore();
                }
                entry.winbox.focus();
                return entry.winbox;
            }
        }

        const id = config.singleton ? type : `${type}-${Date.now()}`;
        const title = (params && params.title) || config.title || 'Janela';
        const taskbarIcon = (params && params.taskbarIcon) || config.taskbarIcon || 'fa-window-maximize';

        if (typeof WinBox === 'undefined') {
            console.error('WinBox is not loaded!');
            return null;
        }

        // Staggered positioning if not explicitly provided
        let posX = (params && params.x) || config.x;
        let posY = (params && params.y) || config.y;

        if (!posX && !posY) {
            const screenW = window.innerWidth;
            const screenH = window.innerHeight;
            const offsetX = 30 + ((this.cascadeCount * 28) % Math.max(100, screenW - 650));
            const offsetY = 30 + ((this.cascadeCount * 28) % Math.max(80, screenH - 520));
            this.cascadeCount++;
            posX = `${offsetX}px`;
            posY = `${offsetY}px`;
        }

        const width = (params && params.width) || config.width || '650px';
        const height = (params && params.height) || config.height || '460px';

        const customClasses = ['os-window', ...(config.classes || [])];
        if (params && params.class) {
            if (Array.isArray(params.class)) customClasses.push(...params.class);
            else customClasses.push(params.class);
        }

        const wb = new WinBox({
            id: `wb-${id}`,
            title: title,
            icon: config.icon || undefined,
            width: width,
            height: height,
            x: posX,
            y: posY,
            class: customClasses,
            border: 4,
            root: document.getElementById('desktop') || document.body,
            bottom: 48, // taskbar clearance

            onclose: () => {
                this.windows.delete(id);
                if (window.Taskbar) {
                    window.Taskbar.removeWindow(id);
                }
                if (typeof config.onclose === 'function') {
                    config.onclose(wb, params);
                }
                return false;
            },

            onfocus: () => {
                if (window.Taskbar) {
                    window.Taskbar.setActive(id);
                }
            },

            onblur: () => {
                if (window.Taskbar) {
                    window.Taskbar.setInactive(id);
                }
            },

            onminimize: () => {
                if (window.Taskbar) {
                    window.Taskbar.setMinimized(id);
                }
                return false;
            },

            onrestore: () => {
                if (window.Taskbar) {
                    window.Taskbar.setActive(id);
                }
            },

            onmaximize: () => {
                if (window.Taskbar) {
                    window.Taskbar.setActive(id);
                }
            }
        });

        // Store reference
        const entry = { id, winbox: wb, config, params };
        this.windows.set(id, entry);

        // Register in Taskbar
        if (window.Taskbar) {
            window.Taskbar.addWindow(id, title, taskbarIcon);
        }

        // Render content
        try {
            if (params && typeof params.customRender === 'function') {
                params.customRender(wb);
            } else if (typeof config.render === 'function') {
                config.render(wb, params);
            }
        } catch (err) {
            console.error(`Error rendering window ${type}:`, err);
            wb.body.innerHTML = `
                <div style="padding: 20px; color: #ff5555; text-align: center;">
                    <p>❌ Erro ao renderizar janela</p>
                    <p style="font-size: 11px; color: #aaa; margin-top: 8px;">${err.message}</p>
                </div>
            `;
        }

        return wb;
    },

    cycleFocus(direction = 1) {
        const list = Array.from(this.windows.values());
        if (list.length === 0) return;

        // Find active window index
        let activeIdx = list.findIndex(e => e.winbox && !e.winbox.min && document.activeElement && (e.winbox.dom === document.activeElement || e.winbox.dom.contains(document.activeElement)));
        if (activeIdx === -1) activeIdx = 0;

        let nextIdx = (activeIdx + direction + list.length) % list.length;
        const next = list[nextIdx];
        if (next && next.winbox) {
            if (next.winbox.min) next.winbox.restore();
            next.winbox.focus();
        }
    },

    close(id) {
        if (this.windows.has(id)) {
            const entry = this.windows.get(id);
            if (entry && entry.winbox) {
                entry.winbox.close();
            }
        }
    }
};

window.WindowManager = WindowManager;
WindowManager.init();
