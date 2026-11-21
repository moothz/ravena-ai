/*
 * Banco › Cotações (cotações oficiais do dia e recálculo manual) e Banco › Configurações
 * (números do banco e parâmetros da economia). As duas leem GET /api/games/bank/admin/config.
 * O cartão "Painel da economia" da tela antiga ficou na área Carga.
 */

import {
	h,
	api,
	send,
	card,
	dataTable,
	tiles,
	kv,
	note,
	pill,
	confirmInline,
	toast,
	coinEmblem,
	externalLink,
	grafanaLink,
	grafanaMissing,
	fmt,
	dateFmt,
	errorNotice
} from "../../core.js";
import { money } from "./lib.js";

const dec = (n, places) => {
	const v = Number(n);
	return Number.isFinite(v)
		? v.toLocaleString("pt-BR", { minimumFractionDigits: places, maximumFractionDigits: places })
		: "—";
};

async function loadConfig(root) {
	try {
		const res = await api("/api/games/bank/admin/config");
		if (!res || !res.ok || !res.data) throw new Error((res && res.error) || "resposta sem dados");
		return res.data;
	} catch (err) {
		root.append(errorNotice(err, "os dados do banco"));
		return null;
	}
}

function recalcButton(ctx) {
	const btn = h("button", {
		type: "button",
		class: "btn",
		"data-key": "recalcular",
		text: "Forçar recálculo"
	});
	return confirmInline(btn, {
		question: "Recalcular as cotações do dia agora?",
		confirmLabel: "Recalcular",
		danger: false,
		onConfirm: async () => {
			const r = await send("POST", "/api/games/bank/admin/recalculate-rates");
			if (!r || !r.ok) throw new Error((r && r.error) || "falha ao recalcular");
			toast("Cotações oficiais recalculadas e gravadas", { kind: "ok" });
			ctx.refresh();
		}
	});
}

const gameName = (coin, text) =>
	h(
		"span",
		{ class: "bk-coin-label" },
		coin ? coinEmblem(coin, 15) : h("span", { class: "bk-coin-gap", "aria-hidden": "true" }),
		text
	);

export async function renderCotacoes(root, ctx) {
	const d = await loadConfig(root);
	if (!d) return;
	const r = d.rates || {};
	const rows = [
		{
			game: gameName(null, "Pesca (peixe comum)"),
			rate: `${dec(r.runasPerKgFish, 4)} ᚱ/kg`,
			mult: r.fishMultiplier,
			stock: `${fmt(Math.round((d.fish && d.fish.totalWeight) || 0))} kg`,
			obs: "Mão única: só venda para o banco"
		},
		{
			game: gameName("Zinthos", "Waifuletes (Zinthos)"),
			rate: `${dec(r.runasPerZinthos, 4)} ᚱ/Z`,
			mult: r.waifuMultiplier,
			stock: `${fmt(Math.round((d.waifu && d.waifu.circulatingZinthos) || 0))} Z`,
			obs: `Inflação observada: ${dec((d.waifu && d.waifu.inflationPercent) || 0, 2)}%`
		},
		{
			game: gameName("Petalitas", "Jardim das Sombras (Petalitas)"),
			rate: `${dec(r.runasPerJardimCoin, 4)} ᚱ/Ptl`,
			mult: r.jardimMultiplier,
			stock: `${fmt(Math.round((d.jardim && d.jardim.totalCoins) || 0))} Ptl`,
			obs: "Bidirecional: compra e venda"
		}
	];
	root.append(
		card({
			title: "Cotações oficiais do dia",
			pill: r.date ? pill(r.date.split("-").reverse().join("/")) : null,
			actions: recalcButton(ctx),
			body: dataTable(
				[
					{ label: "Jogo", primary: true, value: (x) => x.game },
					{ label: "1 unidade em Runas", num: true, value: (x) => x.rate },
					{ label: "Multiplicador", num: true, value: (x) => `${dec(x.mult, 3)}x` },
					{ label: "Em circulação", num: true, value: (x) => x.stock },
					{ label: "Regra", value: (x) => x.obs }
				],
				rows,
				{ caption: "Cotações oficiais do dia" }
			)
		}),
		note(
			`Calculadas todo dia às 04:00 (Brasília)${r.updatedAt ? `; última em ${dateFmt(r.updatedAt)}` : ""}. “Forçar recálculo” refaz agora, sem esperar o horário. `,
			externalLink(grafanaLink("economia", { dtab: "moeda" }), "Efeito no Grafana", {
				missing: grafanaMissing()
			})
		)
	);
}

export async function renderConfig(root) {
	const d = await loadConfig(root);
	if (!d) return;
	const rules = d.rules || {};
	const price = d.storePrices || {};
	const limit = d.storeLimits || {};
	root.append(
		tiles([
			{ label: "M1 circulante", value: `${fmt(Math.round(d.totalRunas || 0))} ᚱ` },
			{ label: "Contas cadastradas", value: fmt(d.totalAccounts || 0) },
			{ label: "Spread queimado", value: `${money(d.totalBurnedRunas || 0)} ᚱ` },
			{ label: "Transações registradas", value: fmt(d.totalTransactions || 0) }
		]),
		card({
			title: "Parâmetros da economia e cotas",
			body: [
				kv([
					[
						"Taxa progressiva (spread)",
						h(
							"span",
							null,
							rules.spreadRange || "3% a 10%",
							h("span", {
								class: "bk-sub",
								text: "Taxa = 3% + 7% × (Volume/Cota)^1,5. O valor arrecadado é destruído (dreno deflacionário)."
							})
						)
					],
					[
						"Trava de segurança",
						rules.circuitBreaker || "variação de cada cotação limitada a ±10% por dia contra ontem"
					],
					["Reset diário de cotas e cotações", rules.rotationTime || "04:00 (horário de Brasília)"],
					[
						"Loja: moedinhas (Slots)",
						`${fmt(price.moeda)} ᚱ · limite ${fmt(limit.dailySlotsCoins)}/dia`
					],
					[
						"Loja: iscas (Pesca)",
						`${fmt(price.isca)} ᚱ · limite ${fmt(limit.dailyFishingBaits)}/dia`
					]
				])
			]
		}),
		note(
			"A carga que alimenta o painel da economia no Grafana (rodar, pausar, intervalo, mudanças) fica em ",
			h("a", { href: "#/carga", text: "Carga da economia" }),
			"."
		)
	);
}
