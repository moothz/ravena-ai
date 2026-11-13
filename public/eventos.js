(function () {
	const yearSelect = document.getElementById("year-select");
	const tbody = document.getElementById("events-tbody");
	const btnRefresh = document.getElementById("btn-refresh");
	const statActive = document.getElementById("stat-active");
	const statNext = document.getElementById("stat-next");
	const statTotal = document.getElementById("stat-total");
	const statYearLabel = document.getElementById("stat-year-label");

	let selectedYear = null;

	function escapeHtml(str) {
		return String(str ?? "")
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#039;");
	}

	function renderChips(list, cssClass) {
		if (!Array.isArray(list) || list.length === 0) {
			return '<span style="color: #64748b; font-size: 12px;">—</span>';
		}
		const prefix = cssClass === "grant" ? "+" : "+";
		return `<div class="buffs-stack">${list
			.map((item) => {
				const valStr = Number(item.value).toLocaleString("pt-BR");
				const suffix = item.unit === "%" ? "%" : ` ${escapeHtml(item.unit)}`;
				return `<span class="buff-chip ${cssClass}" title="${escapeHtml(item.description || "")}">${escapeHtml(item.emoji)} ${escapeHtml(item.label)} (${escapeHtml(item.gameLabel)}): <strong>${prefix}${valStr}${suffix}</strong></span>`;
			})
			.join("")}</div>`;
	}

	function statusIcon(status) {
		if (status === "ativo") return '<i class="fas fa-circle-play fa-play-circle"></i>';
		if (status === "proximo") return '<i class="fas fa-clock"></i>';
		if (status === "passado") return '<i class="fas fa-check-double"></i>';
		return '<i class="fas fa-calendar"></i>';
	}

	function updateSummary(events, year) {
		const activeCount = events.filter((e) => e.status === "ativo").length;
		const nextEvent = events.find((e) => e.status === "proximo");

		statYearLabel.textContent = String(year);
		statTotal.textContent = String(events.length);
		statActive.textContent = activeCount > 0 ? `${activeCount} ativo(s)` : "Nenhum no momento";
		statNext.textContent = nextEvent ? `${nextEvent.name} (${nextEvent.startFormatted})` : "—";
		if (nextEvent) {
			statNext.style.fontSize = "14px";
		} else {
			statNext.style.fontSize = "20px";
		}
	}

	function renderEvents(events) {
		if (!events || events.length === 0) {
			tbody.innerHTML = `
				<tr>
					<td colspan="7" class="empty-state">
						<i class="fas fa-calendar-times"></i>
						<div>Nenhum evento programado encontrado para este ano.</div>
					</td>
				</tr>
			`;
			return;
		}

		tbody.innerHTML = events
			.map((ev) => {
				const rowClass = `event-row-${escapeHtml(ev.status || "normal")}`;
				const badgeClass = escapeHtml(ev.status || "normal");
				return `
					<tr class="${rowClass}">
						<td>
							<span class="status-badge ${badgeClass}">
								${statusIcon(ev.status)} ${escapeHtml(ev.statusLabel || ev.status)}
							</span>
						</td>
						<td>
							<div class="event-name">${escapeHtml(ev.name)}</div>
						</td>
						<td class="mono-date">${escapeHtml(ev.startFormatted)}</td>
						<td class="mono-date">${escapeHtml(ev.endFormatted)}</td>
						<td class="mono-date">${escapeHtml(ev.durationLabel)}</td>
						<td>${renderChips(ev.grantsList, "grant")}</td>
						<td>${renderChips(ev.buffsList, "ongoing")}</td>
					</tr>
				`;
			})
			.join("");
	}

	async function loadEvents(year = null) {
		btnRefresh.disabled = true;
		btnRefresh.querySelector("i").classList.add("fa-spin");
		try {
			const query = year ? `?year=${encodeURIComponent(year)}` : "";
			const res = await fetch(`/api/events/public${query}`);
			const data = await res.json();
			if (!res.ok || !data.ok) {
				throw new Error(data.error || "Erro ao carregar eventos.");
			}

			selectedYear = data.year;
			const years = Array.isArray(data.availableYears) ? data.availableYears : [data.year];
			yearSelect.innerHTML = years
				.map(
					(y) =>
						`<option value="${y}" ${Number(y) === Number(data.year) ? "selected" : ""}>${y}</option>`
				)
				.join("");

			updateSummary(data.events || [], data.year);
			renderEvents(data.events || []);
		} catch (err) {
			tbody.innerHTML = `
				<tr>
					<td colspan="7" class="empty-state" style="color: #f87171;">
						<i class="fas fa-exclamation-triangle"></i>
						<div>Falha ao carregar eventos: ${escapeHtml(err.message)}</div>
					</td>
				</tr>
			`;
		} finally {
			btnRefresh.disabled = false;
			btnRefresh.querySelector("i").classList.remove("fa-spin");
		}
	}

	yearSelect.addEventListener("change", () => {
		loadEvents(yearSelect.value);
	});

	btnRefresh.addEventListener("click", () => {
		loadEvents(selectedYear || yearSelect.value);
	});

	loadEvents();
	setInterval(() => loadEvents(selectedYear), 60000);
})();
