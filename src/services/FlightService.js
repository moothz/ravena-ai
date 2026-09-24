const axios = require("axios");
const Logger = require("../utils/Logger");

const logger = new Logger("flight-service");

// Carrega bases locais de aeroportos e companhias aéreas
let airportsData = [];
let airlinesData = [];

try {
	airportsData = require("../utils/aviation/airports.json");
} catch (e) {
	logger.warn("Não foi possível carregar airports.json:", e.message);
}

try {
	airlinesData = require("../utils/aviation/airlines.json");
} catch (e) {
	logger.warn("Não foi possível carregar airlines.json:", e.message);
}

// Cache em memória para evitar 429 e requisições repetidas (TTL de 10s para ADS-B)
const memoryCache = new Map();
function getCache(key) {
	const item = memoryCache.get(key);
	if (!item) return null;
	if (Date.now() > item.expires) {
		memoryCache.delete(key);
		return null;
	}
	return item.data;
}

function setCache(key, data, ttlMs = 10000) {
	memoryCache.set(key, {
		data,
		expires: Date.now() + ttlMs
	});
}

/**
 * Calcula distância entre duas coordenadas em Milhas Náuticas (NM)
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @returns {number}
 */
function getDistanceNm(lat1, lon1, lat2, lon2) {
	const R = 3440.065; // Raio da Terra em milhas náuticas
	const dLat = ((lat2 - lat1) * Math.PI) / 180;
	const dLon = ((lon2 - lon1) * Math.PI) / 180;
	const a =
		Math.sin(dLat / 2) * Math.sin(dLat / 2) +
		Math.cos((lat1 * Math.PI) / 180) *
			Math.cos((lat2 * Math.PI) / 180) *
			Math.sin(dLon / 2) *
			Math.sin(dLon / 2);
	const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
	return R * c;
}

/**
 * Remove acentuação e converte para minúsculo para busca insensível
 * @param {string} str
 * @returns {string}
 */
function normalizeString(str) {
	if (!str || typeof str !== "string") return "";
	return str
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.trim();
}

/**
 * Localiza um aeroporto pelo código IATA, ICAO ou nome da cidade/aeródromo
 * @param {string} query
 * @returns {Object|null}
 */
function findAirport(query) {
	if (!query) return null;
	const clean = query.trim().toUpperCase();
	const norm = normalizeString(query);

	// 1. Match exato por ICAO (ex: SBCT, SBGR)
	const byIcao = airportsData.find((a) => a.icao.toUpperCase() === clean);
	if (byIcao) return byIcao;

	// 2. Match exato por IATA (ex: CWB, GRU)
	const byIata = airportsData.find((a) => a.iata.toUpperCase() === clean);
	if (byIata) return byIata;

	// 3. Match por cidade (ex: "curitiba", "sao paulo")
	const byCity = airportsData.find((a) => normalizeString(a.city) === norm);
	if (byCity) return byCity;

	// 4. Substring em cidade ou nome do aeroporto
	const bySubstring = airportsData.find(
		(a) =>
			normalizeString(a.city).includes(norm) ||
			normalizeString(a.name).includes(norm) ||
			normalizeString(a.state) === norm
	);
	return bySubstring || null;
}

/**
 * Localiza informações de companhia aérea
 * @param {string} code - IATA ou ICAO
 * @returns {Object|null}
 */
function findAirline(code) {
	if (!code) return null;
	const clean = code.trim().toUpperCase();
	return (
		airlinesData.find(
			(a) =>
				(a.icao && a.icao.toUpperCase() === clean) ||
				(a.iata && a.iata.toUpperCase() === clean) ||
				clean.startsWith(a.icao.toUpperCase()) ||
				clean.startsWith(a.iata.toUpperCase())
		) || null
	);
}

/**
 * Converte rumo em graus para ponto cardeal com emoji
 * @param {number} deg
 * @returns {string}
 */
function formatHeading(deg) {
	if (deg === undefined || deg === null || isNaN(deg)) return "N/D";
	const val = ((deg % 360) + 360) % 360;
	if (val >= 337.5 || val < 22.5) return `${Math.round(val)}° (Norte ⬆️)`;
	if (val >= 22.5 && val < 67.5) return `${Math.round(val)}° (Nordeste ↗️)`;
	if (val >= 67.5 && val < 112.5) return `${Math.round(val)}° (Leste ➡️)`;
	if (val >= 112.5 && val < 157.5) return `${Math.round(val)}° (Sudeste ↘️)`;
	if (val >= 157.5 && val < 202.5) return `${Math.round(val)}° (Sul ⬇️)`;
	if (val >= 202.5 && val < 247.5) return `${Math.round(val)}° (Sudoeste ↙️)`;
	if (val >= 247.5 && val < 292.5) return `${Math.round(val)}° (Oeste ⬅️)`;
	return `${Math.round(val)}° (Noroeste ↖️)`;
}

/**
 * Formata razão vertical de subida/descida
 * @param {number} fpm
 * @returns {string}
 */
function formatVerticalRate(fpm) {
	if (fpm === undefined || fpm === null || isNaN(fpm)) return "Nivelado ➡️";
	if (fpm > 150) return `+${Math.round(fpm)} ft/min (Subindo ↗️)`;
	if (fpm < -150) return `${Math.round(fpm)} ft/min (Descendo ↘️)`;
	return "0 ft/min (Nivelado ➡️)";
}

/**
 * Formata altitude em Pés, Nível de Voo (FL) e Metros
 * @param {number|string} alt
 * @returns {string}
 */
function formatAltitude(alt) {
	if (alt === "ground" || alt === 0) return "No Solo (0 ft)";
	if (alt === undefined || alt === null || isNaN(alt)) return "N/D";
	const ft = Number(alt);
	const m = Math.round(ft * 0.3048);
	const fl = Math.round(ft / 100);
	return `FL${fl} • ${ft.toLocaleString("pt-BR")} ft (${m.toLocaleString("pt-BR")} m)`;
}

/**
 * Formata velocidade de solo em nós e km/h
 * @param {number} knots
 * @returns {string}
 */
function formatSpeed(knots) {
	if (knots === undefined || knots === null || isNaN(knots)) return "N/D";
	const kts = Number(knots);
	const kmh = Math.round(kts * 1.852);
	return `${Math.round(kts)} kts (${kmh} km/h)`;
}

/**
 * Verifica alertas para códigos de transponder squawk
 * @param {string|number} squawk
 * @returns {string|null}
 */
function getSquawkAlert(squawk) {
	if (!squawk) return null;
	const s = String(squawk).trim();
	if (s === "7700") return "🚨 *ALERTA DE EMERGÊNCIA GERAL DECLARADA (Squawk 7700)*";
	if (s === "7600") return "📻 *ALERTA DE FALHA DE COMUNICAÇÃO / RÁDIO - NORDO (Squawk 7600)*";
	if (s === "7500") return "⚠️ *ALERTA DE INTERFERÊNCIA ILÍCITA / SEQUESTRO (Squawk 7500)*";
	return null;
}

/**
 * Normaliza e gera variantes de callsign/código de voo
 * @param {string} input
 * @returns {string[]}
 */
function getCallsignCandidates(input) {
	if (!input) return [];
	const clean = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
	const candidates = [clean];

	// Mapeamentos comuns IATA <-> ICAO
	const iataToIcao = {
		G3: "GLO",
		LA: "TAM",
		JJ: "TAM",
		AD: "AZU",
		"2Z": "VOE",
		TP: "TAP",
		AA: "AAL",
		DL: "DAL",
		UA: "UAL",
		AF: "AFR",
		LH: "DLH",
		IB: "IBE",
		UX: "AEA",
		AR: "ARG",
		AV: "AVA",
		CM: "CMP",
		KL: "KLM",
		BA: "BAW"
	};

	const icaoToIata = {
		GLO: "G3",
		TAM: "LA",
		AZU: "AD",
		VOE: "2Z",
		TAP: "TP",
		AAL: "AA",
		DAL: "DL",
		UAL: "UA",
		AFR: "AF",
		DLH: "LH",
		IBE: "IB",
		AEA: "UX",
		ARG: "AR",
		AVA: "AV",
		CMP: "CM",
		KLM: "KL",
		BAW: "BA"
	};

	for (const [iata, icao] of Object.entries(iataToIcao)) {
		if (clean.startsWith(iata) && clean.length > iata.length) {
			const num = clean.substring(iata.length);
			candidates.push(`${icao}${num}`);
		}
	}

	for (const [icao, iata] of Object.entries(icaoToIata)) {
		if (clean.startsWith(icao) && clean.length > icao.length) {
			const num = clean.substring(icao.length);
			candidates.push(`${iata}${num}`);
		}
	}

	return Array.from(new Set(candidates));
}

/**
 * Verifica se um texto parece ser código de voo ou matrícula de aeronave
 * @param {string} str
 * @returns {boolean}
 */
function isFlightOrTailNumber(str) {
	if (!str) return false;
	const clean = str.toUpperCase().replace(/[^A-Z0-9]/g, "");
	// Padrão de matrícula brasileira: PR-GGD, PS-ABC, PP-XPT, PT-MZL, PU-XYZ
	if (/^(P[RSPTU])[A-Z0-9]{3}$/.test(clean)) return true;
	// Padrão de voo comercial: 2 ou 3 letras seguidas de 1 a 4 números
	if (/^[A-Z0-9]{2,3}[0-9]{1,4}[A-Z]?$/.test(clean)) {
		if (/^SB[A-Z]{2}$/.test(clean)) return false;
		return true;
	}
	return false;
}

class FlightService {
	/**
	 * Consulta aeronaves ao redor de um ponto geográfico com fallback para OpenSky
	 * @param {number} lat
	 * @param {number} lon
	 * @param {number} radiusNm
	 * @returns {Promise<Array>}
	 */
	static async queryPointTraffic(lat, lon, radiusNm = 50) {
		const cacheKey = `point:${lat.toFixed(3)}:${lon.toFixed(3)}:${radiusNm}`;
		const cached = getCache(cacheKey);
		if (cached) return cached;

		// 1. Tenta adsb.lol
		try {
			const res = await axios.get(`https://api.adsb.lol/v2/point/${lat}/${lon}/${radiusNm}`, {
				timeout: 5000,
				headers: { "User-Agent": "Mozilla/5.0 (RavenaBot Aviation Tracker)" }
			});
			if (res.data?.ac && Array.isArray(res.data.ac)) {
				const list = res.data.ac.map((ac) => ({
					hex: ac.hex,
					flight: (ac.flight || ac.r || "").trim(),
					r: ac.r || "",
					t: ac.t || "N/D",
					alt_baro: ac.alt_baro,
					alt_geom: ac.alt_geom,
					gs: ac.gs,
					track: ac.track,
					geom_rate: ac.geom_rate,
					lat: ac.lat,
					lon: ac.lon,
					dst: ac.dst ? Math.round(ac.dst) : Math.round(getDistanceNm(lat, lon, ac.lat, ac.lon)),
					squawk: ac.squawk,
					on_ground: ac.on_ground || ac.alt_baro === "ground"
				}));
				setCache(cacheKey, list, 10000);
				return list;
			}
		} catch (err) {
			logger.warn(`adsb.lol point indisponível (${err.message}), tentando OpenSky fallback...`);
		}

		// 2. Fallback: OpenSky Network Bounding Box
		try {
			const dLat = radiusNm / 60;
			const dLon = radiusNm / (60 * Math.cos((lat * Math.PI) / 180));
			const lamin = lat - dLat;
			const lamax = lat + dLat;
			const lomin = lon - dLon;
			const lomax = lon + dLon;

			const openSkyUrl = `https://opensky-network.org/api/states/all?lamin=${lamin}&lomin=${lomin}&lamax=${lamax}&lomax=${lomax}`;
			const res = await axios.get(openSkyUrl, {
				timeout: 6000,
				headers: { "User-Agent": "Mozilla/5.0" }
			});

			if (res.data?.states && Array.isArray(res.data.states)) {
				const list = res.data.states
					.map((s) => {
						const planeLat = s[6];
						const planeLon = s[5];
						const dist =
							planeLat !== null && planeLon !== null
								? Math.round(getDistanceNm(lat, lon, planeLat, planeLon))
								: 999;

						return {
							hex: s[0],
							flight: (s[1] || "").trim(),
							r: "",
							t: "Aeronave",
							alt_baro: s[7] !== null ? Math.round(s[7] * 3.28084) : null,
							alt_geom: s[13] !== null ? Math.round(s[13] * 3.28084) : null,
							gs: s[9] !== null ? Math.round(s[9] * 1.94384) : null,
							track: s[10],
							geom_rate: s[11] !== null ? Math.round(s[11] * 196.85) : null,
							lat: planeLat,
							lon: planeLon,
							dst: dist,
							squawk: s[14],
							on_ground: s[8]
						};
					})
					.filter((p) => p.dst <= radiusNm);

				setCache(cacheKey, list, 10000);
				return list;
			}
		} catch (openSkyErr) {
			logger.error("OpenSky fallback também falhou:", openSkyErr.message);
		}

		return [];
	}

	/**
	 * Busca dados ao vivo de um voo ou aeronave
	 * @param {string} identifier - Callsign, matrícula ou código hex Mode-S
	 * @returns {Promise<Object|null>}
	 */
	static async getFlightLive(identifier) {
		if (!identifier) return null;
		const candidates = getCallsignCandidates(identifier);
		const rawClean = identifier.toUpperCase().replace(/[^A-Z0-9]/g, "");

		const cacheKey = `flight:${rawClean}`;
		const cached = getCache(cacheKey);
		if (cached) return cached;

		let liveAircraft = null;
		let foundBy = "";

		// 1. Tenta buscar no adsb.lol por callsign
		for (const call of candidates) {
			try {
				const res = await axios.get(`https://api.adsb.lol/v2/callsign/${call}`, {
					timeout: 4000,
					headers: { "User-Agent": "Mozilla/5.0 (RavenaBot Aviation Tracker)" }
				});
				if (res.data?.ac && res.data.ac.length > 0) {
					liveAircraft = res.data.ac[0];
					foundBy = `callsign:${call}`;
					break;
				}
			} catch (err) {
				// tenta próximo
			}
		}

		// 2. Se não achou por callsign, tenta buscar por matrícula
		if (!liveAircraft) {
			try {
				const res = await axios.get(`https://api.adsb.lol/v2/registration/${rawClean}`, {
					timeout: 4000,
					headers: { "User-Agent": "Mozilla/5.0 (RavenaBot Aviation Tracker)" }
				});
				if (res.data?.ac && res.data.ac.length > 0) {
					liveAircraft = res.data.ac[0];
					foundBy = `reg:${rawClean}`;
				}
			} catch (err) {
				// ignora
			}
		}

		// 3. Se for código hex Mode-S (6 caracteres)
		if (!liveAircraft && /^[0-9A-F]{6}$/i.test(rawClean)) {
			try {
				const res = await axios.get(`https://api.adsb.lol/v2/hex/${rawClean.toLowerCase()}`, {
					timeout: 4000,
					headers: { "User-Agent": "Mozilla/5.0 (RavenaBot Aviation Tracker)" }
				});
				if (res.data?.ac && res.data.ac.length > 0) {
					liveAircraft = res.data.ac[0];
					foundBy = `hex:${rawClean}`;
				}
			} catch (err) {
				// ignora
			}
		}

		// 4. Fallback: OpenSky Network
		if (!liveAircraft && /^[0-9A-F]{6}$/i.test(rawClean)) {
			try {
				const res = await axios.get(
					`https://opensky-network.org/api/states/all?icao24=${rawClean.toLowerCase()}`,
					{
						timeout: 5000,
						headers: { "User-Agent": "Mozilla/5.0" }
					}
				);
				if (res.data?.states && res.data.states.length > 0) {
					const s = res.data.states[0];
					liveAircraft = {
						hex: s[0],
						flight: (s[1] || "").trim(),
						lon: s[5],
						lat: s[6],
						alt_baro: s[7] ? Math.round(s[7] * 3.28084) : null,
						on_ground: s[8],
						gs: s[9] ? s[9] * 1.94384 : null,
						track: s[10],
						geom_rate: s[11] ? Math.round(s[11] * 196.85) : null,
						squawk: s[14]
					};
					foundBy = `opensky:${rawClean}`;
				}
			} catch (err) {
				// ignora
			}
		}

		// 5. Coleta metadados adicionais via hexdb.io
		let hexMetadata = null;
		const hexToQuery = liveAircraft?.hex || (/^[0-9A-F]{6}$/i.test(rawClean) ? rawClean : null);
		if (hexToQuery) {
			try {
				const resHex = await axios.get(
					`https://hexdb.io/api/v1/aircraft/${hexToQuery.toLowerCase()}`,
					{ timeout: 4000 }
				);
				if (resHex.data && resHex.data.Registration) {
					hexMetadata = resHex.data;
				}
			} catch (err) {
				// ignora
			}
		}

		if (!liveAircraft && !hexMetadata) {
			return null;
		}

		const callsign = (liveAircraft?.flight || candidates[0] || "").trim();
		const registration =
			liveAircraft?.r ||
			hexMetadata?.Registration ||
			(/^(P[RSPTU])[A-Z0-9]{3}$/.test(rawClean) ? rawClean : "");
		const hexCode = (liveAircraft?.hex || hexMetadata?.ModeS || rawClean).toUpperCase();
		const aircraftType = liveAircraft?.t || hexMetadata?.ICAOTypeCode || "N/D";
		const manufacturer = hexMetadata?.Manufacturer || "";
		const fullModel = hexMetadata?.Type || aircraftType;
		const registeredOwners = hexMetadata?.RegisteredOwners || "";

		const airline =
			findAirline(callsign) ||
			findAirline(hexMetadata?.OperatorFlagCode) ||
			findAirline(registeredOwners) ||
			null;

		const isGround =
			liveAircraft?.on_ground === true ||
			liveAircraft?.alt_baro === "ground" ||
			(Number(liveAircraft?.alt_baro) < 300 && Number(liveAircraft?.gs) < 50);

		const inFlight = Boolean(
			liveAircraft &&
			liveAircraft.lat !== undefined &&
			liveAircraft.lon !== undefined &&
			liveAircraft.lat !== 0 &&
			liveAircraft.lon !== 0 &&
			!isGround
		);

		let locationCard = null;
		if (inFlight) {
			const altFl =
				typeof liveAircraft.alt_baro === "number"
					? `FL${Math.round(liveAircraft.alt_baro / 100)}`
					: "Altitude N/D";
			const spdKmh =
				typeof liveAircraft.gs === "number"
					? `${Math.round(liveAircraft.gs * 1.852)} km/h`
					: "Vel N/D";
			const trk =
				typeof liveAircraft.track === "number" ? `Rumo ${Math.round(liveAircraft.track)}°` : "";

			const cardName = `✈️ ${callsign || registration} (${aircraftType})${airline ? ` - ${airline.name}` : ""}`;
			const cardAddress = [altFl, spdKmh, trk].filter(Boolean).join(" | ");

			locationCard = {
				isLocation: true,
				latitude: Number(liveAircraft.lat),
				longitude: Number(liveAircraft.lon),
				name: cardName,
				address: cardAddress
			};
		}

		const result = {
			callsign,
			registration,
			hexCode,
			aircraftType,
			manufacturer,
			fullModel,
			registeredOwners,
			airline,
			inFlight,
			isGround,
			lat: liveAircraft?.lat,
			lon: liveAircraft?.lon,
			altitude: liveAircraft?.alt_baro,
			altitudeGeom: liveAircraft?.alt_geom,
			speedKnots: liveAircraft?.gs,
			heading: liveAircraft?.track,
			verticalRate: liveAircraft?.geom_rate,
			squawk: liveAircraft?.squawk,
			squawkAlert: getSquawkAlert(liveAircraft?.squawk),
			foundBy,
			locationCard
		};

		// Enriquecimento opcional com AviationStack (Origem/Destino e Horários Comerciais)
		if (process.env.AVIATIONSTACK_API_KEY && callsign && /^[A-Z0-9]{2,3}[0-9]+/.test(callsign)) {
			try {
				result.route = await FlightService.getFlightScheduleAviationStack(callsign);
			} catch (err) {
				// Falha silenciosa para não impactar o rastreamento principal
			}
		}

		setCache(cacheKey, result, 10000);
		return result;
	}

	/**
	 * Consulta dados de rota comercial e horários via AviationStack (com cache agressivo)
	 * @param {string} flightCode - Ex: G31500, GLO1500, LA3054
	 * @returns {Promise<Object|null>}
	 */
	static async getFlightScheduleAviationStack(flightCode) {
		const apiKey = process.env.AVIATIONSTACK_API_KEY;
		if (!apiKey) return null;

		const clean = flightCode.toUpperCase().replace(/[^A-Z0-9]/g, "");
		const cacheKey = `avstack:${clean}`;
		const cached = getCache(cacheKey);
		if (cached !== null && cached !== undefined) return cached;

		try {
			const isIcao = /^[A-Z]{3}[0-9]+/.test(clean);
			const param = isIcao ? `flight_icao=${clean}` : `flight_iata=${clean}`;
			const url = `http://api.aviationstack.com/v1/flights?access_key=${apiKey}&${param}&limit=1`;

			const res = await axios.get(url, { timeout: 4000 });
			const item = res.data?.data?.[0];
			if (item) {
				const dep = item.departure || {};
				const arr = item.arrival || {};
				const route = {
					status: item.flight_status,
					departure: {
						airport: dep.airport,
						iata: dep.iata,
						icao: dep.icao,
						terminal: dep.terminal,
						gate: dep.gate,
						delay: dep.delay,
						scheduled: dep.scheduled,
						estimated: dep.estimated,
						actual: dep.actual
					},
					arrival: {
						airport: arr.airport,
						iata: arr.iata,
						icao: arr.icao,
						terminal: arr.terminal,
						gate: arr.gate,
						delay: arr.delay,
						scheduled: arr.scheduled,
						estimated: arr.estimated,
						actual: arr.actual
					}
				};
				// Guarda no cache por 2 horas para economizar a cota de 100 req/mês
				setCache(cacheKey, route, 2 * 60 * 60 * 1000);
				return route;
			}
			// Não encontrado: cache de 30 minutos para não queimar cota repetindo a busca
			setCache(cacheKey, null, 30 * 60 * 1000);
			return null;
		} catch (err) {
			logger.warn(`AviationStack indisponível ou limite atingido (${err.message})`);
			// Se der erro de quota/rede, cache de 1 hora para parar de tentar
			setCache(cacheKey, null, 60 * 60 * 1000);
			return null;
		}
	}

	/**
	 * Consulta oficial do Registro Aeronáutico Brasileiro (ANAC RAB)
	 * @param {string} prefixo - Ex: PR-GGD, PS-ABC, PT-MNE
	 * @returns {Promise<Object|null>}
	 */
	static async getRAB(prefixo) {
		if (!prefixo) return null;
		const clean = prefixo.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();

		const [rabResult, liveFlight] = await Promise.allSettled([
			(async () => {
				const url = `https://aeronaves.anac.gov.br/aeronaves/cons_rab_resposta.asp?textMarca=${clean}`;
				const res = await axios.get(url, {
					headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) RavenaBot" },
					responseType: "arraybuffer",
					timeout: 8000
				});
				const html = new TextDecoder("latin1").decode(res.data);
				const data = {};
				const regex = /<th[^>]*>([\s\S]*?)<\/th>[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>/gi;
				let match;
				while ((match = regex.exec(html)) !== null) {
					const key = match[1]
						.replace(/<[^>]+>/g, "")
						.replace(/[\r\n\t]+/g, " ")
						.replace(/:/g, "")
						.trim();
					const val = match[2]
						.replace(/<[^>]+>/g, "")
						.replace(/[\r\n\t]+/g, " ")
						.trim();
					if (key && val) {
						data[key] = val;
					}
				}
				return data;
			})(),
			FlightService.getFlightLive(clean)
		]);

		const rabData = rabResult.status === "fulfilled" ? rabResult.value : {};
		const live = liveFlight.status === "fulfilled" ? liveFlight.value : null;

		if (Object.keys(rabData).length === 0 && !live) {
			return null;
		}

		const proprietario = rabData["Proprietário"] || rabData.Proprietario || "";
		const operador = rabData["Operador"] || rabData.Operador || "";
		const cnpj = rabData["CPF/CNPJ"] || "";
		const fabricante = rabData["Fabricante"] || live?.manufacturer || "";
		const modelo = rabData["Modelo"] || live?.fullModel || "";
		const ano = rabData["Ano de Fabricação"] || "";
		const numSerie = rabData["Número de Série"] || "";
		const tipoIcao = rabData["Tipo ICAO"] || live?.aircraftType || "";
		const mtow = rabData["Peso Máximo de Decolagem"] || "";
		const passageiros = rabData["Número de Passageiros"] || "";
		const assentos = rabData["Número de Assentos"] || "";
		const situacao =
			rabData["Situação de Aeronavegabilidade"] || rabData["Data de Validade do CVA"] || "N/D";

		return {
			prefixo: prefixo.toUpperCase(),
			proprietario,
			operador,
			cnpj,
			fabricante,
			modelo,
			ano,
			numSerie,
			tipoIcao,
			mtow,
			passageiros,
			assentos,
			situacao,
			live,
			rawRab: rabData
		};
	}

	/**
	 * Obtém lista de chegadas e partidas de um aeroporto com busca flexível
	 * @param {string} query - Código ICAO/IATA ou nome de cidade
	 * @returns {Promise<Object|null>}
	 */
	static async getAirportFlights(query) {
		if (!query) return null;

		if (isFlightOrTailNumber(query)) {
			return {
				isDirectFlight: true,
				flightQuery: query
			};
		}

		const airport = findAirport(query);
		if (!airport) return null;

		let metarData = null;
		try {
			const metarRes = await axios.get(
				`https://aviationweather.gov/api/data/metar?ids=${airport.icao}&format=json`,
				{ timeout: 4000 }
			);
			if (metarRes.data && metarRes.data.length > 0) {
				metarData = metarRes.data[0];
			}
		} catch (e) {
			// ignora
		}

		const aircraftList = await FlightService.queryPointTraffic(airport.lat, airport.lon, 50);

		const liveDepartures = [];
		const liveArrivals = [];
		const groundPlanes = [];

		for (const ac of aircraftList) {
			const flight = ac.flight;
			if (!flight) continue;

			const alt = ac.alt_baro;
			const rate = ac.geom_rate || 0;
			const dist = ac.dst;
			const speed = ac.gs ? Math.round(ac.gs * 1.852) : 0;
			const type = ac.t || "Aeronave";
			const reg = ac.r || "";
			const airline = findAirline(flight);

			const item = {
				flight,
				reg,
				type,
				alt,
				rate,
				speed,
				dist,
				airline: airline ? airline.name : "",
				flag: airline ? airline.flag : "✈️"
			};

			if (ac.on_ground === true || alt === "ground") {
				groundPlanes.push(item);
			} else if (dist <= 35 && alt <= 15000 && rate > 100) {
				liveDepartures.push(item);
			} else if (dist <= 50 && alt <= 18000 && rate <= 100) {
				liveArrivals.push(item);
			} else {
				liveArrivals.push(item);
			}
		}

		let scheduledDepartures = [];
		let scheduledArrivals = [];

		if (process.env.AIRLABS_API_KEY && airport.iata) {
			try {
				const [depRes, arrRes] = await Promise.allSettled([
					axios.get(
						`https://airlabs.co/api/v9/schedules?dep_iata=${airport.iata}&api_key=${process.env.AIRLABS_API_KEY}`,
						{ timeout: 5000 }
					),
					axios.get(
						`https://airlabs.co/api/v9/schedules?arr_iata=${airport.iata}&api_key=${process.env.AIRLABS_API_KEY}`,
						{ timeout: 5000 }
					)
				]);

				if (depRes.status === "fulfilled" && depRes.value.data?.response) {
					scheduledDepartures = depRes.value.data.response.slice(0, 10);
				}
				if (arrRes.status === "fulfilled" && arrRes.value.data?.response) {
					scheduledArrivals = arrRes.value.data.response.slice(0, 10);
				}
			} catch (e) {
				logger.warn("Erro ao consultar AirLabs schedules:", e.message);
			}
		}

		return {
			airport,
			metar: metarData,
			liveDepartures: liveDepartures.slice(0, 10),
			liveArrivals: liveArrivals.slice(0, 10),
			groundPlanes: groundPlanes.slice(0, 5),
			scheduledDepartures,
			scheduledArrivals
		};
	}

	/**
	 * Retorna radar de tráfego aéreo ao redor de um aeródromo ou cidade
	 * @param {string} query
	 * @param {number} radiusNm
	 * @returns {Promise<Object|null>}
	 */
	static async getRadarTraffic(query, radiusNm = 60) {
		const airport = findAirport(query);
		if (!airport) return null;

		const aircraftList = await FlightService.queryPointTraffic(airport.lat, airport.lon, radiusNm);

		const list = aircraftList
			.map((ac) => ({
				flight: ac.flight,
				reg: ac.r || "",
				type: ac.t || "N/D",
				alt: ac.alt_baro,
				speed: ac.gs ? Math.round(ac.gs * 1.852) : null,
				track: ac.track,
				dist: ac.dst,
				squawk: ac.squawk,
				lat: ac.lat,
				lon: ac.lon
			}))
			.filter((a) => a.flight)
			.sort((a, b) => (a.dist ?? 999) - (b.dist ?? 999));

		return {
			airport,
			radiusNm,
			aircraft: list.slice(0, 15),
			totalFound: list.length
		};
	}

	/**
	 * Retorna dados detalhados de um aeroporto com METAR decodificado e NOTAMs
	 * @param {string} query - Código ICAO ou IATA
	 * @returns {Promise<Object|null>}
	 */
	static async getAirportDetails(query) {
		const airport = findAirport(query);
		if (!airport) return null;

		let metar = null;
		try {
			const res = await axios.get(
				`https://aviationweather.gov/api/data/metar?ids=${airport.icao}&format=json`,
				{ timeout: 5000 }
			);
			if (res.data && res.data.length > 0) metar = res.data[0];
		} catch (e) {
			// ignora
		}

		let notams = [];
		const sunTimes = null;
		if (process.env.AISWEB_API_KEY && process.env.AISWEB_API_PASS) {
			try {
				const notamRes = await axios.get(
					`https://aisweb.decea.mil.br/api/?apiKey=${process.env.AISWEB_API_KEY}&apiPass=${process.env.AISWEB_API_PASS}&area=notam&icaoCode=${airport.icao}`,
					{ timeout: 5000 }
				);
				if (notamRes.data && typeof notamRes.data === "string") {
					const notamMatches = notamRes.data.match(/<item>[\s\S]*?<\/item>/gi) || [];
					notams = notamMatches.slice(0, 3).map((item) => {
						const cleanText = item
							.replace(/<[^>]+>/g, " ")
							.replace(/[\r\n\t]+/g, " ")
							.trim();
						return cleanText.substring(0, 200);
					});
				}
			} catch (e) {
				// ignora erro do AISWEB
			}
		}

		return {
			airport,
			metar,
			notams,
			sunTimes
		};
	}
}

module.exports = {
	FlightService,
	findAirport,
	findAirline,
	formatAltitude,
	formatSpeed,
	formatHeading,
	formatVerticalRate,
	isFlightOrTailNumber
};
