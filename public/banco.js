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

    // 2. Carrega Dados Públicos
    async function loadPublicData() {
        try {
            const res = await fetch("/api/games/bank/public");
            const json = await res.json();
            if (!json.ok || !json.data) return;

            const d = json.data;
            globalRates = d.rates;

            // Banner
            document.getElementById("total-runas").textContent = `💠 ${formatPtBr(d.totalRunas, 2)} ᚱ`;
            document.getElementById("total-accounts").textContent = `Distribuídas entre ${formatInt(d.totalAccounts)} contas cadastradas na rede`;

            // Card Pesca
            const kgPer1000 = Math.round(1000 / d.rates.runasPerKgFish);
            document.getElementById("rate-fish").textContent = `1.000 ᚱ = ${formatInt(kgPer1000)} kg`;
            document.getElementById("unit-fish").textContent = `1 kg = ${formatPtBr(d.rates.runasPerKgFish, 2)} ᚱ`;
            document.getElementById("stock-fish").textContent = `${formatPtBr(d.fish.totalWeight, 1)} kg (${formatInt(d.fish.totalCount)} peixes)`;

            // Card Waifus
            const zPer1000 = Math.round(1000 / d.rates.runasPerZinthos);
            document.getElementById("rate-waifu").textContent = `1.000 ᚱ = ${formatInt(zPer1000)} Z`;
            document.getElementById("unit-waifu").textContent = `1 Z = ${formatPtBr(d.rates.runasPerZinthos, 4)} ᚱ`;
            document.getElementById("stock-waifu").textContent = `${formatInt(d.waifu.circulatingZinthos)} Zinthos`;
            document.getElementById("inflation-waifu").textContent = `+${formatPtBr(d.waifu.inflationPercent, 2)}%`;

            // Card Jardim (Fazenda)
            const mjPer1000 = Math.round(1000 / d.rates.runasPerJardimCoin);
            document.getElementById("rate-jardim").textContent = `1.000 ᚱ = ${formatInt(mjPer1000)} Ptl`;
            document.getElementById("unit-jardim").textContent = `1 Ptl = ${formatPtBr(d.rates.runasPerJardimCoin, 4)} ᚱ`;
            document.getElementById("stock-jardim").textContent = `${formatInt(d.jardim.totalCoins)} Ptl`;
        } catch (err) {
            console.error("Erro ao carregar dados públicos do banco:", err);
        }
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
            document.getElementById("user-phone").textContent = formatPhone(currentUserData.userId);
            document.getElementById("my-runas").textContent = `${formatPtBr(currentUserData.account.runas, 2)} ᚱ`;
            document.getElementById("my-fish").textContent = `${formatPtBr(currentUserData.holdings.fishWeight, 2)} kg (${formatInt(currentUserData.holdings.fishCount)} peixes)`;
            document.getElementById("my-zinthos").textContent = `${formatInt(currentUserData.holdings.zinthos)} Z`;
            document.getElementById("my-jardim").textContent = `${formatInt(currentUserData.holdings.gardenCoins)} Ptl`;

            // Atualiza cotas diárias utilizadas abaixo dos saldos
            const q = currentUserData.quota || { used: {}, limits: {} };
            const qUsed = q.used || {};
            const qLimits = q.limits || {};

            const elRunasQ = document.getElementById("my-runas-quota");
            if (elRunasQ) {
                elRunasQ.textContent = `Cota usada: ${formatPtBr(qUsed.compra || 0, 2)} / ${formatPtBr(qLimits.compra || 15000, 0)} ᚱ`;
            }
            const elFishQ = document.getElementById("my-fish-quota");
            if (elFishQ) {
                elFishQ.textContent = `Cota usada: ${formatPtBr(qUsed.pesca || 0, 1)} / ${formatPtBr(qLimits.pesca || 1500, 0)} kg`;
            }
            const elZinthosQ = document.getElementById("my-zinthos-quota");
            if (elZinthosQ) {
                elZinthosQ.textContent = `Cota usada: ${formatInt(qUsed.zinthos || 0)} / ${formatInt(qLimits.zinthos || 9000)} Z`;
            }
            const elJardimQ = document.getElementById("my-jardim-quota");
            if (elJardimQ) {
                elJardimQ.textContent = `Cota usada: ${formatInt(qUsed.jardim || 0)} / ${formatInt(qLimits.jardim || 30000)} Ptl`;
            }

            // Renderiza extrato
            renderTransactions(currentUserData.transactions);
            updatePreview();
        } catch (err) {
            console.error("Erro ao verificar sessão do banco:", err);
        }
    }

    function renderTransactions(txs) {
        const tbody = document.getElementById("tx-body");
        if (!txs || txs.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: #64748b;">Nenhuma movimentação registrada.</td></tr>`;
            return;
        }

        tbody.innerHTML = txs.map(t => {
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
            } else if (t.game === "waifu") {
                gameBadge = "💜 Waifuletes (Z)";
                formattedAmount = `${formatInt(t.game_amount)} Z`;
            } else if (t.game === "jardim") {
                gameBadge = "🌱 Petalitas (Ptl)";
                formattedAmount = `${formatInt(t.game_amount)} Ptl`;
            } else {
                gameBadge = t.game;
                formattedAmount = formatPtBr(t.game_amount, 2);
            }

            const sign = isVenda ? "+" : "-";
            const spreadFee = formatPtBr(t.spread_fee_runas, 2);
            const spreadPct = formatPtBr(t.spread_rate * 100, 1);

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
    }

    // 4. Logout
    document.getElementById("btn-logout").addEventListener("click", async () => {
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

    // 5. Câmbio Web e Preview Dinâmico
    const opSelect = document.getElementById("trade-operation");
    const gameSelect = document.getElementById("trade-game");
    const amountInput = document.getElementById("trade-amount");
    const btnUseAll = document.getElementById("btn-use-all");
    const previewDiv = document.getElementById("trade-preview");
    const btnExecute = document.getElementById("btn-trade-execute");

    function getUserMaxAmount(op, game) {
        if (!currentUserData) return 0;
        if (op === "deposit") {
            if (game === "pesca") return currentUserData.holdings?.fishWeight || 0;
            if (game === "zinthos") return currentUserData.holdings?.zinthos || 0;
            if (game === "jardim") return currentUserData.holdings?.gardenCoins || 0;
        } else {
            return currentUserData.account?.runas || 0;
        }
        return 0;
    }

    function parseInputAmount(raw) {
        if (!raw) return 0;
        let str = String(raw).trim().toLowerCase();
        if (str === "tudo" || str === "all" || str === "max") {
            return getUserMaxAmount(opSelect.value, gameSelect.value);
        }
        str = str.replace(/\s+/g, "");
        if (str.includes(",") && str.includes(".")) {
            str = str.replace(/\./g, "").replace(",", ".");
        } else if (str.includes(",")) {
            str = str.replace(",", ".");
        } else if (str.includes(".")) {
            const parts = str.split(".");
            if (parts.length > 1 && parts.slice(1).every(p => p.length === 3)) {
                str = str.replace(/\./g, "");
            }
        }
        return parseFloat(str);
    }

    function handleUseAll(e) {
        if (e && e.preventDefault) e.preventDefault();
        const op = opSelect.value;
        const game = gameSelect.value;
        const maxVal = getUserMaxAmount(op, game);
        if (maxVal <= 0) {
            amountInput.value = "0";
        } else if (game === "pesca" || op === "withdraw") {
            amountInput.value = Number(maxVal).toFixed(2);
        } else {
            amountInput.value = String(Math.floor(Number(maxVal) || 0));
        }
        amountInput.dispatchEvent(new Event("input"));
        updatePreview();
    }
    window.handleUseAll = handleUseAll;

    if (btnUseAll) {
        btnUseAll.addEventListener("click", handleUseAll);
    }

    opSelect.addEventListener("change", () => {
        if (opSelect.value === "withdraw") {
            // Remove pesca da lista de compras
            const fishOpt = gameSelect.querySelector("option[value='pesca']");
            if (fishOpt) fishOpt.disabled = true;
            if (gameSelect.value === "pesca") gameSelect.value = "zinthos";
        } else {
            const fishOpt = gameSelect.querySelector("option[value='pesca']");
            if (fishOpt) fishOpt.disabled = false;
        }
        updatePreview();
    });

    gameSelect.addEventListener("change", updatePreview);
    amountInput.addEventListener("input", updatePreview);

    function updatePreview() {
        if (!globalRates) return;

        const op = opSelect.value;
        const game = gameSelect.value;
        const rawVal = (amountInput.value || "").trim().toLowerCase();

        if (!rawVal) {
            previewDiv.innerHTML = "💡 Digite a quantidade acima para simular a prévia de valores e taxas.";
            btnExecute.disabled = false;
            return;
        }

        if (op === "withdraw" && game === "pesca") {
            previewDiv.innerHTML = "<span style='color: #ef4444;'>❌ Não é permitido comprar peixes com Runas (peixes são apenas para venda).</span>";
            btnExecute.disabled = true;
            return;
        }

        const isAll = rawVal === "tudo" || rawVal === "all" || rawVal === "max";
        const amount = parseInputAmount(rawVal);

        if (isNaN(amount) || amount <= 0) {
            previewDiv.innerHTML = "<span style='color: #f59e0b;'>⚠️ Digite um valor numérico positivo.</span>";
            btnExecute.disabled = true;
            return;
        }

        const quota = currentUserData?.quota || { used: {}, limits: {}, remaining: {} };
        let previewHtml = "";

        if (op === "deposit") {
            // Venda para o banco
            if (game === "pesca") {
                const limit = quota.limits?.pesca || 1500;
                const used = quota.used?.pesca || 0;
                const rate = globalRates.runasPerKgFish;
                const spread = calculateDynamicSpread(used, amount, limit);
                const rawRunas = amount * rate;
                const spreadRunas = rawRunas * spread;
                const netRunas = rawRunas - spreadRunas;
                const remQuota = Math.max(0, (quota.remaining?.pesca ?? limit) - amount);

                previewHtml = `
                    <div style="display: flex; flex-direction: column; gap: 4px;">
                        <div>📦 <strong>Vender:</strong> ${formatPtBr(amount, 2)} kg de Peixe Comum ${isAll ? "<em>(Todo o seu inventário comum)</em>" : ""}</div>
                        <div>📈 <strong>Taxa Estimada:</strong> ${formatPtBr(spread * 100, 1)}% (-${formatPtBr(spreadRunas, 2)} ᚱ)</div>
                        <div style="font-size: 14px; color: #a78bfa; font-weight: 700;">💠 <strong>Você Receberá:</strong> ~+${formatPtBr(netRunas, 2)} ᚱ</div>
                        <div style="font-size: 11px; color: #94a3b8;">🛡️ Cota de venda restante hoje: ${formatPtBr(remQuota, 1)} kg</div>
                    </div>
                `;
            } else if (game === "zinthos") {
                const limit = quota.limits?.zinthos || 9000;
                const used = quota.used?.zinthos || 0;
                const rate = globalRates.runasPerZinthos;
                const spread = calculateDynamicSpread(used, amount, limit);
                const rawRunas = amount * rate;
                const spreadRunas = rawRunas * spread;
                const netRunas = rawRunas - spreadRunas;
                const remQuota = Math.max(0, (quota.remaining?.zinthos ?? limit) - amount);

                previewHtml = `
                    <div style="display: flex; flex-direction: column; gap: 4px;">
                        <div>💜 <strong>Vender:</strong> ${formatInt(amount)} Zinthos ${isAll ? "<em>(Todo o seu saldo de Zinthos)</em>" : ""}</div>
                        <div>📈 <strong>Taxa Estimada:</strong> ${formatPtBr(spread * 100, 1)}% (-${formatPtBr(spreadRunas, 2)} ᚱ)</div>
                        <div style="font-size: 14px; color: #a78bfa; font-weight: 700;">💠 <strong>Você Receberá:</strong> ~+${formatPtBr(netRunas, 2)} ᚱ</div>
                        <div style="font-size: 11px; color: #94a3b8;">🛡️ Cota de venda restante hoje: ${formatInt(remQuota)} Z</div>
                    </div>
                `;
            } else if (game === "jardim") {
                const limit = quota.limits?.jardim || 30000;
                const used = quota.used?.jardim || 0;
                const rate = globalRates.runasPerJardimCoin;
                const spread = calculateDynamicSpread(used, amount, limit);
                const rawRunas = amount * rate;
                const spreadRunas = rawRunas * spread;
                const netRunas = rawRunas - spreadRunas;
                const remQuota = Math.max(0, (quota.remaining?.jardim ?? limit) - amount);

                previewHtml = `
                    <div style="display: flex; flex-direction: column; gap: 4px;">
                        <div>🌱 <strong>Vender:</strong> ${formatInt(amount)} Petalitas ${isAll ? "<em>(Todas as suas Petalitas)</em>" : ""}</div>
                        <div>📈 <strong>Taxa Estimada:</strong> ${formatPtBr(spread * 100, 1)}% (-${formatPtBr(spreadRunas, 2)} ᚱ)</div>
                        <div style="font-size: 14px; color: #a78bfa; font-weight: 700;">💠 <strong>Você Receberá:</strong> ~+${formatPtBr(netRunas, 2)} ᚱ</div>
                        <div style="font-size: 11px; color: #94a3b8;">🛡️ Cota de venda restante hoje: ${formatInt(remQuota)} Ptl</div>
                    </div>
                `;
            }
        } else {
            // Compra com Runas
            const limit = quota.limits?.compra || 15000;
            const used = quota.used?.compra || 0;
            const spread = calculateDynamicSpread(used, amount, limit);
            const remQuota = Math.max(0, (quota.remaining?.compra ?? limit) - amount);

            if (game === "zinthos") {
                const rate = globalRates.runasPerZinthos;
                const rawZinthos = amount / rate;
                const netZinthos = Math.floor(rawZinthos * (1 - spread));

                previewHtml = `
                    <div style="display: flex; flex-direction: column; gap: 4px;">
                        <div>💠 <strong>Gastar:</strong> ${formatPtBr(amount, 2)} ᚱ ${isAll ? "<em>(Todo o seu saldo de Runas)</em>" : ""}</div>
                        <div>📈 <strong>Taxa Estimada:</strong> ${formatPtBr(spread * 100, 1)}%</div>
                        <div style="font-size: 14px; color: #f472b6; font-weight: 700;">💎 <strong>Você Receberá:</strong> ~+${formatInt(netZinthos)} Zinthos</div>
                        <div style="font-size: 11px; color: #94a3b8;">🛡️ Cota de compra restante hoje: ${formatPtBr(remQuota, 2)} ᚱ</div>
                    </div>
                `;
            } else if (game === "jardim") {
                const rate = globalRates.runasPerJardimCoin;
                const rawCoins = amount / rate;
                const netCoins = Math.floor(rawCoins * (1 - spread));

                previewHtml = `
                    <div style="display: flex; flex-direction: column; gap: 4px;">
                        <div>💠 <strong>Gastar:</strong> ${formatPtBr(amount, 2)} ᚱ ${isAll ? "<em>(Todo o seu saldo de Runas)</em>" : ""}</div>
                        <div>📈 <strong>Taxa Estimada:</strong> ${formatPtBr(spread * 100, 1)}%</div>
                        <div style="font-size: 14px; color: #4ade80; font-weight: 700;">🌱 <strong>Você Receberá:</strong> ~+${formatInt(netCoins)} Petalitas</div>
                        <div style="font-size: 11px; color: #94a3b8;">🛡️ Cota de compra restante hoje: ${formatPtBr(remQuota, 2)} ᚱ</div>
                    </div>
                `;
            }
        }

        previewDiv.innerHTML = previewHtml;
        btnExecute.disabled = false;
    }

    // Executar Transação Web
    btnExecute.addEventListener("click", async () => {
        if (!token) return;

        const op = opSelect.value;
        const game = gameSelect.value;
        const rawAmount = (amountInput.value || "").trim();

        if (!rawAmount) {
            alert("Por favor, informe a quantidade!");
            return;
        }

        const amount = parseInputAmount(rawAmount);
        if (isNaN(amount) || amount <= 0) {
            alert("Por favor, informe uma quantidade válida e positiva!");
            return;
        }

        btnExecute.disabled = true;
        btnExecute.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Processando...`;

        try {
            const res = await fetch("/api/games/bank/trade", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ token, operation: op, game, amount })
            });

            const json = await res.json();
            if (!json.ok) {
                alert(`❌ Erro no câmbio: ${json.error}`);
            } else {
                alert("🎉 Câmbio realizado com sucesso!");
                amountInput.value = "";
                // Recarrega dados e sessão
                await Promise.all([loadPublicData(), loadSession()]);
            }
        } catch (err) {
            alert(`❌ Falha de comunicação: ${err.message}`);
        } finally {
            btnExecute.disabled = false;
            btnExecute.innerHTML = `<i class="fas fa-check-circle" style="margin-right: 6px;"></i> Confirmar Câmbio`;
        }
    });

    // Inicia carregamento
    await loadPublicData();
    await loadSession();
});
