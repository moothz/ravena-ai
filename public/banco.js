// public/banco.js - Frontend do RavenaBank (Público + Área Autenticada)

document.addEventListener("DOMContentLoaded", async () => {
    // 1. Gerenciamento de Token de Sessão
    const urlParams = new URLSearchParams(window.location.search);
    let token = urlParams.get("token");

    if (token) {
        localStorage.setItem("ravenabank_token", token);
        // Limpa URL para não expor token no histórico
        const cleanUrl = window.location.origin + window.location.pathname;
        window.history.replaceState({}, document.title, cleanUrl);
    } else {
        token = localStorage.getItem("ravenabank_token");
    }

    let globalRates = null;
    let currentUserData = null;
    let allTransactions = [];
    let txCurrentPage = 1;
    const TX_PAGE_SIZE = 10;

    // Funções utilitárias de formatação brasileira
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
        return phone;
    }

    function calculateDynamicSpread(usedToday, addAmount, limit) {
        const total = (Number(usedToday) || 0) + (Number(addAmount) || 0);
        const ratio = Math.min(1.0, Math.max(0, total / (Number(limit) || 1)));
        const spread = 0.03 + 0.07 * Math.pow(ratio, 1.5);
        return Math.min(0.10, Math.max(0.03, spread));
    }

    // Sistema moderno de notificações visuais (Toasts)
    function showNotification(message, type = "info", duration = 4500) {
        const container = document.getElementById("bank-toast-container");
        if (!container) {
            console.log(`[Notification ${type}] ${message}`);
            return;
        }

        const toast = document.createElement("div");
        toast.className = `bank-toast toast-${type}`;

        let iconClass = "fa-info-circle";
        if (type === "success") iconClass = "fa-check-circle";
        else if (type === "error") iconClass = "fa-exclamation-circle";
        else if (type === "warning") iconClass = "fa-exclamation-triangle";

        toast.innerHTML = `
            <i class="fas ${iconClass} toast-icon"></i>
            <div class="toast-body">${message}</div>
            <button type="button" class="toast-close" aria-label="Fechar">&times;</button>
        `;

        const closeBtn = toast.querySelector(".toast-close");
        const removeToast = () => {
            toast.style.opacity = "0";
            toast.style.transform = "translateY(-8px) scale(0.95)";
            setTimeout(() => toast.remove(), 300);
        };

        closeBtn.addEventListener("click", removeToast);
        if (duration > 0) {
            setTimeout(removeToast, duration);
        }

        container.appendChild(toast);
    }

    // 2. Carrega Dados Públicos
    async function loadPublicData() {
        try {
            const res = await fetch("/api/games/bank/public");
            const json = await res.json();
            if (!json.ok || !json.data) return;

            const d = json.data;
            globalRates = d.rates;

            // Banner
            const elTotalRunas = document.getElementById("total-runas");
            if (elTotalRunas) elTotalRunas.textContent = `💠 ${formatPtBr(d.totalRunas, 2)} ᚱ`;
            const elTotalAccounts = document.getElementById("total-accounts");
            if (elTotalAccounts) elTotalAccounts.textContent = `Distribuídas entre ${formatInt(d.totalAccounts)} contas cadastradas na rede`;

            // Card Pesca
            const kgPer1000 = Math.round(1000 / d.rates.runasPerKgFish);
            const elRateFish = document.getElementById("rate-fish");
            if (elRateFish) elRateFish.textContent = `1.000 ᚱ = ${formatInt(kgPer1000)} kg`;
            const elUnitFish = document.getElementById("unit-fish");
            if (elUnitFish) elUnitFish.textContent = `1 kg = ${formatPtBr(d.rates.runasPerKgFish, 2)} ᚱ`;
            const elStockFish = document.getElementById("stock-fish");
            if (elStockFish) elStockFish.textContent = `${formatPtBr(d.fish.totalWeight, 1)} kg (${formatInt(d.fish.totalCount)} peixes)`;

            // Card Waifus
            const zPer1000 = Math.round(1000 / d.rates.runasPerZinthos);
            const elRateWaifu = document.getElementById("rate-waifu");
            if (elRateWaifu) elRateWaifu.textContent = `1.000 ᚱ = ${formatInt(zPer1000)} Z`;
            const elUnitWaifu = document.getElementById("unit-waifu");
            if (elUnitWaifu) elUnitWaifu.textContent = `1 Z = ${formatPtBr(d.rates.runasPerZinthos, 4)} ᚱ`;
            const elStockWaifu = document.getElementById("stock-waifu");
            if (elStockWaifu) elStockWaifu.textContent = `${formatInt(d.waifu.circulatingZinthos)} Zinthos`;
            const elInflationWaifu = document.getElementById("inflation-waifu");
            if (elInflationWaifu) elInflationWaifu.textContent = `+${formatPtBr(d.waifu.inflationPercent, 2)}%`;

            // Card Jardim (Fazenda)
            const mjPer1000 = Math.round(1000 / d.rates.runasPerJardimCoin);
            const elRateJardim = document.getElementById("rate-jardim");
            if (elRateJardim) elRateJardim.textContent = `1.000 ᚱ = ${formatInt(mjPer1000)} Ptl`;
            const elUnitJardim = document.getElementById("unit-jardim");
            if (elUnitJardim) elUnitJardim.textContent = `1 Ptl = ${formatPtBr(d.rates.runasPerJardimCoin, 4)} ᚱ`;
            const elStockJardim = document.getElementById("stock-jardim");
            if (elStockJardim) elStockJardim.textContent = `${formatInt(d.jardim.totalCoins)} Ptl`;

            updateShopCardsStatic();
        } catch (err) {
            console.error("Erro ao carregar dados públicos do banco:", err);
        }
    }

    function updateShopCardsStatic() {
        if (!globalRates) return;
        const elPriceZ = document.getElementById("buy-price-zinthos");
        if (elPriceZ) elPriceZ.innerHTML = `${formatPtBr(globalRates.runasPerZinthos, 4)} ᚱ <span style="font-size: 10px; color: #94a3b8; font-weight: normal;">cada</span>`;

        const elPriceJ = document.getElementById("buy-price-jardim");
        if (elPriceJ) elPriceJ.innerHTML = `${formatPtBr(globalRates.runasPerJardimCoin, 4)} ᚱ <span style="font-size: 10px; color: #94a3b8; font-weight: normal;">cada</span>`;

        const elRateF = document.getElementById("sell-rate-fish");
        if (elRateF) elRateF.textContent = `1 kg = ${formatPtBr(globalRates.runasPerKgFish, 2)} ᚱ`;

        const elRateZ = document.getElementById("sell-rate-zinthos");
        if (elRateZ) elRateZ.textContent = `1 Z = ${formatPtBr(globalRates.runasPerZinthos, 4)} ᚱ`;

        const elRateJ = document.getElementById("sell-rate-jardim");
        if (elRateJ) elRateJ.textContent = `1 Ptl = ${formatPtBr(globalRates.runasPerJardimCoin, 4)} ᚱ`;
    }

    // 3. Carrega Sessão do Usuário
    async function loadSession() {
        if (!token) {
            document.getElementById("guest-prompt").style.display = "block";
            document.getElementById("auth-panel").style.display = "none";
            return;
        }

        try {
            const res = await fetch(`/api/games/bank/session?token=${encodeURIComponent(token)}`);
            const json = await res.json();

            if (!json.ok || !json.authenticated || !json.user) {
                // Token inválido ou expirado
                localStorage.removeItem("ravenabank_token");
                token = null;
                document.getElementById("guest-prompt").style.display = "block";
                document.getElementById("auth-panel").style.display = "none";
                return;
            }

            currentUserData = json.user;

            document.getElementById("guest-prompt").style.display = "none";
            document.getElementById("auth-panel").style.display = "block";

            // Preenche dados do usuário
            const elUserPhone = document.getElementById("user-phone");
            if (elUserPhone) elUserPhone.textContent = formatPhone(currentUserData.userId);

            const elMyRunas = document.getElementById("my-runas");
            if (elMyRunas) elMyRunas.textContent = `${formatPtBr(currentUserData.account.runas, 2)} ᚱ`;

            updateUserDataDisplays();

            // Extrato com paginação
            allTransactions = Array.isArray(currentUserData.transactions) ? [...currentUserData.transactions] : [];
            allTransactions.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
            txCurrentPage = 1;
            renderTransactionsPage();

            updateBuyCart();
            updateSellCart();
        } catch (err) {
            console.error("Erro ao verificar sessão do banco:", err);
        }
    }

    function updateUserDataDisplays() {
        if (!currentUserData) return;

        const h = currentUserData.holdings || {};
        const q = currentUserData.quota || { used: {}, limits: {}, remaining: {} };
        const qRemaining = q.remaining || {};

        // 1. Aba Compra - Limites e Disponibilidades
        const availCoins = Math.max(0, qRemaining.compra_moedas ?? (300 - (q.used?.compra_moedas || 0)));
        const elAvailCoins = document.getElementById("buy-avail-moedas");
        if (elAvailCoins) {
            elAvailCoins.textContent = `${availCoins}`;
            elAvailCoins.style.color = availCoins === 0 ? "#ef4444" : "#facc15";
        }

        const availBaits = Math.max(0, qRemaining.compra_iscas ?? (200 - (q.used?.compra_iscas || 0)));
        const elAvailBaits = document.getElementById("buy-avail-iscas");
        if (elAvailBaits) {
            elAvailBaits.textContent = `${availBaits}`;
            elAvailBaits.style.color = availBaits === 0 ? "#ef4444" : "#38bdf8";
        }

        const availZinthos = Math.max(0, qRemaining.compra_zinthos ?? (200000 - (q.used?.compra_zinthos || 0)));
        const elAvailZ = document.getElementById("buy-avail-zinthos");
        if (elAvailZ) {
            elAvailZ.textContent = `${formatInt(availZinthos)} Z`;
            elAvailZ.style.color = availZinthos === 0 ? "#ef4444" : "#f472b6";
        }

        const availJardim = Math.max(0, qRemaining.compra_jardim ?? (150000 - (q.used?.compra_jardim || 0)));
        const elAvailJ = document.getElementById("buy-avail-jardim");
        if (elAvailJ) {
            elAvailJ.textContent = `${formatInt(availJardim)} Ptl`;
            elAvailJ.style.color = availJardim === 0 ? "#ef4444" : "#4ade80";
        }

        // 2. Aba Venda - Saldos do Usuário
        const elHoldingsFish = document.getElementById("sell-holdings-fish");
        if (elHoldingsFish) {
            elHoldingsFish.textContent = `${formatPtBr(h.fishWeight || 0, 2)} kg (${formatInt(h.fishCount || 0)} peixes)`;
        }

        const elHoldingsZ = document.getElementById("sell-holdings-zinthos");
        if (elHoldingsZ) {
            elHoldingsZ.textContent = `${formatInt(h.zinthos || 0)} Z`;
        }

        const elHoldingsJ = document.getElementById("sell-holdings-jardim");
        if (elHoldingsJ) {
            elHoldingsJ.textContent = `${formatInt(h.gardenCoins || 0)} Ptl`;
        }

        const availVendaRunas = Math.max(0, qRemaining.venda_runas ?? (300000 - (q.used?.venda_runas || 0)));
        const elCartQuota = document.getElementById("sell-cart-quota");
        if (elCartQuota) {
            elCartQuota.innerHTML = `Cota unificada restante: <strong style="color: #c084fc;">${formatPtBr(availVendaRunas, 2)} ᚱ</strong> / dia`;
        }
    }

    // 4. Alternância de Abas: Compra e Venda
    const tabBtnCompra = document.getElementById("tab-btn-compra");
    const tabBtnVenda = document.getElementById("tab-btn-venda");
    const tabContentCompra = document.getElementById("tab-compra-content");
    const tabContentVenda = document.getElementById("tab-venda-content");

    function switchTradeTab(tab) {
        if (tab === "compra") {
            tabBtnCompra.classList.add("active");
            tabBtnVenda.classList.remove("active");
            tabContentCompra.style.display = "block";
            tabContentVenda.style.display = "none";
        } else {
            tabBtnVenda.classList.add("active");
            tabBtnCompra.classList.remove("active");
            tabContentVenda.style.display = "block";
            tabContentCompra.style.display = "none";
        }
    }

    if (tabBtnCompra) tabBtnCompra.addEventListener("click", () => switchTradeTab("compra"));
    if (tabBtnVenda) tabBtnVenda.addEventListener("click", () => switchTradeTab("venda"));

    // 5. Extrato de Transações com Paginação
    function renderTransactionsPage() {
        const tbody = document.getElementById("tx-body");
        const prevBtn = document.getElementById("tx-prev");
        const nextBtn = document.getElementById("tx-next");
        const pageInfo = document.getElementById("tx-page-info");

        if (!tbody) return;

        if (!allTransactions || allTransactions.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: #64748b;">Nenhuma movimentação registrada.</td></tr>`;
            if (prevBtn) prevBtn.disabled = true;
            if (nextBtn) nextBtn.disabled = true;
            if (pageInfo) pageInfo.textContent = "Página 1 de 1";
            return;
        }

        const totalPages = Math.max(1, Math.ceil(allTransactions.length / TX_PAGE_SIZE));
        if (txCurrentPage > totalPages) txCurrentPage = totalPages;
        if (txCurrentPage < 1) txCurrentPage = 1;

        const startIndex = (txCurrentPage - 1) * TX_PAGE_SIZE;
        const pageItems = allTransactions.slice(startIndex, startIndex + TX_PAGE_SIZE);

        tbody.innerHTML = pageItems.map(t => {
            const isVenda = t.type === "DEPOSIT";
            const dateStr = new Date(t.timestamp).toLocaleDateString("pt-BR", { 
                day: "2-digit", 
                month: "2-digit", 
                hour: "2-digit", 
                minute: "2-digit" 
            });
            const typeBadge = isVenda 
                ? `<span style="color: #4ade80; font-weight: 600;">📥 Venda</span>` 
                : `<span style="color: #38bdf8; font-weight: 600;">📤 Compra</span>`;

            let gameBadge = "Desconhecido";
            let formattedAmount = "";

            if (t.game === "pesca") {
                gameBadge = "🎣 Pesca";
                formattedAmount = `${formatPtBr(t.game_amount, 2)} kg`;
            } else if (t.game === "waifu" || t.game === "zinthos") {
                gameBadge = "💜 Waifus (Z)";
                formattedAmount = `${formatInt(t.game_amount)} Z`;
            } else if (t.game === "jardim" || t.game === "fazenda") {
                gameBadge = "🌱 Petalitas (Ptl)";
                formattedAmount = `${formatInt(t.game_amount)} Ptl`;
            } else if (t.game === "moedas" || t.game === "slots") {
                gameBadge = "🎰 Slots (Moedas)";
                formattedAmount = `${formatInt(t.game_amount)} un.`;
            } else if (t.game === "iscas") {
                gameBadge = "🐛 Pesca (Iscas)";
                formattedAmount = `${formatInt(t.game_amount)} un.`;
            } else {
                gameBadge = t.game;
                formattedAmount = formatPtBr(t.game_amount, 2);
            }

            const sign = isVenda ? "+" : "-";
            const spreadFee = t.spread_fee_runas !== undefined ? formatPtBr(t.spread_fee_runas, 2) : "0,00";
            const spreadPct = t.spread_rate !== undefined ? formatPtBr(t.spread_rate * 100, 1) : "0,0";

            return `
                <tr>
                    <td>${dateStr}</td>
                    <td>${typeBadge}</td>
                    <td>${gameBadge}</td>
                    <td>${formattedAmount}</td>
                    <td style="font-family: 'JetBrains Mono', monospace; font-weight: 600; color: #fff;">${sign}${formatPtBr(t.runas_amount, 2)} ᚱ</td>
                    <td style="color: #cbd5e1; font-family: 'JetBrains Mono', monospace;">${spreadFee} (${spreadPct}%)</td>
                </tr>
            `;
        }).join("");

        if (prevBtn) prevBtn.disabled = txCurrentPage <= 1;
        if (nextBtn) nextBtn.disabled = txCurrentPage >= totalPages;
        if (pageInfo) pageInfo.textContent = `Página ${txCurrentPage} de ${totalPages} (${allTransactions.length} transações)`;
    }

    const prevBtn = document.getElementById("tx-prev");
    const nextBtn = document.getElementById("tx-next");
    if (prevBtn) {
        prevBtn.addEventListener("click", () => {
            if (txCurrentPage > 1) {
                txCurrentPage--;
                renderTransactionsPage();
            }
        });
    }
    if (nextBtn) {
        nextBtn.addEventListener("click", () => {
            const totalPages = Math.max(1, Math.ceil(allTransactions.length / TX_PAGE_SIZE));
            if (txCurrentPage < totalPages) {
                txCurrentPage++;
                renderTransactionsPage();
            }
        });
    }

    // 6. Lógica de Carrinho e Controles — ABA COMPRA
    const buyInputs = {
        moedas: document.getElementById("buy-qty-moedas"),
        iscas: document.getElementById("buy-qty-iscas"),
        zinthos: document.getElementById("buy-qty-zinthos"),
        jardim: document.getElementById("buy-qty-jardim")
    };

    function parsePositiveNumber(val) {
        if (!val) return 0;
        const n = parseFloat(String(val).replace(",", "."));
        return isNaN(n) || n < 0 ? 0 : n;
    }

    function setupStepper(minusId, plusId, inputEl, step, maxFn) {
        const minus = document.getElementById(minusId);
        const plus = document.getElementById(plusId);

        if (minus) {
            minus.addEventListener("click", () => {
                const current = parsePositiveNumber(inputEl.value);
                const next = Math.max(0, current - step);
                inputEl.value = next;
                inputEl.dispatchEvent(new Event("input"));
            });
        }

        if (plus) {
            plus.addEventListener("click", () => {
                const current = parsePositiveNumber(inputEl.value);
                const max = maxFn ? maxFn() : Infinity;
                const next = Math.min(max, current + step);
                inputEl.value = next;
                inputEl.dispatchEvent(new Event("input"));
            });
        }
    }

    // Steppers da Compra
    setupStepper("buy-minus-moedas", "buy-plus-moedas", buyInputs.moedas, 1, () => {
        const quota = currentUserData?.quota?.remaining?.compra_moedas ?? 300;
        return Math.max(0, quota);
    });

    setupStepper("buy-minus-iscas", "buy-plus-iscas", buyInputs.iscas, 1, () => {
        const quota = currentUserData?.quota?.remaining?.compra_iscas ?? 200;
        return Math.max(0, quota);
    });

    setupStepper("buy-minus-zinthos", "buy-plus-zinthos", buyInputs.zinthos, 1000, () => {
        const quota = currentUserData?.quota?.remaining?.compra_zinthos ?? 200000;
        return Math.max(0, quota);
    });

    setupStepper("buy-minus-jardim", "buy-plus-jardim", buyInputs.jardim, 1000, () => {
        const quota = currentUserData?.quota?.remaining?.compra_jardim ?? 150000;
        return Math.max(0, quota);
    });

    // Botões "Max" da Compra
    document.getElementById("buy-max-moedas")?.addEventListener("click", () => {
        if (!currentUserData) return;
        const maxByQuota = Math.max(0, currentUserData.quota?.remaining?.compra_moedas ?? 300);
        const userRunas = currentUserData.account?.runas || 0;
        const maxByRunas = Math.floor(userRunas / 55);
        buyInputs.moedas.value = Math.min(maxByQuota, maxByRunas);
        buyInputs.moedas.dispatchEvent(new Event("input"));
    });

    document.getElementById("buy-max-iscas")?.addEventListener("click", () => {
        if (!currentUserData) return;
        const maxByQuota = Math.max(0, currentUserData.quota?.remaining?.compra_iscas ?? 200);
        const userRunas = currentUserData.account?.runas || 0;
        const maxByRunas = Math.floor(userRunas / 45);
        buyInputs.iscas.value = Math.min(maxByQuota, maxByRunas);
        buyInputs.iscas.dispatchEvent(new Event("input"));
    });

    document.getElementById("buy-max-zinthos")?.addEventListener("click", () => {
        if (!currentUserData || !globalRates) return;
        const maxByQuota = Math.max(0, currentUserData.quota?.remaining?.compra_zinthos ?? 200000);
        const userRunas = currentUserData.account?.runas || 0;
        const maxByRunas = Math.floor((userRunas * 0.97) / globalRates.runasPerZinthos);
        buyInputs.zinthos.value = Math.min(maxByQuota, maxByRunas);
        buyInputs.zinthos.dispatchEvent(new Event("input"));
    });

    document.getElementById("buy-max-jardim")?.addEventListener("click", () => {
        if (!currentUserData || !globalRates) return;
        const maxByQuota = Math.max(0, currentUserData.quota?.remaining?.compra_jardim ?? 150000);
        const userRunas = currentUserData.account?.runas || 0;
        const maxByRunas = Math.floor((userRunas * 0.97) / globalRates.runasPerJardimCoin);
        buyInputs.jardim.value = Math.min(maxByQuota, maxByRunas);
        buyInputs.jardim.dispatchEvent(new Event("input"));
    });

    // Atualização em Tempo Real do Carrinho de Compra
    function updateBuyCart() {
        const listEl = document.getElementById("buy-cart-items");
        const totalEl = document.getElementById("buy-cart-total");
        const statusEl = document.getElementById("buy-cart-status");
        const confirmBtn = document.getElementById("btn-confirm-buy");

        if (!listEl || !totalEl || !statusEl || !confirmBtn) return;

        const qtyMoedas = Math.floor(parsePositiveNumber(buyInputs.moedas?.value));
        const qtyIscas = Math.floor(parsePositiveNumber(buyInputs.iscas?.value));
        const qtyZinthos = Math.floor(parsePositiveNumber(buyInputs.zinthos?.value));
        const qtyJardim = Math.floor(parsePositiveNumber(buyInputs.jardim?.value));

        let totalCostRunas = 0;
        const cartRows = [];
        let hasError = false;
        let errorMessage = "";

        const userRunas = currentUserData?.account?.runas || 0;

        // Validação Moedas
        if (qtyMoedas > 0) {
            const cost = qtyMoedas * 55;
            totalCostRunas += cost;
            const remMoedas = currentUserData?.quota?.remaining?.compra_moedas ?? 300;
            if (qtyMoedas > remMoedas) {
                hasError = true;
                errorMessage = `Moedas ultrapassam o limite diário restante de ${remMoedas} moedas.`;
            }
            cartRows.push(`
                <div class="cart-item-row">
                    <span>🎰 <strong>${formatInt(qtyMoedas)}x</strong> Moedinha(s) do Slots (55 ᚱ cada)</span>
                    <span style="font-family: 'JetBrains Mono', monospace; color: #facc15;">${formatPtBr(cost, 2)} ᚱ</span>
                </div>
            `);
        }

        // Validação Iscas
        if (qtyIscas > 0) {
            const cost = qtyIscas * 45;
            totalCostRunas += cost;
            const remIscas = currentUserData?.quota?.remaining?.compra_iscas ?? 200;
            if (qtyIscas > remIscas) {
                hasError = true;
                errorMessage = `Iscas ultrapassam o limite diário restante de ${remIscas} iscas.`;
            }
            cartRows.push(`
                <div class="cart-item-row">
                    <span>🐛 <strong>${formatInt(qtyIscas)}x</strong> Isca(s) de Pesca (45 ᚱ cada)</span>
                    <span style="font-family: 'JetBrains Mono', monospace; color: #38bdf8;">${formatPtBr(cost, 2)} ᚱ</span>
                </div>
            `);
        }

        // Validação Zinthos
        if (qtyZinthos > 0 && globalRates) {
            const quotaRem = currentUserData?.quota?.remaining?.compra_zinthos ?? 200000;
            if (qtyZinthos > quotaRem) {
                hasError = true;
                errorMessage = `Quantidade de Zinthos excede a cota restante de ${formatInt(quotaRem)} Z.`;
            }
            // Cálculo de Runas considerando taxa progressiva
            const usedQuota = currentUserData?.quota?.used?.compra_zinthos || 0;
            const spread = calculateDynamicSpread(usedQuota, qtyZinthos, 200000);
            const cost = (qtyZinthos * globalRates.runasPerZinthos) / (1 - spread);
            totalCostRunas += cost;
            cartRows.push(`
                <div class="cart-item-row">
                    <span>💜 <strong>${formatInt(qtyZinthos)}</strong> Zinthos (taxa ~${formatPtBr(spread * 100, 1)}%)</span>
                    <span style="font-family: 'JetBrains Mono', monospace; color: #f472b6;">~${formatPtBr(cost, 2)} ᚱ</span>
                </div>
            `);
        }

        // Validação Petalitas
        if (qtyJardim > 0 && globalRates) {
            const quotaRem = currentUserData?.quota?.remaining?.compra_jardim ?? 150000;
            if (qtyJardim > quotaRem) {
                hasError = true;
                errorMessage = `Quantidade de Petalitas excede a cota restante de ${formatInt(quotaRem)} Ptl.`;
            }
            const usedQuota = currentUserData?.quota?.used?.compra_jardim || 0;
            const spread = calculateDynamicSpread(usedQuota, qtyJardim, 150000);
            const cost = (qtyJardim * globalRates.runasPerJardimCoin) / (1 - spread);
            totalCostRunas += cost;
            cartRows.push(`
                <div class="cart-item-row">
                    <span>🌱 <strong>${formatInt(qtyJardim)}</strong> Petalitas (taxa ~${formatPtBr(spread * 100, 1)}%)</span>
                    <span style="font-family: 'JetBrains Mono', monospace; color: #4ade80;">~${formatPtBr(cost, 2)} ᚱ</span>
                </div>
            `);
        }

        if (cartRows.length === 0) {
            listEl.innerHTML = `<span style="color: #64748b; font-style: italic;">Nenhum item selecionado. Adicione produtos acima para comprar.</span>`;
            totalEl.textContent = `0,00 ᚱ`;
            statusEl.innerHTML = `Seu saldo: <strong style="color: #c084fc;">${formatPtBr(userRunas, 2)} ᚱ</strong>`;
            confirmBtn.disabled = true;
            return;
        }

        listEl.innerHTML = cartRows.join("");
        totalEl.textContent = `${formatPtBr(totalCostRunas, 2)} ᚱ`;

        if (totalCostRunas > userRunas) {
            hasError = true;
            errorMessage = `Saldo de Runas insuficiente! Saldo: ${formatPtBr(userRunas, 2)} ᚱ, Custo: ${formatPtBr(totalCostRunas, 2)} ᚱ.`;
        }

        if (hasError) {
            statusEl.innerHTML = `<span style="color: #ef4444; font-weight: 600;">⚠️ ${errorMessage}</span>`;
            confirmBtn.disabled = true;
        } else {
            statusEl.innerHTML = `Seu saldo: <strong style="color: #c084fc;">${formatPtBr(userRunas, 2)} ᚱ</strong> (Saldo pós-compra: ${formatPtBr(userRunas - totalCostRunas, 2)} ᚱ)`;
            confirmBtn.disabled = false;
        }
    }

    Object.values(buyInputs).forEach(input => {
        if (input) input.addEventListener("input", updateBuyCart);
    });

    // Confirmar Compra
    document.getElementById("btn-confirm-buy")?.addEventListener("click", async () => {
        if (!token) return;

        const qtyMoedas = Math.floor(parsePositiveNumber(buyInputs.moedas?.value));
        const qtyIscas = Math.floor(parsePositiveNumber(buyInputs.iscas?.value));
        const qtyZinthos = Math.floor(parsePositiveNumber(buyInputs.zinthos?.value));
        const qtyJardim = Math.floor(parsePositiveNumber(buyInputs.jardim?.value));

        const orders = [];
        if (qtyMoedas > 0) orders.push({ game: "moedas", amount: qtyMoedas, label: `${qtyMoedas}x Moedas` });
        if (qtyIscas > 0) orders.push({ game: "iscas", amount: qtyIscas, label: `${qtyIscas}x Iscas` });
        if (qtyZinthos > 0 && globalRates) {
            const used = currentUserData?.quota?.used?.compra_zinthos || 0;
            const spread = calculateDynamicSpread(used, qtyZinthos, 200000);
            const cost = Number(((qtyZinthos * globalRates.runasPerZinthos) / (1 - spread)).toFixed(2));
            orders.push({ game: "zinthos", amount: cost, label: `${formatInt(qtyZinthos)} Zinthos` });
        }
        if (qtyJardim > 0 && globalRates) {
            const used = currentUserData?.quota?.used?.compra_jardim || 0;
            const spread = calculateDynamicSpread(used, qtyJardim, 150000);
            const cost = Number(((qtyJardim * globalRates.runasPerJardimCoin) / (1 - spread)).toFixed(2));
            orders.push({ game: "jardim", amount: cost, label: `${formatInt(qtyJardim)} Petalitas` });
        }

        if (orders.length === 0) return;

        const btn = document.getElementById("btn-confirm-buy");
        btn.disabled = true;
        btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Processando...`;

        try {
            for (const order of orders) {
                btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Comprando ${order.label}...`;
                const res = await fetch("/api/games/bank/trade", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ token, operation: "compra", game: order.game, amount: order.amount })
                });
                const json = await res.json();
                if (!json.ok) {
                    showNotification(`Erro ao comprar ${order.label}: ${json.error}`, "error");
                } else {
                    showNotification(`🎉 ${order.label} comprado(s) com sucesso!`, "success");
                }
            }
            // Zera inputs
            Object.values(buyInputs).forEach(inp => { if (inp) inp.value = "0"; });
            await Promise.all([loadPublicData(), loadSession()]);
        } catch (err) {
            showNotification(`Falha na comunicação: ${err.message}`, "error");
        } finally {
            btn.disabled = false;
            btn.innerHTML = `<i class="fas fa-shopping-bag"></i> Confirmar Compra`;
            updateBuyCart();
        }
    });

    // 7. Lógica de Carrinho e Controles — ABA VENDA
    const sellInputs = {
        pesca: document.getElementById("sell-qty-pesca"),
        zinthos: document.getElementById("sell-qty-zinthos"),
        jardim: document.getElementById("sell-qty-jardim")
    };

    // Steppers da Venda
    setupStepper("sell-minus-pesca", "sell-plus-pesca", sellInputs.pesca, 1, () => {
        return currentUserData?.holdings?.fishWeight || 0;
    });

    setupStepper("sell-minus-zinthos", "sell-plus-zinthos", sellInputs.zinthos, 1000, () => {
        return currentUserData?.holdings?.zinthos || 0;
    });

    setupStepper("sell-minus-jardim", "sell-plus-jardim", sellInputs.jardim, 1000, () => {
        return currentUserData?.holdings?.gardenCoins || 0;
    });

    // Botões "Tudo" da Venda
    document.getElementById("sell-all-pesca")?.addEventListener("click", () => {
        if (!currentUserData) return;
        sellInputs.pesca.value = Number(currentUserData.holdings?.fishWeight || 0).toFixed(2);
        sellInputs.pesca.dispatchEvent(new Event("input"));
    });

    document.getElementById("sell-all-zinthos")?.addEventListener("click", () => {
        if (!currentUserData) return;
        sellInputs.zinthos.value = Math.floor(currentUserData.holdings?.zinthos || 0);
        sellInputs.zinthos.dispatchEvent(new Event("input"));
    });

    document.getElementById("sell-all-jardim")?.addEventListener("click", () => {
        if (!currentUserData) return;
        sellInputs.jardim.value = Math.floor(currentUserData.holdings?.gardenCoins || 0);
        sellInputs.jardim.dispatchEvent(new Event("input"));
    });

    // Atualização em Tempo Real do Carrinho de Venda
    function updateSellCart() {
        const listEl = document.getElementById("sell-cart-items");
        const totalEl = document.getElementById("sell-cart-total");
        const quotaEl = document.getElementById("sell-cart-quota");
        const confirmBtn = document.getElementById("btn-confirm-sell");

        if (!listEl || !totalEl || !quotaEl || !confirmBtn) return;

        const qtyFish = parsePositiveNumber(sellInputs.pesca?.value);
        const qtyZinthos = Math.floor(parsePositiveNumber(sellInputs.zinthos?.value));
        const qtyJardim = Math.floor(parsePositiveNumber(sellInputs.jardim?.value));

        let totalRunasToReceive = 0;
        const cartRows = [];
        let hasError = false;
        let errorMessage = "";

        const holdings = currentUserData?.holdings || {};
        const qUsed = currentUserData?.quota?.used?.venda_runas || 0;
        const qLimit = currentUserData?.quota?.limits?.venda_runas || 300000;
        const qRemaining = Math.max(0, qLimit - qUsed);

        // Validação Peixes
        if (qtyFish > 0 && globalRates) {
            const stockFish = holdings.fishWeight || 0;
            if (qtyFish > stockFish + 0.001) {
                hasError = true;
                errorMessage = `Quantidade de peixe (${formatPtBr(qtyFish, 2)} kg) excede seu estoque de ${formatPtBr(stockFish, 2)} kg.`;
            }
            const rawRunas = qtyFish * globalRates.runasPerKgFish;
            const spread = calculateDynamicSpread(qUsed + totalRunasToReceive, rawRunas, qLimit);
            const netRunas = rawRunas * (1 - spread);
            totalRunasToReceive += netRunas;
            cartRows.push(`
                <div class="cart-item-row">
                    <span>🎣 <strong>${formatPtBr(qtyFish, 2)} kg</strong> de Peixe (taxa ~${formatPtBr(spread * 100, 1)}%)</span>
                    <span style="font-family: 'JetBrains Mono', monospace; color: #38bdf8;">~+${formatPtBr(netRunas, 2)} ᚱ</span>
                </div>
            `);
        }

        // Validação Zinthos
        if (qtyZinthos > 0 && globalRates) {
            const stockZ = holdings.zinthos || 0;
            if (qtyZinthos > stockZ) {
                hasError = true;
                errorMessage = `Quantidade de Zinthos (${formatInt(qtyZinthos)}) excede seu saldo de ${formatInt(stockZ)} Z.`;
            }
            const rawRunas = qtyZinthos * globalRates.runasPerZinthos;
            const spread = calculateDynamicSpread(qUsed + totalRunasToReceive, rawRunas, qLimit);
            const netRunas = rawRunas * (1 - spread);
            totalRunasToReceive += netRunas;
            cartRows.push(`
                <div class="cart-item-row">
                    <span>💜 <strong>${formatInt(qtyZinthos)}</strong> Zinthos (taxa ~${formatPtBr(spread * 100, 1)}%)</span>
                    <span style="font-family: 'JetBrains Mono', monospace; color: #f472b6;">~+${formatPtBr(netRunas, 2)} ᚱ</span>
                </div>
            `);
        }

        // Validação Petalitas
        if (qtyJardim > 0 && globalRates) {
            const stockJ = holdings.gardenCoins || 0;
            if (qtyJardim > stockJ) {
                hasError = true;
                errorMessage = `Quantidade de Petalitas (${formatInt(qtyJardim)}) excede seu saldo de ${formatInt(stockJ)} Ptl.`;
            }
            const rawRunas = qtyJardim * globalRates.runasPerJardimCoin;
            const spread = calculateDynamicSpread(qUsed + totalRunasToReceive, rawRunas, qLimit);
            const netRunas = rawRunas * (1 - spread);
            totalRunasToReceive += netRunas;
            cartRows.push(`
                <div class="cart-item-row">
                    <span>🌱 <strong>${formatInt(qtyJardim)}</strong> Petalitas (taxa ~${formatPtBr(spread * 100, 1)}%)</span>
                    <span style="font-family: 'JetBrains Mono', monospace; color: #4ade80;">~+${formatPtBr(netRunas, 2)} ᚱ</span>
                </div>
            `);
        }

        if (cartRows.length === 0) {
            listEl.innerHTML = `<span style="color: #64748b; font-style: italic;">Nenhum recurso selecionado. Informe as quantidades acima para vender.</span>`;
            totalEl.textContent = `~+0,00 ᚱ`;
            quotaEl.innerHTML = `Cota unificada restante: <strong style="color: #c084fc;">${formatPtBr(qRemaining, 2)} ᚱ</strong> / dia`;
            confirmBtn.disabled = true;
            return;
        }

        listEl.innerHTML = cartRows.join("");
        totalEl.textContent = `~+${formatPtBr(totalRunasToReceive, 2)} ᚱ`;

        if (totalRunasToReceive > qRemaining + 0.01) {
            hasError = true;
            errorMessage = `A venda total ultrapassa sua cota diária restante de ${formatPtBr(qRemaining, 2)} ᚱ!`;
        }

        if (hasError) {
            quotaEl.innerHTML = `<span style="color: #ef4444; font-weight: 600;">⚠️ ${errorMessage}</span>`;
            confirmBtn.disabled = true;
        } else {
            const remainingAfter = Math.max(0, qRemaining - totalRunasToReceive);
            quotaEl.innerHTML = `Cota restante hoje: <strong style="color: #c084fc;">${formatPtBr(remainingAfter, 2)} ᚱ</strong> (Usada hoje: ${formatPtBr(qUsed, 2)} / ${formatPtBr(qLimit, 0)} ᚱ)`;
            confirmBtn.disabled = false;
        }
    }

    Object.values(sellInputs).forEach(input => {
        if (input) input.addEventListener("input", updateSellCart);
    });

    // Confirmar Venda
    document.getElementById("btn-confirm-sell")?.addEventListener("click", async () => {
        if (!token) return;

        const qtyFish = parsePositiveNumber(sellInputs.pesca?.value);
        const qtyZinthos = Math.floor(parsePositiveNumber(sellInputs.zinthos?.value));
        const qtyJardim = Math.floor(parsePositiveNumber(sellInputs.jardim?.value));

        const orders = [];
        if (qtyFish > 0) orders.push({ game: "pesca", amount: qtyFish, label: `${formatPtBr(qtyFish, 2)} kg de Peixe` });
        if (qtyZinthos > 0) orders.push({ game: "zinthos", amount: qtyZinthos, label: `${formatInt(qtyZinthos)} Zinthos` });
        if (qtyJardim > 0) orders.push({ game: "jardim", amount: qtyJardim, label: `${formatInt(qtyJardim)} Petalitas` });

        if (orders.length === 0) return;

        const btn = document.getElementById("btn-confirm-sell");
        btn.disabled = true;
        btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Processando...`;

        try {
            for (const order of orders) {
                btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Vendendo ${order.label}...`;
                const res = await fetch("/api/games/bank/trade", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ token, operation: "venda", game: order.game, amount: order.amount })
                });
                const json = await res.json();
                if (!json.ok) {
                    showNotification(`Erro ao vender ${order.label}: ${json.error}`, "error");
                } else {
                    showNotification(`🎉 ${order.label} vendido(s) com sucesso!`, "success");
                }
            }
            // Zera inputs
            Object.values(sellInputs).forEach(inp => { if (inp) inp.value = "0"; });
            await Promise.all([loadPublicData(), loadSession()]);
        } catch (err) {
            showNotification(`Falha na comunicação: ${err.message}`, "error");
        } finally {
            btn.disabled = false;
            btn.innerHTML = `<i class="fas fa-hand-holding-usd"></i> Confirmar Venda`;
            updateSellCart();
        }
    });

    // 8. Logout
    document.getElementById("btn-logout")?.addEventListener("click", async () => {
        if (token) {
            try {
                await fetch("/api/games/bank/logout", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ token })
                });
            } catch (e) {}
        }
        localStorage.removeItem("ravenabank_token");
        token = null;
        document.getElementById("guest-prompt").style.display = "block";
        document.getElementById("auth-panel").style.display = "none";
    });

    // Inicia carregamento
    await loadPublicData();
    await loadSession();
});
