/**
 * SoftBlockMapper.js
 * Converts between DB row columns and the soft_block JS object shape.
 */

const SoftBlockMapper = {
	/**
	 * @param {Object} row
	 * @returns {Object}
	 */
	fromRow(row) {
		if (!row) return null;
		return {
			numero: row.number,
			invites: !!row.block_invites
		};
	},

	/**
	 * @param {Object} obj - {numero, invites}
	 * @returns {Object}
	 */
	toRow(obj) {
		return {
			number: obj.numero,
			block_invites: obj.invites ? 1 : 0
		};
	}
};

module.exports = SoftBlockMapper;
