/**
 * GroupMapper.js
 * Converts between DB row columns and the Group JS object shape.
 *
 * fromRow(row) → plain object  (used by getGroup / getGroups)
 * toRow(obj)   → column map    (used by saveGroup)
 */

const GroupMapper = {
	/**
	 * Convert a DB row (real columns) into the JS object shape
	 * that the rest of the code already expects.
	 * @param {Object} row
	 * @returns {Object}
	 */
	fromRow(row) {
		if (!row) return null;

		const parse = (val, fallback) => {
			if (val === null || val === undefined) return fallback;
			if (typeof val === "string") {
				try {
					return JSON.parse(val);
				} catch {
					return fallback;
				}
			}
			return val;
		};

		return {
			id: row.id,
			name: row.name,
			titulo: row.titulo ?? null,
			descricao: row.descricao ?? null,
			addedBy: row.added_by ?? null,
			removedBy: row.removed_by ?? false,
			prefix: row.prefix ?? "!",
			customIgnoresPrefix: !!row.custom_ignores_prefix,
			inviteCode: row.invite_code ?? null,
			paused: !!row.paused,
			additionalAdmins: parse(row.additional_admins, []),
			filters: parse(row.filters, { nsfw: false, links: false, words: [], people: [] }),
			twitch: parse(row.twitch, []),
			kick: parse(row.kick, []),
			youtube: parse(row.youtube, []),
			botNotInGroup: parse(row.bot_not_in_group, []),
			webhooks: parse(row.webhooks, []),
			greetings: parse(row.greetings, {}),
			farewells: parse(row.farewells, {}),
			interact: (() => {
				const parsed = parse(row.interact, {
					enabled: true,
					useCmds: true,
					lastInteraction: 0,
					cooldown: 30,
					chance: 100,
					proporcao: 50
				});
				if (parsed && parsed.proporcao === undefined) {
					parsed.proporcao = 50;
				}
				return parsed;
			})(),
			autoTranslateTo: row.auto_translate_to ?? false,
			autoStt: !!row.auto_stt,
			ignoredNumbers: parse(row.ignored_numbers, []),
			ignoredUsers: parse(row.ignored_users, []),
			mutedCommands: parse(row.muted_commands, []),
			mutedCategories: parse(row.muted_categories, []),
			nicks: parse(row.nicks, []),
			warnings: parse(row.warnings, []),
			customAIPrompt: parse(row.custom_ai_prompt, []),
			notificaGrupoFechado: !!row.notifica_grupo_fechado,
			notificaGrupoAberto: !!row.notifica_grupo_aberto,
			createdAt: row.created_at ?? Date.now(),
			updatedAt: row.updated_at ?? Date.now()
		};
	},

	/**
	 * Convert a Group JS object into column values for INSERT/UPDATE.
	 * @param {Object} obj
	 * @returns {Object} Named parameter map for better-sqlite3
	 */
	toRow(obj) {
		const s = (val) => JSON.stringify(val ?? null);
		const asString = (val) => {
			if (val === null || val === undefined) return null;
			if (typeof val === "string") return val;
			if (typeof val === "object") {
				return val.id || val.name || JSON.stringify(val);
			}
			return String(val);
		};

		return {
			id: asString(obj.id),
			name: obj.name !== undefined && obj.name !== null ? asString(obj.name) : null,
			titulo: obj.titulo !== undefined && obj.titulo !== null ? asString(obj.titulo) : null,
			descricao:
				obj.descricao !== undefined && obj.descricao !== null ? asString(obj.descricao) : null,
			added_by: obj.addedBy !== undefined && obj.addedBy !== null ? asString(obj.addedBy) : null,
			removed_by: obj.removedBy && obj.removedBy !== false ? asString(obj.removedBy) : null,
			prefix: obj.prefix ?? "!",
			custom_ignores_prefix: obj.customIgnoresPrefix ? 1 : 0,
			invite_code:
				obj.inviteCode !== undefined && obj.inviteCode !== null ? asString(obj.inviteCode) : null,
			paused: obj.paused ? 1 : 0,
			additional_admins: s(obj.additionalAdmins),
			filters: s(obj.filters),
			twitch: s(obj.twitch),
			kick: s(obj.kick),
			youtube: s(obj.youtube),
			bot_not_in_group: s(obj.botNotInGroup),
			webhooks: s(obj.webhooks),
			greetings: s(obj.greetings),
			farewells: s(obj.farewells),
			interact: s(obj.interact),
			auto_translate_to:
				obj.autoTranslateTo && obj.autoTranslateTo !== false ? asString(obj.autoTranslateTo) : null,
			auto_stt: obj.autoStt ? 1 : 0,
			ignored_numbers: s(obj.ignoredNumbers),
			ignored_users: s(obj.ignoredUsers),
			muted_commands: s(obj.mutedCommands),
			muted_categories: s(obj.mutedCategories),
			nicks: s(obj.nicks),
			warnings: s(obj.warnings),
			custom_ai_prompt: s(obj.customAIPrompt),
			notifica_grupo_fechado: obj.notificaGrupoFechado ? 1 : 0,
			notifica_grupo_aberto: obj.notificaGrupoAberto ? 1 : 0,
			created_at: obj.createdAt ?? Date.now(),
			updated_at: Date.now()
		};
	}
};

module.exports = GroupMapper;
