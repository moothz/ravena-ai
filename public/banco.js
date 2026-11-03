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

    // 2. Carrega Dados Públicos
    async function loadPublicData() {
        try {
            const res = await fetch("/api/games/bank/public");
            const json = await res.json();
            if (!json.ok || !json.data) return;

            const d = json.data;
            globalRates = d.rates;

            // Banner
            document.getElementById("total-runas").textContent = `${d.totalRunas.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ᚱ`;
            document.getElementById("total-accounts").textContent = `Distribuídas entre ${d.totalAccounts} contas cadastradas na rede`;

            // Card Pesca
            const kgPer1000 = Math.round(1000 / d.rates.runasPerKgFish);
            document.getElementById("rate-fish").textContent = `1.000 ᚱ = ${kgPer1000.toLocaleString("pt-BR")} kg`;
            document.getElementById("unit-fish").textContent = `1 kg = ${d.rates.runasPerKgFish.toFixed(2)} ᚱ`;
            document.getElementById("stock-fish").textContent = `${d.fish.totalWeight.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} kg (${d.fish.totalCount} peixes)`;

            // Card Waifus
            const zPer1000 = Math.round(1000 / d.rates.runasPerZinthos);
            document.getElementById("rate-waifu").textContent = `1.000 ᚱ = ${zPer1000.toLocaleString("pt-BR")} Z`;
            document.getElementById("unit-waifu").textContent = `1 Z = ${d.rates.runasPerZinthos.toFixed(4)} ᚱ`;
            document.getElementById("stock-waifu").textContent = `${d.waifu.circulatingZinthos.toLocaleString("pt-BR")} Zinthos`;
            document.getElementById("inflation-waifu").textContent = `+${d.waifu.inflationPercent}%`;

            // Card Jardim
            const mjPer1000 = Math.round(1000 / d.rates.runasPerJardimCoin);
            document.getElementById("rate-jardim").textContent = `1.000 ᚱ = ${mjPer1000.toLocaleString("pt-BR")} Moedas`;
            document.getElementById("unit-jardim").textContent = `1 MJ = ${d.rates.runasPerJardimCoin.toFixed(4)} ᚱ`;
            document.getElementById("stock-jardim").textContent = `${d.jardim.totalCoins.toLocaleString("pt-BR")} moedas`;
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
            document.getElementById("my-runas").textContent = `${currentUserData.account.runas.toFixed(2)} ᚱ`;
            document.getElementById("my-fish").textContent = `${currentUserData.holdings.fishWeight.toFixed(2)} kg (${currentUserData.holdings.fishCount} peixes)`;
            document.getElementById("my-zinthos").textContent = `${currentUserData.holdings.zinthos.toLocaleString("pt-BR")} Z`;
            document.getElementById("my-jardim").textContent = `${currentUserData.holdings.gardenCoins.toLocaleString("pt-BR")} moedas`;

            // Renderiza extrato
            renderTransactions(currentUserData.transactions);
            updatePreview();
        } catch (err) {
            console.error("Erro ao verificar sessão do banco:", err);
        }
    }

    function formatPhone(phone) {
        if (!phone) return "Desconhecido";
        const clean = String(phone).replace(/\D/g, "");
        if (clean.length === 13 && clean.startsWith("55")) {
            return `+${clean.slice(0, 2)} (${clean.slice(2, 4)}) ${clean.slice(4, 9)}-${clean.slice(9)}`;
        }
        return phone;
    }

    function renderTransactions(txs) {
        const tbody = document.getElementById("tx-body");
        if (!txs || txs.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: #64748b;">Nenhuma movimentação registrada.</td></tr>`;
            return;
        }

        tbody.innerHTML = txs.map(t => {
            const isDeposit = t.type === "DEPOSIT";
            const dateStr = new Date(t.timestamp).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
            const typeBadge = isDeposit ? `<span style="color: #4ade80; font-weight: 600;">📥 Depósito</span>` : `<span style="color: #f87171; font-weight: 600;">📤 Saque</span>`;
            const gameBadge = t.game === "pesca" ? "🎣 Pesca" : t.game === "waifu" ? "💜 Waifus" : "🌱 Jardim";
            const sign = isDeposit ? "+" : "-";

            return `
                <tr>
                    <td>${dateStr}</td>
                    <td>${typeBadge}</td>
                    <td>${gameBadge}</td>
                    <td>${t.game_amount.toLocaleString("pt-BR")} ${t.game === "pesca" ? "kg" : ""}</td>
                    <td style="font-family: 'JetBrains Mono', monospace; font-weight: 600; color: #fff;">${sign}${t.runas_amount.toFixed(2)} ᚱ</td>
                    <td style="color: #94a3b8;">${(t.spread_rate * 100).toFixed(1)}%</td>
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
    const previewDiv = document.getElementById("trade-preview");
    const btnExecute = document.getElementById("btn-trade-execute");

    opSelect.addEventListener("change", () => {
        if (opSelect.value === "withdraw") {
            // Remove pesca da lista de saques se presente
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
        const valStr = (amountInput.value || "").trim().toLowerCase();

        if (!valStr) {
            previewDiv.innerHTML = "💡 Digite a quantidade acima para simular o recebimento.";
            btnExecute.disabled = false;
            return;
        }

        if (op === "withdraw" && game === "pesca") {
            previewDiv.innerHTML = "<span style='color: #ef4444;'>❌ Não é permitido converter Runas para peixes (apenas venda).</span>";
            btnExecute.disabled = true;
            return;
        }

        const isAll = valStr === "tudo" || valStr === "all";
        let amount = isAll ? 999999 : parseFloat(valStr);

        if (!isAll && (isNaN(amount) || amount <= 0)) {
            previewDiv.innerHTML = "<span style='color: #f59e0b;'>⚠️ Digite um valor numérico positivo.</span>";
            return;
        }

        let previewText = "";
        if (op === "deposit") {
            if (game === "pesca") {
                const rate = globalRates.runasPerKgFish;
                const estRunas = (isAll ? (currentUserData?.holdings?.fishWeight || 0) : amount) * rate * 0.96;
                previewText = `🐟 Você venderá aproximadamente <strong>${isAll ? "todos os seus peixes comuns" : `${amount} kg`}</strong> e receberá cerca de <strong>+${estRunas.toFixed(2)} ᚱ</strong> (Spread estimado: ~4%).`;
            } else if (game === "zinthos") {
                const rate = globalRates.runasPerZinthos;
                const estRunas = amount * rate * 0.96;
                previewText = `💜 Você depositará <strong>${amount.toLocaleString("pt-BR")} Zinthos</strong> e receberá cerca de <strong>+${estRunas.toFixed(2)} ᚱ</strong>.`;
            } else if (game === "jardim") {
                const rate = globalRates.runasPerJardimCoin;
                const estRunas = amount * rate * 0.96;
                previewText = `🌱 Você depositará <strong>${amount.toLocaleString("pt-BR")} Moedas</strong> e receberá cerca de <strong>+${estRunas.toFixed(2)} ᚱ</strong>.`;
            }
        } else {
            // Withdraw (gastando Runas)
            if (game === "zinthos") {
                const rate = globalRates.runasPerZinthos;
                const estZinthos = Math.floor((amount / rate) * 0.96);
                previewText = `💜 Você gastará <strong>${amount} ᚱ</strong> e receberá cerca de <strong>+${estZinthos.toLocaleString("pt-BR")} Zinthos</strong>.`;
            } else if (game === "jardim") {
                const rate = globalRates.runasPerJardimCoin;
                const estCoins = Math.floor((amount / rate) * 0.96);
                previewText = `🌱 Você gastará <strong>${amount} ᚱ</strong> e receberá cerca de <strong>+${estCoins.toLocaleString("pt-BR")} Moedas do Jardim</strong>.`;
            }
        }

        previewDiv.innerHTML = previewText;
        btnExecute.disabled = false;
    }

    // Executar Transação Web
    btnExecute.addEventListener("click", async () => {
        if (!token) return;

        const op = opSelect.value;
        const game = gameSelect.value;
        const amount = (amountInput.value || "").trim();

        if (!amount) {
            alert("Por favor, informe a quantidade!");
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
