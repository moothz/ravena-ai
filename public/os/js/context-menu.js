// context-menu.js - Retro OS Context Menu Manager

const ContextMenu = {
    el: null,

    init() {
        this.el = document.getElementById('context-menu');
        
        // Hide on any click outside
        document.addEventListener('click', () => this.hide());
        
        // Window blur also hides
        window.addEventListener('blur', () => this.hide());
    },

    show(e, items) {
        if (!this.el) this.init();
        if (!items || items.length === 0) return;

        let html = '';
        items.forEach((item, index) => {
            if (item.separator) {
                html += `<div class="ctx-separator"></div>`;
            } else {
                const iconHtml = item.icon ? `<i class="${item.icon}"></i>` : `<span class="ctx-no-icon"></span>`;
                const boldClass = item.bold ? 'ctx-bold' : '';
                html += `
                    <div class="ctx-item ${boldClass}" data-index="${index}">
                        ${iconHtml}
                        <span>${item.label}</span>
                    </div>
                `;
            }
        });

        this.el.innerHTML = html;

        // Position menu inside viewport
        this.el.style.visibility = 'hidden';
        this.el.classList.remove('hidden');

        const menuWidth = this.el.offsetWidth || 180;
        const menuHeight = this.el.offsetHeight || 120;
        const screenWidth = window.innerWidth;
        const screenHeight = window.innerHeight;

        let x = e.clientX;
        let y = e.clientY;

        if (x + menuWidth > screenWidth) {
            x = screenWidth - menuWidth - 8;
        }
        if (y + menuHeight > screenHeight - 48) { // 48px taskbar
            y = screenHeight - 48 - menuHeight - 8;
        }

        this.el.style.left = `${Math.max(8, x)}px`;
        this.el.style.top = `${Math.max(8, y)}px`;
        this.el.style.visibility = 'visible';

        // Attach click listeners to actionable items
        this.el.querySelectorAll('.ctx-item').forEach((itemEl) => {
            const idx = parseInt(itemEl.dataset.index, 10);
            const item = items[idx];
            itemEl.addEventListener('click', (ev) => {
                ev.stopPropagation();
                this.hide();
                if (typeof item.action === 'function') {
                    item.action();
                }
            });
        });
    },

    hide() {
        if (this.el) {
            this.el.classList.add('hidden');
        }
    }
};

window.ContextMenu = ContextMenu;
