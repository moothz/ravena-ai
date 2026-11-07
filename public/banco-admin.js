// public/banco-admin.js — Frontend do Painel Administrativo do RavenaBank

document.addEventListener("DOMContentLoaded", () => {
    // Estado da aplicação
    const state = {
        currentPage: 1,
        pageSize: 20,
        searchQuery: "",
        totalPages: 1,
        totalUsers: 0,
        isLoading: false,
        activeTab: "tab-users",
        editingUserId: null
    };

    // Elementos DOM
    const tabUsersBtn = document.getElementById("btn-tab-users");
    const tabConfigBtn = document.getElementById("btn-tab-config");
    const tabUsersContent = document.getElementById("tab-users");
    const tabConfigContent = document.getElementById("tab-config");

    const searchInput = document.getElementById("user-search-input");
    const clearSearchBtn = document.getElementById("btn-clear-search");
    const refreshUsersBtn = document.getElementById("btn-refresh-users");
    const usersCountBadge = document.getElementById("users-count-badge");
    const usersTableBody = document.getElementById("users-table-body");
    const paginationControls = document.getElementById("pagination-controls");
    const paginationInfo = document.getElementById("pagination-info");
    const paginationButtons = document.getElementById("pagination-buttons");

    const btnRecalculateRates = document.getElementById("btn-recalculate-rates");

    // Formatação brasileira
    function formatPtBr(val, decimals = 2) {
        if (val === null || val === undefined || isNaN(val)) return "0";
        return Number(val).toLocaleString("pt-BR", {
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals
        });
    }

    function formatInt(val) {
        if (val === null || val === undefined || isNaN(val)) return "0";
        return Math.round(Number(val)).toLocaleString("pt-BR");
    }

    function formatPhone(phone) {
        if (!phone) return "Desconhecido";
        const clean = String(phone).replace(/\D/g, "");
        if (clean.length === 13 && clean.startsWith("55")) {
            return `+${clean.slice(0, 2)} (${clean.slice(2, 4)}) ${clean.slice(4, 9)}-${clean.slice(9)}`;
        }
        if (clean.length === 12 && clean.startsWith("55")) {
            return `+${clean.slice(0, 2)} (${clean.slice(2, 4)}) ${clean.slice(4, 8)}-${clean.slice(8)}`;
        }
        return phone;
    }

    // Toast Notifications
    function showToast(message, type = "info", duration = 4000) {
        const container = document.getElementById("bank-toast-container");
        if (!container) return;

        const toast = document.createElement("div");
        toast.className = `bank-toast toast-${type}`;

        let icon = "fa-info-circle";
        if (type === "success") icon = "fa-check-circle";
        else if (type === "error") icon = "fa-exclamation-circle";
        else if (type === "warning") icon = "fa-exclamation-triangle";

        toast.innerHTML = `
            <i class="fas ${icon} toast-icon"></i>
            <div style="flex: 1; word-break: break-word;">${message}</div>
            <button type="button" class="toast-close">&times;</button>
        `;

        const closeBtn = toast.querySelector(".toast-close");
        const remove = () => {
            toast.style.opacity = "0";
            toast.style.transform = "translateY(-8px) scale(0.95)";
            setTimeout(() => toast.remove(), 250);
        };

        closeBtn.addEventListener("click", remove);
        if (duration > 0) setTimeout(remove, duration);

        container.appendChild(toast);
    }

    // 1. Gerenciamento de Abas
    function switchTab(tabId) {
        state.activeTab = tabId;
        if (tabId === "tab-users") {
            tabUsersBtn.classList.add("active");
            tabConfigBtn.classList.remove("active");
            tabUsersContent.classList.add("active");
            tabConfigContent.classList.remove("active");
        } else {
            tabConfigBtn.classList.add("active");
            tabUsersBtn.classList.remove("active");
            tabConfigContent.classList.add("active");
            tabUsersContent.classList.remove("active");
            loadConfigData();
        }
    }

    tabUsersBtn.addEventListener("click", () => switchTab("tab-users"));
    tabConfigBtn.addEventListener("click", () => switchTab("tab-config"));

    // 2. Carregamento da Lista de Usuários
    async function loadUsers(page = 1) {
        state.isLoading = true;
        state.currentPage = page;

        usersTableBody.innerHTML = `
            <tr>
                <td colspan="4" class="state-container">
                    <i class="fas fa-spinner fa-spin"></i>
                    <p>Consultando usuários e apelidos...</p>
                </td>
            </tr>
        `;

        try {
            const queryParams = new URLSearchParams({
                page: String(state.currentPage),
                limit: String(state.pageSize),
                q: state.searchQuery || ""
            });

            const res = await fetch(`/api/games/bank/admin/users?${queryParams.toString()}`);
            if (res.status === 401) {
                window.location.reload();
                return;
            }

            const json = await res.json();
            if (!json.ok || !json.data) {
                throw new Error(json.error || "Erro ao consultar usuários");
            }

            const { users, total, totalPages } = json.data;
            state.totalUsers = total;
            state.totalPages = totalPages;

            usersCountBadge.textContent = `${formatInt(total)} ${total === 1 ? "usuário" : "usuários"}`;

            renderUsersTable(users);
            renderPagination();
        } catch (err) {
            console.error("Erro ao carregar usuários:", err);
            usersTableBody.innerHTML = `
                <tr>
                    <td colspan="4" class="state-container" style="color: var(--accent-red);">
                        <i class="fas fa-exclamation-triangle"></i>
                        <p>Falha ao carregar lista de usuários: ${err.message}</p>
                        <button type="button" class="btn-refresh" onclick="window.location.reload()" style="margin-top: 10px;">
                            <i class="fas fa-redo"></i> Tentar novamente
                        </button>
                    </td>
                </tr>
            `;
            showToast(`Erro ao carregar usuários: ${err.message}`, "error");
        } finally {
            state.isLoading = false;
        }
    }

    // Renderiza Linhas da Tabela
    function renderUsersTable(users) {
        if (!users || users.length === 0) {
            usersTableBody.innerHTML = `
                <tr>
                    <td colspan="4" class="state-container">
                        <i class="fas fa-user-slash"></i>
                        <p>Nenhum usuário encontrado com os filtros aplicados.</p>
                    </td>
                </tr>
            `;
            paginationControls.style.display = "none";
            return;
        }

        paginationControls.style.display = "flex";
        usersTableBody.innerHTML = "";

        users.forEach((u) => {
            const tr = document.createElement("tr");
            tr.dataset.userId = u.userId;

            // Formatação do nome/apelido
            const initial = (u.name || "?").charAt(0).toUpperCase();

            tr.innerHTML = `
                <td>
                    <div class="col-user-name">
                        <div class="user-avatar-circle">${initial}</div>
                        <div>
                            <div>${escapeHtml(u.name || "Sem apelido")}</div>
                            <small style="font-size: 11px; color: #64748b; font-weight: normal;">
                                ${u.updatedAt ? "Ativo em " + new Date(u.updatedAt).toLocaleDateString("pt-BR") : "Sem movimentação"}
                            </small>
                        </div>
                    </div>
                </td>
                <td>
                    <span class="user-id-badge" title="ID Bruto: ${escapeHtml(u.userId)}">
                        <span>${escapeHtml(formatPhone(u.userId))}</span>
                        <button type="button" class="btn-copy-id" data-copy="${escapeHtml(u.userId)}" title="Copiar ID">
                            <i class="far fa-copy"></i>
                        </button>
                    </span>
                </td>
                <td>
                    <div class="runas-cell" data-user-id="${escapeHtml(u.userId)}" data-runas="${u.runas}" title="Duplo clique ou clique no lápis para editar">
                        <span class="runas-value">${formatPtBr(u.runas)} ᚱ</span>
                        <button type="button" class="btn-edit-trigger" title="Editar saldo de Runas">
                            <i class="fas fa-pencil-alt"></i>
                        </button>
                    </div>
                </td>
                <td style="text-align: center;">
                    <button type="button" class="btn-impersonate" data-user-id="${escapeHtml(u.userId)}" data-user-name="${escapeHtml(u.name)}" title="Acessar painel web logado como este usuário">
                        <i class="fas fa-user-secret"></i> Acessar
                    </button>
                </td>
            `;

            usersTableBody.appendChild(tr);
        });

        // Eventos dos botões de copiar ID
        usersTableBody.querySelectorAll(".btn-copy-id").forEach((btn) => {
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                const text = btn.dataset.copy;
                if (!text) return;
                navigator.clipboard.writeText(text).then(() => {
                    showToast(`ID ${text} copiado para a área de transferência!`, "success", 2000);
                });
            });
        });

        // Eventos de edição inline de Runas (duplo clique ou clique no lápis)
        usersTableBody.querySelectorAll(".runas-cell").forEach((cell) => {
            const triggerEdit = (e) => {
                e.stopPropagation();
                if (state.editingUserId) return; // já editando outro
                initInlineEdit(cell);
            };

            cell.addEventListener("dblclick", triggerEdit);
            const pencilBtn = cell.querySelector(".btn-edit-trigger");
            if (pencilBtn) pencilBtn.addEventListener("click", triggerEdit);
        });

        // Evento de impersonação [Acessar]
        usersTableBody.querySelectorAll(".btn-impersonate").forEach((btn) => {
            btn.addEventListener("click", async (e) => {
                e.stopPropagation();
                const userId = btn.dataset.userId;
                const userName = btn.dataset.userName || userId;
                await handleImpersonate(userId, userName, btn);
            });
        });
    }

    // 3. Edição Inline de Runas
    function initInlineEdit(cell) {
        const userId = cell.dataset.userId;
        const currentRunas = Number(cell.dataset.runas || 0);
        state.editingUserId = userId;

        const originalContent = cell.innerHTML;

        cell.innerHTML = `
            <div class="runas-edit-inline">
                <input type="number" step="any" min="0" class="runas-edit-input" value="${currentRunas}" />
                <button type="button" class="btn-inline-action btn-inline-save" title="Salvar (Enter)">
                    <i class="fas fa-check"></i>
                </button>
                <button type="button" class="btn-inline-action btn-inline-cancel" title="Cancelar (Esc)">
                    <i class="fas fa-times"></i>
                </button>
            </div>
        `;

        const input = cell.querySelector(".runas-edit-input");
        const saveBtn = cell.querySelector(".btn-inline-save");
        const cancelBtn = cell.querySelector(".btn-inline-cancel");

        input.focus();
        input.select();

        let isSubmitting = false;

        const save = async () => {
            if (isSubmitting) return;
            const newRunas = parseFloat(input.value);

            if (isNaN(newRunas) || newRunas < 0) {
                showToast("O saldo deve ser um número válido maior ou igual a zero.", "warning");
                input.focus();
                return;
            }

            isSubmitting = true;
            saveBtn.innerHTML = `<i class="fas fa-spinner fa-spin"></i>`;
            saveBtn.disabled = true;

            try {
                const res = await fetch("/api/games/bank/admin/user-runas", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ userId, runas: newRunas })
                });

                const json = await res.json();
                if (!json.ok) {
                    throw new Error(json.error || "Falha ao salvar saldo");
                }

                showToast(`Saldo de Runas atualizado: ${formatPtBr(newRunas)} ᚱ`, "success");

                cell.dataset.runas = newRunas;
                cell.innerHTML = `
                    <span class="runas-value">${formatPtBr(newRunas)} ᚱ</span>
                    <button type="button" class="btn-edit-trigger" title="Editar saldo de Runas">
                        <i class="fas fa-pencil-alt"></i>
                    </button>
                `;

                // Reassocia eventos de edição na célula
                cell.addEventListener("dblclick", () => initInlineEdit(cell), { once: true });
                const newPencil = cell.querySelector(".btn-edit-trigger");
                if (newPencil) {
                    newPencil.addEventListener("click", (ev) => {
                        ev.stopPropagation();
                        initInlineEdit(cell);
                    }, { once: true });
                }

                state.editingUserId = null;
            } catch (err) {
                console.error("Erro ao salvar saldo:", err);
                showToast(`Erro ao salvar: ${err.message}`, "error");
                saveBtn.innerHTML = `<i class="fas fa-check"></i>`;
                saveBtn.disabled = false;
                isSubmitting = false;
            }
        };

        const cancel = () => {
            cell.innerHTML = originalContent;
            state.editingUserId = null;
            cell.addEventListener("dblclick", () => initInlineEdit(cell), { once: true });
            const pBtn = cell.querySelector(".btn-edit-trigger");
            if (pBtn) {
                pBtn.addEventListener("click", (ev) => {
                    ev.stopPropagation();
                    initInlineEdit(cell);
                }, { once: true });
            }
        };

        saveBtn.addEventListener("click", save);
        cancelBtn.addEventListener("click", cancel);

        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                save();
            } else if (e.key === "Escape") {
                e.preventDefault();
                cancel();
            }
        });
    }

    // 4. Impersonação [Acessar]
    async function handleImpersonate(userId, userName, btnElement) {
        const originalHtml = btnElement.innerHTML;
        btnElement.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Acessando...`;
        btnElement.disabled = true;

        try {
            const res = await fetch("/api/games/bank/admin/impersonate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ userId })
            });

            const json = await res.json();
            if (!json.ok || !json.redirectUrl) {
                throw new Error(json.error || "Não foi possível gerar sessão de acesso");
            }

            showToast(`Acesso concedido para <strong>${escapeHtml(userName)}</strong>! Abrindo em nova aba...`, "success");

            // Abre a interface logada transparente como aquele usuário em nova aba
            window.open(json.redirectUrl, "_blank");
        } catch (err) {
            console.error("Erro na impersonação:", err);
            showToast(`Falha ao acessar como usuário: ${err.message}`, "error");
        } finally {
            btnElement.innerHTML = originalHtml;
            btnElement.disabled = false;
        }
    }

    // 5. Renderização da Paginação
    function renderPagination() {
        const startIdx = (state.currentPage - 1) * state.pageSize + 1;
        const endIdx = Math.min(state.currentPage * state.pageSize, state.totalUsers);

        paginationInfo.textContent = `Mostrando ${formatInt(startIdx)} a ${formatInt(endIdx)} de ${formatInt(state.totalUsers)} usuários`;

        paginationButtons.innerHTML = "";

        if (state.totalPages <= 1) return;

        // Botão Primeira (<<)
        const btnFirst = document.createElement("button");
        btnFirst.className = "btn-page";
        btnFirst.innerHTML = `<i class="fas fa-angle-double-left"></i>`;
        btnFirst.title = "Primeira página";
        btnFirst.disabled = state.currentPage === 1;
        btnFirst.addEventListener("click", () => loadUsers(1));
        paginationButtons.appendChild(btnFirst);

        // Botão Anterior (<)
        const btnPrev = document.createElement("button");
        btnPrev.className = "btn-page";
        btnPrev.innerHTML = `<i class="fas fa-angle-left"></i>`;
        btnPrev.title = "Página anterior";
        btnPrev.disabled = state.currentPage === 1;
        btnPrev.addEventListener("click", () => loadUsers(state.currentPage - 1));
        paginationButtons.appendChild(btnPrev);

        // Gera páginas numeradas visíveis
        const maxPagesToShow = 5;
        let startPage = Math.max(1, state.currentPage - Math.floor(maxPagesToShow / 2));
        let endPage = Math.min(state.totalPages, startPage + maxPagesToShow - 1);

        if (endPage - startPage + 1 < maxPagesToShow) {
            startPage = Math.max(1, endPage - maxPagesToShow + 1);
        }

        for (let p = startPage; p <= endPage; p++) {
            const btnP = document.createElement("button");
            btnP.className = `btn-page ${p === state.currentPage ? "active" : ""}`;
            btnP.textContent = p;
            btnP.addEventListener("click", () => loadUsers(p));
            paginationButtons.appendChild(btnP);
        }

        // Botão Próxima (>)
        const btnNext = document.createElement("button");
        btnNext.className = "btn-page";
        btnNext.innerHTML = `<i class="fas fa-angle-right"></i>`;
        btnNext.title = "Próxima página";
        btnNext.disabled = state.currentPage === state.totalPages;
        btnNext.addEventListener("click", () => loadUsers(state.currentPage + 1));
        paginationButtons.appendChild(btnNext);

        // Botão Última (>>)
        const btnLast = document.createElement("button");
        btnLast.className = "btn-page";
        btnLast.innerHTML = `<i class="fas fa-angle-double-right"></i>`;
        btnLast.title = "Última página";
        btnLast.disabled = state.currentPage === state.totalPages;
        btnLast.addEventListener("click", () => loadUsers(state.totalPages));
        paginationButtons.appendChild(btnLast);
    }

    // 6. Busca com Debounce
    let searchDebounceTimeout = null;

    searchInput.addEventListener("input", () => {
        const q = searchInput.value.trim();
        state.searchQuery = q;

        if (q.length > 0) {
            clearSearchBtn.style.display = "block";
        } else {
            clearSearchBtn.style.display = "none";
        }

        clearTimeout(searchDebounceTimeout);
        searchDebounceTimeout = setTimeout(() => {
            loadUsers(1);
        }, 320);
    });

    clearSearchBtn.addEventListener("click", () => {
        searchInput.value = "";
        state.searchQuery = "";
        clearSearchBtn.style.display = "none";
        loadUsers(1);
    });

    refreshUsersBtn.addEventListener("click", () => {
        loadUsers(state.currentPage);
    });

    // 7. Aba Configurações & Economia
    async function loadConfigData() {
        try {
            const res = await fetch("/api/games/bank/admin/config");
            const json = await res.json();
            if (!json.ok || !json.data) {
                throw new Error(json.error || "Erro ao carregar dados econômicos");
            }

            const d = json.data;

            // Estatísticas de topo
            document.getElementById("stat-total-runas").textContent = `${formatInt(d.totalRunas)} ᚱ`;
            document.getElementById("stat-total-accounts").textContent = formatInt(d.totalAccounts);
            document.getElementById("stat-burned-runas").textContent = `${formatPtBr(d.totalBurnedRunas)} ᚱ`;
            document.getElementById("stat-total-txs").textContent = formatInt(d.totalTransactions);

            // Cotações e multiplicadores
            const container = document.getElementById("rates-grid-container");
            const rates = d.rates || {};

            container.innerHTML = `
                <div class="rate-box">
                    <div class="rate-box-header">
                        <span>🎣 Pesca (Peixe Comum)</span>
                        <span class="rate-value-badge">${formatPtBr(rates.runasPerKgFish, 4)} ᚱ/kg</span>
                    </div>
                    <div class="rate-details">
                        <div>Multiplicador: <strong>${formatPtBr(rates.fishMultiplier, 3)}x</strong></div>
                        <div>Regra: <strong>Mão única (somente venda para o banco)</strong></div>
                        <div>Peso Total Circulante: <strong>${formatInt(d.fish?.totalWeight || 0)} kg</strong></div>
                    </div>
                </div>

                <div class="rate-box">
                    <div class="rate-box-header">
                        <span>💜 Waifuletes (Zinthos)</span>
                        <span class="rate-value-badge">${formatPtBr(rates.runasPerZinthos, 4)} ᚱ/Z</span>
                    </div>
                    <div class="rate-details">
                        <div>Multiplicador: <strong>${formatPtBr(rates.waifuMultiplier, 3)}x</strong></div>
                        <div>M2 Circulante: <strong>${formatInt(d.waifu?.circulatingZinthos || 0)} Z</strong></div>
                        <div>Inflação Observada: <strong>${formatPtBr(d.waifu?.inflationPercent || 0, 2)}%</strong></div>
                    </div>
                </div>

                <div class="rate-box">
                    <div class="rate-box-header">
                        <span>🌱 Jardim das Sombras</span>
                        <span class="rate-value-badge">${formatPtBr(rates.runasPerJardimCoin, 4)} ᚱ/Ptl</span>
                    </div>
                    <div class="rate-details">
                        <div>Multiplicador: <strong>${formatPtBr(rates.jardimMultiplier, 3)}x</strong></div>
                        <div>Petalitas Registradas: <strong>${formatInt(d.jardim?.totalCoins || 0)} Ptl</strong></div>
                        <div>Operação: <strong>Bidirecional (compra e venda)</strong></div>
                    </div>
                </div>
            `;
        } catch (err) {
            console.error("Erro ao carregar configurações:", err);
            showToast(`Falha ao obter dados macroeconômicos: ${err.message}`, "error");
        }
    }

    // 8. Botão Forçar Recálculo de Cotações
    btnRecalculateRates.addEventListener("click", async () => {
        if (!confirm("Deseja realmente recalcular as cotações diárias agora?")) {
            return;
        }

        const originalHtml = btnRecalculateRates.innerHTML;
        btnRecalculateRates.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Recalculando...`;
        btnRecalculateRates.disabled = true;

        try {
            const res = await fetch("/api/games/bank/admin/recalculate-rates", {
                method: "POST"
            });
            const json = await res.json();
            if (!json.ok) {
                throw new Error(json.error || "Erro ao recalcular");
            }

            showToast("Cotações oficiais recalculadas e persistidas com sucesso!", "success");
            await loadConfigData();
        } catch (err) {
            showToast(`Erro ao recalcular cotações: ${err.message}`, "error");
        } finally {
            btnRecalculateRates.innerHTML = originalHtml;
            btnRecalculateRates.disabled = false;
        }
    });

    // Função utilitária de sanitização HTML
    function escapeHtml(str) {
        if (!str) return "";
        return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    // Inicialização
    loadUsers(1);
});
