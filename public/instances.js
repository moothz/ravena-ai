/**
 * Gerenciador de Instâncias e Bots da Ravena
 * Layout Moderno, Sanfonas Múltiplas, Controles Coerentes e Sincronização em Tempo Real
 */
document.addEventListener("DOMContentLoaded", () => {
	// Referências DOM
	const instancesContainer = document.getElementById("instances-container");
	const loadingBox = document.getElementById("loading-box");
	const errorBox = document.getElementById("error-box");
	const errorMessage = document.getElementById("error-message");
	const emptyState = document.getElementById("empty-state");
	const toastContainer = document.getElementById("toast-container");

	// Controles & Botões
	const searchInput = document.getElementById("search-input");
	const btnClearSearch = document.getElementById("btn-clear-search");
	const filterPills = document.querySelectorAll(".filter-pills .cat-pill");
	const btnExpandAll = document.getElementById("btn-expand-all");
	const btnCollapseAll = document.getElementById("btn-collapse-all");
	const btnRefresh = document.getElementById("btn-refresh");
	const refreshIcon = document.getElementById("refresh-icon");
	const btnSaveAll = document.getElementById("btn-save-all");
	const unsavedIndicator = document.getElementById("unsaved-indicator");
	const btnNewInstance = document.getElementById("btn-new-instance");
	const btnRetry = document.getElementById("btn-retry");

	// Sumário
	const sumTotal = document.getElementById("sum-total");
	const sumEnabled = document.getElementById("sum-enabled");
	const sumDisabled = document.getElementById("sum-disabled");
	const sumOnline = document.getElementById("sum-online");
	const sumOffline = document.getElementById("sum-offline");
	const sumPrivate = document.getElementById("sum-private");
	const sumGroups = document.getElementById("sum-groups");
	const sumMsgs = document.getElementById("sum-msgs");

	// Estado da Aplicação
	let allBots = [];
	let currentFilter = "all";
	let currentSearch = "";
	const openBotIds = new Set(); // Preserva quais sanfonas estão abertas
	let isSaving = false;
	let hasUnsavedChanges = false;

	// Gestão de estado de edição para evitar perdas acidentais em auto-refreshes
	function markDirty() {
		if (!hasUnsavedChanges) {
			hasUnsavedChanges = true;
			if (unsavedIndicator) unsavedIndicator.classList.remove("hidden");
			if (btnSaveAll) {
				btnSaveAll.title = "Existem alterações pendentes! Clique para salvar tudo.";
			}
		}
	}

	function markClean() {
		hasUnsavedChanges = false;
		if (unsavedIndicator) unsavedIndicator.classList.add("hidden");
		if (btnSaveAll) {
			btnSaveAll.title = "Salvar todas as alterações em tempo real";
		}
	}

	function isUserEditing() {
		if (hasUnsavedChanges) return true;
		const pubModal = document.getElementById("publish-status-modal");
		if (pubModal && !pubModal.classList.contains("hidden")) return true;
		const active = document.activeElement;
		if (
			active &&
			(active.tagName === "INPUT" ||
				active.tagName === "TEXTAREA" ||
				active.tagName === "SELECT" ||
				active.isContentEditable)
		) {
			return true;
		}
		if (Array.isArray(allBots) && allBots.some((b) => b.isNew)) return true;
		return false;
	}

	// Toast Notification
	function showToast(message, type = "info", duration = 4000) {
		const toast = document.createElement("div");
		toast.className = `toast ${type}`;

		const iconClass =
			type === "success"
				? "fa-check-circle"
				: type === "error"
					? "fa-exclamation-triangle"
					: "fa-info-circle";
		toast.innerHTML = `<i class="fas ${iconClass}"></i><span>${message}</span>`;

		toastContainer.appendChild(toast);
		// Animação de entrada
		setTimeout(() => toast.classList.add("show"), 10);

		setTimeout(() => {
			toast.classList.remove("show");
			setTimeout(() => toast.remove(), 300);
		}, duration);
	}

	// Gerador de senha aleatória segura
	function generateSecurePassword(length = 16) {
		const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%&*";
		let res = "";
		for (let i = 0; i < length; i++) {
			res += chars.charAt(Math.floor(Math.random() * chars.length));
		}
		return res;
	}

	// Formatação de telefone
	function formatPhoneNumber(num) {
		if (!num) return "-";
		const clean = String(num).replace(/\D/g, "");
		if (clean.length === 12 || clean.length === 13) {
			const ddd = clean.slice(2, 4);
			const part1 = clean.length === 13 ? clean.slice(4, 9) : clean.slice(4, 8);
			const part2 = clean.length === 13 ? clean.slice(9) : clean.slice(8);
			return `+55 (${ddd}) ${part1}-${part2}`;
		}
		return num;
	}

	// Formatação de tempo decorrido
	function formatTimeSince(timestamp) {
		if (!timestamp) return "Sem dados";
		const diffMs = Date.now() - Number(timestamp);
		if (diffMs < 0) return "Agora mesmo";
		const mins = Math.floor(diffMs / 60000);
		if (mins < 1) return "Menos de 1 min";
		if (mins < 60) return `${mins} min atrás`;
		const hrs = Math.floor(mins / 60);
		if (hrs < 24) return `${hrs}h atrás`;
		const days = Math.floor(hrs / 24);
		return `${days}d atrás`;
	}

	// Atualização em tempo real suave apenas dos cabeçalhos e status das instâncias (sem recriar formulários nem inputs)
	function updateBotRuntimeInPlace(freshBots) {
		if (!instancesContainer) return;
		freshBots.forEach((bot) => {
			const card = instancesContainer.querySelector(
				`.bot-accordion[data-bot-name="${bot.nome}"]`
			);
			if (!card) return;

			const isEnabled = bot.enabled !== false;
			const isOnline = Boolean(bot.connected && !bot.banido && isEnabled);
			const isBanned = Boolean(bot.banido);
			const platform = bot.useTelegram ? "Telegram" : bot.useDiscord ? "Discord" : "WhatsApp";

			card.classList.remove(
				"status-online",
				"status-offline",
				"status-disabled",
				"status-banned"
			);
			let statusClass = "status-offline";
			let statusBadge =
				'<span class="badge badge-offline"><i class="fas fa-times-circle"></i> Offline</span>';

			if (!isEnabled) {
				statusClass = "status-disabled";
				statusBadge =
					'<span class="badge badge-disabled"><i class="fas fa-power-off"></i> Desativada</span>';
			} else if (isBanned) {
				statusClass = "status-banned";
				statusBadge = '<span class="badge badge-banned"><i class="fas fa-ban"></i> Banida</span>';
			} else if (isOnline) {
				statusClass = "status-online";
				statusBadge =
					'<span class="badge badge-online"><i class="fas fa-check-circle"></i> Online</span>';
			}
			card.classList.add(statusClass);

			const platformIcon =
				platform === "Telegram"
					? '<i class="fab fa-telegram" style="color:#2AABEE;"></i>'
					: platform === "Discord"
						? '<i class="fab fa-discord" style="color:#5865F2;"></i>'
						: '<i class="fab fa-whatsapp" style="color:#25D366;"></i>';

			const msgsHr = Math.round(bot.msgsHr || 0);
			const groupsCount = bot.groupsCount || 0;
			const avgDelay = bot.responseTime ? bot.responseTime.avg || 0 : 0;

			const headerMain = card.querySelector(".bot-header-main");
			if (headerMain) {
				headerMain.innerHTML = `
					<span class="bot-title">
						${platformIcon}
						<span>${escapeHtml(bot.nomeExibir || bot.nome)}</span>
						${bot.nomeExibir && bot.nomeExibir !== bot.nome ? `<small style="font-size:0.75rem; color:var(--text-muted);">(${escapeHtml(bot.nome)})</small>` : ""}
					</span>
					${statusBadge}
					${bot.privado ? '<span class="badge badge-private"><i class="fas fa-lock"></i> Privada</span>' : ""}
					${bot.vip ? '<span class="badge badge-vip"><i class="fas fa-gem"></i> VIP</span>' : ""}
					${bot.comunitario ? '<span class="badge badge-community"><i class="fas fa-hands-helping"></i> Comunitária</span>' : ""}
					<span class="badge badge-platform">${platform}</span>
					<span class="badge badge-stat" title="Mensagens por hora"><i class="fas fa-envelope"></i> ${msgsHr} msgs/h</span>
					<span class="badge badge-stat" title="Grupos conectados"><i class="fas fa-users"></i> ${groupsCount} grupos</span>
					${avgDelay > 0 ? `<span class="badge badge-stat" title="Delay médio de resposta">⚡ ${avgDelay.toFixed(1)}s</span>` : ""}
				`;
			}
		});
	}

	// Carregamento dos dados dos bots
	async function fetchBots(isBackground = false) {
		if (isBackground && isUserEditing()) {
			return;
		}

		if (!isBackground) {
			loadingBox.style.display = "block";
			errorBox.style.display = "none";
			emptyState.style.display = "none";
		}

		if (refreshIcon) refreshIcon.classList.add("fa-spin");

		try {
			const response = await fetch("/api/bots");
			if (!response.ok) {
				throw new Error(`Erro na API (${response.status}): ${response.statusText}`);
			}

			const data = await response.json();
			if (!Array.isArray(data)) {
				throw new Error("Formato inválido retornado pela API.");
			}

			const sameBots =
				allBots.length === data.length &&
				allBots.every((b, i) => b.nome === data[i].nome);

			allBots = data;
			updateSummaryCounters();

			if (isBackground && sameBots && instancesContainer && instancesContainer.children.length > 0) {
				updateBotRuntimeInPlace(data);
			} else {
				renderBotAccordions();
			}

			loadingBox.style.display = "none";
		} catch (err) {
			console.error("Erro ao carregar bots:", err);
			if (!isBackground) {
				loadingBox.style.display = "none";
				errorBox.style.display = "block";
				errorMessage.textContent = err.message || "Falha na conexão com o servidor.";
			}
			showToast(`Erro ao carregar bots: ${err.message}`, "error");
		} finally {
			if (refreshIcon) refreshIcon.classList.remove("fa-spin");
		}
	}

	// Atualização dos contadores do Hero
	function updateSummaryCounters() {
		const total = allBots.length;
		let enabledCount = 0;
		let disabledCount = 0;
		let onlineCount = 0;
		let offlineCount = 0;
		let privateCount = 0;
		let totalGroups = 0;
		let totalMsgs = 0;

		allBots.forEach((bot) => {
			const isEnabled = bot.enabled !== false;
			const isOnline = Boolean(bot.connected && !bot.banido && isEnabled);

			if (isEnabled) enabledCount++;
			else disabledCount++;

			if (isOnline) onlineCount++;
			else offlineCount++;

			if (bot.privado) privateCount++;
			totalGroups += bot.groupsCount || 0;
			totalMsgs += Math.round(bot.msgsHr || 0);
		});

		sumTotal.textContent = total;
		sumEnabled.textContent = enabledCount;
		sumDisabled.textContent = disabledCount;
		sumOnline.textContent = onlineCount;
		sumOffline.textContent = offlineCount;
		sumPrivate.textContent = privateCount;
		sumGroups.textContent = totalGroups.toLocaleString("pt-BR");
		sumMsgs.textContent = totalMsgs.toLocaleString("pt-BR");
	}

	// Renderização das Sanfonas
	function renderBotAccordions() {
		instancesContainer.innerHTML = "";
		const searchLower = currentSearch.toLowerCase().trim();

		const filtered = allBots.filter((bot) => {
			// Filtro por texto
			const matchesSearch =
				!searchLower ||
				(bot.nome && bot.nome.toLowerCase().includes(searchLower)) ||
				(bot.nomeExibir && bot.nomeExibir.toLowerCase().includes(searchLower)) ||
				(bot.numero && String(bot.numero).includes(searchLower)) ||
				(bot.telegramBotName && bot.telegramBotName.toLowerCase().includes(searchLower));

			if (!matchesSearch) return false;

			// Filtro por botões
			const isEnabled = bot.enabled !== false;
			const isOnline = Boolean(bot.connected && !bot.banido && isEnabled);
			const isOffline = !isOnline;

			if (currentFilter === "enabled") return isEnabled;
			if (currentFilter === "disabled") return !isEnabled;
			if (currentFilter === "online") return isOnline;
			if (currentFilter === "offline") return isOffline;
			if (currentFilter === "whatsapp") return !bot.useTelegram && !bot.useDiscord;
			if (currentFilter === "telegram") return Boolean(bot.useTelegram);
			if (currentFilter === "discord") return Boolean(bot.useDiscord);

			return true;
		});

		if (filtered.length === 0) {
			emptyState.style.display = "block";
			return;
		} else {
			emptyState.style.display = "none";
		}

		filtered.forEach((bot) => {
			const accordion = createBotAccordionElement(bot);
			instancesContainer.appendChild(accordion);
		});
	}

	// Criação do elemento de sanfona para uma instância
	function createBotAccordionElement(bot) {
		const isEnabled = bot.enabled !== false;
		const isOnline = Boolean(bot.connected && !bot.banido && isEnabled);
		const isBanned = Boolean(bot.banido);
		const platform = bot.useTelegram ? "Telegram" : bot.useDiscord ? "Discord" : "WhatsApp";

		let statusClass = "status-offline";
		let statusBadge =
			'<span class="badge badge-offline"><i class="fas fa-times-circle"></i> Offline</span>';

		if (!isEnabled) {
			statusClass = "status-disabled";
			statusBadge =
				'<span class="badge badge-disabled"><i class="fas fa-power-off"></i> Desativada</span>';
		} else if (isBanned) {
			statusClass = "status-banned";
			statusBadge = '<span class="badge badge-banned"><i class="fas fa-ban"></i> Banida</span>';
		} else if (isOnline) {
			statusClass = "status-online";
			statusBadge =
				'<span class="badge badge-online"><i class="fas fa-check-circle"></i> Online</span>';
		}

		const platformIcon =
			platform === "Telegram"
				? '<i class="fab fa-telegram" style="color:#2AABEE;"></i>'
				: platform === "Discord"
					? '<i class="fab fa-discord" style="color:#5865F2;"></i>'
					: '<i class="fab fa-whatsapp" style="color:#25D366;"></i>';

		const isOpen = openBotIds.has(bot.nome);

		const card = document.createElement("div");
		card.className = `bot-accordion ${statusClass} ${isOpen ? "active" : ""}`;
		card.dataset.botName = bot.nome;

		const rawPhone = bot.numero ? String(bot.numero).replace(/\D/g, "") : "";
		const cleanPhone = formatPhoneNumber(rawPhone);
		const chatUrl =
			platform === "Telegram"
				? `https://t.me/${bot.telegramBotName || bot.nome}`
				: `https://wa.me/${rawPhone}`;

		const msgsHr = Math.round(bot.msgsHr || 0);
		const groupsCount = bot.groupsCount || 0;
		const avgDelay = bot.responseTime ? bot.responseTime.avg || 0 : 0;

		card.innerHTML = `
            <div class="bot-accordion-header">
                <div class="bot-header-main">
                    <span class="bot-title">
                        ${platformIcon}
                        <span>${bot.nomeExibir || bot.nome}</span>
                        ${bot.nomeExibir && bot.nomeExibir !== bot.nome ? `<small style="font-size:0.75rem; color:var(--text-muted);">(${bot.nome})</small>` : ""}
                    </span>
                    ${statusBadge}
                    ${bot.privado ? '<span class="badge badge-private"><i class="fas fa-lock"></i> Privada</span>' : ""}
                    ${bot.vip ? '<span class="badge badge-vip"><i class="fas fa-gem"></i> VIP</span>' : ""}
                    ${bot.comunitario ? '<span class="badge badge-community"><i class="fas fa-hands-helping"></i> Comunitária</span>' : ""}
                    <span class="badge badge-platform">${platform}</span>
                    <span class="badge badge-stat" title="Mensagens por hora"><i class="fas fa-envelope"></i> ${msgsHr} msgs/h</span>
                    <span class="badge badge-stat" title="Grupos conectados"><i class="fas fa-users"></i> ${groupsCount} grupos</span>
                    ${avgDelay > 0 ? `<span class="badge badge-stat" title="Delay médio de resposta">⚡ ${avgDelay.toFixed(1)}s</span>` : ""}
                </div>
                <i class="fas fa-chevron-down bot-arrow"></i>
            </div>

            <div class="bot-accordion-body">
                <!-- Seção 0: Tipo de Plataforma -->
                <div class="form-section">
                    <div class="form-section-title"><i class="fas fa-robot"></i> Tipo de Bot</div>
                    <div class="form-grid">
                        <div class="form-group" style="grid-column: 1 / -1;">
                            <label>Plataforma</label>
                            <select class="form-control field-platform-type">
                                <option value="whatsapp" ${!bot.useTelegram && !bot.useDiscord ? "selected" : ""}>WhatsApp</option>
                                <option value="telegram" ${bot.useTelegram ? "selected" : ""}>Telegram</option>
                                <option value="discord" ${bot.useDiscord ? "selected" : ""}>Discord</option>
                            </select>
                            <div class="field-hint">Define a plataforma desta instância. Exibe apenas os campos relevantes abaixo.</div>
                        </div>
                    </div>
                </div>

                <!-- Seção 1: Identificação & Acesso -->
                <div class="form-section">
                    <div class="form-section-title"><i class="fas fa-id-card"></i> Identificação & Acesso ao Painel</div>
                    <div class="form-grid">
                        <div class="form-group">
                            <label>Identificador Único (nome) *</label>
                            <input type="text" class="form-control field-nome" value="${bot.nome || ""}" placeholder="ex: ravena1" ${bot.isNew ? "" : "readonly"}>
                            <div class="field-hint">Nome único da instância no bots.json (não editável após criada).</div>
                        </div>
                        <div class="form-group">
                            <label>Nome de Exibição (nomeExibir)</label>
                            <input type="text" class="form-control field-nome-exibir" value="${bot.nomeExibir || ""}" placeholder="ex: Ravena VIP">
                            <div class="field-hint">Nome amigável exibido nas saudações e menus.</div>
                        </div>
                        <div class="form-group">
                            <label>Número de Telefone (numero)</label>
                            <input type="text" class="form-control field-numero" value="${bot.numero || ""}" placeholder="ex: 5511999999999">
                            <div class="field-hint">Número internacional do WhatsApp sem símbolos.</div>
                        </div>
                        <div class="form-group">
                            <label>Prefixo Customizado (customPrefix)</label>
                            <input type="text" class="form-control field-custom-prefix" value="${bot.customPrefix || "!"}" placeholder="ex: ! ou /" maxlength="3">
                            <div class="field-hint">Símbolo que aciona comandos nesta instância.</div>
                        </div>
                        <div class="form-group">
                            <label>Usuário do Painel (managementUser)</label>
                            <input type="text" class="form-control field-mgmt-user" value="${bot.managementUser || ""}" placeholder="ex: admin">
                            <div class="field-hint">Usuário para acesso administrativo a /manage.</div>
                        </div>
                        <div class="form-group">
                            <label>Senha do Painel (managementPW)</label>
                            <div class="input-with-actions">
                                <input type="password" class="form-control field-mgmt-pw" value="${bot.managementPW || ""}" placeholder="Senha de acesso">
                                <button type="button" class="btn btn-secondary btn-sm btn-toggle-pw" title="Mostrar/Ocultar"><i class="fas fa-eye"></i></button>
                                <button type="button" class="btn btn-secondary btn-sm btn-gen-pw" title="Gerar Senha Segura"><i class="fas fa-dice"></i></button>
                            </div>
                            <div class="field-hint">Senha segura para acesso ao painel do grupo.</div>
                        </div>
                    </div>
                </div>

                <!-- Seção 2: Comportamento & Flags -->
                <div class="form-section">
                    <div class="form-section-title"><i class="fas fa-sliders-h"></i> Flags de Comportamento</div>
                    <div class="toggle-grid">
                        <div class="toggle-card" style="border-left: 3px solid var(--primary-color);">
                            <div class="toggle-info">
                                <span class="toggle-title">Instância Ativa</span>
                                <span class="toggle-desc">Habilita ou desativa a leitura e respostas</span>
                            </div>
                            <label class="switch-toggle">
                                <input type="checkbox" class="field-enabled" ${isEnabled ? "checked" : ""}>
                                <span class="slider-round"></span>
                            </label>
                        </div>

                        <div class="toggle-card">
                            <div class="toggle-info">
                                <span class="toggle-title">Instância Privada</span>
                                <span class="toggle-desc">Restrita a grupos do proprietário</span>
                            </div>
                            <label class="switch-toggle">
                                <input type="checkbox" class="field-privado" ${bot.privado ? "checked" : ""}>
                                <span class="slider-round"></span>
                            </label>
                        </div>

                        <div class="toggle-card">
                            <div class="toggle-info">
                                <span class="toggle-title">Bot VIP</span>
                                <span class="toggle-desc">Atributos prioritários e limites VIP</span>
                            </div>
                            <label class="switch-toggle">
                                <input type="checkbox" class="field-vip" ${bot.vip ? "checked" : ""}>
                                <span class="slider-round"></span>
                            </label>
                        </div>

                        <div class="toggle-card">
                            <div class="toggle-info">
                                <span class="toggle-title">Comunitária</span>
                                <span class="toggle-desc">Mantida por membro da comunidade</span>
                            </div>
                            <label class="switch-toggle">
                                <input type="checkbox" class="field-comunitario" ${bot.comunitario ? "checked" : ""}>
                                <span class="slider-round"></span>
                            </label>
                        </div>

                        <div class="toggle-card">
                            <div class="toggle-info">
                                <span class="toggle-title">Ignorar PV</span>
                                <span class="toggle-desc">Não responde mensagens privadas</span>
                            </div>
                            <label class="switch-toggle">
                                <input type="checkbox" class="field-ignore-pv" ${bot.ignorePV ? "checked" : ""}>
                                <span class="slider-round"></span>
                            </label>
                        </div>

                        <div class="toggle-card">
                            <div class="toggle-info">
                                <span class="toggle-title">Download Auto no PV</span>
                                <span class="toggle-desc">Baixa mídias de links enviados no PV</span>
                            </div>
                            <label class="switch-toggle">
                                <input type="checkbox" class="field-auto-download-pv" ${bot.autoDownloadPV ? "checked" : ""}>
                                <span class="slider-round"></span>
                            </label>
                        </div>

                        <div class="toggle-card">
                            <div class="toggle-info">
                                <span class="toggle-title">IA no Privado (pvAI)</span>
                                <span class="toggle-desc">Conversa com IA em mensagens privadas</span>
                            </div>
                            <label class="switch-toggle">
                                <input type="checkbox" class="field-pv-ai" ${bot.pvAI ? "checked" : ""}>
                                <span class="slider-round"></span>
                            </label>
                        </div>

                        <div class="toggle-card">
                            <div class="toggle-info">
                                <span class="toggle-title">Ignorar Convites</span>
                                <span class="toggle-desc">Não entra automaticamente via links</span>
                            </div>
                            <label class="switch-toggle">
                                <input type="checkbox" class="field-ignore-invites" ${bot.ignoreInvites ? "checked" : ""}>
                                <span class="slider-round"></span>
                            </label>
                        </div>

                        <div class="toggle-card">
                            <div class="toggle-info">
                                <span class="toggle-title">Atualizar Status</span>
                                <span class="toggle-desc">Atualiza recado do perfil no scheduler</span>
                            </div>
                            <label class="switch-toggle">
                                <input type="checkbox" class="field-update-status" ${bot.updateStatus !== false ? "checked" : ""}>
                                <span class="slider-round"></span>
                            </label>
                        </div>

                        <div class="toggle-card">
                            <div class="toggle-info">
                                <span class="toggle-title">Enviar Info ao Entrar</span>
                                <span class="toggle-desc">Manda mensagem de boas-vindas ao grupo</span>
                            </div>
                            <label class="switch-toggle">
                                <input type="checkbox" class="field-send-join-info" ${bot.sendJoinInfo ? "checked" : ""}>
                                <span class="slider-round"></span>
                            </label>
                        </div>

                        <div class="toggle-card">
                            <div class="toggle-info">
                                <span class="toggle-title">Marcada Banida</span>
                                <span class="toggle-desc">Identifica instância com bloqueio oficial</span>
                            </div>
                            <label class="switch-toggle">
                                <input type="checkbox" class="field-banido" ${bot.banido ? "checked" : ""}>
                                <span class="slider-round"></span>
                            </label>
                        </div>
                    </div>
                </div>

                <!-- Seção 3: Personalidade & Mensagens -->
                <div class="form-section">
                    <div class="form-section-title"><i class="fas fa-brain"></i> Personalidade da IA & Mensagens de Suporte</div>
                    <div class="form-grid">
                        <div class="form-group" style="grid-column: 1 / -1;">
                            <label>Personalidade da IA (aiPersonality)</label>
                            <textarea class="form-control field-ai-personality" placeholder="Defina a personalidade customizada desta Ravena (ex: bem-humorada, debochada, formal, etc.)...">${bot.aiPersonality || ""}</textarea>
                            <div class="field-hint">Injetada como contexto de sistema em comandos de IA para este bot.</div>
                        </div>
                        <div class="form-group">
                            <label>Mensagem de Suporte (msgSuporte)</label>
                            <textarea class="form-control field-msg-suporte" placeholder="Mensagem padrão enviada ao pedir suporte...">${bot.msgSuporte || bot.supportMsg || ""}</textarea>
                            <div class="field-hint">Texto explicativo de contato para suporte com o administrador.</div>
                        </div>
                        <div class="form-group">
                            <label>Número do Responsável (numeroResponsavel)</label>
                            <input type="text" class="form-control field-numero-responsavel" value="${bot.numeroResponsavel || ""}" placeholder="ex: 5511999998888">
                            <div class="field-hint">Contato do ADM ou dono desta ravena comunitária.</div>
                        </div>
                    </div>
                </div>

                <!-- Seção 4: Canais & Grupos JID -->
                <div class="form-section">
                    <div class="form-section-title"><i class="fas fa-hashtag"></i> Grupos & Canais Notificadores</div>
                    <div class="form-grid-3">
                        <div class="form-group">
                            <label>Grupo de Logs (grupoLogs)</label>
                            <input type="text" class="form-control field-grupo-logs" value="${bot.grupoLogs || ""}" placeholder="ex: 1203634...@g.us">
                            <div class="field-hint">JID do grupo para envio de logs.</div>
                        </div>
                        <div class="form-group">
                            <label>Grupo de Avisos (grupoAvisos)</label>
                            <input type="text" class="form-control field-grupo-avisos" value="${bot.grupoAvisos || ""}" placeholder="ex: 1203634...@g.us">
                            <div class="field-hint">JID do grupo para comunicados.</div>
                        </div>
                        <div class="form-group">
                            <label>Grupo de Convites (grupoInvites)</label>
                            <input type="text" class="form-control field-grupo-invites" value="${bot.grupoInvites || ""}" placeholder="ex: 1203634...@g.us">
                            <div class="field-hint">JID do grupo de triagem de convites.</div>
                        </div>
                        <div class="form-group">
                            <label>Grupo de Dossiês (dossieGroups)</label>
                            <input type="text" class="form-control field-dossie-groups" value="${bot.dossieGroups || ""}" placeholder="ex: 1203634...@g.us">
                            <div class="field-hint">JID para envio de dossiês automáticos.</div>
                        </div>
                        <div class="form-group">
                            <label>Porta Webhook (webhookPort)</label>
                            <input type="number" class="form-control field-webhook-port" value="${bot.webhookPort || ""}" placeholder="ex: 6200">
                            <div class="field-hint">Porta HTTP para eventos do Whatsmeow Go.</div>
                        </div>
                    </div>
                </div>

                <!-- Seção 5: Manutenção & Limpeza de Mensagens -->
                <div class="form-section">
                    <div class="form-section-title"><i class="fas fa-broom"></i> Manutenção & Limpeza de Mensagens</div>
                    <div class="form-grid">
                        <div class="form-group">
                            <label>Rate Limit de Envio (ratelimit)</label>
                            <input type="number"
                                   class="form-control field-ratelimit"
                                   value="${bot.ratelimit !== undefined && bot.ratelimit !== null ? bot.ratelimit : 0}"
                                   min="0" max="600" step="1"
                                   placeholder="0 = desabilitado">
                            <div class="field-hint">
                                Máximo de mensagens por minuto que este bot pode enviar. 0 = sem limite.
                                Sugerido: 15 para bots públicos. Reações valem 1/3 de mensagem.
                                Acima de 50% da cota o sistema começa a atrasar envios progressivamente.
                                ${bot.privado ? '<br><span style="color: var(--status-green);">✓ Bot privado — rate limit não aplicado por padrão.</span>' : ""}
                            </div>
                        </div>
                        <div class="form-group">
                            <label>Delay Orgânico Mínimo (delayMin - s)</label>
                            <input type="number"
                                   class="form-control field-delay-min"
                                   value="${bot.delayMin !== undefined && bot.delayMin !== null ? bot.delayMin : 0}"
                                   min="0" max="5" step="0.5"
                                   placeholder="0 = sem delay mínimo">
                            <div class="field-hint">Atraso mínimo em segundos antes de enviar cada mensagem.</div>
                        </div>
                        <div class="form-group">
                            <label>Delay Orgânico Máximo (delayMax - s)</label>
                            <input type="number"
                                   class="form-control field-delay-max"
                                   value="${bot.delayMax !== undefined && bot.delayMax !== null ? bot.delayMax : (bot.privado ? 0 : 2)}"
                                   min="0" max="5" step="0.5"
                                   placeholder="0 = sem delay máximo">
                            <div class="field-hint">Atraso máximo em segundos. Gera atraso aleatório entre min e max. ${bot.privado ? '<br><span style="color: var(--status-green);">✓ Bot privado — delay orgânico zerado por padrão.</span>' : ""}</div>
                        </div>
                        <div class="form-group">
                            <label>Intervalo de Limpeza de Mensagens (deleteMessagesInterval)</label>
                            <input type="text" class="form-control field-delete-messages-interval" value="${bot.deleteMessagesInterval !== undefined ? bot.deleteMessagesInterval : "false"}" placeholder="false ou número de dias (ex: 3 ou 7)">
                            <div class="field-hint">false = nunca apaga; 3 = apaga a cada 3 dias; 7 = semanalmente às 03:30 AM via ClearChat.</div>
                        </div>
                    </div>
                </div>

                <!-- Seção Telegram -->
                <div class="form-section platform-section" data-platform="telegram">
                    <div class="form-section-title"><i class="fab fa-telegram"></i> Configuração do Telegram</div>
                    <div class="form-grid">
                        <div class="form-group">
                            <label>Token do Bot (telegramBotToken)</label>
                            <input type="password" class="form-control field-telegram-token" value="${bot.telegramBotToken || ""}" placeholder="Token do BotFather">
                        </div>
                        <div class="form-group">
                            <label>Nome do Bot (telegramBotName)</label>
                            <input type="text" class="form-control field-telegram-name" value="${bot.telegramBotName || ""}" placeholder="ex: ravenosabot">
                        </div>
                        <div class="form-group">
                            <label>ID do Bot Telegram (telegramBotId)</label>
                            <input type="text" class="form-control field-telegram-bot-id" value="${bot.telegramBotId || ""}" placeholder="ex: 8402791288">
                        </div>
                        <div class="form-group">
                            <label>Webhook Host (webhookHost)</label>
                            <input type="text" class="form-control field-webhook-host" value="${bot.webhookHost || ""}" placeholder="ex: rav-telegram.moothz.com">
                        </div>
                    </div>
                </div>

                <!-- Seção Discord -->
                <div class="form-section platform-section" data-platform="discord">
                    <div class="form-section-title"><i class="fab fa-discord"></i> Configuração do Discord</div>
                    <div class="form-grid">
                        <div class="form-group" style="grid-column: 1 / -1;">
                            <label>Token do Bot Discord (discordToken)</label>
                            <input type="password" class="form-control field-discord-token" value="${bot.discordToken || ""}" placeholder="Token da aplicação no Discord Developer Portal">
                        </div>
                    </div>
                </div>

                <!-- Seção 6: Construtor Dinâmico de Extras (3 Níveis) -->
                <div class="form-section">
                    <div class="form-section-title">
                        <span><i class="fas fa-cubes"></i> Parâmetros Extras (3 Níveis: extras &rarr; categoria &rarr; propriedade)</span>
                    </div>
                    <div class="extras-container" id="extras-container-${bot.nome}">
                        <!-- Categorias de extras renderizadas aqui -->
                    </div>
                    <div class="extras-actions-bar">
                        <button type="button" class="btn btn-secondary btn-sm btn-add-extra-cat">
                            <i class="fas fa-folder-plus"></i> Adicionar Categoria de Extras
                        </button>
                    </div>
                </div>

                <!-- Seção 7: Ações da Instância -->
                <div class="bot-card-actions">
                    <div class="bot-actions-left">
                        <button type="button" class="btn btn-primary btn-save-instance">
                            <i class="fas fa-save"></i> Salvar Esta Instância
                        </button>
                        <button type="button" class="btn btn-secondary btn-restart-bot">
                            <i class="fas fa-sync-alt"></i> Reiniciar Bot
                        </button>
                        ${
													platform === "WhatsApp"
														? `
                            <a href="/qrcode/${bot.nome}" target="_blank" class="btn btn-secondary">
                                <i class="fas fa-qrcode"></i> QRCode / Reconectar
                            </a>
                        `
														: ""
												}
                        ${
													rawPhone
														? `
                            <a href="${chatUrl}" target="_blank" class="btn btn-secondary">
                                <i class="fas fa-comment-dots"></i> Abrir Conversa
                            </a>
                        `
														: ""
												}
                    </div>
                    <div class="bot-actions-right">
                        <button type="button" class="btn btn-danger-outline btn-logout-bot">
                            <i class="fas fa-sign-out-alt"></i> Desconectar Sessão
                        </button>
                    </div>
                </div>
            </div>
        `;

		// Evento de Toggle da Sanfona
		const header = card.querySelector(".bot-accordion-header");
		header.addEventListener("click", () => {
			const willOpen = !card.classList.contains("active");
			card.classList.toggle("active", willOpen);
			if (willOpen) {
				openBotIds.add(bot.nome);
			} else {
				openBotIds.delete(bot.nome);
			}
		});

		// Visibilidade condicional por plataforma
		function applyPlatformVisibility(platform) {
			card.querySelectorAll(".platform-section").forEach((sec) => {
				sec.style.display = sec.dataset.platform === platform ? "" : "none";
			});
		}
		const platformSelect = card.querySelector(".field-platform-type");
		if (platformSelect) {
			applyPlatformVisibility(platformSelect.value);
			platformSelect.addEventListener("change", () => {
				applyPlatformVisibility(platformSelect.value);
				markDirty();
			});
		}

		// Toggle Mostrar/Ocultar Senha
		const togglePwBtn = card.querySelector(".btn-toggle-pw");
		const pwInput = card.querySelector(".field-mgmt-pw");
		if (togglePwBtn && pwInput) {
			togglePwBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				const isPassword = pwInput.type === "password";
				pwInput.type = isPassword ? "text" : "password";
				togglePwBtn.innerHTML = isPassword
					? '<i class="fas fa-eye-slash"></i>'
					: '<i class="fas fa-eye"></i>';
			});
		}

		// Gerar Senha Segura
		const genPwBtn = card.querySelector(".btn-gen-pw");
		if (genPwBtn && pwInput) {
			genPwBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				const newPass = generateSecurePassword(16);
				pwInput.value = newPass;
				pwInput.type = "text";
				if (togglePwBtn) togglePwBtn.innerHTML = '<i class="fas fa-eye-slash"></i>';
				showToast(`Nova senha gerada para '${bot.nome}'! Lembre-se de salvar.`, "info");
			});
		}

		// Construtor de Extras
		const extrasContainer = card.querySelector(`#extras-container-${bot.nome}`);
		renderExtrasBuilder(extrasContainer, bot.extras || {});

		const addExtraCatBtn = card.querySelector(".btn-add-extra-cat");
		if (addExtraCatBtn) {
			addExtraCatBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				const catName = prompt(
					"Digite o nome da nova categoria de extras (ex: stickers, jogos, ai):"
				);
				if (!catName) return;
				const cleanCat = catName.trim().replace(/[^a-zA-Z0-9_-]/g, "");
				if (!cleanCat) {
					alert("Nome de categoria inválido. Use apenas letras, números, _ ou -.");
					return;
				}
				if (!bot.extras) bot.extras = {};
				if (bot.extras[cleanCat]) {
					alert(`A categoria '${cleanCat}' já existe.`);
					return;
				}
				bot.extras[cleanCat] = {};
				renderExtrasBuilder(extrasContainer, bot.extras);
				markDirty();
				showToast(`Categoria '${cleanCat}' adicionada aos extras!`, "info");
			});
		}

		// Salvar Esta Instância
		const saveInstanceBtn = card.querySelector(".btn-save-instance");
		if (saveInstanceBtn) {
			saveInstanceBtn.addEventListener("click", async (e) => {
				e.stopPropagation();
				updateBotDataFromCard(card, bot);
				await saveAllBotsToServer(bot.nome);
			});
		}

		// Reiniciar Bot
		const restartBtn = card.querySelector(".btn-restart-bot");
		if (restartBtn) {
			restartBtn.addEventListener("click", async (e) => {
				e.stopPropagation();
				if (!confirm(`Deseja reiniciar o bot '${bot.nome}'?`)) return;
				restartBtn.disabled = true;
				restartBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Reiniciando...';
				try {
					const resp = await fetch(`/restart/${bot.nome}`);
					const resJson = await resp.json();
					showToast(`Reinício de '${bot.nome}': ${resJson.message || "Sucesso"}`, "success");
					setTimeout(() => fetchBots(true), 2500);
				} catch (err) {
					showToast(`Erro ao reiniciar '${bot.nome}': ${err.message}`, "error");
				} finally {
					restartBtn.disabled = false;
					restartBtn.innerHTML = '<i class="fas fa-sync-alt"></i> Reiniciar Bot';
				}
			});
		}

		// Desconectar Bot
		const logoutBtn = card.querySelector(".btn-logout-bot");
		if (logoutBtn) {
			logoutBtn.addEventListener("click", async (e) => {
				e.stopPropagation();
				if (!confirm(`ATENÇÃO: Deseja realmente desconectar a sessão do bot '${bot.nome}'?`))
					return;
				logoutBtn.disabled = true;
				logoutBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Desconectando...';
				try {
					const resp = await fetch(`/logout/${bot.nome}`);
					const resJson = await resp.json();
					showToast(`Logout '${bot.nome}': ${resJson.message || resJson.status}`, "info");
					setTimeout(() => fetchBots(true), 2500);
				} catch (err) {
					showToast(`Erro ao desconectar '${bot.nome}': ${err.message}`, "error");
				} finally {
					logoutBtn.disabled = false;
					logoutBtn.innerHTML = '<i class="fas fa-sign-out-alt"></i> Desconectar Sessão';
				}
			});
		}

		return card;
	}

	// Renderizador do Construtor de Extras (3 níveis)
	function renderExtrasBuilder(container, extrasObj) {
		container.innerHTML = "";

		const categories = Object.keys(extrasObj || {});
		if (categories.length === 0) {
			container.innerHTML = `
                <div style="font-size:0.8rem; color:var(--text-muted); font-style:italic; padding: 6px 0;">
                    Nenhum parâmetro extra configurado. Clique em "Adicionar Categoria de Extras" abaixo se precisar configurar regras extras (ex: stickers.maxFiga).
                </div>
            `;
			return;
		}

		categories.forEach((catKey) => {
			const catCard = document.createElement("div");
			catCard.className = "extras-cat-card";
			catCard.dataset.catKey = catKey;

			const propsObj = extrasObj[catKey] || {};
			const propKeys = Object.keys(propsObj);

			catCard.innerHTML = `
                <div class="extras-cat-header">
                    <span class="extras-cat-title"><i class="fas fa-folder-open"></i> ${catKey}</span>
                    <div style="display:flex; gap:6px;">
                        <button type="button" class="btn btn-secondary btn-sm btn-add-prop" title="Adicionar Propriedade"><i class="fas fa-plus"></i> Propriedade</button>
                        <button type="button" class="btn btn-danger-outline btn-sm btn-del-cat" title="Remover Categoria"><i class="fas fa-trash"></i></button>
                    </div>
                </div>
                <div class="extras-props-list">
                    <!-- Linhas de propriedades -->
                </div>
            `;

			const propsList = catCard.querySelector(".extras-props-list");

			if (propKeys.length === 0) {
				propsList.innerHTML = `<div style="font-size:0.75rem; color:var(--text-muted); font-style:italic;">Nenhuma propriedade nesta categoria.</div>`;
			} else {
				propKeys.forEach((propKey) => {
					const propVal = propsObj[propKey];
					const propRow = createPropertyRowElement(catKey, propKey, propVal, extrasObj);
					propsList.appendChild(propRow);
				});
			}

			// Botão Adicionar Propriedade
			const addPropBtn = catCard.querySelector(".btn-add-prop");
			addPropBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				const newPropKey = prompt(`Digite o nome da propriedade para '${catKey}':`);
				if (!newPropKey) return;
				const cleanKey = newPropKey.trim().replace(/[^a-zA-Z0-9_-]/g, "");
				if (!cleanKey) {
					alert("Nome de propriedade inválido.");
					return;
				}
				if (extrasObj[catKey][cleanKey] !== undefined) {
					alert(`A propriedade '${cleanKey}' já existe nesta categoria.`);
					return;
				}
				extrasObj[catKey][cleanKey] = "";
				renderExtrasBuilder(container, extrasObj);
				markDirty();
			});

			// Botão Remover Categoria
			const delCatBtn = catCard.querySelector(".btn-del-cat");
			delCatBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				if (
					!confirm(`Deseja remover a categoria de extras '${catKey}' e todas as suas propriedades?`)
				)
					return;
				delete extrasObj[catKey];
				renderExtrasBuilder(container, extrasObj);
				markDirty();
			});

			container.appendChild(catCard);
		});
	}

	// Criação de uma linha de propriedade no construtor de extras
	function createPropertyRowElement(catKey, propKey, propVal, extrasObj) {
		const row = document.createElement("div");
		row.className = "extras-prop-row";

		let detectedType = "string";
		if (typeof propVal === "number") detectedType = "number";
		else if (typeof propVal === "boolean") detectedType = "boolean";

		row.innerHTML = `
            <input type="text" class="form-control extras-prop-key" value="${propKey}" placeholder="Chave (propriedade)">
            <select class="form-control extras-prop-type">
                <option value="string" ${detectedType === "string" ? "selected" : ""}>Texto</option>
                <option value="number" ${detectedType === "number" ? "selected" : ""}>Número</option>
                <option value="boolean" ${detectedType === "boolean" ? "selected" : ""}>Booleano</option>
            </select>
            <div class="extras-val-container" style="flex: 1.5; min-width: 150px; display:flex;">
                <!-- Campo de valor dinâmico baseado no tipo -->
            </div>
            <button type="button" class="btn btn-danger-outline btn-sm btn-del-prop" title="Excluir propriedade"><i class="fas fa-times"></i></button>
        `;

		const valContainer = row.querySelector(".extras-val-container");
		const typeSelect = row.querySelector(".extras-prop-type");
		const keyInput = row.querySelector(".extras-prop-key");

		function renderValInput(type, currentVal) {
			valContainer.innerHTML = "";
			if (type === "boolean") {
				const sel = document.createElement("select");
				sel.className = "form-control extras-prop-val";
				sel.innerHTML = `
                    <option value="true" ${Boolean(currentVal) === true ? "selected" : ""}>true (Verdadeiro)</option>
                    <option value="false" ${Boolean(currentVal) === false ? "selected" : ""}>false (Falso)</option>
                `;
				valContainer.appendChild(sel);
			} else if (type === "number") {
				const num = document.createElement("input");
				num.type = "number";
				num.className = "form-control extras-prop-val";
				num.value = currentVal !== undefined ? Number(currentVal) : 0;
				valContainer.appendChild(num);
			} else {
				const txt = document.createElement("input");
				txt.type = "text";
				txt.className = "form-control extras-prop-val";
				txt.value = currentVal !== undefined ? String(currentVal) : "";
				valContainer.appendChild(txt);
			}
		}

		renderValInput(detectedType, propVal);

		typeSelect.addEventListener("change", () => {
			const newType = typeSelect.value;
			let currentVal = row.querySelector(".extras-prop-val").value;
			if (newType === "number") currentVal = Number(currentVal) || 0;
			else if (newType === "boolean") currentVal = currentVal === "true";
			renderValInput(newType, currentVal);
			markDirty();
		});

		// Excluir Propriedade
		const delPropBtn = row.querySelector(".btn-del-prop");
		delPropBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			delete extrasObj[catKey][propKey];
			row.remove();
			markDirty();
		});

		return row;
	}

	// Leitura e atualização dos dados da instância a partir do seu Card Accordion
	function updateBotDataFromCard(card, bot) {
		const getVal = (selector) => {
			const el = card.querySelector(selector);
			return el ? el.value.trim() : "";
		};
		const getBool = (selector) => {
			const el = card.querySelector(selector);
			return el ? Boolean(el.checked) : false;
		};

		bot.nome = getVal(".field-nome") || bot.nome;
		bot.nomeExibir = getVal(".field-nome-exibir") || bot.nome;
		bot.numero = getVal(".field-numero");
		bot.customPrefix = getVal(".field-custom-prefix") || "!";
		bot.managementUser = getVal(".field-mgmt-user");
		bot.managementPW = getVal(".field-mgmt-pw");

		bot.enabled = getBool(".field-enabled");
		bot.privado = getBool(".field-privado");
		bot.vip = getBool(".field-vip");
		bot.comunitario = getBool(".field-comunitario");
		bot.banido = getBool(".field-banido");
		bot.ignorePV = getBool(".field-ignore-pv");
		bot.autoDownloadPV = getBool(".field-auto-download-pv");
		bot.ignoreInvites = getBool(".field-ignore-invites");
		bot.pvAI = getBool(".field-pv-ai");
		bot.updateStatus = getBool(".field-update-status");
		bot.sendJoinInfo = getBool(".field-send-join-info");

		bot.aiPersonality = getVal(".field-ai-personality");
		bot.msgSuporte = getVal(".field-msg-suporte");
		bot.numeroResponsavel = getVal(".field-numero-responsavel");

		bot.grupoLogs = getVal(".field-grupo-logs") || null;
		bot.grupoAvisos = getVal(".field-grupo-avisos") || null;
		bot.grupoInvites = getVal(".field-grupo-invites") || null;
		bot.dossieGroups = getVal(".field-dossie-groups") || null;

		const whPortVal = getVal(".field-webhook-port");
		bot.webhookPort = whPortVal ? parseInt(whPortVal, 10) : null;

		const deleteIntervalVal = getVal(".field-delete-messages-interval");
		if (
			!deleteIntervalVal ||
			deleteIntervalVal.toLowerCase() === "false" ||
			deleteIntervalVal === "0"
		) {
			bot.deleteMessagesInterval = false;
		} else {
			const parsedDays = parseInt(deleteIntervalVal, 10);
			bot.deleteMessagesInterval = isNaN(parsedDays) || parsedDays <= 0 ? false : parsedDays;
		}

		// Plataforma
		const platformVal = getVal(".field-platform-type");
		if (platformVal === "telegram") {
			bot.useTelegram = true;
			bot.useDiscord = false;
		} else if (platformVal === "discord") {
			bot.useDiscord = true;
			bot.useTelegram = false;
		} else {
			bot.useTelegram = false;
			bot.useDiscord = false;
		}

		// Campos de Telegram (só lê se for Telegram)
		if (bot.useTelegram) {
			bot.telegramBotToken = getVal(".field-telegram-token");
			bot.telegramBotName = getVal(".field-telegram-name");
			bot.telegramBotId = getVal(".field-telegram-bot-id");
			bot.webhookHost = getVal(".field-webhook-host") || null;
		} else {
			delete bot.telegramBotToken;
			delete bot.telegramBotName;
			delete bot.telegramBotId;
			delete bot.webhookHost;
		}

		// Campos de Discord (só lê se for Discord)
		if (bot.useDiscord) {
			bot.discordToken = getVal(".field-discord-token");
		} else {
			delete bot.discordToken;
		}

		// Rate Limit & Delay Orgânico
		const rateLimitEl = card.querySelector(".field-ratelimit");
		if (rateLimitEl) {
			const rl = parseInt(rateLimitEl.value, 10);
			bot.ratelimit = !isNaN(rl) && rl > 0 ? Math.min(600, rl) : 0;
		} else {
			bot.ratelimit = 0;
		}

		const delayMinEl = card.querySelector(".field-delay-min");
		if (delayMinEl) {
			const dMin = parseFloat(delayMinEl.value);
			bot.delayMin = !isNaN(dMin) && dMin >= 0 ? Math.min(5, dMin) : 0;
		} else {
			bot.delayMin = 0;
		}

		const delayMaxEl = card.querySelector(".field-delay-max");
		if (delayMaxEl) {
			const dMax = parseFloat(delayMaxEl.value);
			bot.delayMax = !isNaN(dMax) && dMax >= 0 ? Math.min(5, dMax) : (bot.privado ? 0 : 2);
		} else {
			bot.delayMax = bot.privado ? 0 : 2;
		}

		// Extrai o objeto extras reconstruído a partir do DOM
		const extrasContainer = card.querySelector(`#extras-container-${bot.nome}`);
		if (extrasContainer) {
			const newExtras = {};
			const catCards = extrasContainer.querySelectorAll(".extras-cat-card");
			catCards.forEach((cCard) => {
				const catKey = cCard.dataset.catKey;
				if (!catKey) return;
				newExtras[catKey] = {};

				const propRows = cCard.querySelectorAll(".extras-prop-row");
				propRows.forEach((pRow) => {
					const pKey = pRow.querySelector(".extras-prop-key").value.trim();
					const pType = pRow.querySelector(".extras-prop-type").value;
					const pValEl = pRow.querySelector(".extras-prop-val");
					if (!pKey || !pValEl) return;

					let finalVal = pValEl.value;
					if (pType === "number") finalVal = Number(finalVal) || 0;
					else if (pType === "boolean") finalVal = pValEl.value === "true";

					newExtras[catKey][pKey] = finalVal;
				});
			});
			bot.extras = newExtras;
		}

		delete bot.isNew;
	}

	// Salvar todas as instâncias no servidor
	async function saveAllBotsToServer(specificBotTarget = null) {
		if (isSaving) return;

		// Atualiza os dados de todos os cards atualmente renderizados
		const cards = instancesContainer.querySelectorAll(".bot-accordion");
		cards.forEach((card) => {
			const bName = card.dataset.botName;
			const targetBot = allBots.find((b) => b.nome === bName);
			if (targetBot) {
				updateBotDataFromCard(card, targetBot);
			}
		});

		// Validação básica
		for (const b of allBots) {
			if (!b.nome || b.nome.trim().length === 0) {
				alert("Erro de validação: Toda instância deve possuir um identificador único (nome).");
				return;
			}
			if (!b.useDiscord && (!b.numero || String(b.numero).trim().length === 0)) {
				alert(
					`Erro de validação: O número de WhatsApp é obrigatório para a instância '${b.nome}'.`
				);
				return;
			}
		}

		isSaving = true;
		btnSaveAll.disabled = true;
		btnSaveAll.innerHTML = '<i class="fas fa-spinner fa-spin"></i> <span>Salvando...</span>';

		try {
			const response = await fetch("/api/bots", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(allBots)
			});

			const result = await response.json();
			if (!response.ok) {
				throw new Error(result.message || "Falha ao salvar no servidor.");
			}

			const targetMsg = specificBotTarget
				? `Instância '${specificBotTarget}' salva e refletida em tempo real!`
				: "Todas as instâncias foram salvas e sincronizadas em tempo real!";

			showToast(targetMsg, "success");
			markClean();
			await fetchBots(true);
		} catch (err) {
			console.error("Falha ao salvar:", err);
			showToast(`Erro ao salvar: ${err.message}`, "error", 6000);
			alert(`Erro ao salvar alterações: ${err.message}`);
		} finally {
			isSaving = false;
			btnSaveAll.disabled = false;
			btnSaveAll.innerHTML = '<i class="fas fa-save"></i> <span>Salvar Tudo</span>';
		}
	}

	// Adicionar Nova Instância
	btnNewInstance.addEventListener("click", () => {
		const randId = "rav-" + Math.floor(1000 + Math.random() * 9000);
		const maxWebhookPort = allBots.reduce((max, b) => {
			const port = parseInt(b.webhookPort, 10);
			return !isNaN(port) && port > max ? port : max;
		}, 0);
		const nextWebhookPort = maxWebhookPort > 0 ? maxWebhookPort + 1 : 14000;

		const newBot = {
			enabled: false,
			nome: randId,
			nomeExibir: "Nova Ravena",
			numero: "",
			webhookPort: nextWebhookPort,
			customPrefix: "!",
			managementUser: "admin",
			managementPW: generateSecurePassword(16),
			privado: false,
			vip: false,
			comunitario: false,
			ignorePV: false,
			autoDownloadPV: false,
			ignoreInvites: false,
			pvAI: true,
			updateStatus: true,
			sendJoinInfo: true,
			aiPersonality: "",
			msgSuporte: "",
			extras: {},
			isNew: true
		};

		// Adiciona no início da lista
		allBots.unshift(newBot);
		openBotIds.add(newBot.nome);
		updateSummaryCounters();
		renderBotAccordions();
		markDirty();

		// Rola até a nova sanfona
		const firstCard = instancesContainer.querySelector(".bot-accordion");
		if (firstCard) {
			firstCard.scrollIntoView({ behavior: "smooth", block: "start" });
			const nomeField = firstCard.querySelector(".field-nome");
			if (nomeField) nomeField.focus();
		}

		showToast(`Nova instância criada como desativada. Preencha os campos e salve!`, "info");
	});

	// Salvar Tudo
	btnSaveAll.addEventListener("click", () => {
		if (
			!confirm(
				"Deseja salvar as configurações de todas as instâncias? As alterações refletirão imediatamente."
			)
		)
			return;
		saveAllBotsToServer();
	});

	// Filtros por Pills
	filterPills.forEach((pill) => {
		pill.addEventListener("click", () => {
			filterPills.forEach((p) => p.classList.remove("active"));
			pill.classList.add("active");
			currentFilter = pill.dataset.filter;
			renderBotAccordions();
		});
	});

	// Busca por Texto
	searchInput.addEventListener("input", (e) => {
		currentSearch = e.target.value;
		btnClearSearch.style.display = currentSearch.length > 0 ? "block" : "none";
		renderBotAccordions();
	});

	btnClearSearch.addEventListener("click", () => {
		searchInput.value = "";
		currentSearch = "";
		btnClearSearch.style.display = "none";
		renderBotAccordions();
	});

	// Expandir Todas / Recolher Todas
	btnExpandAll.addEventListener("click", () => {
		const cards = instancesContainer.querySelectorAll(".bot-accordion");
		cards.forEach((c) => {
			c.classList.add("active");
			if (c.dataset.botName) openBotIds.add(c.dataset.botName);
		});
	});

	btnCollapseAll.addEventListener("click", () => {
		const cards = instancesContainer.querySelectorAll(".bot-accordion");
		cards.forEach((c) => c.classList.remove("active"));
		openBotIds.clear();
	});

	// Atualizar manual
	btnRefresh.addEventListener("click", () => {
		if (hasUnsavedChanges) {
			if (
				!confirm(
					"Você possui alterações não salvas que serão perdidas ao atualizar. Deseja continuar?"
				)
			) {
				return;
			}
			markClean();
		}
		fetchBots(false);
	});
	btnRetry.addEventListener("click", () => fetchBots(false));

	// Registra observadores de alterações para rastrear edições não salvas
	if (instancesContainer) {
		instancesContainer.addEventListener("input", markDirty);
		instancesContainer.addEventListener("change", markDirty);
	}

	window.addEventListener("beforeunload", (e) => {
		if (hasUnsavedChanges) {
			e.preventDefault();
			e.returnValue = "";
		}
	});

	/* ==========================================================================
       MODAL DE PUBLICAÇÃO DE STATUS (/instances)
       ========================================================================== */
	const btnPublishStatus = document.getElementById("btn-publish-status");
	const publishModal = document.getElementById("publish-status-modal");
	const btnClosePublishModal = document.getElementById("btn-close-publish-modal");
	const btnFooterClosePublishModal = document.getElementById("btn-footer-close-publish-modal");
	const announcementMessage = document.getElementById("announcement-message");
	const announcementLivePreview = document.getElementById("announcement-live-preview");
	const announcementExpiresAt = document.getElementById("announcement-expires-at");
	const btnSubmitAnnouncement = document.getElementById("btn-submit-announcement");
	const activeAnnouncementsList = document.getElementById("active-announcements-list");
	const activeAnnouncementsCount = document.getElementById("active-announcements-count");
	const formAnnouncementTitle = document.getElementById("form-announcement-title");
	const editingAnnouncementBanner = document.getElementById("editing-announcement-banner");
	const editingAnnouncementIdLabel = document.getElementById("editing-announcement-id-label");
	const btnCancelAnnouncementEditTop = document.getElementById("btn-cancel-announcement-edit-top");
	const btnCancelAnnouncementEdit = document.getElementById("btn-cancel-announcement-edit");

	let editingAnnouncementId = null;

	function escapeHtml(text) {
		return String(text ?? "").replace(
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

	function formatWhatsAppMarkup(text) {
		if (!text || typeof text !== "string") return "";

		let escaped = escapeHtml(text);

		const codeBlocks = [];
		escaped = escaped.replace(/```([\s\S]*?)```/g, (match, code) => {
			const id = codeBlocks.length;
			codeBlocks.push(`<pre><code>${code}</code></pre>`);
			return `\x00CODEBLOCK_${id}\x00`;
		});

		const inlineCodes = [];
		escaped = escaped.replace(/`([^`\n]+?)`/g, (match, code) => {
			const id = inlineCodes.length;
			inlineCodes.push(`<code>${code}</code>`);
			return `\x00INLINECODE_${id}\x00`;
		});

		const lines = escaped.split("\n");
		const processedLines = [];
		let quoteBuffer = [];

		const flushQuotes = () => {
			if (quoteBuffer.length > 0) {
				processedLines.push(`<blockquote>${quoteBuffer.join("<br>")}</blockquote>`);
				quoteBuffer = [];
			}
		};

		for (const line of lines) {
			const match = line.match(/^(&gt;|>)\s?(.*)$/);
			if (match) {
				quoteBuffer.push(match[2]);
			} else {
				flushQuotes();
				processedLines.push(line);
			}
		}
		flushQuotes();
		escaped = processedLines.join("\n");

		escaped = escaped.replace(/(^|[\s>(~_])\*([^*\n]+?)\*(?=[^\w*]|$)/g, (m, p, inner) => {
			if (/^\s*$/.test(inner)) return m;
			return `${p}<strong>${inner}</strong>`;
		});

		escaped = escaped.replace(/(^|[\s>(~*])_([^_\n]+?)_(?=[^\w_]|$)/g, (m, p, inner) => {
			if (/^\s*$/.test(inner)) return m;
			return `${p}<em>${inner}</em>`;
		});

		escaped = escaped.replace(/(^|[\s>(_*])~([^~\n]+?)~(?=[^\w~]|$)/g, (m, p, inner) => {
			if (/^\s*$/.test(inner)) return m;
			return `${p}<del>${inner}</del>`;
		});

		escaped = escaped.replace(
			/(https?:\/\/[^\s<]+)/gi,
			'<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
		);

		escaped = escaped.replace(/\x00CODEBLOCK_(\d+)\x00/g, (m, id) => codeBlocks[Number(id)] || "");
		escaped = escaped.replace(
			/\x00INLINECODE_(\d+)\x00/g,
			(m, id) => inlineCodes[Number(id)] || ""
		);

		escaped = escaped.replace(/\n/g, "<br>");

		return escaped;
	}

	function updateLivePreview() {
		if (!announcementLivePreview || !announcementMessage) return;
		const text = announcementMessage.value.trim();
		if (!text) {
			announcementLivePreview.innerHTML =
				'<span class="preview-placeholder">A prévia da formatação aparecerá aqui conforme você digita...</span>';
		} else {
			announcementLivePreview.innerHTML = formatWhatsAppMarkup(announcementMessage.value);
		}
	}

	function formatTimestampForInput(timestamp) {
		const targetDate = new Date(Number(timestamp));
		const pad = (n) => String(n).padStart(2, "0");
		const year = targetDate.getFullYear();
		const month = pad(targetDate.getMonth() + 1);
		const day = pad(targetDate.getDate());
		const hour = pad(targetDate.getHours());
		const minute = pad(targetDate.getMinutes());
		return `${year}-${month}-${day}T${hour}:${minute}`;
	}

	function setExpiryHours(hours) {
		if (!announcementExpiresAt) return;
		announcementExpiresAt.value = formatTimestampForInput(Date.now() + hours * 3600 * 1000);
	}

	function startEditingAnnouncement(item) {
		if (!item || !announcementMessage || !announcementExpiresAt) return;
		editingAnnouncementId = item.id;

		if (editingAnnouncementBanner) {
			editingAnnouncementBanner.classList.remove("hidden");
		}
		if (editingAnnouncementIdLabel) {
			editingAnnouncementIdLabel.textContent = `#${item.id}`;
		}
		if (formAnnouncementTitle) {
			formAnnouncementTitle.innerHTML = `<i class="fas fa-edit"></i> Editando Aviso #${item.id}`;
		}
		if (btnCancelAnnouncementEdit) {
			btnCancelAnnouncementEdit.classList.remove("hidden");
		}
		if (btnSubmitAnnouncement) {
			btnSubmitAnnouncement.classList.remove("btn-warning");
			btnSubmitAnnouncement.classList.add("btn-success");
			btnSubmitAnnouncement.innerHTML =
				'<i class="fas fa-save"></i> <span>Salvar Alterações</span>';
		}

		announcementMessage.value = item.message || "";
		const expMs = Number(item.expires_at);
		if (expMs <= Date.now() + 600000) {
			setExpiryHours(24);
		} else {
			announcementExpiresAt.value = formatTimestampForInput(expMs);
		}
		updateLivePreview();

		const modalBody = publishModal ? publishModal.querySelector(".modal-body") : null;
		if (modalBody) {
			modalBody.scrollTo({ top: 0, behavior: "smooth" });
		}
		announcementMessage.focus();
		showToast(
			`Aviso #${item.id} carregado para edição. Altere o que precisar e salve!`,
			"info",
			3500
		);
	}

	function cancelEditingAnnouncement() {
		editingAnnouncementId = null;

		if (editingAnnouncementBanner) {
			editingAnnouncementBanner.classList.add("hidden");
		}
		if (formAnnouncementTitle) {
			formAnnouncementTitle.innerHTML = '<i class="fas fa-edit"></i> Novo Aviso';
		}
		if (btnCancelAnnouncementEdit) {
			btnCancelAnnouncementEdit.classList.add("hidden");
		}
		if (btnSubmitAnnouncement) {
			btnSubmitAnnouncement.classList.remove("btn-success");
			btnSubmitAnnouncement.classList.add("btn-warning");
			btnSubmitAnnouncement.innerHTML =
				'<i class="fas fa-paper-plane"></i> <span>Publicar Aviso</span>';
		}

		if (announcementMessage) {
			announcementMessage.value = "";
		}
		setExpiryHours(24);
		updateLivePreview();
	}

	function reuseAnnouncement(item) {
		if (!item || !announcementMessage) return;
		cancelEditingAnnouncement();
		announcementMessage.value = item.message || "";
		setExpiryHours(24);
		updateLivePreview();

		const modalBody = publishModal ? publishModal.querySelector(".modal-body") : null;
		if (modalBody) {
			modalBody.scrollTo({ top: 0, behavior: "smooth" });
		}
		announcementMessage.focus();
		showToast(
			"Dados do aviso copiados para o formulário. Ajuste o que precisar e publique!",
			"info",
			4000
		);
	}

	function insertAtCursor(before, after = "") {
		if (!announcementMessage) return;
		const start = announcementMessage.selectionStart;
		const end = announcementMessage.selectionEnd;
		const text = announcementMessage.value;
		const selected = text.substring(start, end);

		const replacement = before + selected + after;
		announcementMessage.value = text.substring(0, start) + replacement + text.substring(end);

		const newPos = selected ? start + replacement.length : start + before.length;
		announcementMessage.focus();
		announcementMessage.setSelectionRange(newPos, newPos);
		updateLivePreview();
	}

	async function loadActiveAnnouncements() {
		if (!activeAnnouncementsList) return;
		activeAnnouncementsList.innerHTML =
			'<div class="loading-state-small"><i class="fas fa-spinner fa-spin"></i> Carregando avisos ativos...</div>';

		try {
			const resp = await fetch("/api/status-announcements");
			if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
			const data = await resp.json();
			const list = Array.isArray(data.announcements) ? data.announcements : [];

			if (activeAnnouncementsCount) {
				activeAnnouncementsCount.textContent = String(list.length);
			}

			if (list.length === 0) {
				activeAnnouncementsList.innerHTML =
					'<div class="empty-state-mini"><i class="fas fa-info-circle"></i> Nenhum aviso ativo no momento.</div>';
				return;
			}

			activeAnnouncementsList.innerHTML = list
				.map((item) => {
					const expiryDate = new Date(item.expires_at);
					const formattedExpiry = expiryDate.toLocaleString("pt-BR", {
						day: "2-digit",
						month: "2-digit",
						year: "numeric",
						hour: "2-digit",
						minute: "2-digit"
					});
					const isExpired = Date.now() > Number(item.expires_at);
					const isBeingEdited = editingAnnouncementId === item.id;

					return `
                    <div class="active-announcement-card" data-id="${item.id}" style="${isBeingEdited ? "border-left: 3px solid var(--success-light); background: rgba(56, 161, 105, 0.12);" : ""}">
                        <div class="active-announcement-header">
                            <div class="active-announcement-meta">
                                <span class="active-announcement-badge">
                                    <i class="far fa-clock"></i> ${isExpired ? "Expirado" : "Expira em"}: ${formattedExpiry}
                                </span>
                                <span>Criado em: ${new Date(item.created_at).toLocaleDateString("pt-BR")}</span>
                                ${isBeingEdited ? '<span class="badge badge-online" style="font-size:0.7rem; padding: 2px 6px;"><i class="fas fa-pencil-alt"></i> Em edição</span>' : ""}
                            </div>
                            <div class="active-announcement-actions">
                                <button type="button" class="btn btn-warning-outline btn-sm btn-edit-announcement" data-id="${item.id}" title="Editar este aviso">
                                    <i class="fas fa-edit"></i> <span>Editar</span>
                                </button>
                                <button type="button" class="btn btn-secondary-outline btn-sm btn-reuse-announcement" data-id="${item.id}" title="Preencher formulário para criar um novo aviso baseado neste">
                                    <i class="fas fa-clone"></i> <span>Reutilizar</span>
                                </button>
                                <button type="button" class="btn btn-danger-outline btn-sm btn-delete-announcement" data-id="${item.id}" title="Excluir este aviso imediatamente">
                                    <i class="fas fa-trash"></i> <span>Remover</span>
                                </button>
                            </div>
                        </div>
                        <div class="active-announcement-content">
                            ${formatWhatsAppMarkup(item.message)}
                        </div>
                    </div>
                `;
				})
				.join("");

			// Handlers de edição
			activeAnnouncementsList.querySelectorAll(".btn-edit-announcement").forEach((btn) => {
				btn.addEventListener("click", (e) => {
					const id = Number(e.currentTarget.dataset.id);
					const targetItem = list.find((a) => a.id === id);
					if (targetItem) {
						startEditingAnnouncement(targetItem);
						loadActiveAnnouncements();
					}
				});
			});

			// Handlers de reutilização
			activeAnnouncementsList.querySelectorAll(".btn-reuse-announcement").forEach((btn) => {
				btn.addEventListener("click", (e) => {
					const id = Number(e.currentTarget.dataset.id);
					const targetItem = list.find((a) => a.id === id);
					if (targetItem) {
						reuseAnnouncement(targetItem);
					}
				});
			});

			// Handlers de deleção
			activeAnnouncementsList.querySelectorAll(".btn-delete-announcement").forEach((btn) => {
				btn.addEventListener("click", async (e) => {
					const id = Number(e.currentTarget.dataset.id);
					const targetItem = list.find((a) => a.id === id);
					if (!confirm("Deseja realmente remover este aviso de status?")) return;
					btn.disabled = true;
					btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
					try {
						const delResp = await fetch(`/api/status-announcements/${id}`, { method: "DELETE" });
						if (!delResp.ok) throw new Error(`HTTP ${delResp.status}`);

						// Se estava editando esse aviso, cancela a edição
						if (editingAnnouncementId === id) {
							cancelEditingAnnouncement();
						}

						// Preenche o formulário com os dados excluídos para facilitar recadastro se o formulário estiver vazio
						if (
							targetItem &&
							announcementMessage &&
							(!announcementMessage.value.trim() || editingAnnouncementId === id)
						) {
							announcementMessage.value = targetItem.message;
							setExpiryHours(24);
							updateLivePreview();
							showToast(
								"Aviso removido. Os campos foram preenchidos para recadastro/edição se desejar.",
								"info",
								5000
							);
						} else {
							showToast("Aviso de status removido com sucesso!", "success");
						}

						await loadActiveAnnouncements();
					} catch (delErr) {
						showToast(`Erro ao remover aviso: ${delErr.message}`, "error");
						btn.disabled = false;
						btn.innerHTML = '<i class="fas fa-trash"></i> <span>Remover</span>';
					}
				});
			});
		} catch (err) {
			activeAnnouncementsList.innerHTML = `<div class="empty-state-mini" style="color:var(--danger-color);"><i class="fas fa-exclamation-triangle"></i> Erro ao carregar avisos: ${escapeHtml(err.message)}</div>`;
		}
	}

	function openPublishModal() {
		if (!publishModal) return;
		publishModal.classList.remove("hidden");
		if (announcementExpiresAt && !announcementExpiresAt.value) {
			setExpiryHours(24); // Padrão: 24 horas
		}
		updateLivePreview();
		loadActiveAnnouncements();
	}

	function closePublishModal() {
		if (!publishModal) return;
		publishModal.classList.add("hidden");
		if (editingAnnouncementId) {
			cancelEditingAnnouncement();
		}
	}

	window.openPublishStatusModal = openPublishModal;

	if (btnPublishStatus) {
		btnPublishStatus.addEventListener("click", (e) => {
			e.preventDefault();
			openPublishModal();
		});
	}

	if (btnClosePublishModal) {
		btnClosePublishModal.addEventListener("click", closePublishModal);
	}

	if (btnFooterClosePublishModal) {
		btnFooterClosePublishModal.addEventListener("click", closePublishModal);
	}

	if (btnCancelAnnouncementEditTop) {
		btnCancelAnnouncementEditTop.addEventListener("click", cancelEditingAnnouncement);
	}

	if (btnCancelAnnouncementEdit) {
		btnCancelAnnouncementEdit.addEventListener("click", cancelEditingAnnouncement);
	}

	if (publishModal) {
		publishModal.addEventListener("click", (e) => {
			if (e.target === publishModal) closePublishModal();
		});
	}

	document.addEventListener("keydown", (e) => {
		if (e.key === "Escape" && publishModal && !publishModal.classList.contains("hidden")) {
			closePublishModal();
		}
	});

	if (announcementMessage) {
		announcementMessage.addEventListener("input", updateLivePreview);
	}

	if (publishModal) {
		// Botões de formatação WhatsApp
		publishModal.querySelectorAll(".markup-btn").forEach((btn) => {
			btn.addEventListener("click", () => {
				const tag = btn.dataset.tag;
				if (tag === "bold") insertAtCursor("*", "*");
				else if (tag === "italic") insertAtCursor("_", "_");
				else if (tag === "strike") insertAtCursor("~", "~");
				else if (tag === "mono") insertAtCursor("```", "```");
				else if (tag === "quote") insertAtCursor("> ");
			});
		});

		// Emojis rápidos
		publishModal.querySelectorAll(".emoji-pill").forEach((btn) => {
			btn.addEventListener("click", () => {
				const emoji = btn.dataset.emoji;
				if (emoji) insertAtCursor(emoji);
			});
		});

		// Presets de expiração (+1h, +6h, etc.)
		publishModal.querySelectorAll(".expiry-preset-btn").forEach((btn) => {
			btn.addEventListener("click", () => {
				const hours = Number(btn.dataset.hours) || 24;
				setExpiryHours(hours);
			});
		});
	}

	if (btnSubmitAnnouncement) {
		btnSubmitAnnouncement.addEventListener("click", async () => {
			const message = announcementMessage ? announcementMessage.value.trim() : "";
			if (!message) {
				showToast("Por favor, digite o texto do aviso antes de salvar.", "error");
				if (announcementMessage) announcementMessage.focus();
				return;
			}

			const expiryVal = announcementExpiresAt ? announcementExpiresAt.value : "";
			if (!expiryVal) {
				showToast("Por favor, selecione uma data e hora de expiração válida.", "error");
				if (announcementExpiresAt) announcementExpiresAt.focus();
				return;
			}

			const expiresTimestamp = new Date(expiryVal).getTime();
			if (!Number.isFinite(expiresTimestamp) || expiresTimestamp <= Date.now()) {
				showToast("A data de expiração deve ser posterior ao horário atual.", "error");
				if (announcementExpiresAt) announcementExpiresAt.focus();
				return;
			}

			const isEditing = Boolean(editingAnnouncementId);
			btnSubmitAnnouncement.disabled = true;
			btnSubmitAnnouncement.innerHTML = isEditing
				? '<i class="fas fa-spinner fa-spin"></i> <span>Salvando...</span>'
				: '<i class="fas fa-spinner fa-spin"></i> <span>Publicando...</span>';

			try {
				const url = isEditing
					? `/api/status-announcements/${editingAnnouncementId}`
					: "/api/status-announcements";
				const method = isEditing ? "PUT" : "POST";

				const resp = await fetch(url, {
					method,
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						message,
						expiresAt: expiresTimestamp
					})
				});

				const resJson = await resp.json();
				if (!resp.ok || resJson.status !== "ok") {
					throw new Error(resJson.message || `Erro HTTP ${resp.status}`);
				}

				showToast(
					isEditing
						? "Aviso de status atualizado com sucesso!"
						: "Aviso de status publicado com sucesso!",
					"success"
				);

				cancelEditingAnnouncement();
				await loadActiveAnnouncements();
			} catch (err) {
				showToast(`Falha ao salvar aviso: ${err.message}`, "error");
			} finally {
				btnSubmitAnnouncement.disabled = false;
				if (editingAnnouncementId) {
					btnSubmitAnnouncement.innerHTML =
						'<i class="fas fa-save"></i> <span>Salvar Alterações</span>';
				} else {
					btnSubmitAnnouncement.innerHTML =
						'<i class="fas fa-paper-plane"></i> <span>Publicar Aviso</span>';
				}
			}
		});
	}

	// Carregamento inicial
	fetchBots(false);

	// Auto-refresh suave a cada 30 segundos em segundo plano (mantém sanfonas abertas e respeita edição)
	setInterval(() => {
		if (!isSaving && !isUserEditing()) {
			fetchBots(true);
		}
	}, 30000);
});
