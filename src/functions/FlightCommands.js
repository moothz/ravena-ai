const Logger = require("../utils/Logger");
const Command = require("../models/Command");
const ReturnMessage = require("../models/ReturnMessage");
const {
	FlightService,
	findAirport,
	formatAltitude,
	formatSpeed,
	formatHeading,
	formatVerticalRate,
	isFlightOrTailNumber
} = require("../services/FlightService");

const logger = new Logger("flight-commands");

/**
 * Comando !voo <código / matrícula>
 * Rastreia um voo individual com envio de localização GPS se em voo
 */
async function vooCommand(bot, message, args) {
	const chatId = message.group ?? message.author;

	try {
		if (!args.length) {
			return new ReturnMessage({
				chatId,
				content:
					"✈️ *Rastreamento de Vôos*\n\nInforme o código do voo, callsign ou matrícula da aeronave.\n\n*Exemplos:*\n• `!voo G31500` (GOL 1500)\n• `!voo TAM3054` (LATAM 3054)\n• `!voo AZU4001` (Azul 4001)\n• `!voo PR-GGD` (Matrícula ANAC)\n• `!voo AF447` (Voo internacional)",
				options: {
					quotedMessageId: message.origin?.id?._serialized,
					goReply: message.origin
				}
			});
		}

		const query = args.join(" ").trim();
		const flight = await FlightService.getFlightLive(query);

		if (!flight) {
			return new ReturnMessage({
				chatId,
				content: `❌ Nenhum sinal ao vivo encontrado para *"${query.toUpperCase()}"* nos radares ADS-B no momento.\n\n💡 O voo pode já ter pousado, ainda não ter decolado ou estar fora da cobertura de transponder.`,
				options: {
					quotedMessageId: message.origin?.id?._serialized,
					goReply: message.origin
				}
			});
		}

		// Monta sumário em texto
		const lines = [];
		const title = flight.callsign
			? `✈️ *VOO ${flight.callsign}*`
			: `✈️ *AERONAVE ${flight.registration || flight.hexCode}*`;
		lines.push(title);

		if (flight.airline) {
			lines.push(`🏢 *Companhia:* ${flight.airline.name} ${flight.airline.flag || ""}`);
		} else if (flight.registeredOwners) {
			lines.push(`🏢 *Operador:* ${flight.registeredOwners}`);
		}

		lines.push("");

		// Status
		if (flight.inFlight) {
			lines.push("🟢 *Status:* Em Voo");
		} else if (flight.isGround) {
			lines.push("🟡 *Status:* No Solo / Táxi");
		} else {
			lines.push("⚪ *Status:* Sinal Ativo");
		}

		// Rota comercial (se obtida via AviationStack)
		if (flight.route) {
			const dep = flight.route.departure;
			const arr = flight.route.arrival;
			const depName = dep?.airport || dep?.iata || dep?.icao;
			const arrName = arr?.airport || arr?.iata || arr?.icao;

			if (depName || arrName) {
				lines.push("");
				if (depName) {
					const depDetails = [];
					if (dep.iata) depDetails.push(dep.iata);
					if (dep.gate) depDetails.push(`Portão ${dep.gate}`);
					if (dep.delay) depDetails.push(`Atraso +${dep.delay}m`);
					const extraDep = depDetails.length ? ` (${depDetails.join(" • ")})` : "";
					lines.push(`🛫 *Origem:* ${depName}${extraDep}`);
				}
				if (arrName) {
					const arrDetails = [];
					if (arr.iata) arrDetails.push(arr.iata);
					if (arr.terminal) arrDetails.push(`Terminal ${arr.terminal}`);
					if (arr.gate) arrDetails.push(`Portão ${arr.gate}`);
					if (arr.delay) arrDetails.push(`Atraso +${arr.delay}m`);
					const extraArr = arrDetails.length ? ` (${arrDetails.join(" • ")})` : "";
					lines.push(`🛬 *Destino:* ${arrName}${extraArr}`);
				}
			}
		}

		// Informações da aeronave
		const modelStr = flight.fullModel || flight.aircraftType;
		const mfrStr = flight.manufacturer ? `${flight.manufacturer} ` : "";
		lines.push(`🛩️ *Aeronave:* ${mfrStr}${modelStr} (${flight.aircraftType})`);

		const ids = [];
		if (flight.registration) ids.push(`*Matrícula:* ${flight.registration}`);
		if (flight.hexCode) ids.push(`*Mode-S:* ${flight.hexCode}`);
		if (ids.length) lines.push(`🆔 ${ids.join(" • ")}`);

		lines.push("");
		lines.push("📊 *Dinâmica de Voo:*");
		lines.push(`• 📏 *Altitude:* ${formatAltitude(flight.altitude)}`);
		lines.push(`• ⚡ *Velocidade:* ${formatSpeed(flight.speedKnots)}`);
		lines.push(`• 🧭 *Rumo:* ${formatHeading(flight.heading)}`);
		lines.push(`• 📈 *Razão Vertical:* ${formatVerticalRate(flight.verticalRate)}`);

		if (flight.squawk) {
			lines.push(`• 📟 *Transponder Squawk:* ${flight.squawk}`);
		}

		if (flight.squawkAlert) {
			lines.push("");
			lines.push(flight.squawkAlert);
		}

		if (flight.lat !== undefined && flight.lon !== undefined) {
			lines.push("");
			lines.push(`📍 *Posição:* ${flight.lat.toFixed(4)}, ${flight.lon.toFixed(4)}`);
		}

		if (flight.seenPos !== undefined) {
			lines.push(`📡 *Sinal ADS-B:* há ${Math.round(flight.seenPos)}s atrás`);
		}

		// Links de rastreamento web
		lines.push("");
		lines.push("🗺️ *Rastreamento ao Vivo:*");
		if (flight.callsign) {
			lines.push(`• Flightradar24: https://www.flightradar24.com/${flight.callsign}`);
		}
		if (flight.hexCode) {
			lines.push(`• ADS-B Globe: https://globe.adsb.lol/?icao=${flight.hexCode.toLowerCase()}`);
		}

		const textContent = lines.join("\n");

		// Se a aeronave estiver no ar e temos o locationCard, envia array com texto + card de localização
		if (flight.inFlight && flight.locationCard) {
			return [
				new ReturnMessage({
					chatId,
					content: textContent,
					options: {
						quotedMessageId: message.origin?.id?._serialized,
						goReply: message.origin
					}
				}),
				new ReturnMessage({
					chatId,
					content: flight.locationCard
				})
			];
		}

		// Se não está voando (no solo), envia apenas o relatório em texto
		return new ReturnMessage({
			chatId,
			content: textContent,
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin
			}
		});
	} catch (error) {
		logger.error("Erro ao executar comando voo:", error);
		return new ReturnMessage({
			chatId,
			content: "❌ Ocorreu um erro ao consultar o voo. Por favor, tente novamente mais tarde."
		});
	}
}

/**
 * Comando !voos <aeroporto / cidade>
 * Painel de partidas e chegadas de um aeroporto
 */
async function voosCommand(bot, message, args) {
	const chatId = message.group ?? message.author;

	try {
		if (!args.length) {
			return new ReturnMessage({
				chatId,
				content:
					"✈️ *Painel de Voos (Aeroportos)*\n\nInforme o código IATA/ICAO ou a cidade do aeroporto.\n\n*Exemplos:*\n• `!voos CWB` ou `!voos curitiba`\n• `!voos GRU` ou `!voos guarulhos`\n• `!voos GIG` ou `!voos galeao`\n• `!voos BSB` ou `!voos brasilia`\n• `!voos SDU` ou `!voos santos dumont`\n\n💡 _Se você digitar o número de um voo (ex: !voos G31500), buscaremos o voo diretamente!_",
				options: {
					quotedMessageId: message.origin?.id?._serialized,
					goReply: message.origin
				}
			});
		}

		const query = args.join(" ").trim();

		// Se o usuário digitou diretamente um número de voo (ex: G31500, TAM3054, PR-GGD)
		if (isFlightOrTailNumber(query)) {
			return vooCommand(bot, message, args);
		}

		const result = await FlightService.getAirportFlights(query);

		if (!result || result.isDirectFlight) {
			if (result?.isDirectFlight) {
				return vooCommand(bot, message, args);
			}
			return new ReturnMessage({
				chatId,
				content: `❌ Aeroporto ou cidade não encontrada para *"${query}"*.\n\nTente usar a sigla IATA (ex: \`CWB\`, \`GRU\`, \`GIG\`, \`BSB\`, \`SDU\`) ou o nome da cidade.`,
				options: {
					quotedMessageId: message.origin?.id?._serialized,
					goReply: message.origin
				}
			});
		}

		const {
			airport,
			metar,
			liveDepartures,
			liveArrivals,
			groundPlanes,
			scheduledDepartures,
			scheduledArrivals
		} = result;

		const lines = [];
		lines.push(`✈️ *PAINEL DE VOOS — ${airport.name.toUpperCase()}*`);
		lines.push(
			`📍 *${airport.city}, ${airport.state}* • Código: *${airport.iata} / ${airport.icao}*`
		);

		// Clima local (METAR)
		if (metar) {
			const temp = metar.temp !== undefined ? `${metar.temp}°C` : "";
			const wind =
				metar.wdir !== undefined && metar.wspd !== undefined
					? `Vento ${metar.wdir}° ${metar.wspd}kt`
					: "";
			const cat = metar.fltCat ? `[${metar.fltCat}]` : "";
			const metarSummary = [temp, wind, cat].filter(Boolean).join(" • ");
			if (metarSummary) {
				lines.push(`🌤️ *Clima Local:* ${metarSummary}`);
			}
		}

		lines.push("");

		// Partidas ao vivo
		lines.push(`🛫 *PARTIDAS (Em subida / Saindo de ${airport.iata}):*`);
		if (liveDepartures.length > 0) {
			for (const dep of liveDepartures) {
				const flightCode = dep.flight;
				const altStr = formatAltitude(dep.alt);
				lines.push(
					`• *${flightCode}* (${dep.type})${dep.airline ? ` — ${dep.airline}` : ""}\n  ↳ ${altStr} • ${dep.speed} km/h • a ${dep.dist} nm`
				);
			}
		} else {
			lines.push("  _Nenhuma decolagem ativa na TMA no momento._");
		}

		lines.push("");

		// Chegadas ao vivo
		lines.push(`🛬 *CHEGADAS (Aproximando / Pousando em ${airport.iata}):*`);
		if (liveArrivals.length > 0) {
			for (const arr of liveArrivals) {
				const flightCode = arr.flight;
				const altStr = formatAltitude(arr.alt);
				lines.push(
					`• *${flightCode}* (${arr.type})${arr.airline ? ` — ${arr.airline}` : ""}\n  ↳ ${altStr} • ${arr.speed} km/h • a ${arr.dist} nm`
				);
			}
		} else {
			lines.push("  _Nenhuma aeronave em aproximação no momento._");
		}

		// Se houver horários agendados de API externa
		if (scheduledDepartures.length > 0 || scheduledArrivals.length > 0) {
			lines.push("");
			lines.push("📅 *VOOS PROGRAMADOS (Hoje):*");
			if (scheduledDepartures.length > 0) {
				lines.push("🛫 *Próximas Partidas:*");
				for (const s of scheduledDepartures.slice(0, 4)) {
					lines.push(
						`• *${s.flight_iata || s.flight_icao}* ➔ ${s.arr_iata || "Destino"} (${s.dep_time || "Horário"})`
					);
				}
			}
			if (scheduledArrivals.length > 0) {
				lines.push("🛬 *Próximas Chegadas:*");
				for (const s of scheduledArrivals.slice(0, 4)) {
					lines.push(
						`• *${s.flight_iata || s.flight_icao}* de ${s.dep_iata || "Origem"} (${s.arr_time || "Horário"})`
					);
				}
			}
		}

		// Aeronaves no solo
		if (groundPlanes.length > 0) {
			lines.push("");
			lines.push(`🅿️ *No Solo / Pátio:* ${groundPlanes.map((g) => g.flight).join(", ")}`);
		}

		// Rodapé com chamada de ação
		lines.push("");
		lines.push("💡 *Para ver detalhes e localização GPS ao vivo de um voo:*");
		lines.push(
			"Digite: `!voo <código>` (ex: `!voo " +
				(liveDepartures[0]?.flight || liveArrivals[0]?.flight || "G31500") +
				"`)"
		);

		return new ReturnMessage({
			chatId,
			content: lines.join("\n"),
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin
			}
		});
	} catch (error) {
		logger.error("Erro ao executar comando voos:", error);
		return new ReturnMessage({
			chatId,
			content:
				"❌ Ocorreu um erro ao consultar o painel de voos. Por favor, tente novamente mais tarde."
		});
	}
}

/**
 * Comando !prefixo <matrícula> (Alias: !rab)
 * Consulta o Registro Aeronáutico Brasileiro da ANAC oficial + radar ADS-B
 */
async function prefixoCommand(bot, message, args) {
	const chatId = message.group ?? message.author;

	try {
		if (!args.length) {
			return new ReturnMessage({
				chatId,
				content:
					"📋 *Consulta ANAC RAB (Registro Aeronáutico Brasileiro)*\n\nInforme a matrícula ou prefixo da aeronave.\n\n*Exemplos:*\n• `!prefixo PR-XMR` (Boeing 737 MAX da Gol)\n• `!rab PT-MNE` (A320 da LATAM)\n• `!prefixo PS-ABC`\n• `!prefixo PP-XPT`",
				options: {
					quotedMessageId: message.origin?.id?._serialized,
					goReply: message.origin
				}
			});
		}

		const prefixo = args.join("").trim().toUpperCase();
		const rab = await FlightService.getRAB(prefixo);

		if (!rab) {
			return new ReturnMessage({
				chatId,
				content: `❌ Matrícula *"${prefixo}"* não encontrada no Registro Aeronáutico Brasileiro (RAB) da ANAC.`,
				options: {
					quotedMessageId: message.origin?.id?._serialized,
					goReply: message.origin
				}
			});
		}

		const lines = [];
		lines.push(`📋 *REGISTRO AERONÁUTICO BRASILEIRO (ANAC RAB)*`);
		lines.push(`🛩️ *Matrícula:* *${rab.prefixo}*${rab.tipoIcao ? ` (${rab.tipoIcao})` : ""}`);
		lines.push("");

		if (rab.operador) {
			lines.push(`🏢 *Operador:* ${rab.operador}`);
			if (rab.cnpj) lines.push(`📄 *CPF/CNPJ:* ${rab.cnpj}`);
		}

		if (rab.proprietario && rab.proprietario !== rab.operador) {
			lines.push(`👤 *Proprietário:* ${rab.proprietario}`);
		}

		lines.push("");
		lines.push("🛠️ *Dados Técnicos da Aeronave:*");
		if (rab.fabricante) lines.push(`• *Fabricante:* ${rab.fabricante}`);
		if (rab.modelo) lines.push(`• *Modelo:* ${rab.modelo}`);
		if (rab.ano) lines.push(`• *Ano de Fabricação:* ${rab.ano}`);
		if (rab.numSerie) lines.push(`• *Nº de Série:* ${rab.numSerie}`);
		if (rab.mtow) lines.push(`• *Peso Máx. Decolagem (MTOW):* ${rab.mtow}`);
		if (rab.passageiros)
			lines.push(
				`• *Passageiros:* ${rab.passageiros} (Assentos: ${rab.assentos || rab.passageiros})`
			);

		lines.push("");
		lines.push(`🛡️ *Aeronavegabilidade:* ${rab.situacao}`);

		// Se a aeronave estiver voando agora
		let locationCard = null;
		if (rab.live && rab.live.inFlight) {
			lines.push("");
			lines.push("🟢 *STATUS AO VIVO: EM VOO NESTE MOMENTO!* ✈️");
			lines.push(`• *Callsign do Voo:* ${rab.live.callsign || rab.prefixo}`);
			lines.push(`• *Altitude:* ${formatAltitude(rab.live.altitude)}`);
			lines.push(`• *Velocidade:* ${formatSpeed(rab.live.speedKnots)}`);
			lines.push(`• *Rumo:* ${formatHeading(rab.live.heading)}`);
			lines.push(`• *Posição:* ${rab.live.lat?.toFixed(4)}, ${rab.live.lon?.toFixed(4)}`);
			lines.push("📍 _Localização GPS nativa enviada logo abaixo no WhatsApp!_");
			locationCard = rab.live.locationCard;
		} else if (rab.live && rab.live.isGround) {
			lines.push("");
			lines.push("🟡 *Status ao Vivo:* Aeronave detectada no solo / pátio.");
		}

		const textSummary = lines.join("\n");

		if (locationCard) {
			return [
				new ReturnMessage({
					chatId,
					content: textSummary,
					options: {
						quotedMessageId: message.origin?.id?._serialized,
						goReply: message.origin
					}
				}),
				new ReturnMessage({
					chatId,
					content: locationCard
				})
			];
		}

		return new ReturnMessage({
			chatId,
			content: textSummary,
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin
			}
		});
	} catch (error) {
		logger.error("Erro ao executar comando prefixo/rab:", error);
		return new ReturnMessage({
			chatId,
			content:
				"❌ Ocorreu um erro ao consultar o RAB da ANAC. Por favor, tente novamente mais tarde."
		});
	}
}

/**
 * Comando !radar [aeroporto / cidade]
 * Mostra tráfego aéreo na região
 */
async function radarCommand(bot, message, args) {
	const chatId = message.group ?? message.author;

	try {
		const query = args.length ? args.join(" ").trim() : "SBGR";
		const radar = await FlightService.getRadarTraffic(query);

		if (!radar || !radar.airport) {
			return new ReturnMessage({
				chatId,
				content: `❌ Aeroporto ou cidade não encontrada para *"${query}"*. Exemplo: \`!radar SBGR\` ou \`!radar Curitiba\``,
				options: {
					quotedMessageId: message.origin?.id?._serialized,
					goReply: message.origin
				}
			});
		}

		const lines = [];
		lines.push(`📡 *RADAR AÉREO — ${radar.airport.name.toUpperCase()}*`);
		lines.push(
			`📍 *${radar.airport.city}, ${radar.airport.state}* (${radar.airport.iata}/${radar.airport.icao})`
		);
		lines.push(
			`🎯 *Raio:* ${radar.radiusNm} milhas náuticas • Total detectado: *${radar.totalFound} aeronaves*`
		);
		lines.push("");

		if (radar.aircraft.length > 0) {
			for (const ac of radar.aircraft) {
				const altStr = formatAltitude(ac.alt);
				const spdStr = ac.speed ? `${ac.speed} km/h` : "Vel N/D";
				const distStr = ac.dist !== null ? `a ${ac.dist} nm` : "";
				const regStr = ac.reg ? `(${ac.reg})` : "";
				lines.push(`✈️ *${ac.flight}* ${regStr} [${ac.type}]`);
				lines.push(`   ↳ ${altStr} • ${spdStr} • ${formatHeading(ac.track)} • ${distStr}`);
			}
		} else {
			lines.push("_Nenhuma aeronave transmitindo sinal ADS-B neste raio no momento._");
		}

		lines.push("");
		lines.push("💡 _Para rastrear um voo individual: !voo <código>_");

		return new ReturnMessage({
			chatId,
			content: lines.join("\n"),
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin
			}
		});
	} catch (error) {
		logger.error("Erro ao executar comando radar:", error);
		return new ReturnMessage({
			chatId,
			content:
				"❌ Ocorreu um erro ao consultar o radar aéreo. Por favor, tente novamente mais tarde."
		});
	}
}

/**
 * Comando !aeroporto <icao / iata>
 * Informações técnicas do aeroporto com METAR decodificado
 */
async function aeroportoCommand(bot, message, args) {
	const chatId = message.group ?? message.author;

	try {
		if (!args.length) {
			return new ReturnMessage({
				chatId,
				content:
					"🛬 *Consulta de Aeroporto*\n\nInforme o código ICAO ou IATA do aeroporto.\nExemplo: `!aeroporto SBGR` ou `!aeroporto CWB`",
				options: {
					quotedMessageId: message.origin?.id?._serialized,
					goReply: message.origin
				}
			});
		}

		const query = args.join(" ").trim();
		const data = await FlightService.getAirportDetails(query);

		if (!data || !data.airport) {
			return new ReturnMessage({
				chatId,
				content: `❌ Aeroporto não encontrado para *"${query}"*.`,
				options: {
					quotedMessageId: message.origin?.id?._serialized,
					goReply: message.origin
				}
			});
		}

		const { airport, metar, notams } = data;
		const lines = [];
		lines.push(`🏢 *${airport.name.toUpperCase()}*`);
		lines.push(`📍 *Localização:* ${airport.city} - ${airport.state}, ${airport.country}`);
		lines.push(`🏷️ *Códigos:* ICAO: *${airport.icao}* | IATA: *${airport.iata}*`);
		lines.push(`⛰️ *Elevação:* ${airport.elev} metros (${Math.round(airport.elev * 3.28084)} ft)`);
		lines.push(`🌐 *Coordenadas:* ${airport.lat.toFixed(4)}, ${airport.lon.toFixed(4)}`);

		if (metar) {
			lines.push("");
			lines.push("🌤️ *Meteorologia Aeronáutica (METAR):*");
			if (metar.temp !== undefined)
				lines.push(`• *Temperatura:* ${metar.temp}°C (Orvalho: ${metar.dewp}°C)`);
			if (metar.wdir !== undefined && metar.wspd !== undefined) {
				lines.push(`• *Vento:* ${metar.wdir}° com ${metar.wspd} nós`);
			}
			if (metar.altim !== undefined) lines.push(`• *Pressão (QNH):* ${metar.altim} hPa`);
			if (metar.fltCat) lines.push(`• *Regra de Voo:* ${metar.fltCat}`);
			if (metar.rawOb) lines.push(`• *Código Puro:* \`\`\`${metar.rawOb}\`\`\``);
		}

		if (notams && notams.length > 0) {
			lines.push("");
			lines.push("⚠️ *Avisos aos Aeronavegantes (NOTAMs Recentes):*");
			for (const notam of notams) {
				lines.push(`• ${notam}`);
			}
		}

		return new ReturnMessage({
			chatId,
			content: lines.join("\n"),
			options: {
				quotedMessageId: message.origin?.id?._serialized,
				goReply: message.origin
			}
		});
	} catch (error) {
		logger.error("Erro ao executar comando aeroporto:", error);
		return new ReturnMessage({
			chatId,
			content: "❌ Ocorreu um erro ao consultar o aeroporto. Por favor, tente novamente mais tarde."
		});
	}
}

// Definição dos comandos exportados
const commands = [
	new Command({
		name: "voo",
		aliases: ["flight", "rastrear"],
		description:
			"Rastreia um voo em tempo real com mapa e localização (ex: !voo G31500, !voo TAM3054, !voo PR-GGD)",
		usage: "!voo <código_do_voo_ou_matrícula>",
		category: "busca",
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "✈️",
			error: "❌"
		},
		method: vooCommand
	}),
	new Command({
		name: "voos",
		aliases: ["flights", "painelvoos"],
		description:
			"Painel de partidas e chegadas de um aeroporto ou busca de voo (ex: !voos CWB, !voos curitiba, !voos GRU)",
		usage: "!voos <aeroporto_ou_cidade_ou_voo>",
		category: "busca",
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🛫",
			error: "❌"
		},
		method: voosCommand
	}),
	new Command({
		name: "prefixo",
		aliases: ["rab", "matricula", "aeronave"],
		description:
			"Consulta dados oficiais no Registro Aeronáutico Brasileiro (ANAC RAB) e status ao vivo (ex: !prefixo PR-XMR, !rab PT-XYZ)",
		usage: "!prefixo <matrícula>",
		category: "busca",
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "📋",
			error: "❌"
		},
		method: prefixoCommand
	}),
	new Command({
		name: "radar",
		aliases: ["voosradar", "airtraffic"],
		description:
			"Radar de tráfego aéreo ao redor de um aeródromo ou cidade (ex: !radar SBGR, !radar Curitiba)",
		usage: "!radar [aeroporto_ou_cidade]",
		category: "busca",
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "📡",
			error: "❌"
		},
		method: radarCommand
	}),
	new Command({
		name: "aeroporto",
		aliases: ["airport"],
		description:
			"Ficha técnica e condições meteorológicas METAR de um aeroporto (ex: !aeroporto SBGR, !aeroporto CWB)",
		usage: "!aeroporto <código_icao_ou_iata>",
		category: "busca",
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🛬",
			error: "❌"
		},
		method: aeroportoCommand
	})
];

const helper = {
	about: "Rastreamento de vôos ao vivo, painel de aeroportos, consulta ANAC RAB e radar aéreo",
	implementation:
		"Integração com redes ADS-B (adsb.lol e OpenSky), Registro Aeronáutico Brasileiro da ANAC oficial, NOAA Aviation Weather e envio nativo de localização no WhatsApp quando em voo"
};

module.exports = { commands, helper };
