const fs = require("fs");
const path = require("path");
const Logger = require("./Logger");
const { getPublicBotContacts, getSupportContact } = require("./RavenaContacts");

let CATEGORY_EMOJIS = {};
try {
	CATEGORY_EMOJIS = require("../functions/MenuOrder").CATEGORY_EMOJIS || {};
} catch (e) {
	CATEGORY_EMOJIS = {};
}

/**
 * Comandos restritos ao dono do bot (SuperAdmin) ou administrativos internos.
 * NUNCA podem ser indexados no catálogo enviado à IA nem exibidos para usuários.
 */
const RESTRICTED_CMD_REGEX = /^[!/]?(sa-|admin-)/i;

/**
 * Indica se uma entrada de comando do helper deve ser ocultada do catálogo
 * (prefixos !sa-/!admin- em qualquer alias, ou flags hidden/superadmin)
 * @param {Object} cmdObj
 * @returns {boolean}
 */
function isRestrictedHelperCmd(cmdObj) {
	if (!cmdObj || typeof cmdObj !== "object") return true;
	if (
		cmdObj.hidden === true ||
		cmdObj.superAdminOnly === true ||
		cmdObj.superadminOnly === true ||
		cmdObj.superAdmin === true ||
		cmdObj.superadmin === true ||
		String(cmdObj.category || "").toLowerCase() === "superadmin"
	) {
		return true;
	}
	const names = String(cmdObj.cmd || "")
		.split("/")
		.map((n) => n.trim())
		.filter(Boolean);
	const usages = Array.isArray(cmdObj.usage) ? cmdObj.usage : [];
	return [...names, ...usages.map((u) => String(u).trim())].some((n) =>
		RESTRICTED_CMD_REGEX.test(n)
	);
}

/**
 * Indica se o termo consultado é um comando restrito (ex: "sa-joinGrupo", "!admin-roubar")
 * @param {string} name
 * @returns {boolean}
 */
function isRestrictedCommandName(name) {
	return RESTRICTED_CMD_REGEX.test(String(name || "").trim());
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
	 * @param {Object} [options] - Ver findCommandMeta (ex: { exactOnly: true })
	 * @returns {Object|null}
	 */
	static findCommandMeta(commandName, options = {}) {
		return CommandsHelper.getInstance().findCommandMeta(commandName, options);
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
	 * Remove do catálogo comandos restritos (!sa-, !admin-, hidden/superadmin)
	 * @param {Array} cmds
	 * @param {string} file
	 * @returns {Array}
	 * @private
	 */
	_filterPublicCmds(cmds, file) {
		if (!Array.isArray(cmds)) return [];
		return cmds.filter((c) => {
			if (isRestrictedHelperCmd(c)) {
				this.logger.debug(`Comando restrito omitido do catálogo (${file}): ${c?.cmd}`);
				return false;
			}
			return true;
		});
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
							cmds: this._filterPublicCmds(helperData.cmds, file)
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
						cmds: this._filterPublicCmds(mgmtHelper.cmds, "Management.js")
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
	 * Monta o objeto de metadados de um comando do catálogo
	 * @param {Object} h - Módulo (helper) indexado
	 * @param {Object} c - Entrada de comando do helper
	 * @returns {Object}
	 * @private
	 */
	_buildCommandMeta(h, c) {
		return {
			cmd: c.cmd,
			desc: c.desc || "",
			usage:
				Array.isArray(c.usage) && c.usage.length > 0 ? c.usage : [`!${c.cmd.replace(/^[!/]/, "")}`],
			category: c.category || "resto",
			file: h.file,
			about: h.about || "",
			implementation: h.implementation || "",
			tags: h.tags || "",
			relatedCmds: (h.cmds || []).filter((other) => other.cmd !== c.cmd).map((other) => other.cmd),
			isManagement: h.source === "management" || c.cmd.startsWith("!g-")
		};
	}

	/**
	 * Retorna os metadados brutos de um comando (nome, desc, usage, categoria, módulo)
	 *
	 * Ordem de busca:
	 * 1. Nome exato do comando (com/sem prefixo `!`, `/` e `g-`)
	 * 2. Primeira palavra dos exemplos de uso (aliases)
	 * 3. (somente sem exactOnly) Tag do módulo -> primeiro comando do módulo.
	 *    É um palpite grosseiro (ex: tag "pesca" pode cair em !banco); quem precisa
	 *    do comando certo deve usar `{ exactOnly: true }` e recorrer ao search().
	 *
	 * @param {string} commandName
	 * @param {Object} [options]
	 * @param {boolean} [options.exactOnly=false] - Desliga o fallback por tags (passo 3)
	 * @returns {Object|null}
	 */
	findCommandMeta(commandName = "", options = {}) {
		if (!this.initialized || this.helpers.length === 0) {
			this.loadHelpers();
		}

		const { exactOnly = false } = options || {};
		const cleanCmd = (commandName || "").trim().toLowerCase().replace(/^[!/]/, "");
		if (!cleanCmd || isRestrictedCommandName(cleanCmd)) return null;

		// 1. Busca exata pelo nome do comando
		for (const h of this.helpers) {
			for (const c of h.cmds) {
				const name = (c.cmd || "").toLowerCase().replace(/^[!/]/, "");
				if (
					name === cleanCmd ||
					name === `g-${cleanCmd}` ||
					(cleanCmd.startsWith("g-") && name === cleanCmd.slice(2))
				) {
					return this._buildCommandMeta(h, c);
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
					return this._buildCommandMeta(h, c);
				}
			}
		}

		if (exactOnly) return null;

		// 3. Busca nas tags do módulo (palpite: primeiro comando do módulo)
		for (const h of this.helpers) {
			const tags = (h.tags || "")
				.toLowerCase()
				.split(",")
				.map((t) => t.trim());
			if (tags.includes(cleanCmd) && h.cmds && h.cmds.length > 0) {
				return this._buildCommandMeta(h, h.cmds[0]);
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
		if (isRestrictedCommandName(String(commandName || "").trim())) {
			// Não ecoa o nome nem busca: comandos restritos não existem para usuários/IA
			return "Comando não encontrado no catálogo público da Ravena.";
		}

		// Apenas correspondência exata: tags de módulo levariam ao comando errado
		// (ex: "pesca" -> !banco); nesse caso a busca abaixo lista os candidatos certos.
		const meta = this.findCommandMeta(commandName, { exactOnly: true });
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
			if (meta.implementation) text += `⚙️ **Mecânicas/Implementação:** ${meta.implementation}\n`;
			if (meta.isManagement) {
				text += `🔒 **Acesso:** Exclusivo para administradores do grupo (inicia com \`!g-\`). No painel web: !g-painel.\n`;
			}
			if (meta.relatedCmds && meta.relatedCmds.length > 0) {
				text += `🔗 **Outros comandos deste módulo:** ${meta.relatedCmds.map((r) => `\`${r}\``).join(", ")}\n`;
			}

			return text.trim();
		}

		const cleanCmd = (commandName || "").trim().toLowerCase().replace(/^[!/]/, "");
		// Se não encontrou o comando exato, faz uma busca por aproximação
		return `Comando '${commandName}' não encontrado exatamente.\n\n${this.search(cleanCmd, { limit: 5 })}`;
	}

	/**
	 * Retorna um índice completo e compacto de todos os comandos organizados por categoria
	 * @returns {string}
	 */
	getCommandsIndex() {
		if (!this.initialized || this.helpers.length === 0) {
			this.loadHelpers();
		}

		const catMap = {};
		for (const h of this.helpers) {
			for (const c of h.cmds) {
				const cat = (c.category || "resto").toLowerCase();
				if (!catMap[cat]) catMap[cat] = [];
				if (!catMap[cat].includes(c.cmd)) catMap[cat].push(c.cmd);
			}
		}

		let text = "## 📋 Índice de Comandos Disponíveis por Categoria:\n";
		for (const [cat, cmds] of Object.entries(catMap)) {
			const emoji = CATEGORY_EMOJIS[cat] || EXTRA_CATEGORY_EMOJIS[cat] || "📁";
			text += `- ${emoji} **${cat}**: ${cmds.map((cmd) => `\`${cmd}\``).join(", ")}\n`;
		}

		return text.trim();
	}

	/**
	 * Retorna o contexto base fundamental da Ravena para o assistente de ajuda
	 * sem depender da leitura de arquivos externos pesados como LLM-HELPER.md.
	 * @returns {string}
	 */
	getBaseHelpContext() {
		const commandsIndex = this.getCommandsIndex();
		const support = getSupportContact();
		const activeBotsLines = getPublicBotContacts()
			.map((b) => `  - ${b.id}: ${b.display} (${b.link})`)
			.join("\n");

		return `# Ravena - Informações Base

A **Ravena** é um bot de WhatsApp gratuito e de código aberto, desenvolvido por **moothz** (GitHub: https://github.com/moothz/ravena-ai).
O objetivo é auxiliar grupos, comunidades e streamers com recursos de mídia (figurinhas/áudio/vídeo), inteligência artificial, jogos/economia (pesca, roleta, etc.), utilidades e moderação de grupos.

---
## 📞 Contatos e Suporte Oficial
- **WhatsApp de Suporte Oficial (moothz)**: ${support.display} (${support.link})
  - _Incentive os usuários a chamarem no suporte oficial para relatar bugs, dúvidas técnicas ou sugestões._
- **Comunidade Oficial da Ravena**: https://chat.whatsapp.com/HPycWOAUYuY6tZs4vhW2Vz
- **Site Oficial**: https://ravena.moothz.com
- **Números Ativos (PV cria figurinhas automáticas e aceita convites)**:
${activeBotsLines}

---
## ⚙️ Arquitetura, Estabilidade e Dúvidas Frequentes
- Todos os bots rodam no mesmo servidor e compartilham o mesmo banco de dados SQLite central.
- A existência de múltiplos números serve como redundância/contingência contra banimentos do WhatsApp.
- Delays, lentidão temporária ou softblocks ocorrem periodicamente por controle do próprio WhatsApp; não adianta trocar de Ravena no grupo por causa disso.
- Nunca remova o bot de um grupo por instabilidade sem antes chamar o suporte: a remoção afeta o chip perante o WhatsApp e bloqueia convites futuros do grupo.

---
## 🚪 Instruções de Convite (!convite)
- Para colocar a Ravena no grupo: envie APENAS o link individual do grupo no PV de uma das Ravenas ativas.
- Após enviar o link, envie uma mensagem autêntica justificando o pedido. O bot avalia e aceita automaticamente por IA.
- Grupos com nomes/descrições preconceituosos, com menores (underage), só de figurinhas ou descartáveis são recusados.

---
## 💖 Doações (!doar)
- Mantido por doações voluntárias para custos de servidores e APIs: https://tipa.ai/moothz

---
## 🎲 Variáveis para Comandos Personalizados (!g-addCmd)
- **Boas-vindas/despedidas**: \`{pessoa}\`, \`{tituloGrupo}\`
- **Sistema**: \`{day}\`, \`{date}\`, \`{time}\`, \`{data-hora}\`, \`{data-dia}\`, \`{data-mes}\`, \`{data-ano}\`
- **Aleatórios**: \`{randomPequeno}\` (1-10), \`{randomMedio}\` (1-100), \`{randomGrande}\` (1-1000), \`{rndDado-X}\`, \`{rndDadoRange-X-Y}\`
- **Menções**: \`{pessoa}\`, \`{group}\`, \`{contador}\`, \`{mention}\`, \`{singleMention}\`, \`{mentionOuEu}\`, \`{mentionAll}\`, \`{membroRandom}\`
- **Web/APIs**: \`{weather:cidade}\`, \`{reddit-subreddit}\`, \`{API#GET#TEXT#url}\`
- **Outros**: \`{file-nome}\`, \`{cmd-comando}\` (executa outro comando como alias)

---
${commandsIndex}`;
	}

	/**
	 * Ponto de entrada unificado para a ferramenta list_commands / search_commands
	 * @param {Object|string} options - Parâmetros da tool: { category, command, query }
	 * @returns {string}
	 */
	listCommands(options = {}) {
		if (typeof options === "string") {
			const str = options.trim();
			if (str.startsWith("!") || str.startsWith("/")) {
				return this.getCommandDetails(str);
			}
			const meta = this.findCommandMeta(str, { exactOnly: true });
			if (meta) {
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
				return this.getCommandsIndex();
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

			// Se a busca for o nome exato de um comando, retorna os detalhes completos diretamente.
			// Termos que só batem com tags de módulo (ex: "pesca", "waifu") vão para o search().
			const exactMeta = this.findCommandMeta(cleanQuery, { exactOnly: true });
			if (exactMeta) {
				return this.getCommandDetails(cleanQuery);
			}

			return this.search(query);
		}

		// Padrão: índice de comandos por categoria
		return this.getCommandsIndex();
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
