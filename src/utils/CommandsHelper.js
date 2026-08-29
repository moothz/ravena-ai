const fs = require("fs");
const path = require("path");
const Logger = require("./Logger");

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
