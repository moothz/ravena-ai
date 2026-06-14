document.addEventListener('DOMContentLoaded', () => {
    // Placeholder help strings - to be filled with actual content
    const helpStrings = {
        'lbl-group-id': '[Fixo] O identificador único do seu grupo no WhatsApp.',
        'lbl-group-created-at': '[Fixo] A data e hora em que este grupo foi registrado no sistema.',
        'lbl-group-name': 'O nome atual do grupo. Você pode alterá-lo aqui, é usado para identicar o mesmo em comandos como !g-manage.',
        'lbl-group-prefix': 'O caractere usado para iniciar comandos (ex: !menu, .ajuda). <b>MUITO CUIDADO</b> ao definir este valor vazio.',
        'lbl-bot-enabled': 'Se desmarcado, o bot não responderá a nenhum comando neste grupo.',
        'lbl-bot-personality': 'Defina como o bot deve "pensar". Útil para respostas de IA e interaões ficarem mais conectadas com seu grupo.',
        'lbl-custom-ignores': 'Se ativado, comandos personalizados funcionarão mesmo sem o prefixo.',
        
        'lbl-ignored-numbers': 'Números que o bot irá ignorar completamente (não responderá).',
        'lbl-delete-links': 'Remove mensagens contendo links (exceto de admins).',
        'lbl-delete-nsfw': 'Tenta identificar e apagar imagens e vídeos impróprios (+18).',
        'lbl-forbidden-words': 'Mensagens com estas palavras serão apagadas automaticamente. <br><b>CUIDADO:</b> se tiver algo no meio da palavra, ele apaga também.',
        'lbl-forbidden-users': 'Apaga todas as mensagens enviadas por estes usuários específicos.<br><b>É difícil definir aqui devido a nova criptografia de números do whatsapp. Use o comando marcando a pessoa:<br><i>!g-filtro-pessoa @PessoaIgnorar</i>',
        'lbl-muted-categories': 'Desativa categorias inteiras de comandos (ex: não responder jogos).',
        'lbl-ignored-cmds': 'Comandos específicos que o bot deve ignorar (ex: !ping, ou emoji pra comandos ativados via reações).',
        'lbl-additional-admins': 'Números que terão permissão de admin no bot (e não são admins do grupo do whats).',
        
        'lbl-auto-stt': 'Converte áudios em texto automaticamente quando enviados.',
        'lbl-auto-interaction': 'O bot pode interagir sozinho em conversas aleatórias, lendo o contexto da conversa e imagens enviadas.',
        'lbl-interaction-chance': 'Probabilidade do bot interagir em uma mensagem (0.1% a 10%).',
        'lbl-interaction-cooldown': 'Tempo mínimo entre duas interações automáticas.',
        'lbl-auto-translate': 'Traduz automaticamente o que o bot envia para o idioma escolhido (usa LLM).',
        
        'lbl-greetings': 'Mensagens enviadas quando alguém entra no grupo. Use <b>{pessoa}</b> na mensagem para marcar quem entrou.',
        'lbl-farewells': 'Mensagens enviadas quando alguém sai ou é removido. Use <b>{pessoa}</b> na mensagem para marcar quem saiu.',
        
        'lbl-cmd-trigger': 'A palavra que aciona o comando, desconsiderando o prefixo (ex: "regras" para !regras).',
        'lbl-cmd-active': 'Desative para suspender o comando temporariamente sem deletar.',
        'lbl-cmd-interact': 'O bot pode usar este comando ao interagir automaticamente no grupo.',
        'lbl-cmd-reply-quote': 'Se o bot deve responder marcando a mensagem original.',
        'lbl-cmd-send-all': '[Ainda não implementado] Se marcado, envia TODAS as respostas definidas (não apenas uma aleatória).',
        'lbl-cmd-emoji': '[Opcional] O bot reagirá à mensagem com este emoji.',
        'lbl-cmd-cooldown': '[Opcional] Tempo mínimo (em segundos) que os usuários devem esperar entre usos deste comando. Use 0 para sem cooldown. Máximo: 60000s (~16,6 horas).',
        'lbl-cmd-responses': 'O que o bot deve responder. Pode ser texto ou mídia.',
        
        'lbl-stream-channel': 'O nome do canal na plataforma, apenas o nome, sem link.',
        'lbl-stream-mention': 'Menciona todos os membros (@everyone) quando a live começar.',
        'lbl-stream-ai': 'Usa IA para criar um texto convidativo baseado no jogo/título.',
        'lbl-stream-change-title': 'Altera o nome do grupo do WhatsApp quando a live começa/termina.',
        'lbl-stream-title-on': '(Opcional) Nome do grupo quando a live está ONLINE. Use {titulo} para o título da live (e outras variáveis).',
        'lbl-stream-title-off': '(Opcional) Nome do grupo quando a live está OFFLINE.'
    };

    const tooltip = document.getElementById('custom-tooltip');
    const tooltipContent = document.getElementById('tooltip-content');
    const tooltipClose = document.getElementById('tooltip-close');
    let activeIcon = null;

    // Inject Help Icons
    for (const [id, text] of Object.entries(helpStrings)) {
        const label = document.getElementById(id);
        if (label) {
            const icon = document.createElement('span');
            icon.className = 'help-icon';
            icon.textContent = '?'; // ?⃝ char could be used, but CSS styling creates the circle better
            icon.dataset.for = id;
            
            // Handle placement inside or after
            // If label has children (like input in some frameworks, but here labels are mostly text or wrap inputs)
            // We append to the label to keep it associated.
            label.appendChild(icon);
            
            setupEvents(icon, text);
        }
    }

    function setupEvents(icon, text) {
        // Desktop Hover
        icon.addEventListener('mouseenter', (e) => {
            if (window.matchMedia('(hover: hover)').matches) {
                showTooltip(icon, text);
            }
        });

        icon.addEventListener('mouseleave', (e) => {
            if (window.matchMedia('(hover: hover)').matches) {
                hideTooltip();
            }
        });

        // Click (Mobile & Desktop fallback)
        icon.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (activeIcon === icon && !tooltip.classList.contains('hidden')) {
                hideTooltip();
            } else {
                showTooltip(icon, text, true); // true = persistent (for click)
            }
        });
    }

    function showTooltip(targetIcon, htmlContent, persistent = false) {
        activeIcon = targetIcon;
        tooltipContent.innerHTML = htmlContent;
        tooltip.classList.remove('hidden');
        
        if (persistent || !window.matchMedia('(hover: hover)').matches) {
            tooltipClose.classList.remove('hidden');
        } else {
            tooltipClose.classList.add('hidden');
        }

        updatePosition(targetIcon);
    }

    function hideTooltip() {
        tooltip.classList.add('hidden');
        activeIcon = null;
    }

    function updatePosition(targetIcon) {
        const rect = targetIcon.getBoundingClientRect();
        const tooltipRect = tooltip.getBoundingClientRect();
        const scrollX = window.scrollX || window.pageXOffset;
        const scrollY = window.scrollY || window.pageYOffset;

        // Default: Top Center
        let top = rect.top + scrollY - tooltipRect.height - 10;
        let left = rect.left + scrollX + (rect.width / 2) - (tooltipRect.width / 2);

        // Adjust for viewport edges
        const viewportWidth = window.innerWidth;
        
        // Check left edge
        if (left < 10) left = 10;
        
        // Check right edge
        if (left + tooltipRect.width > viewportWidth - 10) {
            left = viewportWidth - tooltipRect.width - 10;
        }

        // Check top edge (if not enough space on top, show below)
        if (top < scrollY + 10) {
            top = rect.bottom + scrollY + 10;
        }

        tooltip.style.top = `${top}px`;
        tooltip.style.left = `${left}px`;
    }

    // Close on X click
    tooltipClose.addEventListener('click', (e) => {
        e.stopPropagation();
        hideTooltip();
    });

    // Close on click outside (mobile behavior)
    document.addEventListener('click', (e) => {
        if (!tooltip.classList.contains('hidden') && !e.target.classList.contains('help-icon') && !tooltip.contains(e.target)) {
            hideTooltip();
        }
    });

    // Re-position on resize/scroll
    window.addEventListener('resize', () => {
        if(activeIcon) updatePosition(activeIcon);
    });
});
