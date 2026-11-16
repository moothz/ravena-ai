"use strict";

process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const Database = require("../utils/Database");
const ScheduledEventService = require("../services/ScheduledEventService");

const HOLIDAY_EVENTS = [
	{
		dateStr: "20/11/2026",
		name: "Dia Nacional de Zumbi e da Consciência Negra",
		startTimeStr: "2026-11-20T00:00:00-03:00",
		endTimeStr: "2026-11-20T23:59:00-03:00",
		impact: "Médio-Alto",
		theme: "Resistência e Prosperidade",
		startGrants: {
			"waifu.zinthos": 40000,
			"pesca.iscas": 40,
			"slots.moedas": 25,
			"fazenda.bags": 4
		},
		ongoingBuffs: {
			"fazenda.apodrecer": 60,
			"fazenda.fortuna": 40,
			"pesca.peso": 30,
			"waifu.wish": 25,
			"slots.vitoria": 20
		}
	},
	{
		dateStr: "25/12/2026",
		name: "Natal",
		startTimeStr: "2026-12-25T00:00:00-03:00",
		endTimeStr: "2026-12-25T23:59:00-03:00",
		impact: "Máximo",
		theme: "Mega Evento Natalino - Presentes em Todos os Jogos",
		startGrants: {
			"waifu.zinthos": 100000,
			"waifu.rolls": 10,
			"pesca.iscas": 80,
			"pesca.buff": 5,
			"slots.moedas": 60,
			"fazenda.moedas": 5000,
			"fazenda.bags": 8
		},
		ongoingBuffs: {
			"waifu.raros": 35,
			"waifu.wish": 40,
			"pesca.lendario": 50,
			"pesca.peso": 40,
			"slots.vitoria": 35,
			"slots.moedas": 50,
			"fazenda.fortuna": 60,
			"fazenda.apodrecer": 50
		}
	},
	{
		dateStr: "01/01/2027",
		name: "Confraternização Universal",
		startTimeStr: "2027-01-01T00:00:00-03:00",
		endTimeStr: "2027-01-01T23:59:00-03:00",
		impact: "Muito Alto",
		theme: "Ano Novo - Renovação da Sorte, Desejos e Giros",
		startGrants: {
			"waifu.zinthos": 70000,
			"waifu.rolls": 8,
			"pesca.iscas": 60,
			"slots.moedas": 50,
			"fazenda.bags": 6
		},
		ongoingBuffs: {
			"slots.vitoria": 35,
			"slots.moedas": 40,
			"waifu.wish": 35,
			"waifu.raros": 25,
			"fazenda.fortuna": 50,
			"pesca.lendario": 40
		}
	},
	{
		dateStr: "08/02/2027",
		name: "Carnaval",
		startTimeStr: "2027-02-08T00:00:00-03:00",
		endTimeStr: "2027-02-08T23:59:00-03:00",
		impact: "Alto",
		theme: "Carnaval (Segunda) - Folia, Moedas nos Slots e Waifus",
		startGrants: {
			"slots.moedas": 45,
			"waifu.zinthos": 50000,
			"waifu.rolls": 6,
			"pesca.iscas": 40,
			"fazenda.moedas": 2500
		},
		ongoingBuffs: {
			"slots.vitoria": 30,
			"slots.moedas": 50,
			"waifu.raros": 30,
			"fazenda.fortuna": 35,
			"pesca.peso": 25
		}
	},
	{
		dateStr: "09/02/2027",
		name: "Carnaval",
		startTimeStr: "2027-02-09T00:00:00-03:00",
		endTimeStr: "2027-02-09T23:59:00-03:00",
		impact: "Muito Alto",
		theme: "Carnaval (Terça) - Apogeu da Folia e Caça aos Lendários",
		startGrants: {
			"slots.moedas": 50,
			"waifu.zinthos": 60000,
			"waifu.rolls": 8,
			"pesca.iscas": 50,
			"fazenda.bags": 5
		},
		ongoingBuffs: {
			"slots.vitoria": 35,
			"slots.iscas": 50,
			"waifu.wish": 35,
			"pesca.lendario": 45,
			"fazenda.fortuna": 45
		}
	},
	{
		dateStr: "28/03/2027",
		name: "Páscoa",
		startTimeStr: "2027-03-28T00:00:00-03:00",
		endTimeStr: "2027-03-28T23:59:00-03:00",
		impact: "Alto",
		theme: "Caça aos Ovos / Sementes Raras e Fartura na Pesca",
		startGrants: {
			"fazenda.bags": 8,
			"fazenda.moedas": 3000,
			"waifu.zinthos": 50000,
			"pesca.iscas": 50,
			"pesca.buff": 4,
			"slots.moedas": 30
		},
		ongoingBuffs: {
			"fazenda.fortuna": 50,
			"fazenda.apodrecer": 50,
			"waifu.raros": 30,
			"pesca.lendario": 40,
			"pesca.peso": 30,
			"slots.vitoria": 25
		}
	},
	{
		dateStr: "21/04/2027",
		name: "Tiradentes",
		startTimeStr: "2027-04-21T00:00:00-03:00",
		endTimeStr: "2027-04-21T23:59:00-03:00",
		impact: "Médio",
		theme: "Feriado Cívico Equilibrado",
		startGrants: {
			"waifu.zinthos": 35000,
			"pesca.iscas": 35,
			"slots.moedas": 25,
			"fazenda.bags": 4
		},
		ongoingBuffs: {
			"pesca.peso": 30,
			"slots.vitoria": 25,
			"waifu.raros": 20,
			"waifu.wish": 20,
			"fazenda.fortuna": 35,
			"fazenda.apodrecer": 40
		}
	},
	{
		dateStr: "01/05/2027",
		name: "Dia do Trabalho",
		startTimeStr: "2027-05-01T00:00:00-03:00",
		endTimeStr: "2027-05-01T23:59:00-03:00",
		impact: "Alto",
		theme: "Produtividade Máxima no Campo e no Mar",
		startGrants: {
			"fazenda.moedas": 4000,
			"fazenda.bags": 6,
			"pesca.iscas": 60,
			"waifu.rolls": 7,
			"slots.moedas": 35
		},
		ongoingBuffs: {
			"fazenda.fortuna": 60,
			"pesca.peso": 45,
			"slots.moedas": 40,
			"waifu.wish": 25,
			"fazenda.apodrecer": 50
		}
	},
	{
		dateStr: "07/09/2027",
		name: "Independência do Brasil",
		startTimeStr: "2027-09-07T00:00:00-03:00",
		endTimeStr: "2027-09-07T23:59:00-03:00",
		impact: "Alto",
		theme: "Glória Nacional, Ouro e Conquistas",
		startGrants: {
			"waifu.zinthos": 50000,
			"pesca.iscas": 50,
			"slots.moedas": 35,
			"fazenda.bags": 5,
			"fazenda.moedas": 2500
		},
		ongoingBuffs: {
			"waifu.raros": 25,
			"waifu.wish": 25,
			"pesca.peso": 35,
			"pesca.lendario": 30,
			"slots.vitoria": 30,
			"fazenda.fortuna": 45
		}
	},
	{
		dateStr: "02/11/2027",
		name: "Finados",
		startTimeStr: "2027-11-02T00:00:00-03:00",
		endTimeStr: "2027-11-02T23:59:00-03:00",
		impact: "Médio",
		theme: "Jardim das Sombras e Profundezas Oceânicas",
		startGrants: {
			"fazenda.bags": 7,
			"pesca.buff": 4,
			"pesca.iscas": 40,
			"waifu.zinthos": 30000,
			"slots.moedas": 25
		},
		ongoingBuffs: {
			"fazenda.apodrecer": 70,
			"pesca.lendario": 45,
			"waifu.raros": 20,
			"slots.iscas": 50,
			"fazenda.fortuna": 30
		}
	},
	{
		dateStr: "15/11/2027",
		name: "Proclamação da República",
		startTimeStr: "2027-11-15T00:00:00-03:00",
		endTimeStr: "2027-11-15T23:59:00-03:00",
		impact: "Alto",
		theme: "República e Prosperidade Geral",
		startGrants: {
			"waifu.zinthos": 50000,
			"pesca.iscas": 50,
			"slots.moedas": 30,
			"fazenda.bags": 5
		},
		ongoingBuffs: {
			"pesca.peso": 25,
			"waifu.raros": 15,
			"waifu.wish": 20,
			"slots.vitoria": 25,
			"fazenda.apodrecer": 50,
			"fazenda.fortuna": 50
		}
	},
	{
		dateStr: "20/11/2027",
		name: "Dia Nacional de Zumbi e da Consciência Negra",
		startTimeStr: "2027-11-20T00:00:00-03:00",
		endTimeStr: "2027-11-20T23:59:00-03:00",
		impact: "Médio-Alto",
		theme: "Resistência Cultural e Força",
		startGrants: {
			"waifu.zinthos": 40000,
			"pesca.iscas": 40,
			"slots.moedas": 25,
			"fazenda.bags": 4
		},
		ongoingBuffs: {
			"fazenda.apodrecer": 60,
			"fazenda.fortuna": 40,
			"pesca.peso": 30,
			"waifu.wish": 25,
			"slots.vitoria": 20
		}
	},
	{
		dateStr: "25/12/2027",
		name: "Natal",
		startTimeStr: "2027-12-25T00:00:00-03:00",
		endTimeStr: "2027-12-25T23:59:00-03:00",
		impact: "Máximo",
		theme: "Mega Evento Natalino - Presentes em Todos os Jogos",
		startGrants: {
			"waifu.zinthos": 100000,
			"waifu.rolls": 10,
			"pesca.iscas": 80,
			"pesca.buff": 5,
			"slots.moedas": 60,
			"fazenda.moedas": 5000,
			"fazenda.bags": 8
		},
		ongoingBuffs: {
			"waifu.raros": 35,
			"waifu.wish": 40,
			"pesca.lendario": 50,
			"pesca.peso": 40,
			"slots.vitoria": 35,
			"slots.moedas": 50,
			"fazenda.fortuna": 60,
			"fazenda.apodrecer": 50
		}
	}
];

function buildCustomWhatsAppMessage(payload) {
	const baseMsg = ScheduledEventService.generateWhatsAppMessage(payload);
	return baseMsg.replace(
		"_Aproveite! Digite `!eventos` no grupo para conferir os buffs ativos._",
		"_Aproveite! Digite `!eventos` no grupo ou acesse https://ravena.moothz.com/eventos para conferir os buffs ativos e próximos eventos!_"
	);
}

async function main() {
	const isCommit = process.argv.includes("--commit");
	const isJson = process.argv.includes("--json");
	const database = Database.getInstance();

	console.log("================================================================================");
	console.log(
		`  PROGRAMADOR DE EVENTOS DE FERIADOS - MODO: ${isCommit ? "COMMIT (ESCRITA NO BANCO)" : "DRY-RUN (SIMULAÇÃO)"}`
	);
	console.log("================================================================================\n");

	const existingRows = await database.getScheduledEvents({});
	const existingMap = new Map();
	for (const row of existingRows) {
		const key = `${row.name}::${row.startTime}`;
		existingMap.set(key, row);
	}

	const preparedList = [];
	let errors = 0;

	for (let i = 0; i < HOLIDAY_EVENTS.length; i++) {
		const h = HOLIDAY_EVENTS[i];
		const startTime = Date.parse(h.startTimeStr);
		const endTime = Date.parse(h.endTimeStr);

		const rawPayload = {
			name: h.name,
			startTime,
			endTime,
			startGrants: h.startGrants,
			ongoingBuffs: h.ongoingBuffs
		};

		try {
			const validated = ScheduledEventService.validateEventPayload(rawPayload, {
				requireTimes: true
			});
			validated.message = buildCustomWhatsAppMessage(validated);

			const exists = existingMap.get(`${validated.name}::${validated.startTime}`);

			preparedList.push({
				index: i + 1,
				holidayDate: h.dateStr,
				name: validated.name,
				impact: h.impact,
				theme: h.theme,
				startTime: validated.startTime,
				endTime: validated.endTime,
				startTimeBRT: ScheduledEventService.formatDateTimeBRT(validated.startTime),
				endTimeBRT: ScheduledEventService.formatDateTimeBRT(validated.endTime),
				duration: ScheduledEventService.formatDurationPtBr(validated.endTime - validated.startTime),
				startGrants: validated.startGrants,
				ongoingBuffs: validated.ongoingBuffs,
				message: validated.message,
				alreadyExists: Boolean(exists),
				existingId: exists ? exists.id : null,
				validatedPayload: validated
			});
		} catch (err) {
			console.error(
				`[ERRO DE VALIDAÇÃO] Evento #${i + 1} (${h.name} em ${h.dateStr}): ${err.message}`
			);
			errors++;
		}
	}

	if (errors > 0) {
		console.error(`\nForam encontrados ${errors} erro(s) de validação. Abortando.`);
		process.exit(1);
	}

	if (isJson) {
		console.log(JSON.stringify(preparedList, null, 2));
		process.exit(0);
	}

	// Exibição amigável
	for (const item of preparedList) {
		console.log(
			`[${item.index.toString().padStart(2, "0")}/13] 📅 ${item.holidayDate} - ${item.name}`
		);
		console.log(
			`     ⏰ Horário BRT: ${item.startTimeBRT} até ${item.endTimeBRT} (Duração: ${item.duration})`
		);
		console.log(`     🌟 Impacto: ${item.impact} | Tema: ${item.theme}`);
		console.log(`     🎁 Início: ${JSON.stringify(item.startGrants)}`);
		console.log(`     ⚡ Buffs:  ${JSON.stringify(item.ongoingBuffs)}`);
		if (item.alreadyExists) {
			console.log(`     ⚠️  Status na DB: JÁ EXISTE (ID: #${item.existingId})`);
		} else {
			console.log("     ✅ Status na DB: Pronto para inserir");
		}
		console.log("--------------------------------------------------------------------------------");
	}

	console.log(`\nTotal de eventos analisados: ${preparedList.length}`);
	console.log(
		`Eventos novos prontos para inserção: ${preparedList.filter((e) => !e.alreadyExists).length}`
	);
	console.log(`Eventos já existentes: ${preparedList.filter((e) => e.alreadyExists).length}`);

	if (!isCommit) {
		console.log("\n⚠️  [DRY-RUN CONCLUÍDO]: Nenhuma alteração foi gravada no banco de dados.");
		console.log(
			"Para gravar efetivamente no banco, execute este script com o argumento --commit.\n"
		);
		process.exit(0);
	}

	console.log("\nExecutando inserção real no SQLite core.db...");
	const inserted = [];
	for (const item of preparedList) {
		if (item.alreadyExists) {
			console.log(
				`[SKIP] #${item.index} "${item.name}" (${item.holidayDate}) já existe com ID #${item.existingId}.`
			);
			continue;
		}
		const res = await database.createScheduledEvent(item.validatedPayload);
		console.log(
			`[INSERIDO] #${item.index} "${res.name}" (${item.holidayDate}) criado com ID #${res.id}!`
		);
		inserted.push(res);
	}

	console.log(
		`\n🎉 Finalizado! ${inserted.length} novo(s) evento(s) inserido(s) com sucesso na base de dados SQLite core.db.`
	);
	process.exit(0);
}

main().catch((err) => {
	console.error("Falha fatal:", err);
	process.exit(1);
});
