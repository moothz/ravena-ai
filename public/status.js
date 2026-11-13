document.addEventListener("DOMContentLoaded", () => {
	const botsContainer = document.getElementById("status-bots-container");
	const botsSection = botsContainer ? botsContainer.closest(".status-bots-section") : null;
	const updatedEl = document.getElementById("status-updated");
	const alertEl = document.getElementById("status-alert");
	const pageContainer = document.querySelector("body > .container");
	const modalBackdrop = document.getElementById("bot-detail-modal");
	const modalTitle = document.getElementById("bot-modal-title");
	const modalBody = document.getElementById("bot-modal-body");
	const modalCloseBtn = document.getElementById("bot-modal-close");

	const HEALTH_INTERVAL_MS = 30000;
	const BARS_INTERVAL_MS = 1000;
	const HEALTH_TIMEOUT_MS = 15000;
	const FALLBACK_AVATAR = "/android-chrome-192x192.png";
	const MODAL_FOCUSABLE =
		'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

	let healthData = null;
	const botMessageTimestamps = {};
	let activeModalBotId = null;

	// Diferença (ms) entre o relógio do servidor (data.timestamp do /health) e o do navegador.
	// Evita que um relógio local adiantado/atrasado marque bots ativos como "Alerta"/"Inativa".
	let clockSkew = 0;
	// Horário (do servidor) dos dados exibidos, usado no "Atualizado às" e no aviso de falha.
	let lastUpdatedAt = null;
	// Assinatura da estrutura da grade no último render completo (bots, categorias e estado
	// online/offline). Se não mudar, os cards existentes são atualizados no lugar.
	let gridSignature = null;
	// Avatares que já falharam (404): usa o fallback direto, sem requisitar de novo a cada render.
	const failedAvatars = new Set();
	// Garante que apenas a resposta do /health mais recente seja aplicada.
	let fetchSeq = 0;

	let healthTimer = null;
	let barsTimer = null;
	let eventSource = null;

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

	/** Horário atual estimado no relógio do servidor. */
	function serverNow() {
		return Date.now() + clockSkew;
	}

	function getTimeSinceLastMessage(timestamp) {
		if (!timestamp) return Infinity;
		return Math.floor((serverNow() - timestamp) / 1000 / 60);
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

	function formatClock(timestamp) {
		return new Date(timestamp).toLocaleTimeString("pt-BR", {
			hour: "2-digit",
			minute: "2-digit"
		});
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

	function avatarSrc(botId) {
		return failedAvatars.has(String(botId))
			? FALLBACK_AVATAR
			: `/os/img/profiles/${encodeURIComponent(botId)}.jpg`;
	}

	function findDriveItems(botId) {
		if (!botsContainer) return [];
		return Array.from(
			botsContainer.querySelectorAll(`.drive-item[data-bot-id="${CSS.escape(String(botId))}"]`)
		);
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

	/** Calcula tudo o que é exibido em um card, para o render completo e a atualização no lugar. */
	function computeBotView(bot) {
		const isBanned = !!bot.banido;
		const isOffline = !bot.connected || isBanned;

		const msgsHr = getBotMsgsHr(bot);
		const msgsPercent = Math.min(75, (msgsHr / 5000) * 75);
		const avgDelay = bot.responseTime ? bot.responseTime.avg || 0 : 0;
		const delayPercent = Math.min(25, ((avgDelay * 1000) / 30000) * 25);
		const totalPercent = Math.min(100, Math.max(5, msgsPercent + delayPercent));
		const hue = Math.max(0, 120 - totalPercent * 1.2);

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

		return {
			isBanned,
			isOffline,
			statusDotClass,
			barText,
			barWidth: isOffline ? 100 : totalPercent,
			barColor: isOffline ? "#2a2a38" : `hsl(${hue}, 85%, 45%)`,
			cleanPhone: bot.phoneNumber ? String(bot.phoneNumber).replace(/\D/g, "") : ""
		};
	}

	function renderDriveItem(bot) {
		const view = computeBotView(bot);
		const phone = bot.phoneNumber || "";
		const safeId = escapeHtml(bot.id);

		return `
            <div class="drive-item ${view.isOffline ? "drive-offline" : ""}"
                 data-bot-id="${safeId}"
                 data-phone="${escapeHtml(phone)}"
                 role="button"
                 tabindex="0"
                 title="Clique para mais informações">
                <img src="${escapeHtml(avatarSrc(bot.id))}"
                     class="drive-icon"
                     data-avatar-bot-id="${safeId}"
                     alt=""
                     width="44" height="44"
                     loading="lazy" decoding="async">
                <div class="drive-info">
                    <div class="drive-name">
                        <span class="status-dot ${view.statusDotClass}"></span>
                        <span>${safeId}</span>
                        ${bot.privado ? '<i class="fas fa-lock" style="font-size: 10px; color: #ff9800; margin-left: 4px;" title="Privada"></i>' : ""}
                    </div>
                    <div class="drive-bar">
                        <div class="drive-bar-fill" style="width: ${view.barWidth}%; background: ${view.barColor};"></div>
                        <span class="drive-bar-text ${view.isOffline ? "bar-text-offline" : ""}">${escapeHtml(view.barText)}</span>
                    </div>
                </div>
                ${
									view.cleanPhone
										? `
                    <a href="https://wa.me/${view.cleanPhone}" target="_blank" rel="noopener noreferrer" class="drive-wa-btn" title="Chamar no WhatsApp" aria-label="Chamar ${safeId} no WhatsApp">
                        <i class="fab fa-whatsapp"></i>
                    </a>
                `
										: ""
								}
            </div>
        `;
	}

	/** Atualiza no lugar os cards de um bot (bolinha de status e barra), sem recriar o DOM. */
	function updateBotNodes(bot) {
		const items = findDriveItems(bot.id);
		if (items.length === 0) return;

		const view = computeBotView(bot);
		items.forEach((el) => {
			const dotEl = el.querySelector(".status-dot");
			const fillEl = el.querySelector(".drive-bar-fill");
			const textEl = el.querySelector(".drive-bar-text");

			if (dotEl) dotEl.className = `status-dot ${view.statusDotClass}`;
			if (fillEl) {
				fillEl.style.width = `${view.barWidth}%`;
				fillEl.style.background = view.barColor;
			}
			if (textEl && textEl.textContent !== view.barText) {
				textEl.textContent = view.barText;
			}
		});
	}

	/** Partes do bot que exigem recriar a grade (seções, cards, links); o resto muda no lugar. */
	function computeGridSignature(bots) {
		return JSON.stringify(
			bots.map((bot) => {
				const view = computeBotView(bot);
				return [
					String(bot.id),
					!!bot.privado,
					!!bot.vip,
					!!bot.comunitario,
					view.cleanPhone,
					view.isOffline,
					view.isBanned
				];
			})
		);
	}

	function renderBots() {
		if (!botsContainer) return;

		const bots = healthData && Array.isArray(healthData.bots) ? healthData.bots : [];
		const signature = computeGridSignature(bots);

		if (signature === gridSignature) {
			bots.forEach(updateBotNodes);
			return;
		}
		gridSignature = signature;

		if (bots.length === 0) {
			botsContainer.innerHTML = `
                <div class="status-loading">
                    <i class="fas fa-robot" style="color: #888;"></i>
                    <p>Nenhuma instância encontrada no momento.</p>
                </div>
            `;
			return;
		}

		const botsPrivados = bots.filter((b) => b.privado);
		const botsNormais = bots.filter((b) => !b.comunitario && !b.vip && !b.privado);
		const botsComunitarios = bots.filter((b) => b.comunitario && !b.privado);
		const botsVips = bots.filter((b) => b.vip && !b.privado);

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

		// Preserva o foco do teclado/leitor de tela através do re-render (card ou link do WhatsApp)
		let focusBotId = null;
		let focusWaBtn = false;
		const active = document.activeElement;
		if (active && botsContainer.contains(active)) {
			const item = active.closest(".drive-item");
			if (item) {
				focusBotId = item.dataset.botId;
				focusWaBtn = active.classList.contains("drive-wa-btn");
			}
		}

		botsContainer.innerHTML = `<div class="meu-computador">${sections.join('<hr class="win-xp-separator">')}</div>`;

		if (focusBotId !== null) {
			const item = findDriveItems(focusBotId)[0];
			const target = item && focusWaBtn ? item.querySelector(".drive-wa-btn") || item : item;
			if (target) target.focus({ preventScroll: true });
		}
	}

	function updateLiveBars() {
		if (!healthData || !Array.isArray(healthData.bots) || !botsContainer) return;

		const now = Date.now();
		for (const botId of Object.keys(botMessageTimestamps)) {
			botMessageTimestamps[botId] = botMessageTimestamps[botId].filter((t) => now - t <= 60000);
		}

		healthData.bots.forEach(updateBotNodes);
	}

	function findBot(botId) {
		if (!healthData || !Array.isArray(healthData.bots)) return null;
		return healthData.bots.find((b) => String(b.id) === String(botId)) || null;
	}

	function handleAvatarError(e) {
		const img = e.target;
		if (!(img instanceof HTMLImageElement) || img.dataset.avatarBotId === undefined) return;
		failedAvatars.add(img.dataset.avatarBotId);
		if (!img.src.endsWith(FALLBACK_AVATAR)) {
			img.src = FALLBACK_AVATAR;
		}
	}

	if (botsContainer) {
		// Delegação: os listeners sobrevivem aos re-renders da grade
		botsContainer.addEventListener("click", (e) => {
			if (e.target.closest(".drive-wa-btn")) return;
			const item = e.target.closest(".drive-item");
			if (!item) return;
			const bot = findBot(item.dataset.botId);
			if (bot) openBotModal(bot);
		});

		botsContainer.addEventListener("keydown", (e) => {
			const item = e.target.closest(".drive-item");
			// Só o próprio card trata Enter/Espaço: no link do WhatsApp aninhado, o Enter
			// precisa seguir o comportamento nativo e abrir o link.
			if (!item || e.target !== item) return;
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				const bot = findBot(item.dataset.botId);
				if (bot) openBotModal(bot);
			}
		});

		// Eventos "error" não borbulham: captura para cachear avatares inexistentes
		botsContainer.addEventListener("error", handleAvatarError, true);
	}
	if (modalBody) {
		modalBody.addEventListener("error", handleAvatarError, true);
	}

	function openBotModal(bot) {
		if (!modalBackdrop || !modalBody || !modalTitle) return;

		activeModalBotId = String(bot.id);
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
                    <img src="${escapeHtml(avatarSrc(bot.id))}"
                         class="bot-detail-avatar"
                         data-avatar-bot-id="${safeId}"
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
		// O restante da página fica inerte enquanto o diálogo (aria-modal) está aberto
		if (pageContainer) pageContainer.inert = true;
		modalBody.scrollTop = 0;
		if (modalCloseBtn) modalCloseBtn.focus();
	}

	function closeBotModal() {
		if (!modalBackdrop || modalBackdrop.hidden) return;
		modalBackdrop.hidden = true;
		if (pageContainer) pageContainer.inert = false;

		const returnBotId = activeModalBotId;
		activeModalBotId = null;

		// Devolve o foco ao card de origem (buscado de novo: a grade pode ter sido recriada)
		if (returnBotId !== null) {
			const item = findDriveItems(returnBotId)[0];
			if (item) item.focus();
		}
	}

	/** Mantém o Tab/Shift+Tab circulando dentro do diálogo aberto. */
	function trapModalFocus(e) {
		const modal = modalBackdrop.querySelector(".status-modal") || modalBackdrop;
		const focusable = Array.from(modal.querySelectorAll(MODAL_FOCUSABLE)).filter(
			(el) => el.getClientRects().length > 0
		);
		if (focusable.length === 0) {
			e.preventDefault();
			return;
		}

		const first = focusable[0];
		const last = focusable[focusable.length - 1];
		const active = document.activeElement;
		const outside = !modal.contains(active);

		if (e.shiftKey && (active === first || outside)) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && (active === last || outside)) {
			e.preventDefault();
			first.focus();
		}
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
		if (!modalBackdrop || modalBackdrop.hidden) return;
		if (e.key === "Escape") {
			e.preventDefault();
			closeBotModal();
		} else if (e.key === "Tab") {
			trapModalFocus(e);
		}
	});

	/** Dados recebidos com sucesso: mostra o horário e remove o aviso de falha. */
	function markFresh(timestamp) {
		lastUpdatedAt = Number.isFinite(timestamp) ? timestamp : serverNow();
		if (botsSection) botsSection.classList.remove("is-stale");
		if (updatedEl) updatedEl.textContent = `Atualizado às ${formatClock(lastUpdatedAt)}`;
		clearStaleBanner();
	}

	/** Falha após já haver dados na tela: sinaliza que o que está exibido está desatualizado. */
	function markStale(err) {
		if (botsSection) botsSection.classList.add("is-stale");

		const since = lastUpdatedAt ? formatClock(lastUpdatedAt) : null;
		if (updatedEl && since) updatedEl.textContent = `Dados de ${since} (desatualizados)`;
		if (!alertEl) return;

		const reason = err && err.message ? err.message : "erro desconhecido";
		const text = `Falha ao atualizar o status (${reason}).${since ? ` Exibindo dados de ${since};` : ""} nova tentativa em instantes.`;
		// Só reescreve se mudou, para o leitor de tela não repetir o aviso a cada tentativa
		if (alertEl.dataset.message === text) return;
		alertEl.dataset.message = text;
		alertEl.innerHTML = `
            <div class="status-stale-banner">
                <i class="fas fa-exclamation-triangle" aria-hidden="true"></i>
                <span>${escapeHtml(text)}</span>
            </div>
        `;
	}

	function clearStaleBanner() {
		if (alertEl && alertEl.dataset.message !== undefined) {
			delete alertEl.dataset.message;
			alertEl.innerHTML = "";
		}
	}

	async function fetchHealth() {
		const seq = ++fetchSeq;
		const controller = typeof AbortController === "function" ? new AbortController() : null;
		const timeout = controller ? setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS) : null;

		try {
			const res = await fetch("/health", {
				credentials: "same-origin",
				signal: controller ? controller.signal : undefined
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			if (!data || data.status === "error") {
				throw new Error((data && data.message) || "resposta inválida");
			}
			if (seq !== fetchSeq) return;

			healthData = data;
			if (Number.isFinite(data.timestamp)) {
				clockSkew = data.timestamp - Date.now();
			}

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

			markFresh(data.timestamp);
			renderBots();
		} catch (err) {
			if (seq !== fetchSeq) return;
			const error =
				err && err.name === "AbortError" ? new Error("tempo de resposta esgotado") : err;

			if (!healthData) {
				if (botsContainer) {
					gridSignature = null;
					botsContainer.innerHTML = `
                    <div class="status-loading">
                        <i class="fas fa-exclamation-triangle" style="color: #f6ad55;"></i>
                        <p>Erro ao carregar status: ${escapeHtml(error && error.message)}</p>
                    </div>
                `;
				}
			} else {
				markStale(error);
			}
		} finally {
			if (timeout) clearTimeout(timeout);
		}
	}

	function onActivity(e) {
		try {
			const data = JSON.parse(e.data);
			if (!data || !data.botId) return;

			if (!botMessageTimestamps[data.botId]) {
				botMessageTimestamps[data.botId] = [];
			}
			botMessageTimestamps[data.botId].push(Date.now());

			const iconEl = botsContainer?.querySelector(
				`.drive-item[data-bot-id="${CSS.escape(String(data.botId))}"] .drive-icon`
			);
			if (iconEl) {
				iconEl.classList.remove("avatar-flash");
				void iconEl.offsetWidth;
				iconEl.classList.add("avatar-flash");
			}

			if (activeModalBotId === String(data.botId) && modalBackdrop && !modalBackdrop.hidden) {
				const avatar = modalBody?.querySelector(".bot-detail-avatar");
				if (avatar) {
					avatar.classList.remove("avatar-flash");
					void avatar.offsetWidth;
					avatar.classList.add("avatar-flash");
				}
			}
		} catch (_) {}
	}

	function connectSSE() {
		if (eventSource || typeof EventSource === "undefined") return;
		try {
			eventSource = new EventSource("/api/stream");
			eventSource.addEventListener("activity", onActivity);
		} catch (_) {
			eventSource = null;
		}
	}

	function disconnectSSE() {
		if (eventSource) {
			eventSource.close();
			eventSource = null;
		}
	}

	/** Liga SSE e timers (somente com a aba visível). */
	function startLiveUpdates() {
		connectSSE();
		if (!healthTimer) healthTimer = setInterval(fetchHealth, HEALTH_INTERVAL_MS);
		if (!barsTimer) barsTimer = setInterval(updateLiveBars, BARS_INTERVAL_MS);
	}

	/** Pausa SSE e timers enquanto a aba está oculta. */
	function stopLiveUpdates() {
		disconnectSSE();
		if (healthTimer) {
			clearInterval(healthTimer);
			healthTimer = null;
		}
		if (barsTimer) {
			clearInterval(barsTimer);
			barsTimer = null;
		}
	}

	document.addEventListener("visibilitychange", () => {
		if (document.hidden) {
			stopLiveUpdates();
		} else {
			fetchHealth();
			startLiveUpdates();
		}
	});

	fetchHealth();
	if (!document.hidden) startLiveUpdates();
});
