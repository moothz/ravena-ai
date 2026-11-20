/**
 * economyConstants.js
 *
 * Parâmetros de balanceamento das Runas usados pelo BankService (câmbio, cotas diárias, loja). Módulo
 * puro (sem banco, rede nem cron): o BankService importa daqui e a carga do painel da economia
 * (EconomyAnalyticsService, no worker) lê daqui para registrar sozinha as mudanças (anotação 'auto'
 * na aba Mudanças) com o valor antigo e o novo.
 *
 * Valor novo de economia das Runas entra aqui. O teste de guarda (test_economy_analytics.js) falha se
 * o BankService ganhar uma constante de módulo que não venha deste arquivo nem esteja na lista de
 * ignoradas, com motivo.
 */
"use strict";

// Constantes econômicas base (1.000 Runas = 800 kg = 3.500 Z = 8.000 Ptl), multiplicadas pela cotação do
// dia. O câmbio afeta também Zinthos e Petalitas: a mudança é anotada em "todas"
const BASE_RUNAS_PER_KG_FISH = 1000 / 800; // 1.25 Runas / kg
const BASE_RUNAS_PER_ZINTHOS = 1000 / 3500; // ~0.2857 Runas / Zinthos
const BASE_RUNAS_PER_JARDIM = 1000 / 8000; // 0.125 Runas / Petalita (Ptl)

// Cotas diárias de economia: venda para ganhar Runas (300k/dia unificado) e caminho inverso para jogos (base 500k Zinthos, 300k Petalitas, 300 moedas, 200 iscas)
const DAILY_LIMITS = {
	venda_runas: 300000, // 300.000 ᚱ/dia (limite unificado para ganhar Runas vendendo peixes, zinthos ou petalitas)
	compra_zinthos: 500000, // Base de 500.000 Zinthos/dia (progressivo diário com inflação, inicia ~600k)
	compra_jardim: 300000, // Base de 300.000 Petalitas/dia (progressivo diário com inflação, inicia ~320k)
	compra_moedas: 300, // 300 moedas/dia no SlotsGame
	compra_iscas: 200, // 200 iscas/dia no FishingGame
	// Legado para compatibilidade:
	pesca: 300000,
	zinthos: 500000,
	jardim: 300000,
	compra: 300000
};

// Configurações da Loja do RavenaBank (compra de consumíveis com Runas)
const STORE_PRICES = {
	moeda: 55, // 55 Runas por moedinha de Slots
	isca: 45 // 45 Runas por isca de Pesca
};

const STORE_LIMITS = {
	dailySlotsCoins: 300, // Limite diário de 300 moedas compradas
	dailyFishingBaits: 200 // Limite diário de 200 iscas compradas
};

/**
 * Parâmetros no formato lido pela carga (as chaves achatadas, ex. cambio.BASE_RUNAS_PER_ZINTHOS,
 * cotas.DAILY_LIMITS.venda_runas, loja.STORE_PRICES.moeda, são as que aparecem nas anotações).
 */
function economyParams() {
	return {
		cambio: { BASE_RUNAS_PER_KG_FISH, BASE_RUNAS_PER_ZINTHOS, BASE_RUNAS_PER_JARDIM },
		cotas: { DAILY_LIMITS },
		loja: { STORE_PRICES, STORE_LIMITS }
	};
}

/** Grupo de parâmetros cuja mudança afeta todas as moedas (câmbio). */
const ALL_CURRENCIES_GROUPS = ["cambio"];

module.exports = {
	BASE_RUNAS_PER_KG_FISH,
	BASE_RUNAS_PER_ZINTHOS,
	BASE_RUNAS_PER_JARDIM,
	DAILY_LIMITS,
	STORE_PRICES,
	STORE_LIMITS,
	economyParams,
	ALL_CURRENCIES_GROUPS
};
