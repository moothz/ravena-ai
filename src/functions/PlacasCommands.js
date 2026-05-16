const axios = require("axios");

const Logger = require("../utils/Logger");
const Command = require("../models/Command");
const Database = require("../utils/Database");
const ReturnMessage = require("../models/ReturnMessage");
const path = require("path");
require("dotenv").config();

const logger = new Logger("placas-commands");
const database = Database.getInstance();
const DB_NAME = "placas";

// Initialize Database
database.getSQLiteDb(
	DB_NAME,
	`
  CREATE TABLE IF NOT EXISTS placas (
    placa TEXT PRIMARY KEY,
    json_data TEXT
  );
`
);

/**
 * Valida e normaliza uma placa de carro brasileira
 * @param {string} placa - A placa a ser validada/normalizada
 * @returns {Object} - Objeto com a placa normalizada e status de validação
 */
function validarPlaca(placa) {
	if (!placa) {
		return { valid: false, placa: null };
	}

	// Normaliza a placa: remove espaços, traços e converte para minúsculo
	let placaNormalizada = placa.replace(/[^a-zA-Z0-9]/g, "");

	// Substituir 'o' ou 'O' por '0'
	const primeiros3 = placaNormalizada.substring(0, 3);
	const resto = placaNormalizada.substring(3);
	const restoCorrigido = resto.replace(/o/gi, "0");

	placaNormalizada = primeiros3 + restoCorrigido;
	placaNormalizada = placaNormalizada.toLowerCase().trim();

	// Verificar o formato da placa
	const formatoAntigo = /^[a-z]{3}[0-9]{4}$/;
	const formatoNovo = /^[a-z]{3}[0-9][a-j][0-9]{2}$/;

	if (!formatoAntigo.test(placaNormalizada) && !formatoNovo.test(placaNormalizada)) {
		return { valid: false, placa: placaNormalizada };
	}

	return { valid: true, placa: placaNormalizada };
}

/**
 * Busca informações sobre uma placa de carro usando a API de placas
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {Object} message - Dados da mensagem
 * @param {Array} args - Argumentos do comando
 * @param {Object} group - Dados do grupo
 * @returns {Promise<ReturnMessage|Array<ReturnMessage>>} - ReturnMessage ou array de ReturnMessages
 */
async function buscarPlaca(bot, message, args, group) {
	try {
		const chatId = message.group ?? message.author;

		if (args.length === 0) {
			return new ReturnMessage({
				chatId,
				content: "Por favor, forneça uma placa para consultar. Exemplo: !placa ABC1234"
			});
		}

		// Obtém a placa do primeiro argumento
		const placaInput = args.join("");

		// Valida e normaliza a placa
		const { valid, placa } = validarPlaca(placaInput);

		if (!valid) {
			return new ReturnMessage({
				chatId,
				content: `❌ Placa inválida: "${placaInput}". Formato correto: ABC1234 ou ABC1D23`
			});
		}

		logger.info(`Consultando placa: ${placa}`);

		// Verifica se a API está configurada
		if (!process.env.API_PLACAS_COMUM || !process.env.API_PLACAS_PREMIUM) {
			return new ReturnMessage({
				chatId,
				content:
					"⚠️ API de consulta de placas não configurada. Defina API_PLACAS_COMUM e/ou API_PLACAS_PREMIUM no arquivo .env"
			});
		}

		// Configura parâmetros para a apiPlacas
		const isPremium = process.env.API_PLACAS_USAR_PREMIUM ? true : false;

		// Define uma Promise para capturar o resultado da função apiPlacas
		const placaPromise = new Promise((resolve) => {
			// Função de callback para receber o resultado
			const callback = (resultados) => {
				resolve(resultados);
			};

			// Chama a função apiPlacas com callback
			apiPlacas(message, message.author, placa, isPremium, callback);
		});

		// Espera o resultado da consulta
		const resultado = await placaPromise;

		// Verifica se houve resposta
		let retorno;
		if (!resultado || !resultado.msg) {
			retorno = new ReturnMessage({
				chatId,
				content: `❌ Não foi possível consultar a placa "${placa}". Tente novamente mais tarde.`,
				options: {
					quotedMessageId: message.origin.id._serialized,
					goReply: message.origin
				}
			});
		} else {
			retorno = [
				new ReturnMessage({
					chatId,
					content: resultado.msg,
					options: {
						quotedMessageId: message.origin.id._serialized,
						goReply: message.origin
					},
					reaction: resultado.react || "🚘"
				})
			];
		}

		if (placa === "lsj0023") {
			const lsj0023 = path.join(database.databasePath, "media", "lsj0023.mp3");

			const media = await bot.createMedia(lsj0023, "audio/mp3");
			retorno.push(
				new ReturnMessage({
					chatId,
					content: media,
					options: {
						quotedMessageId: message.origin.id._serialized,
						goReply: message.origin
					}
				})
			);
		}
		// Retorna o resultado da consulta
		return retorno;
	} catch (error) {
		logger.error("Erro ao consultar placa:", error);

		const chatId = message.group ?? message.author;
		return new ReturnMessage({
			chatId,
			content: "❌ Erro ao consultar placa. Tente novamente mais tarde.",
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});
	}
}

/**
 * Implementação da função apiPlacas
 * @param {Object} msg - Mensagem original
 * @param {string} numeroAutor - Número do autor
 * @param {string} placa - Placa a ser consultada
 * @param {boolean} premium - Se deve usar API premium
 * @param {Function} callback - Callback para retornar resultado
 */
async function apiPlacas(msg, numeroAutor, placa, premium, callback) {
	const cacheKey = `${placa}_${premium}`;
	const now = new Date().getTime();
	const threeMonths = 3 * 30 * 24 * 60 * 60 * 1000; // 3 months in milliseconds

	try {
		// Check DB cache first
		const row = await database.dbGet(DB_NAME, "SELECT json_data FROM placas WHERE placa = ?", [
			cacheKey
		]);

		if (row) {
			const cached = JSON.parse(row.json_data);
			if (now - cached.timestamp < threeMonths) {
				logger.info(`[apiPlacas_cache] Usando cache para a placa: ${placa}`);
				callback(cached.data);
				return;
			}
		}
	} catch (error) {
		logger.error("Erro ao ler cache de placas:", error);
	}

	// Configura a URL da API baseada no tipo de acesso
	const apiUrl = `https://wdapi2.com.br/consulta/${placa}/${premium ? process.env.API_PLACAS_PREMIUM : process.env.API_PLACAS_COMUM}`;

	// Faz a requisição à API
	axios
		.get(apiUrl)
		.then((res) => res.data)
		.then(async (dados) => {
			logger.info(
				`[apiPlacas_${premium ? "premium" : "comum"}] ${placa} => ${JSON.stringify(dados, null, "\t")}`
			);

			const retorno = { msg: "", react: "🚘" };

			if (dados.message || dados.erro) {
				const mensagem = dados.message ?? dados.erro;
				retorno.msg = `🔎 Resultado para *${placa}*\n\n_${mensagem.trim()}_`;
			} else {
				let fipe = {
					texto_valor: "R$ ??,??",
					codigo_fipe: "?",
					mes_referencia: "?",
					texto_modelo: "?"
				};
				if (dados.fipe?.dados) {
					if (Array.isArray(dados.fipe?.dados)) {
						if (dados.fipe?.dados.length > 0) {
							dados.fipe.dados.sort((a, b) => b.score - a.score);
							fipe = dados.fipe?.dados[0];
						}
					}
				}

				const nomeCarro = (dados.marcamodelo ?? `${dados.MARCA ?? dados.marca ?? ""} ${dados.MODELO ?? dados.modelo ?? ""}`.trim()) || "Desconhecido";
				
				const chassi = dados.extra?.chassi ?? dados.chassi ?? "-";
				const motor = dados.extra?.motor ?? dados.motor ?? "-";
				const renavam = dados.extra?.renavam ?? dados.renavam ? `\n   🪪 *Renavam:* ${dados.extra?.renavam ?? dados.renavam}` : "";
				const passageiros = dados.extra?.quantidade_passageiro ?? dados.quantidade_passageiro ?? "-";
				const cilindradas = dados.extra?.cilindradas ?? dados.cilindradas ?? "-";
				const combustivel = dados.extra?.combustivel ?? dados.combustivel ?? "-";
				const tipoVeiculo = dados.extra?.tipo_veiculo ?? dados.tipo_veiculo ?? "?";
				const tipoDoc = dados.extra?.tipo_doc_prop ?? dados.tipo_doc_prop ?? "-";
				const situacao = dados.situacao ?? dados.extra?.situacao ?? "-";

				const restricoesArr = [
					dados.extra?.restricao_1,
					dados.extra?.restricao_2,
					dados.extra?.restricao_3,
					dados.extra?.restricao_4
				].filter((r) => r && r !== "-");

				const restricoes = restricoesArr.length > 0 
					? restricoesArr.filter(onlyUnique).join(", ") 
					: situacao;

				const ano = parseInt(dados.ano ?? "1970");
				const municipio = dados.extra?.municipio ?? dados.municipio ?? "-";
				const estado = dados.extra?.uf ?? dados.uf ?? "-";

				const origem = dados.origem ?? dados.extra?.origem ?? "-";

				retorno.msg = `🔎 Resultado para *${dados.placa}/${dados.placa_alternativa ?? dados.placa_modelo_antigo ?? "?"}* _(${tipoVeiculo})_:\n\n   🚘 *Modelo:* ${nomeCarro} (${dados.cor})\n   📅 *Ano:* ${dados.ano} / ${dados.anoModelo} (${origem})\n   📍 *Localidade:* ${municipio} - ${estado}\n   🔢 *Chassi/Motor:* ${chassi} / ${motor}\n   🧍 *Passageiros:* ${passageiros}\n   ⚡️ *Performance:* (${cilindradas} cc) | ${combustivel}\n\n   🪙 *FIPE:* ${fipe.texto_valor} (${fipe.texto_modelo} (${fipe.codigo_fipe}), ${fipe.mes_referencia})${renavam}\n   ⚠️ *Obs:* ${tipoDoc}, ${restricoes}`;

				// Verifica se é um Honda Civic Si entre 2006 e 2011
				if (nomeCarro.toLowerCase().includes("honda civic si") && 2006 <= ano && ano <= 2011) {
					logger.info(
						`[apiPlacas_${premium ? "premium" : "comum"}] Carro buscado é um Civic Si, buscando também no SiPt...`
					);

					try {
						// Busca também no SiPt
						const resSiPt = await getSiPtPlaca(dados.placa, `${numeroAutor}`);

						if (resSiPt && resSiPt.length > 0) {
							const respostaSiPt = resSiPt[0].msg.replace("Resultado", "SiPT Resultado");
							logger.info(
								`[apiPlacas_${premium ? "premium" : "comum"}] Resposta Sipt: ${respostaSiPt}`
							);

							if (respostaSiPt.includes(" / ")) {
								// retorno válido
								logger.info(
									`[apiPlacas_${premium ? "premium" : "comum"}] Resposta válida, incluindo!`
								);
								retorno.msg += `\n\n${respostaSiPt}`;
							}
						}
					} catch (siPtError) {
						logger.error(
							`[apiPlacas_${premium ? "premium" : "comum"}] Erro ao buscar no SiPt:`,
							siPtError
						);
					}
				}
			}

			// Update cache
			const cacheEntry = {
				timestamp: now,
				data: retorno,
				fullData: dados
			};

			try {
				await database.dbRun(
					DB_NAME,
					"INSERT OR REPLACE INTO placas (placa, json_data) VALUES (?, ?)",
					[cacheKey, JSON.stringify(cacheEntry)]
				);
			} catch (dbError) {
				logger.error("Erro ao salvar o cache de placas:", dbError);
			}

			// Retorna resultado via callback
			callback(retorno);
		})
		.catch((error) => {
			logger.error(`[apiPlacas_${premium ? "premium" : "comum"}] Erro:`, error);
			callback({
				msg: `❌ Erro ao consultar a placa ${placa}. Tente novamente mais tarde.`,
				react: "⚠️"
			});
		});
}

/**
 * Função auxiliar para filtrar valores únicos em um array
 */
function onlyUnique(value, index, array) {
	return array.indexOf(value) === index;
}

/**
 * Converte HTML para formatação de WhatsApp
 * @param {string} html - String HTML para converter
 * @returns {string} - Texto formatado para WhatsApp
 */
function convertToWhatsAppMarkup(html) {
	if (!html) return "";

	// Convert <br> tags to line breaks
	let result = html.replace(/<br\s*\/?>/gi, "\n");

	// Convert <b> and <strong> tags to asterisks
	result = result.replace(/<(b|strong)>(.*?)<\/\1>/gi, "*$2*");

	// Convert <i> and <em> tags to underscores
	result = result.replace(/<(i|em)>(.*?)<\/\1>/gi, "_$2_");

	// Convert <u> tags to tilde (~)
	result = result.replace(/<u>(.*?)<\/u>/gi, "~$1~");

	// Convert <a> tags to plain text links
	result = result.replace(/<a\s+(?:[^>]*?\s+)?href=(["'])(.*?)\1[^>]*>(.*?)<\/a>/gi, "$3 ($2)");

	// Remove all other HTML tags
	result = result.replace(/<\/?[^>]+(>|$)/g, "");

	return result;
}

/**
 * Consulta uma placa no serviço SiPt
 * @param {string} placa - Placa para consulta
 * @param {string} usuario - ID do usuário que solicitou
 * @returns {Promise<Array>} - Array com objetos de resultado
 */
async function getSiPtPlaca(placa, usuario) {
	const retorno = {
		msg: `⚠️ Ocorreu um erro buscando esta placa.`,
		reply: true,
		react: "🚘"
	};

	// Limita o tamanho da placa
	placa = placa.substring(0, 10);

	// Create JSON payload
	const payload = JSON.stringify({
		placa: placa.toLowerCase(),
		usuario
	});

	// Set request options
	const url = process.env.SIPT_URL || "http://192.168.3.200:1936/getInfoPlaca";
	const headers = {
		"Content-Type": "application/json",
		"x-sipt-token": process.env.SIPT_TOKEN
	};

	try {
		// Send HTTP request with axios
		const response = await axios.post(url, payload, {
			headers,
			timeout: 5000
		});

		const responseData = response.data;
		logger.info(`[siPtPlaca] Resultado busca placa: ${JSON.stringify(responseData)}`);

		if (responseData.status === 1) {
			retorno.msg = convertToWhatsAppMarkup(responseData.resultado);
		}
	} catch (error) {
		logger.warn(`[siPtPlaca] Erro buscando placa: ${error}`);
	}

	return [retorno];
}

/**
 * Consulta uma placa no serviço SiPt
 * @param {WhatsAppBot} bot - Instância do bot
 * @param {Object} message - Dados da mensagem
 * @param {Array} args - Argumentos do comando
 * @param {Object} group - Dados do grupo
 * @returns {Promise<ReturnMessage|Array<ReturnMessage>>} - ReturnMessage ou array de ReturnMessages
 */
async function consultarSiPt(bot, message, args, group) {
	try {
		const chatId = message.group ?? message.author;

		if (args.length === 0) {
			return new ReturnMessage({
				chatId,
				content: "Por favor, forneça uma placa para consultar. Exemplo: !sipt ABC1234"
			});
		}

		// Obtém a placa do primeiro argumento
		const placaInput = args[0];

		// Valida e normaliza a placa
		const { valid, placa } = validarPlaca(placaInput);

		if (!valid) {
			return new ReturnMessage({
				chatId,
				content: `❌ Placa inválida: "${placaInput}". Formato correto: ABC1234 ou ABC1D23`
			});
		}

		logger.info(`Consultando placa no SiPt: ${placa}`);

		// Busca no SiPt usando função nativa
		const resultados = await getSiPtPlaca(placa, message.author);

		if (!resultados || resultados.length === 0 || !resultados[0].msg) {
			return new ReturnMessage({
				chatId,
				content: `❌ Não foi possível consultar a placa "${placa}" no SiPt. Tente novamente mais tarde.`,
				options: {
					quotedMessageId: message.origin.id._serialized,
					goReply: message.origin
				}
			});
		}

		// Retorna o resultado da consulta
		return new ReturnMessage({
			chatId,
			content: resultados[0].msg,
			options: {
				quotedMessageId: resultados[0].reply ? message.origin.id._serialized : undefined,
				goReply: message.origin
			},
			reaction: resultados[0].react || "🚘"
		});
	} catch (error) {
		logger.error("Erro ao consultar placa no SiPt:", error);

		const chatId = message.group ?? message.author;
		return new ReturnMessage({
			chatId,
			content: "❌ Erro ao consultar placa no SiPt. Tente novamente mais tarde.",
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});
	}
}

// Criar array de comandos usando a classe Command
const commands = [
	new Command({
		name: "placa",
		hidden: true,
		description: "Consulta informações sobre uma placa de veículo",
		category: "busca",
		usage: "!placa ABC1234",
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🚘"
		},
		method: buscarPlaca,
		exclusive: process.env.GRUPOS_PLACA_PREMIUM ? process.env.GRUPOS_PLACA_PREMIUM.split(",") : []
	}),
	new Command({
		name: "sipt",
		description: "Consulta informações sobre uma placa no InstaSiPt",
		category: "busca",
		usage: "!sipt ABC1234",
		aliases: ["instasipt"],
		reactions: {
			before: process.env.LOADING_EMOJI ?? "⌛️",
			after: "🚘"
		},
		method: consultarSiPt
	})
];

module.exports = { commands };
