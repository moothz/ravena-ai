/**
 * PendingJoinMapper.js
 * Converts between DB row columns and the pending_join JS object shape.
 */

const PendingJoinMapper = {
	/**
	 * @param {Object} row
	 * @returns {Object}
	 */
	fromRow(row) {
		if (!row) return null;
		return {
			code: row.code,
			authorId: row.author_id ?? null,
			authorName: row.author_name ?? null,
			timestamp: row.timestamp ?? null
		};
	},

	/**
	 * @param {Object} obj - {code, authorId, authorName, timestamp}
	 * @returns {Object}
	 */
	toRow(obj) {
		return {
			code: obj.code,
			author_id: obj.authorId ?? null,
			author_name: obj.authorName ?? null,
			timestamp: obj.timestamp ?? Date.now()
		};
	}
};

module.exports = PendingJoinMapper;
