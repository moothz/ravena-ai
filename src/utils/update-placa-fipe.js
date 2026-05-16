const Database = require("./Database");
const Logger = require("./Logger");
const { formatarRetornoPlaca } = require("../functions/PlacasCommands");

const logger = new Logger("update-placa-fipe");
const database = Database.getInstance({ disableBackup: true });
const DB_NAME = "placas";

async function runUpdate() {
	logger.info("====================================================================");
	logger.info("🚗 Iniciando verificação e atualização de FIPE nas placas cacheadas...");
	logger.info("====================================================================");

	try {
		// Busca todas as linhas de placas
		const rows = await database.dbAll(DB_NAME, "SELECT placa, json_data FROM placas");
		if (!rows || rows.length === 0) {
			logger.info("Nenhuma placa encontrada no banco de dados.");
			process.exit(0);
		}

		// Conta quantas placas precisam de atualização
		let totalParaAtualizar = 0;
		const linhasPendentes = [];

		for (const row of rows) {
			if (!row.json_data) continue;
			try {
				const parsed = JSON.parse(row.json_data);
				const jaAtualizado =
					parsed.fipe_updated === true ||
					(parsed.data?.msg && parsed.data.msg.includes("📊 *Histórico"));
				if (!jaAtualizado) {
					totalParaAtualizar++;
					linhasPendentes.push({ row, parsed });
				}
			} catch (e) {}
		}

		logger.info(`📊 Total de placas cacheadas no banco: ${rows.length}`);
		logger.info(`⏳ Total de placas aguardando atualização FIPE: ${totalParaAtualizar}`);
		logger.info("--------------------------------------------------------------------");

		if (linhasPendentes.length === 0) {
			logger.info("✅ Todas as placas cacheadas já estão atualizadas com a nova FIPE!");
			process.exit(0);
		}

		let count = 0;
		const maxPerRun = 100;
		const totalNestaExecucao = Math.min(linhasPendentes.length, maxPerRun);

		logger.info(`▶️ Iniciando processamento do lote de ${totalNestaExecucao} placas...`);
		logger.info("--------------------------------------------------------------------");

		for (const item of linhasPendentes) {
			if (count >= maxPerRun) {
				logger.info(`\n🛑 Limite configurado de ${maxPerRun} placas atingido nesta execução.`);
				break;
			}

			const { row, parsed } = item;
			const placaKey = row.placa;
			const placaStr = placaKey.split("_")[0].toUpperCase();
			const fullData = parsed.fullData || {};
			const nomeVeiculo =
				(fullData.marcamodelo ??
					`${fullData.MARCA ?? fullData.marca ?? ""} ${fullData.MODELO ?? fullData.modelo ?? ""}`.trim()) ||
				"Desconhecido";
			const progresso = `[${count + 1}/${totalNestaExecucao}]`;

			logger.info(`🔄 ${progresso} Consultando: ${placaStr} 🚘 ${nomeVeiculo}`);

			if (!parsed.fullData) {
				parsed.fipe_updated = true;
				parsed.fipe_updated_ts = Date.now();
				await saveCache(placaKey, parsed);
				logger.warn(`⚠️  ${progresso} Placa ${placaStr} sem dados brutos (fullData). Pulando.`);
				count++;
				continue;
			}

			const { retorno, dadosAtualizados } = await formatarRetornoPlaca(
				parsed.fullData,
				placaStr,
				true
			);

			if (retorno && retorno.msg) {
				parsed.data = {
					...parsed.data,
					msg: retorno.msg,
					react: retorno.react || parsed.data?.react || "🚘"
				};
				parsed.fullData = dadosAtualizados;

				const fipeObj = dadosAtualizados?.fipe?.dados?.[0] || dadosAtualizados?.fipe;
				const precoStr = fipeObj?.texto_valor || "?";
				const modeloFipe = fipeObj?.texto_modelo || "?";
				const mesRef = fipeObj?.mes_referencia || "?";

				logger.info(
					`✅ ${progresso} ATUALIZADO -> ${placaStr} | FIPE: ${precoStr} (${modeloFipe} - ${mesRef})`
				);
			} else {
				logger.warn(`❌ ${progresso} FALHA ao formatar ou consultar placa ${placaStr}.`);
			}

			// Marca como atualizado
			parsed.fipe_updated = true;
			parsed.fipe_updated_ts = Date.now();

			await saveCache(placaKey, parsed);
			count++;

			// Pequeno delay para não sobrecarregar
			await new Promise((res) => setTimeout(res, 300));
		}

		logger.info("====================================================================");
		logger.info(`🎉 Execução concluída com sucesso! ${count} placas atualizadas neste lote.`);
		const restantes = totalParaAtualizar - count;
		if (restantes > 0) {
			logger.info(
				`⏩ Ainda restam ${restantes} placas no banco. Execute o script novamente para o próximo lote.`
			);
		} else {
			logger.info("🏁 Todas as placas pendentes foram totalmente atualizadas!");
		}
		logger.info("====================================================================");

		process.exit(0);
	} catch (error) {
		logger.error("❌ Erro fatal durante a atualização de placas:", error);
		process.exit(1);
	}
}

async function saveCache(placaKey, cacheObj) {
	try {
		await database.dbRun(
			DB_NAME,
			"INSERT OR REPLACE INTO placas (placa, json_data) VALUES (?, ?)",
			[placaKey, JSON.stringify(cacheObj)]
		);
	} catch (err) {
		logger.error(`Erro ao salvar no banco para a placa ${placaKey}:`, err);
	}
}

// Inicia após pequeno tempo para garantir abertura dos bancos SQLite
setTimeout(runUpdate, 500);
