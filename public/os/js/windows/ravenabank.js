// windows/ravenabank.js - RavenaBank Window Component for Ravena Desktop OS & Mobile

WindowManager.register("ravenabank", {
	title: "RavenaBank 🏛️",
	taskbarIcon: "fa-landmark",
	width: "900px",
	height: "640px",
	singleton: true,

	render(wb) {
		const body = wb.body;
		body.innerHTML = `
            <div style="display: flex; flex-direction: column; width: 100%; height: 100%; background: #05060d;">
                <div style="padding: 8px 12px; background: #0d101d; border-bottom: 1px solid #242945; display: flex; justify-content: space-between; align-items: center; font-size: 11px; flex-shrink: 0;">
                    <span style="color: #94a3b8;">
                        <i class="fas fa-landmark" style="color: #04a9f0; margin-right: 4px;"></i> <strong>RavenaBank</strong> — Banco Central & Câmbio de Runas
                    </span>
                    <a href="/ravenabank" target="_blank" rel="noopener noreferrer" class="os-btn" style="font-size: 11px; padding: 3px 8px; text-decoration: none; color: #fff;">
                        <i class="fas fa-external-link-alt"></i> Abrir em Nova Aba
                    </a>
                </div>
                <iframe src="/ravenabank" style="flex: 1; width: 100%; height: 100%; border: none; background: #05060d;"></iframe>
            </div>
        `;
	}
});
