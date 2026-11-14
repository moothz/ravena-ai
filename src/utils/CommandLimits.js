/**
 * Limites de frequência de comandos por grupo ("Editar frequência" no !g-painel).
 *
 * Cada regra fica em `group.commandLimits`:
 *   { command: "roleta", maxUses: 10, hours: 24, scope: "global" | "user", ignoreAdmins: false }
 *
 * O uso é registrado na tabela `command_limit_usage` e avaliado em janela deslizante:
 * o comando é bloqueado quando já houve `maxUses` execuções nas últimas `hours` horas,
 * contando o grupo todo (global) ou apenas o autor (user). Com `ignoreAdmins`, admins
 * não são bloqueados e seus usos não entram na contagem.
 */

const Database = require("./Database");
const Logger = require("./Logger");

const COMMAND_LIMIT_SCOPES = Object.freeze({ GLOBAL: "global", USER: "user" });
const DEFAULT_LIMIT_HOURS = 24;
const MAX_LIMIT_HOURS = 720;
const MAX_LIMIT_USES = 1000;
const MAX_LIMIT_RULES = 50;
const MAX_COMMAND_NAME_LENGTH = 50;
const HOUR_MS = 60 * 60 * 1000;

const DB_NAME = "command_limits";
const DB_SCHEMA = `
	CREATE TABLE IF NOT EXISTS command_limit_usage (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		group_id TEXT NOT NULL,
		command TEXT NOT NULL,
		user_id TEXT,
		timestamp INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_command_limit_usage_lookup
		ON command_limit_usage(group_id, command, timestamp);
`;

/**
 * Normaliza o nome do comando: minúsculo, sem espaços nas pontas e sem "!" inicial.
 * @param {string} name
 * @returns {string}
 */
function normalizeCommandName(name) {
	if (typeof name !== "string") return "";
	return name.trim().toLowerCase().replace(/^!+/, "");
}

/**
 * Valida e normaliza a lista de limites recebida do painel.
 * @param {Array} rawLimits
 * @returns {{ valid: true, limits: Array } | { valid: false, error: string }}
 */
function validateCommandLimits(rawLimits) {
	if (rawLimits === null || rawLimits === undefined) return { valid: true, limits: [] };
	if (!Array.isArray(rawLimits)) {
		return { valid: false, error: "A lista de limites de comandos é inválida." };
	}
	if (rawLimits.length > MAX_LIMIT_RULES) {
		return { valid: false, error: `Máximo de ${MAX_LIMIT_RULES} limites de comandos por grupo.` };
	}

	const limits = [];
	const seen = new Set();

	for (const rule of rawLimits) {
		const command = normalizeCommandName(rule?.command);
		if (!command || command.length > MAX_COMMAND_NAME_LENGTH || /\s/.test(command)) {
			return { valid: false, error: `Nome de comando inválido: "${rule?.command ?? ""}".` };
		}
		if (seen.has(command)) {
			return { valid: false, error: `O comando "${command}" tem mais de um limite configurado.` };
		}

		const maxUses = Number(rule.maxUses);
		if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > MAX_LIMIT_USES) {
			return {
				valid: false,
				error: `Limite de usos do comando "${command}" deve ser um número inteiro entre 1 e ${MAX_LIMIT_USES}.`
			};
		}

		const hours = Number(rule.hours ?? DEFAULT_LIMIT_HOURS);
		if (!Number.isInteger(hours) || hours < 1 || hours > MAX_LIMIT_HOURS) {
			return {
				valid: false,
				error: `Intervalo do comando "${command}" deve ser um número inteiro de horas entre 1 e ${MAX_LIMIT_HOURS}.`
			};
		}

		const scope = rule.scope ?? COMMAND_LIMIT_SCOPES.GLOBAL;
		if (!Object.values(COMMAND_LIMIT_SCOPES).includes(scope)) {
			return { valid: false, error: `Tipo de limite inválido para o comando "${command}".` };
		}

		seen.add(command);
		limits.push({ command, maxUses, hours, scope, ignoreAdmins: rule.ignoreAdmins === true });
	}

	return { valid: true, limits };
}

/**
 * Busca o limite configurado para um comando no grupo.
 * @param {Object|null} group
 * @param {string} commandName
 * @returns {Object|null}
 */
function findCommandLimit(group, commandName) {
	if (!group || !Array.isArray(group.commandLimits) || group.commandLimits.length === 0) {
		return null;
	}
	const target = normalizeCommandName(commandName);
	if (!target) return null;
	return group.commandLimits.find((rule) => normalizeCommandName(rule?.command) === target) ?? null;
}

/**
 * Avalia a janela deslizante a partir dos timestamps de uso dentro dela.
 * @param {number[]} usageTimestamps - Usos dentro da janela, do mais recente para o mais antigo
 * @param {Object} limit - Regra de limite
 * @param {number} now - Timestamp atual (ms)
 * @returns {{ blocked: boolean, retryInSeconds: number }}
 */
function evaluateUsage(usageTimestamps, limit, now) {
	const windowMs = limit.hours * HOUR_MS;
	const inWindow = usageTimestamps.filter((timestamp) => now - timestamp < windowMs);
	if (inWindow.length < limit.maxUses) {
		return { blocked: false, retryInSeconds: 0 };
	}

	// O uso que libera a próxima vaga é o maxUses-ésimo mais recente
	const sorted = [...inWindow].sort((a, b) => b - a);
	const releasingUse = sorted[limit.maxUses - 1];
	const retryInSeconds = Math.max(1, Math.ceil((releasingUse + windowMs - now) / 1000));
	return { blocked: true, retryInSeconds };
}

/**
 * Descreve a regra em texto curto, ex.: "10 usos a cada 24h por pessoa".
 * @param {Object} limit
 * @returns {string}
 */
function describeCommandLimit(limit) {
	const uses = limit.maxUses === 1 ? "1 uso" : `${limit.maxUses} usos`;
	const scope = limit.scope === COMMAND_LIMIT_SCOPES.USER ? "por pessoa" : "no grupo";
	return `${uses} a cada ${limit.hours}h ${scope}`;
}

class CommandLimitTracker {
	constructor() {
		this.logger = new Logger("command-limits");
		this.database = Database.getInstance();
		this.database.getSQLiteDb(DB_NAME, DB_SCHEMA, true);
	}

	static getInstance() {
		if (!CommandLimitTracker.instance) {
			CommandLimitTracker.instance = new CommandLimitTracker();
		}
		return CommandLimitTracker.instance;
	}

	/**
	 * Verifica se o comando atingiu o limite.
	 * @param {Object} limit - Regra de limite
	 * @param {string} groupId
	 * @param {string} userId
	 * @returns {Promise<{ blocked: boolean, retryInSeconds: number }>}
	 */
	async check(limit, groupId, userId) {
		const now = Date.now();
		const command = normalizeCommandName(limit.command);
		const since = now - limit.hours * HOUR_MS;
		const isPerUser = limit.scope === COMMAND_LIMIT_SCOPES.USER;

		try {
			const rows = await this.database.dbAll(
				DB_NAME,
				`SELECT timestamp FROM command_limit_usage
				 WHERE group_id = ? AND command = ? AND timestamp > ?${isPerUser ? " AND user_id = ?" : ""}
				 ORDER BY timestamp DESC LIMIT ?`,
				isPerUser
					? [groupId, command, since, userId, limit.maxUses]
					: [groupId, command, since, limit.maxUses]
			);
			return evaluateUsage(
				rows.map((row) => row.timestamp),
				limit,
				now
			);
		} catch (error) {
			this.logger.error("Erro ao verificar limite de comando:", error);
			return { blocked: false, retryInSeconds: 0 };
		}
	}

	/**
	 * Registra um uso do comando e descarta registros fora da janela.
	 * @param {Object} limit - Regra de limite
	 * @param {string} groupId
	 * @param {string} userId
	 */
	async record(limit, groupId, userId) {
		const now = Date.now();
		const command = normalizeCommandName(limit.command);

		try {
			await this.database.dbRun(
				DB_NAME,
				"INSERT INTO command_limit_usage (group_id, command, user_id, timestamp) VALUES (?, ?, ?, ?)",
				[groupId, command, userId ?? null, now]
			);
			await this.database.dbRun(
				DB_NAME,
				"DELETE FROM command_limit_usage WHERE group_id = ? AND command = ? AND timestamp <= ?",
				[groupId, command, now - limit.hours * HOUR_MS]
			);
		} catch (error) {
			this.logger.error("Erro ao registrar uso de comando limitado:", error);
		}
	}
}

module.exports = {
	COMMAND_LIMIT_SCOPES,
	validateCommandLimits,
	findCommandLimit,
	evaluateUsage,
	describeCommandLimit,
	CommandLimitTracker
};
