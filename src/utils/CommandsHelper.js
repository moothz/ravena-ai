const fs = require("fs");
const path = require("path");
const Logger = require("./Logger");

let CATEGORY_EMOJIS = {};
try {
	CATEGORY_EMOJIS = require("../functions/MenuOrder").CATEGORY_EMOJIS || {};
} catch (e) {
	CATEGORY_EMOJIS = {};
}

const EXTRA_CATEGORY_EMOJIS = {
	gerenciamento: "⚙️",
	filtros: "🛡️",
	"custom-cmds": "🧩",
	streamers: "📺",
	streams: "📺"
};

class CommandsHelper {
	/**
	 * Retorna a instância singleton
	 * @returns {CommandsHelper}
	 */
	static getInstance() {
		if (!CommandsHelper.instance) {
			CommandsHelper.instance = new CommandsHelper();
		}
		return CommandsHelper.instance;
	}

	/**
	 * Atalho estático para obter metadados de comando
	 * @param {string} commandName
	 * @returns {Object|null}
	 */
	static findCommandMeta(commandName) {
		return CommandsHelper.getInstance().findCommandMeta(commandName);
	}

	constructor() {
		this.logger = new Logger("commands-helper");
		this.helpers = [];
		this.initialized = false;
		this.functionsPath = path.join(__dirname, "../functions");
		this.managementPath = path.join(__dirname, "../commands/Management.js");
		this.loadHelpers();
	}

	/**
	 * Extrai o objeto helper de forma estática e segura a partir do código do arquivo
	 * @param {string} filePath
	 * @returns {Object|null}
	 */
	_extractHelperFromFile(filePath) {
		try {
			if (!fs.existsSync(filePath)) return null;
			const content = fs.readFileSync(filePath, "utf8");
			const match = content.match(/const\s+helper\s*=\s*(\{[\s\S]*?\n\t*\};)/);
			if (match) {
				const fn = new Function("return " + match[1].replace(/;\s*$/, ""));
				return fn();
			}
		} catch (err) {
			this.logger.warn(`Erro ao extrair helper de ${filePath}: ${err.message}`);
		}
		return null;
	}

	/**
	 * Carrega e indexa todos os helpers dos módulos da pasta functions e do Management.js
	 */
	loadHelpers() {
		try {
			this.helpers = [];

			// 1. Carrega todos os arquivos de functions
			if (fs.existsSync(this.functionsPath)) {
				const files = fs.readdirSync(this.functionsPath).filter((f) => f.endsWith(".js"));
				for (const file of files) {
					// Ignora arquivos obsoletos ou temporários se houver
					if (file === "AnythingLLMHelper.js") continue;

					const filePath = path.join(this.functionsPath, file);
					const helperData = this._extractHelperFromFile(filePath);
					if (helperData && typeof helperData === "object") {
						this.helpers.push({
							file,
							source: "function",
							about: helperData.about || "",
							implementation: helperData.implementation || "",
							tags: helperData.tags || "",
							cmds: Array.isArray(helperData.cmds) ? helperData.cmds : []
						});
					}
				}
			}

			// 2. Carrega o Management.js
			if (fs.existsSync(this.managementPath)) {
				const mgmtHelper = this._extractHelperFromFile(this.managementPath);
				if (mgmtHelper && typeof mgmtHelper === "object") {
					this.helpers.push({
						file: "Management.js",
						source: "management",
						about: mgmtHelper.about || "",
						implementation: mgmtHelper.implementation || "",
						tags: mgmtHelper.tags || "",
						cmds: Array.isArray(mgmtHelper.cmds) ? mgmtHelper.cmds : []
					});
				}
			}

			this.initialized = true;
			this.logger.info(`CommandsHelper carregou ${this.helpers.length} módulos de documentação.`);
		} catch (error) {
			this.logger.error("Erro ao carregar helpers:", error);
		}
	}

	/**
	 * Realiza busca inteligente nos comandos e documentação indexada
	 * @param {string} query - Termo de busca
	 * @param {Object} options - Opções (ex: limit)
	 * @returns {string} - Resumo formatado com os comandos e detalhes encontrados
	 */
	search(query = "", options = {}) {
		if (!this.initialized || this.helpers.length === 0) {
			this.loadHelpers();
		}

		const limit = options.limit || 8;
		const cleanQuery = (query || "").trim().toLowerCase();

		if (!cleanQuery) {
			// Retorna visão geral dos módulos disponíveis
			return this._formatOverview();
		}

		const terms = cleanQuery.split(/\s+/).filter(Boolean);
		const results = [];

		for (const h of this.helpers) {
			let score = 0;
			const matchedCmds = [];

			// Avalia correspondência nos comandos do módulo
			for (const cmdObj of h.cmds) {
				let cmdScore = 0;
				const cmdName = (cmdObj.cmd || "").toLowerCase();
				const cmdDesc = (cmdObj.desc || "").toLowerCase();
				const cmdCat = (cmdObj.category || "").toLowerCase();
				const cmdUsage = (cmdObj.usage || []).join(" ").toLowerCase();

				for (const term of terms) {
					if (cmdName === term || cmdName === `!${term}` || cmdName === `!g-${term}`) {
						cmdScore += 10;
					} else if (cmdName.includes(term)) {
						cmdScore += 5;
					}
					if (cmdDesc.includes(term)) cmdScore += 3;
					if (cmdCat.includes(term)) cmdScore += 2;
					if (cmdUsage.includes(term)) cmdScore += 2;
				}

				if (cmdScore > 0) {
					matchedCmds.push({ ...cmdObj, score: cmdScore });
					score += cmdScore;
				}
			}

			// Avalia correspondência em tags, about e implementation do arquivo
			const aboutText = (h.about || "").toLowerCase();
			const implText = (h.implementation || "").toLowerCase();
			const tagsText = (h.tags || "").toLowerCase();

			for (const term of terms) {
				if (tagsText.includes(term)) score += 4;
				if (aboutText.includes(term)) score += 3;
				if (implText.includes(term)) score += 2;
				if (h.file.toLowerCase().includes(term)) score += 4;
			}

			if (score > 0) {
				// Ordena comandos do módulo por relevância
				matchedCmds.sort((a, b) => b.score - a.score);
				results.push({
					score,
					file: h.file,
					about: h.about,
					implementation: h.implementation,
					tags: h.tags,
					cmds: matchedCmds.length > 0 ? matchedCmds : h.cmds
				});
			}
		}

		results.sort((a, b) => b.score - a.score);

		const topResults = results.slice(0, limit);

		if (topResults.length === 0) {
			return `Nenhum comando ou funcionalidade encontrada para o termo: "${query}". Tente buscar por palavras-chave gerais como 'figurinha', 'ia', 'jogos', 'clima', 'gerenciamento' ou 'filtros'.`;
		}

		let formatted = `### 🔍 Resultados de Comandos e Ajuda para "${query}":\n\n`;

		for (const res of topResults) {
			formatted += `📁 **Módulo:** \`${res.file}\`\n`;
			if (res.about) formatted += `ℹ️ **Sobre:** ${res.about}\n`;
			if (res.implementation) formatted += `⚙️ **Implementação:** ${res.implementation}\n`;

			if (res.cmds && res.cmds.length > 0) {
				formatted += `📋 **Comandos:**\n`;
				for (const c of res.cmds.slice(0, 6)) {
					formatted += `  - **${c.cmd}**: ${c.desc || "Sem descrição."}`;
					if (c.usage && c.usage.length > 0) {
						formatted += ` | Exemplo: \`${c.usage[0]}\``;
					}
					formatted += `\n`;
				}
			}
			formatted += `\n`;
		}

		return formatted.trim();
	}

	/**
	 * Lista todas as categorias disponíveis com contagem de comandos e emojis
	 * @returns {string}
	 */
	listCategories() {
		if (!this.initialized || this.helpers.length === 0) {
			this.loadHelpers();
		}

		const categoryCounts = {};
		for (const h of this.helpers) {
			for (const c of h.cmds) {
				const cat = (c.category || "resto").toLowerCase();
				categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
			}
		}

		let text = "📚 **Categorias de Comandos da Ravena:**\n\n";
		for (const [cat, count] of Object.entries(categoryCounts)) {
			const emoji = CATEGORY_EMOJIS[cat] || EXTRA_CATEGORY_EMOJIS[cat] || "📁";
			text += `${emoji} **${cat}** (${count} comando${count > 1 ? "s" : ""})\n`;
		}

		text +=
			"\n💡 *Dica:* Para listar todos os comandos de uma categoria, consulte com `category: '<categoria>'`.\n";
		text +=
			"Para ver detalhes e exemplos de um comando específico, consulte com `command: '<nome_comando>'`.";
		return text;
	}

	/**
	 * Lista todos os comandos pertencentes a uma categoria específica com descrições e exemplos
	 * @param {string} category - Nome da categoria
	 * @returns {string}
	 */
	getCommandsByCategory(category = "") {
		if (!this.initialized || this.helpers.length === 0) {
			this.loadHelpers();
		}

		const cleanCat = (category || "").trim().toLowerCase();
		const catAliases = {
			ai: "ia",
			inteligencia: "ia",
			sticker: "stickers",
			figurinha: "stickers",
			figurinhas: "stickers",
			jogo: "jogos",
			game: "jogos",
			games: "jogos",
			downloader: "downloaders",
			download: "downloaders",
			musica: "downloaders",
			musicas: "downloaders",
			videos: "downloaders",
			video: "downloaders",
			audio: "audio",
			audios: "audio",
			gerencia: "gerenciamento",
			gerência: "gerenciamento",
			admin: "gerenciamento",
			adm: "gerenciamento",
			custom: "custom-cmds",
			customizados: "custom-cmds",
			filtro: "filtros",
			stream: "streams",
			streamer: "streams"
		};

		const targetCat = catAliases[cleanCat] || cleanCat;
		const matchedCmds = [];

		for (const h of this.helpers) {
			for (const c of h.cmds) {
				const cmdCat = (c.category || "resto").toLowerCase();
				if (
					cmdCat === targetCat ||
					(targetCat === "gerenciamento" && (cmdCat === "filtros" || cmdCat === "custom-cmds"))
				) {
					matchedCmds.push({
						...c,
						file: h.file
					});
				}
			}
		}

		if (matchedCmds.length === 0) {
			return `Nenhum comando encontrado para a categoria '${category}'.\n\n${this.listCategories()}`;
		}

		const emoji = CATEGORY_EMOJIS[targetCat] || EXTRA_CATEGORY_EMOJIS[targetCat] || "📋";
		let text = `${emoji} **Comandos na categoria '${targetCat}' (${matchedCmds.length} comandos):**\n\n`;

		for (const c of matchedCmds) {
			text += `• **${c.cmd}**: ${c.desc || "Sem descrição."}`;
			if (c.usage && c.usage.length > 0) {
				text += `\n  - _Exemplo:_ \`${c.usage[0]}\``;
			}
			text += "\n";
		}

		return text.trim();
	}

	/**
	 * Retorna os metadados brutos de um comando (nome, desc, usage, categoria, módulo)
	 * @param {string} commandName
	 * @returns {Object|null}
	 */
	findCommandMeta(commandName = "") {
		if (!this.initialized || this.helpers.length === 0) {
			this.loadHelpers();
		}

		const cleanCmd = (commandName || "").trim().toLowerCase().replace(/^[!/]/, "");
		if (!cleanCmd) return null;

		// 1. Busca exata pelo nome do comando
		for (const h of this.helpers) {
			for (const c of h.cmds) {
				const name = (c.cmd || "").toLowerCase().replace(/^[!/]/, "");
				if (
					name === cleanCmd ||
					name === `g-${cleanCmd}` ||
					(cleanCmd.startsWith("g-") && name === cleanCmd.slice(2))
				) {
					return {
						cmd: c.cmd,
						desc: c.desc || "",
						usage:
							Array.isArray(c.usage) && c.usage.length > 0
								? c.usage
								: [`!${c.cmd.replace(/^[!/]/, "")}`],
						category: c.category || "resto",
						file: h.file,
						about: h.about || "",
						isManagement: h.source === "management" || c.cmd.startsWith("!g-")
					};
				}
			}
		}

		// 2. Busca nos exemplos de usage ou aliases
		for (const h of this.helpers) {
			for (const c of h.cmds) {
				const usages = (c.usage || []).map(
					(u) => u.toLowerCase().replace(/^[!/]/, "").split(/\s+/)[0]
				);
				if (usages.includes(cleanCmd) || usages.includes(`g-${cleanCmd}`)) {
					return {
						cmd: c.cmd,
						desc: c.desc || "",
						usage:
							Array.isArray(c.usage) && c.usage.length > 0
								? c.usage
								: [`!${c.cmd.replace(/^[!/]/, "")}`],
						category: c.category || "resto",
						file: h.file,
						about: h.about || "",
						isManagement: h.source === "management" || c.cmd.startsWith("!g-")
					};
				}
			}
		}

		// 3. Busca nas tags do módulo
		for (const h of this.helpers) {
			const tags = (h.tags || "")
				.toLowerCase()
				.split(",")
				.map((t) => t.trim());
			if (tags.includes(cleanCmd)) {
				if (h.cmds && h.cmds.length > 0) {
					const c = h.cmds[0];
					return {
						cmd: c.cmd,
						desc: c.desc || "",
						usage:
							Array.isArray(c.usage) && c.usage.length > 0
								? c.usage
								: [`!${c.cmd.replace(/^[!/]/, "")}`],
						category: c.category || "resto",
						file: h.file,
						about: h.about || "",
						isManagement: h.source === "management" || c.cmd.startsWith("!g-")
					};
				}
			}
		}

		return null;
	}

	/**
	 * Obtém informações detalhadas, sintaxe e exemplos de uso de um comando específico
	 * @param {string} commandName - Nome do comando (com ou sem prefixo)
	 * @returns {string}
	 */
	getCommandDetails(commandName = "") {
		const meta = this.findCommandMeta(commandName);
		if (meta) {
			let text = `🤖 **Comando:** \`${meta.cmd}\`\n`;
			if (meta.category) {
				const emoji =
					CATEGORY_EMOJIS[meta.category] || EXTRA_CATEGORY_EMOJIS[meta.category] || "📁";
				text += `🏷️ **Categoria:** ${emoji} ${meta.category}\n`;
			}
			text += `📝 **Descrição:** ${meta.desc || "Sem descrição."}\n`;

			if (meta.usage && meta.usage.length > 0) {
				text += `💡 **Como usar (Exemplos):**\n`;
				for (const u of meta.usage) {
					text += `  - \`${u}\`\n`;
				}
			}

			if (meta.about) text += `ℹ️ **Sobre o módulo:** ${meta.about}\n`;
			if (meta.isManagement) {
				text += `🔒 **Acesso:** Exclusivo para administradores do grupo (inicia com \`!g-\`).\n`;
			}

			return text.trim();
		}

		const cleanCmd = (commandName || "").trim().toLowerCase().replace(/^[!/]/, "");
		// Se não encontrou o comando exato, faz uma busca por aproximação
		return `Comando '${commandName}' não encontrado exatamente.\n\n${this.search(cleanCmd, { limit: 5 })}`;
	}

	/**
	 * Ponto de entrada unificado para a ferramenta list_commands
	 * @param {Object|string} options - Parâmetros da tool: { category, command, query }
	 * @returns {string}
	 */
	listCommands(options = {}) {
		if (typeof options === "string") {
			const str = options.trim();
			if (str.startsWith("!") || str.startsWith("/")) {
				return this.getCommandDetails(str);
			}
			return this.search(str);
		}

		const { category, command, query } = options || {};

		if (command && typeof command === "string" && command.trim().length > 0) {
			return this.getCommandDetails(command);
		}

		if (category && typeof category === "string" && category.trim().length > 0) {
			if (
				category.trim().toLowerCase() === "all" ||
				category.trim().toLowerCase() === "todas" ||
				category.trim().toLowerCase() === "todas as categorias"
			) {
				return this.listCategories();
			}
			return this.getCommandsByCategory(category);
		}

		if (query && typeof query === "string" && query.trim().length > 0) {
			const cleanQuery = query.trim().toLowerCase();
			const knownCategories = [
				"ia",
				"geral",
				"jogos",
				"cultura",
				"zoeira",
				"utilidades",
				"stickers",
				"midia",
				"arquivos",
				"busca",
				"grupo",
				"listas",
				"interacao",
				"downloaders",
				"voz",
				"streams",
				"mudae",
				"gerenciamento",
				"filtros",
				"custom-cmds"
			];
			if (knownCategories.includes(cleanQuery)) {
				return this.getCommandsByCategory(cleanQuery);
			}
			if (cleanQuery.startsWith("!") || cleanQuery.startsWith("g-")) {
				return this.getCommandDetails(cleanQuery);
			}
			return this.search(query);
		}

		// Padrão: visão geral das categorias
		return this.listCategories();
	}

	/**
	 * Formata uma visão geral resumida dos módulos e categorias
	 * @private
	 */
	_formatOverview() {
		let text = "📚 **Visão Geral dos Módulos da Ravena:**\n\n";
		const categories = new Set();
		for (const h of this.helpers) {
			for (const c of h.cmds) {
				if (c.category) categories.add(c.category);
			}
		}
		text += `Total de módulos: ${this.helpers.length}\n`;
		text += `Categorias: ${Array.from(categories).join(", ")}\n\n`;
		text += "Use uma busca específica para consultar sintaxes e exemplos de uso de cada comando.";
		return text;
	}
}

module.exports = CommandsHelper;
