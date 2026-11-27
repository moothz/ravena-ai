/*
 * Painel administrativo do Jogo do Bicho (/admin#/bicho)
 * Permite configurar variáveis do jogo, horários de sorteio/corte, limites de aposta e
 * exibe em tempo real a tabela de cálculos (probabilidades reais, RTP, margem da banca, teto).
 */

import {
	h,
	api,
	send,
	card,
	dataTable,
	pill,
	toast,
	errorNotice,
	loading,
	field,
	form,
	icon,
	dateFmt,
	fmt
} from "../core.js";

const BASE = "/api/admin/bicho";

export default {
	id: "bicho",
	group: "Jogos",
	title: "Jogo do Bicho",
	desc: "Configurações, limites e matemática do Jogo do Bicho em Runas.",
	summary(p) {
		return { text: "19:00 BRT · Diário", attention: false };
	},

	async render(ctx) {
		const root = h("div", { class: "bicho-area" });
		root.append(loading("Carregando configurações do Jogo do Bicho..."));

		try {
			const res = await api(`${BASE}`);
			const data = res?.data;
			root.replaceChildren(buildContent(data, ctx));
		} catch (err) {
			root.replaceChildren(errorNotice(err, "Falha ao carregar dados do Jogo do Bicho."));
		}

		return root;
	}
};

function buildContent(data, ctx) {
	const config = data?.config || {};
	const stats = data?.stats || {};
	const nextDrawDate = data?.nextDrawDate || "—";
	const lastDraw = data?.lastDraw;

	const container = h("div", { class: "stack" });

	// 1. Resumo Operacional
	const cardsRow = h(
		"div",
		{ class: "grid-cards" },
		card(
			h(
				"div",
				{ class: "stat" },
				h("span", { class: "label", text: "Próxima Extração" }),
				h("strong", {
					class: "val",
					text: `${nextDrawDate} às ${String(config.drawHour).padStart(2, "0")}:${String(config.drawMinute).padStart(2, "0")} BRT`
				}),
				h("span", {
					class: "sub",
					text: `Corte de apostas: ${String(config.cutoffHour).padStart(2, "0")}:${String(config.cutoffMinute).padStart(2, "0")} BRT`
				})
			)
		),
		card(
			h(
				"div",
				{ class: "stat" },
				h("span", { class: "label", text: "Total Apostado (Histórico)" }),
				h("strong", { class: "val", text: `${fmt(stats.totalAmount || 0)} ᚱ` }),
				h("span", { class: "sub", text: `${stats.totalBets || 0} bilhetes jogados` })
			)
		),
		card(
			h(
				"div",
				{ class: "stat" },
				h("span", { class: "label", text: "Total Pago em Prêmios" }),
				h("strong", { class: "val", text: `${fmt(stats.totalPayout || 0)} ᚱ` }),
				h("span", { class: "sub", text: `${stats.totalWins || 0} bilhetes premiados` })
			)
		),
		card(
			h(
				"div",
				{ class: "stat" },
				h("span", { class: "label", text: "Resultado da Banca" }),
				h("strong", {
					class: `val ${(stats.houseProfit || 0) >= 0 ? "good" : "bad"}`,
					text: `${fmt(stats.houseProfit || 0)} ᚱ`
				}),
				h("span", {
					class: "sub",
					text: (stats.houseProfit || 0) >= 0 ? "Lucro retido" : "Prejuízo temporário"
				})
			)
		)
	);
	container.append(cardsRow);

	// 2. Formulário de Configuração & Tabela de Cálculos em Tempo Real
	const configBox = h("div", { class: "bicho-config-layout" });

	// Estado local dos inputs para recalcular tabela em tempo real
	const state = {
		active: config.active !== false,
		minBet: config.minBet || 1000,
		maxBet: config.maxBet || 500000,
		maxPayoutMultiplier: config.maxPayoutMultiplier || 10,
		maxBetsPerDraw: config.maxBetsPerDraw || 10,
		drawHour: config.drawHour ?? 19,
		drawMinute: config.drawMinute ?? 0,
		cutoffHour: config.cutoffHour ?? 18,
		cutoffMinute: config.cutoffMinute ?? 45,
		multGrupo: config.multipliers?.grupo || 18,
		multDezena: config.multipliers?.dezena || 60,
		multCentena: config.multipliers?.centena || 600,
		multMilhar: config.multipliers?.milhar || 4000,
		cercadoDivisor: config.multipliers?.cercadoDivisor || 5
	};

	const tableContainer = h("div", { class: "calc-table-wrap" });

	function renderCalcTable() {
		const maxPayout = state.maxBet * state.maxPayoutMultiplier;

		// Modalidades:
		// - Grupo: chance cabeça = 1/25 (4%), cercado = 5/25 (20%)
		// - Dezena: chance cabeça = 1/100 (1%), cercado = 5/100 (5%)
		// - Centena: chance cabeça = 1/1000 (0.1%), cercado = 5/1000 (0.5%)
		// - Milhar: chance cabeça = 1/10000 (0.01%), cercado = 5/10000 (0.05%)
		const rows = [
			{
				mod: "Grupo (Cabeça)",
				chance: "4.00%",
				mult: `${state.multGrupo}x`,
				rtp: `${(0.04 * state.multGrupo * 100).toFixed(1)}%`,
				margin: `${(100 - 0.04 * state.multGrupo * 100).toFixed(1)}%`,
				payoutTeto: `${fmt(maxPayout)} ᚱ`,
				betLimit: `${fmt(Math.floor(maxPayout / state.multGrupo))} ᚱ`
			},
			{
				mod: `Grupo (Cercado 1-5)`,
				chance: "20.00%",
				mult: `${(state.multGrupo / state.cercadoDivisor).toFixed(1)}x por acerto`,
				rtp: `${(0.04 * state.multGrupo * 100).toFixed(1)}%`,
				margin: `${(100 - 0.04 * state.multGrupo * 100).toFixed(1)}%`,
				payoutTeto: `${fmt(maxPayout)} ᚱ`,
				betLimit: `${fmt(Math.floor(maxPayout / (state.multGrupo / state.cercadoDivisor)))} ᚱ`
			},
			{
				mod: "Dezena (Cabeça)",
				chance: "1.00%",
				mult: `${state.multDezena}x`,
				rtp: `${(0.01 * state.multDezena * 100).toFixed(1)}%`,
				margin: `${(100 - 0.01 * state.multDezena * 100).toFixed(1)}%`,
				payoutTeto: `${fmt(maxPayout)} ᚱ`,
				betLimit: `${fmt(Math.floor(maxPayout / state.multDezena))} ᚱ`
			},
			{
				mod: "Dezena (Cercado 1-5)",
				chance: "5.00%",
				mult: `${(state.multDezena / state.cercadoDivisor).toFixed(1)}x por acerto`,
				rtp: `${(0.01 * state.multDezena * 100).toFixed(1)}%`,
				margin: `${(100 - 0.01 * state.multDezena * 100).toFixed(1)}%`,
				payoutTeto: `${fmt(maxPayout)} ᚱ`,
				betLimit: `${fmt(Math.floor(maxPayout / (state.multDezena / state.cercadoDivisor)))} ᚱ`
			},
			{
				mod: "Centena (Cabeça)",
				chance: "0.10%",
				mult: `${state.multCentena}x`,
				rtp: `${(0.001 * state.multCentena * 100).toFixed(1)}%`,
				margin: `${(100 - 0.001 * state.multCentena * 100).toFixed(1)}%`,
				payoutTeto: `${fmt(maxPayout)} ᚱ`,
				betLimit: `${fmt(Math.floor(maxPayout / state.multCentena))} ᚱ`
			},
			{
				mod: "Centena (Cercado 1-5)",
				chance: "0.50%",
				mult: `${(state.multCentena / state.cercadoDivisor).toFixed(1)}x por acerto`,
				rtp: `${(0.001 * state.multCentena * 100).toFixed(1)}%`,
				margin: `${(100 - 0.001 * state.multCentena * 100).toFixed(1)}%`,
				payoutTeto: `${fmt(maxPayout)} ᚱ`,
				betLimit: `${fmt(Math.floor(maxPayout / (state.multCentena / state.cercadoDivisor)))} ᚱ`
			},
			{
				mod: "Milhar (Cabeça)",
				chance: "0.01%",
				mult: `${state.multMilhar}x`,
				rtp: `${(0.0001 * state.multMilhar * 100).toFixed(1)}%`,
				margin: `${(100 - 0.0001 * state.multMilhar * 100).toFixed(1)}%`,
				payoutTeto: `${fmt(maxPayout)} ᚱ`,
				betLimit: `${fmt(Math.floor(maxPayout / state.multMilhar))} ᚱ`
			},
			{
				mod: "Milhar (Cercado 1-5)",
				chance: "0.05%",
				mult: `${(state.multMilhar / state.cercadoDivisor).toFixed(1)}x por acerto`,
				rtp: `${(0.0001 * state.multMilhar * 100).toFixed(1)}%`,
				margin: `${(100 - 0.0001 * state.multMilhar * 100).toFixed(1)}%`,
				payoutTeto: `${fmt(maxPayout)} ᚱ`,
				betLimit: `${fmt(Math.floor(maxPayout / (state.multMilhar / state.cercadoDivisor)))} ᚱ`
			}
		];

		const table = dataTable({
			columns: [
				{ key: "mod", title: "Modalidade" },
				{ key: "chance", title: "Chance Real" },
				{ key: "mult", title: "Cotação Paga" },
				{ key: "rtp", title: "RTP Esperado" },
				{ key: "margin", title: "Margem da Casa" },
				{ key: "payoutTeto", title: "Teto de Pagamento" },
				{ key: "betLimit", title: "Aposta Efetiva Máxima" }
			],
			rows
		});

		tableContainer.replaceChildren(
			h("h3", { text: "Tabela Matemática & Cálculos em Tempo Real" }),
			h("p", {
				class: "faint",
				text: `Teto calculado atual: 10x maxBet = ${fmt(maxPayout)} ᚱ por bilhete.`
			}),
			table
		);
	}

	renderCalcTable();

	// Inputs
	const inMinBet = h("input", { type: "number", value: state.minBet });
	const inMaxBet = h("input", { type: "number", value: state.maxBet });
	const inMaxPayoutMult = h("input", { type: "number", value: state.maxPayoutMultiplier });
	const inMaxBets = h("input", { type: "number", value: state.maxBetsPerDraw });

	const inDrawHour = h("input", { type: "number", min: 0, max: 23, value: state.drawHour });
	const inDrawMin = h("input", { type: "number", min: 0, max: 59, value: state.drawMinute });
	const inCutoffHour = h("input", { type: "number", min: 0, max: 23, value: state.cutoffHour });
	const inCutoffMin = h("input", { type: "number", min: 0, max: 59, value: state.cutoffMinute });

	const inMultGrupo = h("input", { type: "number", value: state.multGrupo });
	const inMultDezena = h("input", { type: "number", value: state.multDezena });
	const inMultCentena = h("input", { type: "number", value: state.multCentena });
	const inMultMilhar = h("input", { type: "number", value: state.multMilhar });
	const inCercadoDiv = h("input", { type: "number", value: state.cercadoDivisor });

	function onInputSync() {
		state.minBet = Number(inMinBet.value) || 1000;
		state.maxBet = Number(inMaxBet.value) || 500000;
		state.maxPayoutMultiplier = Number(inMaxPayoutMult.value) || 10;
		state.maxBetsPerDraw = Number(inMaxBets.value) || 10;
		state.drawHour = Number(inDrawHour.value) || 19;
		state.drawMinute = Number(inDrawMin.value) || 0;
		state.cutoffHour = Number(inCutoffHour.value) || 18;
		state.cutoffMinute = Number(inCutoffMin.value) || 45;
		state.multGrupo = Number(inMultGrupo.value) || 18;
		state.multDezena = Number(inMultDezena.value) || 60;
		state.multCentena = Number(inMultCentena.value) || 600;
		state.multMilhar = Number(inMultMilhar.value) || 4000;
		state.cercadoDivisor = Number(inCercadoDiv.value) || 5;

		renderCalcTable();
	}

	[
		inMinBet,
		inMaxBet,
		inMaxPayoutMult,
		inMaxBets,
		inDrawHour,
		inDrawMin,
		inCutoffHour,
		inCutoffMin,
		inMultGrupo,
		inMultDezena,
		inMultCentena,
		inMultMilhar,
		inCercadoDiv
	].forEach((el) => {
		el.addEventListener("input", onInputSync);
	});

	const formEl = form({
		title: "Configurações do Jogo",
		fields: [
			field("Aposta Mínima (ᚱ)", inMinBet, "Mínimo permitido por bilhete"),
			field("Aposta Máxima (ᚱ)", inMaxBet, "Máximo permitido por bilhete"),
			field(
				"Multiplicador do Teto",
				inMaxPayoutMult,
				"Ex: 10 = prêmio máximo é 10x a aposta máxima"
			),
			field("Máximo de Apostas / Dia", inMaxBets, "Limite por usuário em cada extração"),
			field("Horário da Extração (Hora BRT)", inDrawHour),
			field("Horário da Extração (Minuto)", inDrawMin),
			field("Horário de Corte (Hora BRT)", inCutoffHour),
			field("Horário de Corte (Minuto)", inCutoffMin),
			field("Cotação: Grupo (Cabeça)", inMultGrupo),
			field("Cotação: Dezena (Cabeça)", inMultDezena),
			field("Cotação: Centena (Cabeça)", inMultCentena),
			field("Cotação: Milhar (Cabeça)", inMultMilhar),
			field(
				"Divisor do Cercado",
				inCercadoDiv,
				"Divisor para cálculo do 1º ao 5º prêmio (padrão 5)"
			)
		],
		submitText: "Salvar Configurações",
		async onSubmit() {
			try {
				await send(`${BASE}/config`, {
					method: "PUT",
					body: {
						minBet: state.minBet,
						maxBet: state.maxBet,
						maxPayoutMultiplier: state.maxPayoutMultiplier,
						maxBetsPerDraw: state.maxBetsPerDraw,
						drawHour: state.drawHour,
						drawMinute: state.drawMinute,
						cutoffHour: state.cutoffHour,
						cutoffMinute: state.cutoffMinute,
						multipliers: {
							grupo: state.multGrupo,
							dezena: state.multDezena,
							centena: state.multCentena,
							milhar: state.multMilhar,
							cercadoDivisor: state.cercadoDivisor
						}
					}
				});
				toast("Configurações do Jogo do Bicho salvas com sucesso!");
			} catch (err) {
				toast(`Erro ao salvar: ${err.message}`, "bad");
			}
		}
	});

	configBox.append(card(formEl), card(tableContainer));
	container.append(configBox);

	// 3. Última Extração Sorteada
	if (lastDraw) {
		const prizesBox = h(
			"div",
			{ class: "last-draw-box stack" },
			h("h3", { text: `Última Extração Realizada (${lastDraw.draw_date})` }),
			h(
				"ul",
				{ class: "prizes-list" },
				lastDraw.prizes.map((p) =>
					h(
						"li",
						null,
						h("strong", { text: p.prize === 1 ? "1º Prêmio (Cabeça): " : `${p.prize}º Prêmio: ` }),
						h("span", {
							text: `${p.number} — Gr. ${String(p.group).padStart(2, "0")} ${p.animalEmoji} ${p.animalName}`
						})
					)
				)
			)
		);
		container.append(card(prizesBox));
	}

	return container;
}
