const axios = require("axios");
const cheerio = require("cheerio");
const Database = require("../utils/Database");
const ReturnMessage = require("../models/ReturnMessage");
const Command = require("../models/Command");
const Logger = require("../utils/Logger");

const logger = new Logger("raffles");
const database = Database.getInstance();
const dbName = "raffle_cache";

// Initialize SQLite database
database.getSQLiteDb(
	dbName,
	`
    CREATE TABLE IF NOT EXISTS raffle_cache (
        url TEXT PRIMARY KEY,
        title TEXT,
        price TEXT,
        total_nums INTEGER,
        available_nums INTEGER,
        alert_text TEXT,
        description TEXT,
        image_url TEXT,
        updated_at INTEGER
    );
    `,
	true
);

const memoryCache = new Map();

/**
 * Decode helpers for FmRaffle
 */
function strtr(str, from, to) {
	if (!str) return "";
	const fromArr = from.split("");
	const toArr = to.split("");
	let res = str;
	fromArr.forEach((ch, idx) => {
		res = res.replaceAll(ch, toArr[idx] || "");
	});
	return res;
}

function getInfoDecode(index, decodedStr) {
	const start = 10 * index - 10;
	const end = 10 * index;
	return parseInt(decodedStr.slice(start, end), 10) || 0;
}

function decodeSorteioNumeros(sorteio) {
	if (!sorteio || !sorteio._) return null;
	try {
		const decodedStr = strtr(sorteio._, "POIUYTREWQ", "0123456789");
		return {
			minimoCotas: getInfoDecode(1, decodedStr),
			limiteCotas: getInfoDecode(2, decodedStr),
			digitos: getInfoDecode(3, decodedStr),
			inicial: getInfoDecode(4, decodedStr),
			final: getInfoDecode(5, decodedStr),
			total_numeros: getInfoDecode(6, decodedStr),
			pagos: getInfoDecode(7, decodedStr),
			apenas_disponiveis: getInfoDecode(8, decodedStr),
			porcentagem_livres: getInfoDecode(9, decodedStr) / 100,
			qtd_titulos_inicial: getInfoDecode(10, decodedStr)
		};
	} catch (e) {
		return null;
	}
}

/**
 * Parser for FmRaffle (Next.js __NEXT_DATA__)
 */
function parseFmRaffle(html, $, url, nextDataScript) {
	try {
		const json = JSON.parse(nextDataScript);
		const pageProps = json.props?.pageProps;
		const sorteio = pageProps?.sorteio;

		if (!sorteio) return null;

		// Extract Title
		let title = sorteio.title || sorteio.titulo;
		if (!title && pageProps.pageTitle) {
			title = pageProps.pageTitle.split("::")[0].trim();
		}
		if (!title) {
			title = $('meta[property="og:title"]').attr("content") || $("title").text().trim() || "Ação";
			if (title) title = title.split("|")[0].split("::")[0].trim();
		}

		// Extract Price
		let priceText = "R$ 0,00";
		if (typeof sorteio.valor === "number") {
			priceText = `R$ ${sorteio.valor.toLocaleString("pt-BR", {
				minimumFractionDigits: 2,
				maximumFractionDigits: 2
			})}`;
		} else if (typeof sorteio.valor === "string" && sorteio.valor) {
			priceText = sorteio.valor.startsWith("R$") ? sorteio.valor : `R$ ${sorteio.valor}`;
		}
		priceText = priceText.replace(/\s+/g, " ").trim();

		// Extract Total & Available Numbers
		let totalNums = sorteio.maximo_cotas || 0;
		let availableNums = 0;

		if (sorteio._) {
			const decoded = decodeSorteioNumeros(sorteio);
			if (decoded) {
				if (decoded.total_numeros) totalNums = decoded.total_numeros;
				const pagos = decoded.pagos || 0;
				availableNums = Math.max(0, totalNums - pagos);
			}
		}

		// Extract Alert Text
		let alertText = sorteio.aviso || "";
		if (!alertText && sorteio.status && sorteio.status.mensagem && sorteio.status.id !== 1) {
			alertText = sorteio.status.mensagem;
		}

		// Extract Description
		let description = "";
		if (sorteio.texto) {
			const $desc = cheerio.load(sorteio.texto);
			$desc("br").replaceWith("\n");
			$desc("p").each((i, el) => {
				$desc(el).append("\n\n");
			});
			description = $desc
				.text()
				.replace(/\r\n/g, "\n")
				.replace(/\n{3,}/g, "\n\n")
				.trim();
		}
		if (!description && sorteio.descricao) {
			description = sorteio.descricao;
		}

		// Filter starting from "Data do sorteio:" if present
		const dateMatchFm = description.match(/(Data do sorteio:[\s\S]*)/i);
		if (dateMatchFm) {
			description = dateMatchFm[1].trim();
		}

		if (description.length > 800) {
			description = description.substring(0, 800) + "...";
		}

		// Extract Image URL
		let imageUrl = sorteio.img || (sorteio.galeria && sorteio.galeria[0]) || "";
		if (!imageUrl) {
			imageUrl = $('meta[property="og:image"]').attr("content");
		}
		if (imageUrl) {
			const parsed = new URL(url);
			if (imageUrl.startsWith("/")) {
				imageUrl = parsed.origin + imageUrl;
			}
			imageUrl = imageUrl.replace(/&amp;/g, "&");
		}

		return {
			title,
			price: priceText,
			total_nums: totalNums,
			available_nums: availableNums,
			alert_text: alertText,
			description,
			image_url: imageUrl || "",
			updated_at: Date.now()
		};
	} catch (err) {
		logger.error("Error parsing FmRaffle:", err.message ?? err);
		return null;
	}
}

/**
 * Parser for BoostLab (raffle.php)
 */
async function parseBoostLab(html, $, url) {
	try {
		// Extract Title
		let title = $(".nav-title").first().text().trim();
		if (!title) {
			title = $('meta[property="og:title"]').attr("content");
			if (title) {
				title = title.split("|")[0].trim();
			}
		}
		if (!title) {
			title = $("title").text().trim();
			if (title) {
				title = title.split("|")[0].trim();
			}
		}
		if (!title) {
			title = "Ação";
		}

		// Extract Price
		let priceText = $(".price-head .value").first().text().trim();
		if (!priceText) {
			const scriptText = $("script").text();
			const priceMatch = scriptText.match(/const\s+PRICE\s*=\s*([\d.]+)/);
			if (priceMatch) {
				const priceVal = parseFloat(priceMatch[1]);
				priceText = `R$ ${priceVal.toLocaleString("pt-BR", {
					minimumFractionDigits: 2,
					maximumFractionDigits: 2
				})}`;
			} else {
				priceText = "R$ 0,00";
			}
		}
		priceText = priceText.replace(/\s+/g, " ").trim();

		// Extract Total Nums
		let totalNums = 0;
		const scriptText = $("script").text();
		const totalNumsMatch = scriptText.match(/const\s+TOTAL_NUMS\s*=\s*(\d+)/);
		if (totalNumsMatch) {
			totalNums = parseInt(totalNumsMatch[1], 10);
		} else {
			totalNums = 100000; // fallback
		}

		// Extract alert-warning banner (if any)
		let alertText = "";
		const alertDiv = $(".alert-warning")
			.not(".small, #buyerModal *, #buyerForm *, .modal *")
			.first();
		if (alertDiv.length > 0) {
			alertText = alertDiv.text().replace(/\s+/g, " ").trim();
		}

		// Extract Description
		let description =
			$("#descText").text().trim() ||
			$(".desc-card p").text().trim() ||
			$(".desc-card").text().trim() ||
			"";
		description = description
			.replace(/\r\n/g, "\n")
			.replace(/\n{3,}/g, "\n\n")
			.trim();
		if (description.length > 400) {
			description = description.substring(0, 400) + "...";
		}

		// Extract First Image
		let imageUrl = $("#carouselRifa .carousel-item img").first().attr("src");
		if (!imageUrl) {
			imageUrl = $('meta[property="og:image"]').attr("content");
		}
		if (imageUrl) {
			const parsed = new URL(url);
			if (imageUrl.startsWith("/")) {
				imageUrl = parsed.origin + imageUrl;
			}
			imageUrl = imageUrl.replace(/&amp;/g, "&");
			if (imageUrl.includes("/thumb.php") && imageUrl.includes("w=")) {
				imageUrl = imageUrl.replace(/w=\d+/, "w=800");
			}
		}

		// Now fetch available numbers if rid exists
		let availableCount = 0;
		const parsed = new URL(url);
		const rid = parsed.searchParams.get("rid");
		if (rid) {
			const availableNumsUrl = `${parsed.origin}/available_nums.php?rid=${rid}`;
			logger.info(`Fetching available numbers from: ${availableNumsUrl}`);
			const availResponse = await axios.get(availableNumsUrl, {
				timeout: 10000,
				headers: {
					"User-Agent":
						"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36"
				}
			});

			const availData = availResponse.data;
			if (Array.isArray(availData)) {
				availableCount = availData.length;
			} else if (typeof availData === "string") {
				const trimmed = availData.trim();
				if (trimmed) {
					let cleanText = trimmed;
					if (cleanText.startsWith("[")) cleanText = cleanText.substring(1);
					if (cleanText.endsWith("]")) cleanText = cleanText.substring(0, cleanText.length - 1);
					const nums = cleanText
						.split(",")
						.map((n) => n.trim())
						.filter((n) => n !== "");
					availableCount = nums.length;
				}
			}
		}

		return {
			title,
			price: priceText,
			total_nums: totalNums,
			available_nums: availableCount,
			alert_text: alertText,
			description,
			image_url: imageUrl || "",
			updated_at: Date.now()
		};
	} catch (err) {
		logger.error("Error parsing BoostLab:", err.message ?? err);
		return null;
	}
}

/**
 * Fetches raffle data from URL with caching
 * @param {string} url - The raffle URL
 * @returns {Promise<Object|null>} - The raffle data
 */
async function getRaffleData(url) {
	// Check memory cache first
	const cached = memoryCache.get(url);
	if (cached && Date.now() - cached.timestamp < 15 * 60 * 1000) {
		logger.info(`Raffle cache hit (memory) for ${url}`);
		return cached.data;
	}

	let data = null;
	try {
		logger.info(`Fetching raffle page: ${url}`);
		const response = await axios.get(url, {
			timeout: 10000,
			headers: {
				"User-Agent":
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36"
			}
		});

		const html = response.data;
		const $ = cheerio.load(html);

		// 1. Try FmRaffle parser first (Next.js __NEXT_DATA__)
		const nextDataScript = $("#__NEXT_DATA__").html();
		if (nextDataScript) {
			data = parseFmRaffle(html, $, url, nextDataScript);
		}

		// 2. If not FmRaffle or parsing failed, try BoostLab parser
		if (!data) {
			data = await parseBoostLab(html, $, url);
		}

		if (data) {
			// Save to SQLite
			logger.info(`Saving raffle data to SQLite for ${url}`);
			await database.dbRun(
				dbName,
				`INSERT OR REPLACE INTO raffle_cache (url, title, price, total_nums, available_nums, alert_text, description, image_url, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					url,
					data.title,
					data.price,
					data.total_nums,
					data.available_nums,
					data.alert_text,
					data.description,
					data.image_url,
					data.updated_at
				]
			);

			// Cache in memory
			memoryCache.set(url, {
				data,
				timestamp: Date.now()
			});
		}
	} catch (error) {
		logger.error(`Error fetching raffle online for ${url}:`, error.message ?? error);

		// Fallback to SQLite
		logger.info(`Attempting SQLite fallback for ${url}`);
		const cachedRow = await database.dbGet(dbName, "SELECT * FROM raffle_cache WHERE url = ?", [
			url
		]);
		if (cachedRow) {
			data = {
				title: cachedRow.title,
				price: cachedRow.price,
				total_nums: cachedRow.total_nums,
				available_nums: cachedRow.available_nums,
				alert_text: cachedRow.alert_text,
				description: cachedRow.description,
				image_url: cachedRow.image_url,
				updated_at: cachedRow.updated_at
			};

			// Put in memory cache to avoid constant network retries
			memoryCache.set(url, {
				data,
				timestamp: Date.now()
			});
		}
	}

	return data;
}

/**
 * Handler command for raffle
 */
async function raffleCommand(bot, message, args, group) {
	const chatId = message.group ?? message.author;
	if (args.length === 0) {
		return new ReturnMessage({
			chatId,
			content:
				"⚠️ *Atenção:* Use o comando informando o link da rifa. Exemplo: `!raffle https://www.narigapremios.com/campanha/fiat-palio-71054`",
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});
	}

	let link = args[0].trim();
	if (!/^https?:\/\//i.test(link)) {
		link = "https://" + link;
	}

	try {
		new URL(link);
	} catch (e) {
		return new ReturnMessage({
			chatId,
			content: `🎁 *Ação: _não encontrada_*\n\nNão encontrei dados de uma ação no link ${args[0]}`,
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});
	}

	try {
		// React loading
		message.origin.react(process.env.LOADING_EMOJI ?? "⌛️").catch(() => {});

		const data = await getRaffleData(link);
		if (!data) {
			return new ReturnMessage({
				chatId,
				content: `🎁 *Ação: _não encontrada_*\n\nNão encontrei dados de uma ação no link ${link}`,
				options: {
					quotedMessageId: message.origin.id._serialized,
					goReply: message.origin
				}
			});
		}

		// Calculate values for formatting
		const available = data.available_nums;
		const total = data.total_nums;
		const sold = total - available;
		const percent = total ? Math.round((sold / total) * 100) : 0;

		const totalBlocks = 13;
		const filledBlocks = total ? Math.round((sold / total) * totalBlocks) : 0;
		const emptyBlocks = totalBlocks - filledBlocks;
		const progressBar = "[" + "▰".repeat(filledBlocks) + "▱".repeat(emptyBlocks) + "]";

		// Base message without description
		let textWithoutDesc = `🎁 *Ação: _${data.title}_*\n`;
		textWithoutDesc += `💸 *${data.price}* cada cota\n`;
		textWithoutDesc += `_${percent}% vendido, ${available.toLocaleString("pt-BR")} cotas restantes_\n`;
		textWithoutDesc += `${progressBar}\n\n`;

		if (data.alert_text) {
			textWithoutDesc += `⚠️ ${data.alert_text}\n\n`;
		}
		textWithoutDesc += `🔗 ${link}`;

		// Message with description
		let text = `🎁 *Ação: _${data.title}_*\n`;
		text += `💸 *${data.price}* cada cota\n`;
		text += `_${percent}% vendido, ${available.toLocaleString("pt-BR")} cotas restantes_\n`;
		text += `${progressBar}\n\n`;

		if (data.alert_text) {
			text += `⚠️ ${data.alert_text}\n\n`;
		}

		if (data.description) {
			text += `📝 *Descrição:*\n${data.description}\n\n`;
		}
		text += `🔗 ${link}`;

		// Try sending with image
		if (data.image_url) {
			try {
				const media = await bot.createMediaFromURL(data.image_url);
				media.mimetype = "image/jpeg";
				media.filename = "raffle.jpg";

				// Captions support up to 1024 characters
				if (text.length > 1024 && data.description) {
					return [
						new ReturnMessage({
							chatId,
							content: media,
							options: {
								caption: textWithoutDesc,
								quotedMessageId: message.origin.id._serialized,
								goReply: message.origin
							}
						}),
						new ReturnMessage({
							chatId,
							content: `📝 *Descrição:*\n${data.description}`,
							options: {
								quotedMessageId: message.origin.id._serialized,
								goReply: message.origin
							}
						})
					];
				} else {
					return new ReturnMessage({
						chatId,
						content: media,
						options: {
							caption: text,
							quotedMessageId: message.origin.id._serialized,
							goReply: message.origin
						}
					});
				}
			} catch (imageError) {
				logger.error("Error creating/sending media, falling back to text:", imageError);
			}
		}

		// Text fallback
		return new ReturnMessage({
			chatId,
			content: text,
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});
	} catch (error) {
		logger.error("Error executing raffle command:", error);
		return new ReturnMessage({
			chatId,
			content: `🎁 *Ação: _não encontrada_*\n\nNão encontrei dados de uma ação no link ${link}`,
			options: {
				quotedMessageId: message.origin.id._serialized,
				goReply: message.origin
			}
		});
	}
}

const commands = [
	new Command({
		name: "raffle",
		aliases: ["rifa", "acao"],
		description: "Busca informações de uma rifa ou ação.",
		category: "busca",
		cooldown: 15,
		needsArgs: true,
		minArgs: 1,
		method: raffleCommand,
		reactions: {
			after: "🎁",
			error: "❌"
		}
	})
];

module.exports = { commands };
