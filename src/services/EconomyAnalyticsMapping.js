/**
 * EconomyAnalyticsMapping.js
 *
 * Tabela versionada motivo (reason) → tipo (kind) do painel da economia.
 * Contrato do painel da economia, seção 2. Ver OBSERVABILITY.md ("Painel da economia").
 *
 * kind:
 *   creation      moeda nasce (recompensa, prêmio, bônus, venda de algo que não é moeda acompanhada)
 *   destruction   moeda some (taxa, loja, compra do sistema)
 *   transfer      moeda passa de um jogador para outro (soma zero, salvo taxa)
 *   exchange_in   moeda entra vinda de outra moeda acompanhada (câmbio no RavenaBank)
 *   exchange_out  moeda sai para outra moeda acompanhada (câmbio no RavenaBank)
 *   non_monetary  linha do extrato que NÃO mexe no saldo (fica fora de todas as somas de dinheiro do
 *                 painel, inclusive da moeda sem origem). Extensão aos kinds do contrato.
 *   unknown       motivo sem mapeamento (aparece no painel para alguém mapear)
 *
 * Motivos "mistos" (ex.: ADMIN_GRANT, ADMIN_ADJUST) recebem o kind do sentido dominante; os valores
 * de saída continuam em amount_out, então entradas e saídas totais do painel não dependem do kind.
 *
 * A cada subida a carga regrava o kind de toda linha do flows_hourly que difere deste mapeamento (não
 * precisa subir MAPPING_VERSION para valer; suba para registrar a mudança). Todo motivo mapeado precisa
 * de um nome legível em LABELS (vira a tabela reason_labels, usada pelo painel).
 */
"use strict";

const MAPPING_VERSION = 1;

const KINDS = [
	"creation",
	"destruction",
	"transfer",
	"exchange_in",
	"exchange_out",
	"non_monetary",
	"unknown"
];

/** Kinds que não representam dinheiro movido: fora de entradas, saídas e moeda sem origem. */
const NON_MONETARY_KINDS = ["non_monetary"];

const MAPPING = {
	// Zinthos: enum KakeraReason do waifuletes (api/prisma/schema.prisma). A rota do waifuletes separa
	// ADMIN_GRANT pelo metadata.reason: `ADMIN_GRANT:<reason>` ([a-z0-9_], senão `ADMIN_GRANT:other`).
	zinthos: {
		DAILY_REWARD: "creation",
		DIVORCE: "creation", // vender (divorciar) personagem paga Zinthos
		ROLL_CRYSTAL: "creation",
		EVENT_REWARD: "creation",
		WISHLIST_BONUS: "creation",
		SOULMATE_BONUS: "creation",
		// ADMIN_GRANT:<metadata.reason ou metadata.source>. Sufixo fora desta lista vira unknown (aparece no painel).
		ADMIN_GRANT: "creation", // concessão manual sem metadata
		"ADMIN_GRANT:other": "creation", // metadata fora de [a-z0-9_]
		"ADMIN_GRANT:donor_bonus": "creation",
		"ADMIN_GRANT:slots_prize": "creation",
		"ADMIN_GRANT:admin_panel_edit": "creation", // ajuste do painel admin; negativo vai para amount_out
		// Câmbio do RavenaBank (lado Zinthos)
		"ADMIN_GRANT:bank_withdraw_zinthos": "exchange_in", // Runas → Zinthos
		"ADMIN_GRANT:bank_deposit_runas": "exchange_out", // Zinthos → Runas
		"ADMIN_GRANT:bank_deposit_rollback_error": "exchange_in", // estorno de venda que falhou
		"ADMIN_GRANT:bank_undo_deposit_zinthos": "exchange_in", // desfazer venda
		"ADMIN_GRANT:bank_undo_withdraw_zinthos": "exchange_out", // desfazer compra
		MARKET_TRADE: "transfer", // comprador paga, vendedor recebe líquido (5% de spread some: líquido negativo)
		MARKET_BUY: "destruction", // investimento no mercado (paga ao sistema)
		MARKET_REFUND: "creation", // estorno de compra/investimento
		HOSTING_FEE: "destruction",
		// Valor da waifu confiscada usado para quitar dívida de taxa: linha positiva que nunca entra no
		// saldo (a sobra creditada de verdade não tem linha). Contado à parte, fora das somas.
		HOSTING_FEE_WAIFU: "non_monetary"
	},
	// Petalitas: o Jardim ainda não tem extrato (ledger.available = false). Sem motivos mapeados.
	petalitas: {},
	// Runas: `${type}:${game}` de bank_transactions (src/services/BankService.js)
	runas: {
		"DEPOSIT:pesca": "creation", // venda de peixe (peixe não é moeda acompanhada)
		"DEPOSIT:waifu": "exchange_in", // Zinthos → Runas
		"DEPOSIT:jardim": "exchange_in", // Petalitas → Runas
		"WITHDRAW:waifu": "exchange_out", // Runas → Zinthos
		"WITHDRAW:jardim": "exchange_out", // Runas → Petalitas
		"STORE_BUY:slots": "destruction", // moedinhas de Slots
		"STORE_BUY:fishing": "destruction", // iscas de pesca
		"BONUS:donor_bonus": "creation", // DonorBonusService
		"BONUS:slots_prize": "creation", // SlotsGame
		"BONUS:bonus": "creation", // creditRunas com recordTransaction sem source
		"ADMIN_ADJUST:admin": "creation", // adminSetUserRunas (diferença com sinal)
		"TRANSFER_IN:market": "transfer",
		"TRANSFER_OUT:market": "transfer",
		// Desfazer (undoTransaction): o motivo leva o tipo original, porque o sentido depende dele.
		"UNDO_DEPOSIT:pesca": "destruction", // devolve o peixe, tira as Runas
		"UNDO_DEPOSIT:waifu": "exchange_out",
		"UNDO_DEPOSIT:jardim": "exchange_out",
		"UNDO_WITHDRAW:waifu": "exchange_in",
		"UNDO_WITHDRAW:jardim": "exchange_in",
		"UNDO_STORE_BUY:slots": "creation", // estorno da loja (Runas voltam com 5% retidos)
		"UNDO_STORE_BUY:fishing": "creation"
	}
};

/** Nome legível de cada motivo mapeado (painel). Motivo sem nome aparece cru. */
const LABELS = {
	zinthos: {
		DAILY_REWARD: "Recompensa diária",
		DIVORCE: "Divórcio (venda de personagem)",
		ROLL_CRYSTAL: "Cristal de roll",
		EVENT_REWARD: "Prêmio de evento",
		WISHLIST_BONUS: "Bônus da lista de desejos",
		SOULMATE_BONUS: "Bônus de alma gêmea",
		ADMIN_GRANT: "Concessão de admin",
		"ADMIN_GRANT:other": "Concessão de admin (outros)",
		"ADMIN_GRANT:donor_bonus": "Bônus de doador",
		"ADMIN_GRANT:slots_prize": "Prêmio dos slots",
		"ADMIN_GRANT:admin_panel_edit": "Ajuste no painel admin",
		"ADMIN_GRANT:bank_withdraw_zinthos": "Câmbio: compra com Runas",
		"ADMIN_GRANT:bank_deposit_runas": "Câmbio: venda por Runas",
		"ADMIN_GRANT:bank_deposit_rollback_error": "Câmbio: estorno de venda com erro",
		"ADMIN_GRANT:bank_undo_deposit_zinthos": "Câmbio: venda desfeita",
		"ADMIN_GRANT:bank_undo_withdraw_zinthos": "Câmbio: compra desfeita",
		MARKET_TRADE: "Mercado: negociação entre jogadores",
		MARKET_BUY: "Mercado: investimento",
		MARKET_REFUND: "Mercado: estorno",
		HOSTING_FEE: "Taxa de hospedagem",
		HOSTING_FEE_WAIFU: "Taxa de hospedagem: waifu confiscada"
	},
	petalitas: {},
	runas: {
		"DEPOSIT:pesca": "Venda de peixe",
		"DEPOSIT:waifu": "Câmbio: venda de Zinthos",
		"DEPOSIT:jardim": "Câmbio: venda de Petalitas",
		"WITHDRAW:waifu": "Câmbio: compra de Zinthos",
		"WITHDRAW:jardim": "Câmbio: compra de Petalitas",
		"STORE_BUY:slots": "Loja: moedas dos slots",
		"STORE_BUY:fishing": "Loja: iscas",
		"BONUS:donor_bonus": "Bônus de doador",
		"BONUS:slots_prize": "Prêmio dos slots",
		"BONUS:bonus": "Bônus",
		"ADMIN_ADJUST:admin": "Ajuste de admin",
		"TRANSFER_IN:market": "Mercado: recebido de jogador",
		"TRANSFER_OUT:market": "Mercado: pago a jogador",
		"UNDO_DEPOSIT:pesca": "Venda de peixe desfeita",
		"UNDO_DEPOSIT:waifu": "Câmbio desfeito: venda de Zinthos",
		"UNDO_DEPOSIT:jardim": "Câmbio desfeito: venda de Petalitas",
		"UNDO_WITHDRAW:waifu": "Câmbio desfeito: compra de Zinthos",
		"UNDO_WITHDRAW:jardim": "Câmbio desfeito: compra de Petalitas",
		"UNDO_STORE_BUY:slots": "Loja desfeita: moedas dos slots",
		"UNDO_STORE_BUY:fishing": "Loja desfeita: iscas"
	}
};

/** Linhas da tabela reason_labels: todo motivo mapeado, com nome e tipo. */
function reasonLabelRows() {
	const rows = [];
	for (const [currency, table] of Object.entries(MAPPING)) {
		for (const [reason, kind] of Object.entries(table)) {
			rows.push({ currency, reason, kind, label: (LABELS[currency] || {})[reason] || reason });
		}
	}
	return rows;
}

/**
 * @param {string} currency zinthos | petalitas | runas
 * @param {string} reason motivo cru
 * @returns {string} kind
 */
function kindFor(currency, reason) {
	const table = MAPPING[currency];
	if (!table || !Object.prototype.hasOwnProperty.call(table, reason)) return "unknown";
	return table[reason];
}

module.exports = {
	MAPPING_VERSION,
	MAPPING,
	LABELS,
	KINDS,
	NON_MONETARY_KINDS,
	kindFor,
	reasonLabelRows
};
