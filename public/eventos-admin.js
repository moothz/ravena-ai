(function () {
	const tbody = document.getElementById("admin-events-tbody");
	const searchInput = document.getElementById("search-input");
	const statusFilter = document.getElementById("status-filter");
	const eventsCountBadge = document.getElementById("events-count");
	const btnNewEvent = document.getElementById("btn-new-event");
	const btnRefresh = document.getElementById("btn-refresh");

	// Modal Form
	const eventModal = document.getElementById("event-modal");
	const eventForm = document.getElementById("event-form");
	const modalTitle = document.getElementById("modal-title");
	const fieldId = document.getElementById("field-id");
	const fieldName = document.getElementById("field-name");
	const fieldStart = document.getElementById("field-start");
	const fieldEnd = document.getElementById("field-end");
	const fieldMessage = document.getElementById("field-message");
	const grantsGrid = document.getElementById("grants-grid");
	const buffsGrid = document.getElementById("buffs-grid");
	const btnRegenerateMsg = document.getElementById("btn-regenerate-msg");
	const btnSaveEvent = document.getElementById("btn-save-event");

	// Modal Mensagem
	const messageModal = document.getElementById("message-modal");
	const msgModalTitle = document.getElementById("msg-modal-title");
	const msgModalTextarea = document.getElementById("msg-modal-textarea");
	const btnCopyGeneratedMsg = document.getElementById("btn-copy-generated-msg");
	const btnSaveGeneratedMsg = document.getElementById("btn-save-generated-msg");

	// Modal Exclusão
	const deleteModal = document.getElementById("delete-modal");
	const deleteModalText = document.getElementById("delete-modal-text");
	const btnConfirmDelete = document.getElementById("btn-confirm-delete");

	let allEvents = [];
	let catalog = { startGrants: [], ongoingBuffs: [] };
	let messageEditedManually = false;
	let activeMsgEventId = null;
	let activeDeleteEventId = null;

	function escapeHtml(str) {
		return String(str ?? "")
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#039;");
	}

	function showToast(msg, type = "info") {
		const container = document.getElementById("toast-container");
		const el = document.createElement("div");
		el.className = `toast-item ${type}`;
		const icon =
			type === "success"
				? "fa-check-circle"
				: type === "error"
					? "fa-exclamation-circle"
					: "fa-info-circle";
		el.innerHTML = `<i class="fas ${icon}"></i><span>${escapeHtml(msg)}</span>`;
		container.appendChild(el);
		setTimeout(() => {
			el.remove();
		}, 4000);
	}

	function toBrtDatetimeLocal(tsMs) {
		if (!Number.isFinite(tsMs)) return "";
		// BRT é UTC-03:00 fixo: desloca -3h e lê UTC ISO slice(0, 16)
		const brtDate = new Date(tsMs - 3 * 60 * 60 * 1000);
		return brtDate.toISOString().slice(0, 16);
	}

	function renderCatalogGrid(containerEl, items, valuesMap, groupName) {
		containerEl.innerHTML = items
			.map((item) => {
				const rawVal = valuesMap && valuesMap[item.id];
				const isChecked = Number(rawVal) > 0;
				const val = isChecked ? Number(rawVal) : item.defaultValue;
				return `
					<div class="buff-item ${isChecked ? "checked" : ""}" data-group="${groupName}" data-id="${escapeHtml(item.id)}">
						<label class="buff-check-label">
							<input type="checkbox" class="buff-checkbox" data-group="${groupName}" data-id="${escapeHtml(item.id)}" ${isChecked ? "checked" : ""}>
							<span>
								${escapeHtml(item.emoji)} ${escapeHtml(item.label)}
								<span class="buff-meta">${escapeHtml(item.gameLabel)} · Válido: ${item.min} a ${item.max} ${escapeHtml(item.unit)}</span>
							</span>
						</label>
						<div class="buff-value-row">
							<input
								type="text"
								inputmode="numeric"
								pattern="[0-9]*"
								class="buff-value-input"
								data-group="${groupName}"
								data-id="${escapeHtml(item.id)}"
								data-min="${item.min}"
								data-max="${item.max}"
								value="${val}"
								${isChecked ? "" : "disabled"}
							>
							<span class="buff-unit">${escapeHtml(item.unit)}</span>
						</div>
					</div>
				`;
			})
			.join("");

		containerEl.querySelectorAll(".buff-checkbox").forEach((cb) => {
			cb.addEventListener("change", () => {
				const box = cb.closest(".buff-item");
				const input = box.querySelector(".buff-value-input");
				box.classList.toggle("checked", cb.checked);
				input.disabled = !cb.checked;
				if (cb.checked) {
					const min = Number(input.dataset.min || 1);
					const max = Number(input.dataset.max || 1000000);
					const cur = Number(input.value);
					if (!Number.isInteger(cur) || cur < min || cur > max) {
						const item = items.find((i) => i.id === cb.dataset.id);
						input.value = item ? item.defaultValue : min;
					}
					input.focus();
				}
				maybeAutoGenerateMessage();
			});
		});

		containerEl.querySelectorAll(".buff-value-input").forEach((input) => {
			input.addEventListener("input", () => {
				// Impede caracteres não numéricos/decimais em tempo real
				input.value = input.value.replace(/[^0-9]/g, "");
				maybeAutoGenerateMessage();
			});
		});
	}

	function collectBuffSection(containerEl, items) {
		const selected = {};
		const boxes = containerEl.querySelectorAll(".buff-item");
		for (const box of boxes) {
			const cb = box.querySelector(".buff-checkbox");
			const input = box.querySelector(".buff-value-input");
			if (!cb.checked) continue;

			const id = cb.dataset.id;
			const spec = items.find((i) => i.id === id);
			const raw = input.value.trim();
			if (!/^\d+$/.test(raw)) {
				throw new Error(
					`Informe um número inteiro válido para "${spec ? spec.label : id}".`
				);
			}
			const num = parseInt(raw, 10);
			if (spec && (num < spec.min || num > spec.max)) {
				throw new Error(
					`"${spec.label}" aceita valores entre ${spec.min} e ${spec.max} (${spec.unit}).`
				);
			}
			selected[id] = num;
		}
		return selected;
	}

	function collectFormPayload({ allowPartialForPreview = false } = {}) {
		const name = fieldName.value.trim();
		const startTime = fieldStart.value;
		const endTime = fieldEnd.value;

		if (!allowPartialForPreview) {
			if (!name) throw new Error("Informe o nome do evento.");
			if (!startTime || !endTime) throw new Error("Preencha a data/hora inicial e final.");
			if (endTime <= startTime) {
				throw new Error("A data/hora final deve ser posterior à data/hora inicial.");
			}
		}

		const startGrants = collectBuffSection(grantsGrid, catalog.startGrants);
		const ongoingBuffs = collectBuffSection(buffsGrid, catalog.ongoingBuffs);

		return {
			name,
			startTime,
			endTime,
			startGrants,
			ongoingBuffs,
			message: fieldMessage.value
		};
	}

	let previewTimer = null;
	function maybeAutoGenerateMessage(force = false) {
		if (!force && messageEditedManually) return;
		clearTimeout(previewTimer);
		previewTimer = setTimeout(async () => {
			try {
				if (!fieldName.value.trim() || !fieldStart.value || !fieldEnd.value) return;
				if (fieldEnd.value <= fieldStart.value) return;
				const payload = collectFormPayload({ allowPartialForPreview: true });
				const res = await fetch("/api/events/admin/generate-message", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(payload)
				});
				const data = await res.json();
				if (res.ok && data.ok) {
					fieldMessage.value = data.message;
					if (force) messageEditedManually = false;
				}
			} catch (_e) {
				// Silencioso no preview automático se um input estiver sendo digitado
			}
		}, force ? 0 : 250);
	}

	function openEventModal(eventObj = null) {
		messageEditedManually = Boolean(eventObj && eventObj.message);

		if (eventObj) {
			fieldId.value = String(eventObj.id);
			modalTitle.innerHTML =
				'<i class="fas fa-edit" style="color: var(--primary-color);"></i><span>Editar Evento Programado</span>';
			fieldName.value = eventObj.name || "";
			fieldStart.value = toBrtDatetimeLocal(eventObj.startTime);
			fieldEnd.value = toBrtDatetimeLocal(eventObj.endTime);
			fieldMessage.value = eventObj.message || "";
			renderCatalogGrid(grantsGrid, catalog.startGrants, eventObj.startGrants, "grants");
			renderCatalogGrid(buffsGrid, catalog.ongoingBuffs, eventObj.ongoingBuffs, "buffs");
		} else {
			fieldId.value = "";
			modalTitle.innerHTML =
				'<i class="fas fa-calendar-plus" style="color: var(--accent-green);"></i><span>Novo Evento Programado</span>';
			const now = Date.now();
			const defaultStart = now + 60 * 60 * 1000;
			const defaultEnd = defaultStart + 24 * 60 * 60 * 1000;
			fieldName.value = "";
			fieldStart.value = toBrtDatetimeLocal(defaultStart);
			fieldEnd.value = toBrtDatetimeLocal(defaultEnd);
			fieldMessage.value = "";
			messageEditedManually = false;
			renderCatalogGrid(grantsGrid, catalog.startGrants, {}, "grants");
			renderCatalogGrid(buffsGrid, catalog.ongoingBuffs, {}, "buffs");
		}

		eventModal.classList.add("active");
	}

	function closeEventModal() {
		eventModal.classList.remove("active");
	}

	async function handleGenerateRowMessage(eventObj) {
		try {
			const res = await fetch("/api/events/admin/generate-message", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ id: eventObj.id, save: false })
			});
			const data = await res.json();
			if (!res.ok || !data.ok) {
				throw new Error(data.error || "Erro ao gerar mensagem.");
			}
			activeMsgEventId = eventObj.id;
			msgModalTitle.textContent = `Mensagem WhatsApp — ${eventObj.name}`;
			msgModalTextarea.value = data.message;
			messageModal.classList.add("active");
		} catch (err) {
			showToast(err.message, "error");
		}
	}

	function openDeleteModal(eventObj) {
		activeDeleteEventId = eventObj.id;
		deleteModalText.innerHTML = `Deseja realmente apagar o evento <strong>${escapeHtml(eventObj.name)}</strong> (#${eventObj.id})? Essa ação não pode ser desfeita.`;
		deleteModal.classList.add("active");
	}

	function renderMiniChips(list, cls) {
		if (!Array.isArray(list) || list.length === 0) {
			return '<span style="color: #64748b; font-size: 12px;">—</span>';
		}
		return `<div class="mini-chips">${list
			.map(
				(i) =>
					`<span class="mini-chip ${cls}">${escapeHtml(i.emoji)} ${escapeHtml(i.label)}: +${Number(i.value).toLocaleString("pt-BR")}${i.unit === "%" ? "%" : ` ${escapeHtml(i.unit)}`}</span>`
			)
			.join("")}</div>`;
	}

	function renderTable() {
		const query = searchInput.value.trim().toLowerCase();
		const statusVal = statusFilter.value;

		const filtered = allEvents.filter((ev) => {
			if (statusVal !== "all" && ev.status !== statusVal) return false;
			if (query && !String(ev.name || "").toLowerCase().includes(query)) return false;
			return true;
		});

		eventsCountBadge.textContent = `${filtered.length} evento${filtered.length === 1 ? "" : "s"}`;

		if (filtered.length === 0) {
			tbody.innerHTML = `
				<tr>
					<td colspan="9" style="text-align: center; padding: 36px; color: #8b8ea8;">
						Nenhum evento encontrado. Clique em <strong>Novo Evento</strong> para programar o próximo!
					</td>
				</tr>
			`;
			return;
		}

		tbody.innerHTML = filtered
			.map(
				(ev) => `
				<tr class="row-${escapeHtml(ev.status || "normal")}" data-id="${ev.id}">
					<td class="mono-text">#${ev.id}</td>
					<td><span class="status-badge ${escapeHtml(ev.status || "normal")}">${escapeHtml(ev.statusLabel || ev.status)}</span></td>
					<td>
						<div style="font-weight: 700; color: #fff; margin-bottom: 4px;">${escapeHtml(ev.name)}</div>
						${ev.startedAt ? '<span style="font-size: 11px; color: #34d399;"><i class="fas fa-paper-plane"></i> Aviso &amp; itens iniciais disparados</span>' : '<span style="font-size: 11px; color: #94a3b8;"><i class="fas fa-hourglass"></i> Aguardando início</span>'}
					</td>
					<td class="mono-text">${escapeHtml(ev.startFormatted)}</td>
					<td class="mono-text">${escapeHtml(ev.endFormatted)}</td>
					<td class="mono-text">${escapeHtml(ev.durationLabel)}</td>
					<td>${renderMiniChips(ev.grantsList, "grant")}</td>
					<td>${renderMiniChips(ev.buffsList, "ongoing")}</td>
					<td>
						<div class="actions-col">
							<button type="button" class="btn-row edit" data-action="edit" data-id="${ev.id}">
								<i class="fas fa-edit"></i> Editar
							</button>
							<button type="button" class="btn-row msg" data-action="msg" data-id="${ev.id}">
								<i class="fab fa-whatsapp"></i> Gerar Mensagem
							</button>
							<button type="button" class="btn-row delete" data-action="delete" data-id="${ev.id}">
								<i class="fas fa-trash"></i> Apagar
							</button>
						</div>
					</td>
				</tr>
			`
			)
			.join("");

		tbody.querySelectorAll("button[data-action]").forEach((btn) => {
			btn.addEventListener("click", () => {
				const id = Number(btn.dataset.id);
				const ev = allEvents.find((e) => e.id === id);
				if (!ev) return;

				const action = btn.dataset.action;
				if (action === "edit") openEventModal(ev);
				else if (action === "delete") openDeleteModal(ev);
				else if (action === "msg") handleGenerateRowMessage(ev);
			});
		});
	}

	async function loadAdminEvents() {
		const icon = btnRefresh.querySelector("i");
		icon.classList.add("fa-spin");
		try {
			const res = await fetch("/api/events/admin");
			if (res.status === 401) {
				window.location.reload();
				return;
			}
			const data = await res.json();
			if (!res.ok || !data.ok) {
				throw new Error(data.error || "Falha ao carregar eventos.");
			}
			allEvents = data.events || [];
			if (data.catalog) catalog = data.catalog;
			renderTable();
		} catch (err) {
			showToast(err.message, "error");
		} finally {
			icon.classList.remove("fa-spin");
		}
	}

	eventForm.addEventListener("submit", async (e) => {
		e.preventDefault();
		let payload;
		try {
			payload = collectFormPayload();
		} catch (valErr) {
			showToast(valErr.message, "error");
			return;
		}

		const id = fieldId.value ? Number(fieldId.value) : null;
		btnSaveEvent.disabled = true;
		try {
			const url = id ? `/api/events/admin/${id}` : "/api/events/admin";
			const method = id ? "PUT" : "POST";
			const res = await fetch(url, {
				method,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload)
			});
			const data = await res.json();
			if (!res.ok || !data.ok) {
				throw new Error(data.error || "Erro ao salvar evento.");
			}
			showToast(
				id ? "Evento atualizado com sucesso!" : "Evento programado criado com sucesso!",
				"success"
			);
			closeEventModal();
			await loadAdminEvents();
		} catch (err) {
			showToast(err.message, "error");
		} finally {
			btnSaveEvent.disabled = false;
		}
	});

	fieldName.addEventListener("input", () => maybeAutoGenerateMessage());
	fieldStart.addEventListener("change", () => maybeAutoGenerateMessage());
	fieldEnd.addEventListener("change", () => maybeAutoGenerateMessage());
	fieldMessage.addEventListener("input", () => {
		messageEditedManually = fieldMessage.value.trim().length > 0;
	});

	btnRegenerateMsg.addEventListener("click", async () => {
		try {
			const payload = collectFormPayload({ allowPartialForPreview: false });
			const res = await fetch("/api/events/admin/generate-message", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload)
			});
			const data = await res.json();
			if (!res.ok || !data.ok) {
				throw new Error(data.error || "Não foi possível gerar a mensagem.");
			}
			fieldMessage.value = data.message;
			messageEditedManually = false;
			showToast("Mensagem WhatsApp gerada!", "success");
		} catch (err) {
			showToast(err.message, "error");
		}
	});

	btnCopyGeneratedMsg.addEventListener("click", async () => {
		try {
			await navigator.clipboard.writeText(msgModalTextarea.value);
			showToast("Mensagem copiada para a área de transferência!", "success");
		} catch (_err) {
			msgModalTextarea.select();
			document.execCommand("copy");
			showToast("Mensagem selecionada/copiada!", "success");
		}
	});

	btnSaveGeneratedMsg.addEventListener("click", async () => {
		const ev = allEvents.find((e) => e.id === activeMsgEventId);
		if (!ev) return;
		btnSaveGeneratedMsg.disabled = true;
		try {
			const res = await fetch(`/api/events/admin/${ev.id}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: ev.name,
					startTime: ev.startTime,
					endTime: ev.endTime,
					startGrants: ev.startGrants,
					ongoingBuffs: ev.ongoingBuffs,
					message: msgModalTextarea.value
				})
			});
			const data = await res.json();
			if (!res.ok || !data.ok) {
				throw new Error(data.error || "Erro ao salvar mensagem.");
			}
			showToast("Mensagem salva no evento!", "success");
			messageModal.classList.remove("active");
			await loadAdminEvents();
		} catch (err) {
			showToast(err.message, "error");
		} finally {
			btnSaveGeneratedMsg.disabled = false;
		}
	});

	btnConfirmDelete.addEventListener("click", async () => {
		if (!activeDeleteEventId) return;
		btnConfirmDelete.disabled = true;
		try {
			const res = await fetch(`/api/events/admin/${activeDeleteEventId}`, {
				method: "DELETE"
			});
			const data = await res.json();
			if (!res.ok || !data.ok) {
				throw new Error(data.error || "Erro ao apagar evento.");
			}
			showToast("Evento apagado.", "success");
			deleteModal.classList.remove("active");
			await loadAdminEvents();
		} catch (err) {
			showToast(err.message, "error");
		} finally {
			btnConfirmDelete.disabled = false;
		}
	});

	btnNewEvent.addEventListener("click", () => openEventModal(null));
	btnRefresh.addEventListener("click", () => loadAdminEvents());
	searchInput.addEventListener("input", () => renderTable());
	statusFilter.addEventListener("change", () => renderTable());

	document.getElementById("btn-close-event-modal").addEventListener("click", closeEventModal);
	document.getElementById("btn-cancel-event-modal").addEventListener("click", closeEventModal);
	document
		.getElementById("btn-close-msg-modal")
		.addEventListener("click", () => messageModal.classList.remove("active"));
	document
		.getElementById("btn-close-delete-modal")
		.addEventListener("click", () => deleteModal.classList.remove("active"));
	document
		.getElementById("btn-cancel-delete-modal")
		.addEventListener("click", () => deleteModal.classList.remove("active"));

	loadAdminEvents();
})();
