document.addEventListener("DOMContentLoaded", () => {
	const tabUsers = document.getElementById("tab-users");
	const tabGroups = document.getElementById("tab-groups");
	const usersView = document.getElementById("users-view");
	const groupsView = document.getElementById("groups-view");
	const usersContainer = document.getElementById("users-container");
	const groupsContainer = document.getElementById("groups-container");
	const searchInput = document.getElementById("global-search");
	const refreshBtn = document.getElementById("refresh-btn");
	const loadingContainer = document.getElementById("loading-container");
	const errorContainer = document.getElementById("error-container");
	const errorMessage = document.getElementById("error-message");
	const retryBtn = document.getElementById("retry-button");

	const userModal = document.getElementById("user-modal");
	const modalCloseBtn = document.getElementById("modal-close-btn");
	const modalUserName = document.getElementById("modal-user-name");
	const modalUserBody = document.getElementById("modal-user-body");

	let currentTab = "users"; // 'users' ou 'groups'
	let searchTimeout = null;

	// Alternância de Abas
	tabUsers.addEventListener("click", () => {
		currentTab = "users";
		tabUsers.classList.add("active");
		tabGroups.classList.remove("active");
		usersView.classList.remove("hidden");
		groupsView.classList.add("hidden");
		fetchData();
	});

	tabGroups.addEventListener("click", () => {
		currentTab = "groups";
		tabGroups.classList.add("active");
		tabUsers.classList.remove("active");
		groupsView.classList.remove("hidden");
		usersView.classList.add("hidden");
		fetchData();
	});

	// Busca com debounce
	searchInput.addEventListener("input", () => {
		clearTimeout(searchTimeout);
		searchTimeout = setTimeout(() => {
			fetchData();
		}, 300);
	});

	refreshBtn.addEventListener("click", () => fetchData());
	retryBtn.addEventListener("click", () => fetchData());

	// Fechar modal
	modalCloseBtn.addEventListener("click", () => userModal.classList.add("hidden"));
	userModal.addEventListener("click", (e) => {
		if (e.target === userModal) userModal.classList.add("hidden");
	});

	async function fetchData() {
		loadingContainer.classList.remove("hidden");
		errorContainer.classList.add("hidden");

		const query = searchInput.value.trim();

		try {
			if (currentTab === "users") {
				const res = await fetch(`/api/dossies/users?q=${encodeURIComponent(query)}&limit=50`);
				if (!res.ok) throw new Error("Erro ao carregar lista de usuários");
				const users = await res.json();
				renderUsers(users);
			} else {
				const res = await fetch(`/api/dossies/groups?q=${encodeURIComponent(query)}&limit=50`);
				if (!res.ok) throw new Error("Erro ao carregar lista de grupos");
				const groups = await res.json();
				renderGroups(groups);
			}
			loadingContainer.classList.add("hidden");
		} catch (err) {
			loadingContainer.classList.add("hidden");
			errorContainer.classList.remove("hidden");
			errorMessage.textContent = err.message;
		}
	}

	function renderUsers(users) {
		usersContainer.innerHTML = "";
		if (!users || users.length === 0) {
			usersContainer.innerHTML = '<div class="alert alert-info" style="grid-column: 1/-1;">Nenhum usuário encontrado na memória.</div>';
			return;
		}

		users.forEach((u) => {
			const card = document.createElement("div");
			card.className = "user-card";

			const platformBadge = u.platform === "whatsapp" ? '<span class="user-badge badge-wa">WhatsApp</span>' : '<span class="user-badge badge-tg">Telegram</span>';
			const factsBadge = u.facts_count > 0 ? `<span class="user-badge badge-facts">${u.facts_count} fatos IA</span>` : "";

			card.innerHTML = `
				<div class="user-card-header">
					<div class="user-card-title">${escapeHtml(u.display_name || "Membro")}</div>
					<div style="display: flex; gap: 5px;">
						${platformBadge}
						${factsBadge}
					</div>
				</div>
				<div class="user-card-meta">
					<div><strong>ID:</strong> <code>${escapeHtml(u.platform_id)}</code></div>
					<div><strong>Canônico:</strong> <code>${escapeHtml(u.canonical_user_id)}</code></div>
				</div>
				<div style="font-size: 0.8em; color: #888; margin-top: 8px;">
					<i class="fas fa-eye"></i> Clique para abrir o Dossiê 360º
				</div>
			`;

			card.addEventListener("click", () => openUserModal(u.canonical_user_id || u.platform_id));
			usersContainer.appendChild(card);
		});
	}

	async function openUserModal(userId) {
		modalUserName.textContent = "Carregando Dossiê 360º...";
		modalUserBody.innerHTML = '<div class="loading-spinner"></div>';
		userModal.classList.remove("hidden");

		try {
			const res = await fetch(`/api/dossies/user/${encodeURIComponent(userId)}`);
			if (!res.ok) throw new Error("Usuário não encontrado");
			const d = await res.json();

			modalUserName.textContent = `Dossiê 360º: ${d.display_name || d.canonical_user_id}`;

			// Identidades
			let identitiesHtml = "";
			if (d.identities && d.identities.length > 0) {
				identidadesHtml = d.identities
					.map((i) => `<li>[${i.platform}] <strong>${i.id_type}:</strong> <code>${i.platform_id}</code></li>`)
					.join("");
			}

			// Jogos
			const g = d.games || {};
			let gamesHtml = '<div class="stats-grid">';
			if (g.fishing) {
				gamesHtml += `
					<div class="stat-item">
						<div class="stat-label">🎣 Pesca Ravena</div>
						<div class="stat-val">Nível ${g.fishing.level} (${g.fishing.total_fishes_caught || 0} peixes)</div>
						<div style="font-size:0.8em; color:#aaa;">Vara: ${g.fishing.equipped_rod || "Básica"}</div>
					</div>`;
			}
			if (g.slots) {
				gamesHtml += `
					<div class="stat-item">
						<div class="stat-label">🎰 Cassino / Slots</div>
						<div class="stat-val">${g.slots.coins || 0} fichas</div>
						<div style="font-size:0.8em; color:#aaa;">${g.slots.total_bets || 0} apostas realizadas</div>
					</div>`;
			}
			if (g.donation && g.donation.valor > 0) {
				gamesHtml += `
					<div class="stat-item">
						<div class="stat-label">💎 Apoiador / Doador</div>
						<div class="stat-val" style="color: #ffd166;">R$ ${g.donation.valor.toFixed(2)}</div>
						<div style="font-size:0.8em; color:#aaa;">Doador registrado</div>
					</div>`;
			}
			if (g.relationships && g.relationships.length > 0) {
				const r = g.relationships[0];
				gamesHtml += `
					<div class="stat-item">
						<div class="stat-label">💍 Relacionamento</div>
						<div class="stat-val">${r.tipo} (${r.status})</div>
						<div style="font-size:0.8em; color:#aaa;">${r.coisas_count || 0} interações</div>
					</div>`;
			}
			gamesHtml += "</div>";

			// Fatos Semânticos
			let factsHtml = "";
			if (d.facts && d.facts.length > 0) {
				factsHtml = d.facts
					.map((f) => {
						const date = f.last_confirmed_at ? new Date(f.last_confirmed_at).toLocaleDateString("pt-BR") : "";
						return `<div class="fact-pill">
							<span style="font-size: 0.75em; text-transform: uppercase; color: #b197fc; font-weight: bold;">[${f.category}]</span> 
							${escapeHtml(f.fact_text)} 
							<span style="float: right; color: #888; font-size: 0.8em;">${date}</span>
						</div>`;
					})
					.join("");
			} else {
				factsHtml = '<div style="color: #888; font-style: italic;">Nenhum fato semântico extraído pela IA ainda.</div>';
			}

			// Grupos
			let groupsHtml = "";
			if (d.active_groups && d.active_groups.length > 0) {
				groupsHtml = d.active_groups
					.map((ag) => `<li><code>${escapeHtml(ag.target_id)}</code>: <strong>${ag.msgs_count}</strong> mensagens recentes</li>`)
					.join("");
			}

			modalUserBody.innerHTML = `
				<div class="section-box">
					<div class="section-title"><i class="fas fa-id-card"></i> Identidades & Vinculações</div>
					<div style="font-size: 0.9em; margin-bottom: 6px;"><strong>ID Canônico:</strong> <code>${d.canonical_user_id}</code></div>
					<ul style="padding-left: 20px; font-size: 0.9em;">
						${identidadesHtml || "<li>Nenhuma identidade adicional vinculada</li>"}
					</ul>
				</div>

				<div class="section-box">
					<div class="section-title"><i class="fas fa-gamepad"></i> Atividades nos Jogos & Economia</div>
					${gamesHtml}
				</div>

				<div class="section-box">
					<div class="section-title"><i class="fas fa-brain"></i> Fatos e Curiosidades Memorizadas (Global)</div>
					${factsHtml}
				</div>

				<div class="section-box">
					<div class="section-title"><i class="fas fa-comments"></i> Atividade em Grupos</div>
					<ul style="padding-left: 20px; font-size: 0.9em;">
						${groupsHtml || "<li>Sem atividade recente em grupos registrada no buffer</li>"}
					</ul>
				</div>
			`;
		} catch (err) {
			modalUserBody.innerHTML = `<div class="alert alert-danger">Erro ao carregar dossiê: ${err.message}</div>`;
		}
	}

	function renderGroups(groups) {
		groupsContainer.innerHTML = "";
		if (!groups || groups.length === 0) {
			groupsContainer.innerHTML = '<div class="alert alert-info">Nenhum grupo encontrado na memória.</div>';
			return;
		}

		groups.forEach((g) => {
			const section = document.createElement("div");
			section.className = "group-section";

			const score = g.average_problematic_score || 0;
			const scoreClass = score >= 7 ? "score-high" : score >= 4 ? "score-medium" : "score-low";

			let topicsPills = "";
			try {
				const topics = typeof g.frequent_topics === "string" ? JSON.parse(g.frequent_topics) : g.frequent_topics;
				if (Array.isArray(topics) && topics.length > 0) {
					topicsPills = topics.map((t) => `<span class="user-badge badge-facts" style="margin-right: 4px;">${escapeHtml(t)}</span>`).join("");
				}
			} catch (e) {}

			section.innerHTML = `
				<div class="group-header">
					<div style="display: flex; align-items: center; gap: 15px; flex: 1;">
						<span style="font-weight: 500; font-size: 1.1em;">${escapeHtml(g.title || g.group_id)}</span>
						<span class="group-score ${scoreClass}">Nota Risco: ${score.toFixed(1)}</span>
						<span style="font-size: 0.85em; color: #888;">${g.dossiers_count || 0} dossiês</span>
					</div>
					<div class="toggle-icon"><i class="fas fa-chevron-down"></i></div>
				</div>
				<div style="padding: 15px 20px; border-top: 1px solid rgba(255,255,255,0.05); font-size: 0.9em; background: rgba(0,0,0,0.15);">
					<div style="margin-bottom: 8px;"><strong>Vibe:</strong> <em>${escapeHtml(g.vibe_summary || "descontraído")}</em></div>
					<div style="margin-bottom: 8px;"><strong>Último Resumo:</strong> ${escapeHtml(g.latest_summary || "Nenhum resumo recente gerado.")}</div>
					<div><strong>Tópicos Recorrentes:</strong> ${topicsPills || '<span style="color:#888;">Não catalogados</span>'}</div>
				</div>
			`;

			groupsContainer.appendChild(section);
		});
	}

	function escapeHtml(str) {
		if (!str) return "";
		return String(str)
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#039;");
	}

	// Carregamento inicial
	fetchData();
});
