/**
 * CommandMapper.js
 * Converts between DB row columns and the custom_command JS object shape.
 */

const CommandMapper = {
	/**
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

		const jsonData = parse(row.json_data, {});

		return {
			...jsonData,
			// Core fields used by CommandHandler
			startsWith: row.trigger,
			groupId: row.group_id,
			responses: parse(row.responses, []),
			adminOnly: !!row.admin_only,
			active: !!row.active,
			deleted: !!row.deleted,
			count: row.count ?? 0,
			lastUsed: row.last_used ?? null,
			metadata: parse(row.metadata, {
				createdBy: row.created_by ?? null,
				createdAt: row.created_at ?? null
			})
		};
	},

	/**
	 * @param {string} groupId
	 * @param {Object} obj
	 * @returns {Object}
	 */
	toRow(groupId, obj) {
		const metadata = obj.metadata ?? {};
		return {
			group_id: groupId,
			trigger: obj.startsWith,
			responses: JSON.stringify(obj.responses ?? []),
			admin_only: obj.adminOnly ? 1 : 0,
			active: obj.active !== false ? 1 : 0,
			deleted: obj.deleted ? 1 : 0,
			count: obj.count ?? 0,
			last_used: obj.lastUsed ?? null,
			created_by: metadata.createdBy ?? null,
			created_at: metadata.createdAt ?? Date.now(),
			metadata: JSON.stringify(metadata)
		};
	}
};

module.exports = CommandMapper;
