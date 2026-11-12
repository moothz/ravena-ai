document.addEventListener("DOMContentLoaded", () => {
	const botsContainer = document.getElementById("status-bots-container");
	const modalBackdrop = document.getElementById("bot-detail-modal");
	const modalTitle = document.getElementById("bot-modal-title");
	const modalBody = document.getElementById("bot-modal-body");
	const modalCloseBtn = document.getElementById("bot-modal-close");

	let healthData = null;
	const botMessageTimestamps = {};
	let activeModalBotId = null;

	function escapeHtml(value) {
		return String(value ?? "").replace(
			/[&<>"']/g,
			(c) =>
				({
					"&": "&amp;",
					"<": "&lt;",
					">": "&gt;",
					'"': "&quot;",
					"'": "&#39;"
				})[c]
		);
	}

	function getTimeSinceLastMessage(timestamp) {
		if (!timestamp) return Infinity;
		return Math.floor((Date.now() - timestamp) / 1000 / 60);
	}

	function formatTimeSince(minutes) {
		if (minutes === Infinity) return "Sem atividade registrada";
		if (minutes < 1) return "Ativa agora ✨";

		let timeText = "";
		if (minutes < 60) {
			timeText = `${minutes} ${minutes === 1 ? "minuto" : "minutos"}`;
		} else {
			const hours = Math.floor(minutes / 60);
			if (hours < 24) {
				timeText = `${hours} ${hours === 1 ? "hora" : "horas"}`;
			} else {
				const days = Math.floor(hours / 24);
				timeText = `${days} ${days === 1 ? "dia" : "dias"}`;
			}
		}

		return minutes < 15 ? `Ativa há ${timeText}` : `Sem atividade há ${timeText}`;
	}

	function formatPhoneNumber(number) {
		if (!number || typeof number !== "string") return "";
		const clean = number.replace(/\D/g, "");
		if (clean.length >= 12 && clean.startsWith("55")) {
			const country = clean.substring(0, 2);
			const ddd = clean.substring(2, 4);
			const part1 = clean.substring(4, clean.length - 4);
			const part2 = clean.substring(clean.length - 4);
			return `+${country} (${ddd}) ${part1}-${part2}`;
		}
		return number;
	}

	function getBotMsgsHr(bot) {
		let msgsHr = Math.round(bot.msgsHr || 0);
		if (botMessageTimestamps[bot.id]) {
			const now = Date.now();
			const recent = botMessageTimestamps[bot.id].filter((t) => now - t <= 60000);
			if (recent.length > 0) {
				msgsHr = recent.length * 60;
			}
		}
		return msgsHr;
	}

	function renderDriveItem(bot) {
		const isOffline = !bot.connected || bot.banido;
		const isBanned = !!bot.banido;

		const msgsHr = getBotMsgsHr(bot);
		const msgsPercent = Math.min(75, (msgsHr / 5000) * 75);
		const avgDelay = bot.responseTime ? bot.responseTime.avg || 0 : 0;
		const delayPercent = Math.min(25, ((avgDelay * 1000) / 30000) * 25);
		const totalPercent = Math.min(100, Math.max(5, msgsPercent + delayPercent));

		const hue = Math.max(0, 120 - totalPercent * 1.2);
		const barColor = `hsl(${hue}, 85%, 45%)`;

		const minutesSince = getTimeSinceLastMessage(bot.lastMessageReceived);
		let statusDotClass = "status-green";
		if (isBanned) {
			statusDotClass = "banned";
		} else if (!bot.connected || minutesSince > 15) {
			statusDotClass = "disconnected";
		} else if (minutesSince > 5) {
			statusDotClass = "status-red";
		} else if (minutesSince > 2) {
			statusDotClass = "status-yellow";
		}

		const barText = isBanned
			? "BANIDA"
			: !bot.connected
				? "DESCONECTADO"
				: `${msgsHr} msgs/hr, ${avgDelay.toFixed(1)}s delay`;

		const phone = bot.phoneNumber || "";
		const cleanPhone = phone ? String(phone).replace(/\D/g, "") : "";
		const safeId = escapeHtml(bot.id);

		return `
            <div class="drive-item ${isOffline ? "drive-offline" : ""}"
                 data-bot-id="${safeId}"
                 data-phone="${escapeHtml(phone)}"
                 role="button"
                 tabindex="0"
                 title="Clique para mais informações">
                <img src="/os/img/profiles/${encodeURIComponent(bot.id)}.jpg"
                     class="drive-icon"
                     onerror="this.onerror=null;this.src='/android-chrome-192x192.png';"
                     alt=""
                     width="44" height="44"
                     loading="lazy" decoding="async">
                <div class="drive-info">
                    <div class="drive-name">
                        <span class="status-dot ${statusDotClass}"></span>
                        <span>${safeId}</span>
                        ${bot.privado ? '<i class="fas fa-lock" style="font-size: 10px; color: #ff9800; margin-left: 4px;" title="Privada"></i>' : ""}
                    </div>
                    <div class="drive-bar">
                        <div class="drive-bar-fill" style="width: ${isOffline ? 100 : totalPercent}%; background: ${isOffline ? "#2a2a38" : barColor};"></div>
                        <span class="drive-bar-text ${isOffline ? "bar-text-offline" : ""}">${barText}</span>
                    </div>
                </div>
                ${
									cleanPhone
										? `
                    <a href="https://wa.me/${cleanPhone}" target="_blank" rel="noopener noreferrer" class="drive-wa-btn" title="Chamar no WhatsApp" aria-label="Chamar ${safeId} no WhatsApp">
                        <i class="fab fa-whatsapp"></i>
                    </a>
                `
										: ""
								}
            </div>
        `;
	}

	function renderBots() {
		if (!botsContainer) return;

		if (!healthData || !Array.isArray(healthData.bots) || healthData.bots.length === 0) {
			botsContainer.innerHTML = `
                <div class="status-loading">
                    <i class="fas fa-robot" style="color: #888;"></i>
                    <p>Nenhuma instância encontrada no momento.</p>
                </div>
            `;
			return;
		}

		const botsPrivados = healthData.bots.filter((b) => b.privado);
		const botsNormais = healthData.bots.filter((b) => !b.comunitario && !b.vip && !b.privado);
		const botsComunitarios = healthData.bots.filter((b) => b.comunitario && !b.privado);
		const botsVips = healthData.bots.filter((b) => b.vip && !b.privado);

		const sections = [];

		if (botsNormais.length > 0) {
			sections.push(`
                <div class="drive-category">
                    <h2 class="drive-category-title"><i class="fas fa-dove"></i> Ravenas Normais</h2>
                    <div class="drive-list">
                        ${botsNormais.map(renderDriveItem).join("")}
                    </div>
                </div>
            `);
		}

		if (botsComunitarios.length > 0) {
			sections.push(`
                <div class="drive-category">
                    <h2 class="drive-category-title"><i class="fas fa-users"></i> Ravenas Comunitárias ☭</h2>
                    <div class="drive-list">
                        ${botsComunitarios.map(renderDriveItem).join("")}
                    </div>
                </div>
            `);
		}

		if (botsVips.length > 0) {
			sections.push(`
                <div class="drive-category">
                    <h2 class="drive-category-title"><i class="fas fa-gem" style="color: var(--status-gold);"></i> Ravenas VIP</h2>
                    <div class="drive-list">
                        ${botsVips.map(renderDriveItem).join("")}
                    </div>
                </div>
            `);
		}

		if (botsPrivados.length > 0) {
			sections.push(`
                <div class="drive-category">
                    <h2 class="drive-category-title"><i class="fas fa-lock" style="color: #ff9800;"></i> Ravenas Privadas 🔒</h2>
                    <div class="drive-list">
                        ${botsPrivados.map(renderDriveItem).join("")}
                    </div>
                </div>
            `);
		}

		botsContainer.innerHTML = `<div class="meu-computador">${sections.join('<hr class="win-xp-separator">')}</div>`;

		botsContainer.querySelectorAll(".drive-item").forEach((el) => {
			const open = (e) => {
				if (e.target.closest(".drive-wa-btn")) return;
				const botId = el.dataset.botId;
				const bot = healthData.bots.find((b) => b.id === botId);
				if (bot) openBotModal(bot);
			};

			el.addEventListener("click", open);
			el.addEventListener("keydown", (e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					open(e);
				}
			});
		});

		botsContainer.querySelectorAll(".drive-wa-btn").forEach((a) => {
			a.addEventListener("click", (e) => e.stopPropagation());
		});
	}

	function updateLiveBars() {
		if (!healthData || !Array.isArray(healthData.bots) || !botsContainer) return;

		const now = Date.now();
		for (const botId of Object.keys(botMessageTimestamps)) {
			botMessageTimestamps[botId] = botMessageTimestamps[botId].filter((t) => now - t <= 60000);
		}

		healthData.bots.forEach((bot) => {
			const el = botsContainer.querySelector(`.drive-item[data-bot-id="${CSS.escape(bot.id)}"]`);
			if (!el || !bot.connected || bot.banido) return;

			const msgsHr = getBotMsgsHr(bot);
			const msgsPercent = Math.min(75, (msgsHr / 5000) * 75);
			const avgDelay = bot.responseTime ? bot.responseTime.avg || 0 : 0;
			const delayPercent = Math.min(25, ((avgDelay * 1000) / 30000) * 25);
			const totalPercent = Math.min(100, Math.max(5, msgsPercent + delayPercent));

			const hue = Math.max(0, 120 - totalPercent * 1.2);
			const barColor = `hsl(${hue}, 85%, 45%)`;

			const fillEl = el.querySelector(".drive-bar-fill");
			const textEl = el.querySelector(".drive-bar-text");

			if (fillEl) {
				fillEl.style.width = `${totalPercent}%`;
				fillEl.style.background = barColor;
			}
			if (textEl) {
				textEl.textContent = `${msgsHr} msgs/hr, ${avgDelay.toFixed(1)}s delay`;
			}
		});
	}

	function openBotModal(bot) {
		if (!modalBackdrop || !modalBody || !modalTitle) return;

		activeModalBotId = bot.id;
		const safeId = escapeHtml(bot.id);
		modalTitle.innerHTML = `<i class="fas fa-info-circle"></i> Detalhes: ${safeId}`;

		const phoneNumber = bot.phoneNumber ? formatPhoneNumber(bot.phoneNumber) : "Não informado";
		const cleanPhone = bot.phoneNumber ? String(bot.phoneNumber).replace(/\D/g, "") : "";
		const waUrl = cleanPhone ? `https://wa.me/${cleanPhone}` : "#";

		const respPhoneRaw = bot.numeroResponsavel || bot.responsible || bot.owner;
		const cleanRespPhone = respPhoneRaw ? String(respPhoneRaw).replace(/\D/g, "") : "";
		const respPhoneFormatted = respPhoneRaw ? formatPhoneNumber(String(respPhoneRaw)) : "";

		const minutesSince = getTimeSinceLastMessage(bot.lastMessageReceived);
		const lastSeenText = formatTimeSince(minutesSince);

		const avgDelay = bot.responseTime ? bot.responseTime.avg || 0 : 0;
		const maxDelay = bot.responseTime ? bot.responseTime.max || 0 : 0;
		const msgsHr = getBotMsgsHr(bot);

		let typeBadge = '<span style="color: var(--status-bright-blue);">🐦‍⬛ Oficial</span>';
		if (bot.privado) typeBadge = '<span style="color: #ff9800;">🔒 Privada</span>';
		else if (bot.vip) typeBadge = '<span style="color: var(--status-gold);">💎 VIP</span>';
		else if (bot.comunitario) typeBadge = '<span style="color: #ff6b6b;">🐓 Comunitária ☭</span>';

		let statusText = '<span style="color: var(--status-green);">● Online e Ativa</span>';
		if (bot.banido) statusText = '<span style="color: #ff4d4d;">● Banida</span>';
		else if (!bot.connected)
			statusText = '<span style="color: var(--status-gray);">● Desconectada</span>';
		else if (minutesSince > 15)
			statusText = '<span style="color: var(--status-gray);">● Inativa</span>';
		else if (minutesSince > 5)
			statusText = '<span style="color: var(--status-red);">● Alerta</span>';
		else if (minutesSince > 2)
			statusText = '<span style="color: var(--status-yellow);">● Atenção</span>';

		let comunitContent = "";
		if (bot.comunitario || cleanRespPhone) {
			const resp = escapeHtml(respPhoneFormatted || "Voluntário");
			comunitContent = `
                <div class="detail-card" style="grid-column: span 2; border-left: 2px solid #ff6b6b;">
                    <div class="detail-card-label">Responsável pela Ravena</div>
                    <div class="detail-card-value" style="font-size: 11px;">${resp}</div>
                    ${
											bot.supportMsg
												? `<p style="font-size: 10px; color: #b7b7c5; margin-top: 4px; font-style: italic;">"${escapeHtml(bot.supportMsg)}"</p>`
												: ""
										}
                </div>
            `;
		}

		modalBody.innerHTML = `
            <div class="bot-detail-view">
                <div class="bot-detail-header">
                    <img src="/os/img/profiles/${encodeURIComponent(bot.id)}.jpg"
                         class="bot-detail-avatar"
                         onerror="this.onerror=null;this.src='/android-chrome-192x192.png';"
                         alt="${safeId}">
                    <div class="bot-detail-title">
                        <h2>${safeId}</h2>
                        <p>${typeBadge} &nbsp;|&nbsp; ${statusText}</p>
                    </div>
                </div>

                <div class="bot-detail-grid">
                    <div class="detail-card">
                        <div class="detail-card-label">Telefone da Ravena</div>
                        <div class="detail-card-value" style="font-size: 11px;">${escapeHtml(phoneNumber)}</div>
                    </div>
                    <div class="detail-card">
                        <div class="detail-card-label">Fluxo / Hora</div>
                        <div class="detail-card-value">${msgsHr} msgs/h</div>
                    </div>
                    <div class="detail-card">
                        <div class="detail-card-label">Delay Médio</div>
                        <div class="detail-card-value">${avgDelay.toFixed(2)}s <span style="font-size: 10px; color: #888;">(máx ${maxDelay.toFixed(1)}s)</span></div>
                    </div>
                    <div class="detail-card">
                        <div class="detail-card-label">Última Atividade</div>
                        <div class="detail-card-value" style="font-size: 11px;">${escapeHtml(lastSeenText)}</div>
                    </div>
                    ${comunitContent}
                </div>

                <div style="display: flex; gap: 8px; margin-top: 4px; justify-content: flex-end; flex-wrap: wrap;">
                    ${
											cleanRespPhone
												? `
                        <a href="https://wa.me/${cleanRespPhone}" target="_blank" rel="noopener noreferrer" class="status-btn" style="background: linear-gradient(180deg, #f6ad55 0%, #d68910 100%); border-color: #f6ad55; color: #000;">
                            <i class="fab fa-whatsapp"></i> Chamar Responsável
                        </a>
                    `
												: ""
										}
                    ${
											cleanPhone
												? `
                        <a href="${waUrl}" target="_blank" rel="noopener noreferrer" class="status-btn" style="background: linear-gradient(180deg, #25d366 0%, #128c7e 100%); border-color: #25d366;">
                            <i class="fab fa-whatsapp"></i> Chamar no Whats
                        </a>
                    `
												: ""
										}
                </div>
            </div>
        `;

		modalBackdrop.hidden = false;
	}

	function closeBotModal() {
		if (!modalBackdrop) return;
		modalBackdrop.hidden = true;
		activeModalBotId = null;
	}

	if (modalCloseBtn) {
		modalCloseBtn.addEventListener("click", closeBotModal);
	}
	if (modalBackdrop) {
		modalBackdrop.addEventListener("click", (e) => {
			if (e.target === modalBackdrop) closeBotModal();
		});
	}
	document.addEventListener("keydown", (e) => {
		if (e.key === "Escape" && modalBackdrop && !modalBackdrop.hidden) {
			closeBotModal();
		}
	});

	async function fetchHealth() {
		try {
			const res = await fetch("/health", { credentials: "same-origin" });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			healthData = data;

			const now = Date.now();
			if (Array.isArray(data.bots)) {
				data.bots.forEach((bot) => {
					if (!botMessageTimestamps[bot.id]) {
						botMessageTimestamps[bot.id] = [];
						const initialCount = Math.round((bot.msgsHr || 0) / 60);
						for (let i = 0; i < initialCount; i++) {
							botMessageTimestamps[bot.id].push(now - Math.floor(Math.random() * 60000));
						}
					}
				});
			}

			renderBots();
		} catch (err) {
			if (!healthData && botsContainer) {
				botsContainer.innerHTML = `
                    <div class="status-loading">
                        <i class="fas fa-exclamation-triangle" style="color: #f6ad55;"></i>
                        <p>Erro ao carregar status: ${escapeHtml(err.message)}</p>
                    </div>
                `;
			}
		}
	}

	function connectSSE() {
		if (typeof EventSource === "undefined") return;
		try {
			const source = new EventSource("/api/stream");
			source.addEventListener("activity", (e) => {
				try {
					const data = JSON.parse(e.data);
					if (!data || !data.botId) return;

					if (!botMessageTimestamps[data.botId]) {
						botMessageTimestamps[data.botId] = [];
					}
					botMessageTimestamps[data.botId].push(Date.now());

					const iconEl = botsContainer?.querySelector(
						`.drive-item[data-bot-id="${CSS.escape(data.botId)}"] .drive-icon`
					);
					if (iconEl) {
						iconEl.classList.remove("avatar-flash");
						void iconEl.offsetWidth;
						iconEl.classList.add("avatar-flash");
					}

					if (activeModalBotId === data.botId && modalBackdrop && !modalBackdrop.hidden) {
						const avatar = modalBody?.querySelector(".bot-detail-avatar");
						if (avatar) {
							avatar.classList.remove("avatar-flash");
							void avatar.offsetWidth;
							avatar.classList.add("avatar-flash");
						}
					}
				} catch (_) {}
			});
		} catch (_) {}
	}

	fetchHealth();
	connectSSE();
	setInterval(fetchHealth, 30000);
	setInterval(updateLiveBars, 1000);
});
