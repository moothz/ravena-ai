// windows/waifuletes.js - Waifuletes Window Component for Ravena Desktop OS & Mobile

WindowManager.register('waifuletes', {
    title: 'Waifuletes ✨',
    taskbarIcon: 'fa-heart',
    width: '560px',
    height: '460px',
    singleton: true,

    render(wb) {
        const body = wb.body;

        body.innerHTML = `
            <div class="waifu-redirect-container">
                <div class="waifu-redirect-header">
                    <h2 class="waifu-redirect-title">O Waifuletes agora tem site próprio!</h2>
                </div>

                <div class="waifu-redirect-card">
                    <p class="waifu-redirect-text">
                        Envie <code class="waifu-command-tag" data-copy="!mu-adm" title="Clique para copiar">!mu-adm</code> para uma das ravenas e conheça o novo painel administrativo onde você gerenciar seu harém, colocar waifus/husbandos na wishlist, sugerir mudanças e mais!
                    </p>

                    <p class="waifu-redirect-text">
                        Você pode compartilhar o link do seu harém com os amigos, pegue ele usando <code class="waifu-command-tag" data-copy="!mu-compartilhar" title="Clique para copiar">!mu-compartilhar</code>
                    </p>
                </div>

                <div class="waifu-redirect-cta-section">
                    <span class="waifu-redirect-cta-label">Acesse agora:</span>
                    <div class="waifu-redirect-links">
                        <a href="https://waifuletes.moothz.win/" target="_blank" rel="noopener noreferrer" class="waifu-redirect-icon-link" title="Acessar Waifuletes (waifuletes.moothz.win)">
                            <img src="img/icons/waifuletes.svg" alt="Waifuletes" class="waifu-redirect-icon">
                        </a>
                        <a href="https://waifuletes.moothz.win/" target="_blank" rel="noopener noreferrer" class="waifu-redirect-url-link">
                            <span>https://waifuletes.moothz.win/</span>
                            <i class="fas fa-external-link-alt"></i>
                        </a>
                    </div>
                </div>
            </div>
        `;

        body.querySelectorAll('.waifu-command-tag').forEach((el) => {
            el.addEventListener('click', () => {
                const cmd = el.getAttribute('data-copy') || el.textContent.trim();
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(cmd).then(() => {
                        this.showCopied(el);
                    }).catch(() => {
                        this.fallbackCopy(cmd, el);
                    });
                } else {
                    this.fallbackCopy(cmd, el);
                }
            });
        });
    },

    showCopied(el) {
        const originalText = el.textContent;
        el.textContent = 'Copiado!';
        el.classList.add('copied');
        setTimeout(() => {
            el.textContent = originalText;
            el.classList.remove('copied');
        }, 1500);
    },

    fallbackCopy(cmd, el) {
        try {
            const ta = document.createElement('textarea');
            ta.value = cmd;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            this.showCopied(el);
        } catch (_) {}
    }
});
