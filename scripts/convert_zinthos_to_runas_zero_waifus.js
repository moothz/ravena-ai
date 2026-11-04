/**
 * Script de Conversão de Zinthos para Runas (Usuários com 0 Waifus)
 *
 * Converte o saldo de Zinthos de jogadores que não participam do jogo de Waifus
 * (possuem 0 waifus casadas no harém) para a moeda global Runas no RavenaBank.
 *
 * Modos de Execução:
 *   Simulação (Dry-Run):
 *     docker exec ravena-ai node /app/scripts/convert_zinthos_to_runas_zero_waifus.js --dry-run
 *
 *   Execução Real (Aplica as alterações no banco e no Waifuletes):
 *     docker exec ravena-ai node /app/scripts/convert_zinthos_to_runas_zero_waifus.js --apply
 */

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const BankService = require("../src/services/BankService");
const Logger = require("../src/utils/Logger");

const logger = new Logger("convert-zinthos-zero-waifus");

const WAIFULETES_URL = (
	process.env.WAIFULETES_API_URL || "http://host.docker.internal:3030"
).replace(/\/+$/, "");
const WAIFULETES_KEY = process.env.WAIFULETES_API_KEY;

const waifuApi = axios.create({
	baseURL: WAIFULETES_URL,
	headers: {
		Authorization: `Bearer ${WAIFULETES_KEY || ""}`,
		"Content-Type": "application/json"
	},
	timeout: 8000
});

async function main() {
	const isApply = process.argv.includes("--apply");
	const isDryRun = !isApply || process.argv.includes("--dry-run");
	const useBaseRate = process.argv.includes("--base-rate");

	console.log("================================================================================");
	console.log(
		`🏦 CONVERSÃO DE ZINTHOS PARA RUNAS (0 WAIFUS) [${isDryRun ? "DRY-RUN / SIMULAÇÃO" : "MODO REAL --APPLY"}]`
	);
	console.log("================================================================================\n");

	// 1. Obter cotação oficial do RavenaBank
	const rates = await BankService.getRates();
	const runasPerZinthos = useBaseRate ? 1000 / 3500 : rates.runasPerZinthos || 1000 / 3500;

	console.log("📈 Parâmetros Cambiais do RavenaBank:");
	console.log(
		`   • Modo de Taxa: ${useBaseRate ? "Paridade Base Fixa (1.000 ᚱ = 3.500 Z)" : "Cotação Dinâmica do Dia"}`
	);
	console.log(`   • Cotação Utilizada: 1 Zinthos = ${runasPerZinthos.toFixed(6)} Runas`);
	console.log(`   • Paridade Base: 3.500 Zinthos ≡ 1.000 Runas (~0.285714 ᚱ)`);
	console.log(`   • Spread Administrativo Aplicado: 0% (Conversão nominal integral de migração)\n`);

	// 2. Carregar arquivo de usuários elegíveis
	const dataFilePath = path.join(__dirname, "../data/zero_waifus_zinthos.json");
	if (!fs.existsSync(dataFilePath)) {
		console.error(`❌ Arquivo de dados não encontrado: ${dataFilePath}`);
		process.exit(1);
	}

	const rawData = fs.readFileSync(dataFilePath, "utf8");
	let allUsers = [];
	try {
		allUsers = JSON.parse(rawData);
	} catch (e) {
		console.error("❌ Falha ao decodificar JSON de usuários:", e.message);
		process.exit(1);
	}

	// Filtra usuários de teste e garante saldo positivo
	const targetUsers = allUsers.filter((u) => {
		const id = String(u.id || "").toLowerCase();
		const name = String(u.name || "").toLowerCase();
		const isTest = id.startsWith("test_") || name.includes("jogador web teste");
		return !isTest && Number(u.kakera) > 0;
	});

	if (targetUsers.length === 0) {
		console.log("Nenhum usuário elegível com saldo de Zinthos e 0 waifus encontrado.");
		process.exit(0);
	}

	console.log(`📋 Total de usuários elegíveis identificados: ${targetUsers.length}\n`);

	// 3. Estatísticas e Cálculos
	let totalZinthos = 0;
	let totalRunas = 0;

	const brackets = {
		b1: { label: "1 a 1.000 Z", count: 0, zinthos: 0, runas: 0 },
		b2: { label: "1.001 a 10.000 Z", count: 0, zinthos: 0, runas: 0 },
		b3: { label: "10.001 a 50.000 Z", count: 0, zinthos: 0, runas: 0 },
		b4: { label: "Mais de 50.000 Z", count: 0, zinthos: 0, runas: 0 }
	};

	const preparedList = targetUsers.map((u) => {
		const z = Math.round(Number(u.kakera));
		const r = Math.round(z * runasPerZinthos);
		totalZinthos += z;
		totalRunas += r;

		if (z <= 1000) {
			brackets.b1.count++;
			brackets.b1.zinthos += z;
			brackets.b1.runas += r;
		} else if (z <= 10000) {
			brackets.b2.count++;
			brackets.b2.zinthos += z;
			brackets.b2.runas += r;
		} else if (z <= 50000) {
			brackets.b3.count++;
			brackets.b3.zinthos += z;
			brackets.b3.runas += r;
		} else {
			brackets.b4.count++;
			brackets.b4.zinthos += z;
			brackets.b4.runas += r;
		}

		return {
			id: u.id,
			name: u.name || "Sem Nome",
			zinthos: z,
			runas: r
		};
	});

	// Ordena por maior quantidade de Zinthos
	preparedList.sort((a, b) => b.zinthos - a.zinthos);

	// Exibe Amostra dos 25 Maiores Saldos
	console.log("🏆 TOP 25 MAIORES SALDOS A CONVERTER:");
	console.log("--------------------------------------------------------------------------------");
	console.log(
		" Rank | Telefone/ID       | Nome                  | Zinthos (Atual) | Runas (Novo) "
	);
	console.log("--------------------------------------------------------------------------------");
	preparedList.slice(0, 25).forEach((u, idx) => {
		const rankStr = String(idx + 1).padStart(4, " ");
		const idStr = String(u.id).padEnd(17, " ");
		const nameStr = String(u.name).slice(0, 21).padEnd(21, " ");
		const zStr = u.zinthos.toLocaleString("pt-BR").padStart(15, " ");
		const rStr = u.runas.toLocaleString("pt-BR").padStart(12, " ");
		console.log(` ${rankStr} | ${idStr} | ${nameStr} | ${zStr} | ${rStr} ᚱ`);
	});
	console.log("--------------------------------------------------------------------------------\n");

	// Distribuição por Faixas de Saldo
	console.log("📊 DISTRIBUIÇÃO POR FAIXA DE SALDO:");
	console.log("--------------------------------------------------------------------------------");
	console.log(" Faixa               | Usuários | % Total | Zinthos Total   | Runas a Gerar     ");
	console.log("--------------------------------------------------------------------------------");
	for (const key of Object.keys(brackets)) {
		const b = brackets[key];
		const pct = ((b.count / targetUsers.length) * 100).toFixed(1);
		const fLabel = b.label.padEnd(18, " ");
		const cStr = String(b.count).padStart(8, " ");
		const pStr = `${pct}%`.padStart(7, " ");
		const zStr = b.zinthos.toLocaleString("pt-BR").padStart(15, " ");
		const rStr = b.runas.toLocaleString("pt-BR").padStart(16, " ");
		console.log(` ${fLabel} | ${cStr} | ${pStr} | ${zStr} | ${rStr} ᚱ`);
	}
	console.log("--------------------------------------------------------------------------------\n");

	console.log("💰 RESUMO CONSOLIDADO:");
	console.log(`   • Total de Contas Afetadas: ${targetUsers.length.toLocaleString("pt-BR")}`);
	console.log(`   • Total de Zinthos a Remover: ${totalZinthos.toLocaleString("pt-BR")} Z`);
	console.log(`   • Total de Runas a Creditar: ${totalRunas.toLocaleString("pt-BR")} ᚱ`);
	console.log(
		`   • Redução na Massa Monetária (M2) do Mudae: -${totalZinthos.toLocaleString("pt-BR")} Zinthos`
	);
	console.log(
		`   • Injeção de Liquidez no RavenaBank: +${totalRunas.toLocaleString("pt-BR")} Runas\n`
	);

	if (isDryRun) {
		console.log("================================================================================");
		console.log("🛡️ [DRY-RUN CONCLUÍDO] Nenhuma alteração foi realizada nos bancos de dados.");
		console.log("Para efetivar a conversão e aplicar no Waifuletes e no RavenaBank, execute:");
		console.log(
			"  docker exec ravena-ai node /app/scripts/convert_zinthos_to_runas_zero_waifus.js --apply"
		);
		console.log("================================================================================");
		process.exit(0);
	}

	// 4. MODO REAL (--apply)
	console.log("🚀 INICIANDO PROCESSAMENTO REAL DOS 415 USUÁRIOS...");
	let successCount = 0;
	let failedCount = 0;
	const errors = [];

	for (let i = 0; i < preparedList.length; i++) {
		const u = preparedList[i];
		const progress = `[${i + 1}/${preparedList.length}]`;

		try {
			// A. Credita Runas no RavenaBank
			await BankService.creditRunas(u.id, u.runas, {
				recordTransaction: true,
				source: "migration_0_waifus",
				details: {
					originalZinthos: u.zinthos,
					rate: runasPerZinthos
				}
			});

			// B. Debita Zinthos do Waifuletes via API oficial
			await waifuApi.post("/admin/kakera/take", {
				userId: String(u.id).replace(/\D/g, "") || String(u.id),
				amount: u.zinthos,
				reason: "Conversão para Runas no RavenaBank (0 waifus)"
			});

			successCount++;
			if ((i + 1) % 50 === 0 || i === preparedList.length - 1) {
				console.log(`   ${progress} Processados ${i + 1} usuários...`);
			}
		} catch (err) {
			failedCount++;
			const errorMsg = err.response?.data?.message || err.message;
			errors.push({ id: u.id, name: u.name, error: errorMsg });
			logger.error(`Falha ao converter usuário ${u.id} (${u.name}): ${errorMsg}`);
		}
	}

	console.log("\n================================================================================");
	console.log(`✅ PROCESSAMENTO CONCLUÍDO!`);
	console.log(`   • Sucessos: ${successCount}`);
	console.log(`   • Falhas: ${failedCount}`);
	console.log(`   • Zinthos Retirados do Mudae: ${totalZinthos.toLocaleString("pt-BR")} Z`);
	console.log(`   • Runas Injetadas no RavenaBank: ${totalRunas.toLocaleString("pt-BR")} ᚱ`);
	console.log("================================================================================");

	if (errors.length > 0) {
		console.log("\n⚠️ Lista de Erros Encontrados:");
		errors.forEach((e) => console.log(`   - ${e.id} (${e.name}): ${e.error}`));
	}

	process.exit(0);
}

main().catch((err) => {
	console.error("Erro fatal no script de conversão:", err);
	process.exit(1);
});
