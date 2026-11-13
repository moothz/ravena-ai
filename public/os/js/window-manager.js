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

    isMobileLayout() {
        if (window.RavenaOS && typeof window.RavenaOS.checkMobile === 'function') {
            return window.RavenaOS.checkMobile();
        }
        return window.innerWidth < 768;
    },

    register(type, config) {
        this.configs[type] = config;
    },

    open(type, params = {}) {
        if (this.isMobileLayout() && window.MobileApp) {
            return window.MobileApp.openApp(type, params);
        }

        const config = this.configs[type];
        if (!config) {
            console.error(`Unknown window type: ${type}`);
            return null;
        }

        // Singleton check: if already open, focus it (or clean up stale entry if already closed)
        if (config.singleton && this.windows.has(type)) {
            const entry = this.windows.get(type);
            if (entry && entry.winbox && entry.winbox.body) {
                if (entry.winbox.min) {
                    entry.winbox.restore();
                }
                entry.winbox.focus();
                return entry.winbox;
            }
            this.windows.delete(type);
            if (window.Taskbar) {
                window.Taskbar.removeWindow(type);
            }
        }

        const id = config.singleton ? type : `${type}-${Date.now()}`;
        const title = (params && params.title) || config.title || 'Janela';
        const taskbarIcon = (params && params.taskbarIcon) || config.taskbarIcon || 'fa-window-maximize';

        if (typeof WinBox === 'undefined') {
            console.error('WinBox is not loaded!');
            return null;
        }

        const screenW = window.innerWidth;
        const screenH = window.innerHeight;

        const rawWidth = (params && params.width) || config.width || '750px';
        let width = typeof rawWidth === 'function' ? rawWidth() : rawWidth;
        const rawHeight = (params && params.height) || config.height || '530px';
        let height = typeof rawHeight === 'function' ? rawHeight() : rawHeight;

        // Ensure window dimensions never overflow screen bounds
        let parsedW = parseInt(width) || 750;
        let parsedH = parseInt(height) || 530;

        const maxAvailableW = Math.max(280, screenW - 20);
        const maxAvailableH = Math.max(240, screenH - 68); // 48px taskbar clearance + margins

        if (parsedW > maxAvailableW) {
            parsedW = maxAvailableW;
            width = `${parsedW}px`;
        }
        if (parsedH > maxAvailableH) {
            parsedH = maxAvailableH;
            height = `${parsedH}px`;
        }

        // Staggered positioning if not explicitly provided
        let posX = (params && params.x) || config.x;
        let posY = (params && params.y) || config.y;

        if (!posX && !posY) {
            const leftMargin = screenW > 700 && window.Desktop ? window.Desktop.getIconsAreaRight() : 20;
            const maxWOffset = Math.max(20, screenW - leftMargin - parsedW);
            const maxHOffset = Math.max(20, screenH - 68 - parsedH);
            const offsetX = leftMargin + ((this.cascadeCount * 22) % maxWOffset);
            const offsetY = 20 + ((this.cascadeCount * 22) % maxHOffset);
            this.cascadeCount++;
            posX = `${offsetX}px`;
            posY = `${offsetY}px`;
        } else {
            let numX = parseInt(posX) || 20;
            let numY = parseInt(posY) || 20;
            if (numX + parsedW > screenW - 10) {
                numX = Math.max(10, screenW - parsedW - 10);
                posX = `${numX}px`;
            }
            if (numY + parsedH > screenH - 58) {
                numY = Math.max(10, screenH - parsedH - 58);
                posY = `${numY}px`;
            }
        }

        const customClasses = ['os-window', ...(config.classes || [])];
        if (params && params.class) {
            if (Array.isArray(params.class)) customClasses.push(...params.class);
            else customClasses.push(params.class);
        }

        // wb.cleanup idempotente: a janela atribui sua função de limpeza durante o render e ela
        // roda no máximo uma vez, mesmo que o onclose da janela também a chame manualmente.
        let cleanupFn = null;
        let cleanupDone = false;
        const runCleanup = () => {
            if (cleanupDone || !cleanupFn) return;
            cleanupDone = true;
            cleanupFn();
        };

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
                // Um onclose que lança erro não pode impedir a limpeza (listeners/timers) nem o
                // fechamento: se o erro subisse, o WinBox abortaria o close e a janela ficaria órfã.
                try {
                    if (typeof config.onclose === 'function') {
                        config.onclose(wb, params);
                    }
                } catch (err) {
                    console.error(`Error in onclose of window ${type}:`, err);
                } finally {
                    try {
                        runCleanup();
                    } catch (err) {
                        console.error(`Error in cleanup of window ${type}:`, err);
                    }
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

        Object.defineProperty(wb, 'cleanup', {
            configurable: true,
            enumerable: true,
            get: () => (cleanupFn ? runCleanup : undefined),
            set: (fn) => {
                cleanupFn = typeof fn === 'function' ? fn : null;
                cleanupDone = false;
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
                    <p style="font-size: 11px; color: #aaa; margin-top: 8px;">${Formatters.escapeHtml(err && err.message)}</p>
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
        if (this.isMobileLayout() && window.MobileApp) {
            window.MobileApp.closeApp();
            return;
        }
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
