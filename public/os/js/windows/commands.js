// windows/commands.js - Catálogo de comandos da RavenaBot (/cmd)

WindowManager.register('commands', {
    title: 'Comandos — RavenaBot',
    taskbarIcon: 'fa-terminal',
    width: '920px',
    height: '650px',
    singleton: true,
    class: ['os-window', 'window-commands'],

    render(wb) {
        const body = wb.body;
        body.classList.add('commands-body');

        body.innerHTML = `
            <iframe src="/cmd" class="commands-iframe" title="Comandos RavenaBot" allow="clipboard-read; clipboard-write"></iframe>
        `;
    },

    onclose(wb) {
        if (wb && wb.body) {
            wb.body.classList.remove('commands-body');
        }
    }
});
