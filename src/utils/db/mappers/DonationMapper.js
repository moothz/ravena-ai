/**
 * DonationMapper.js
 * Converts between DB row columns and the donation JS object shape.
 */

const DonationMapper = {
	/**
	 * @param {Object} row
	 * @returns {Object}
	 */
	fromRow(row) {
		if (!row) return null;

		let historico = [];
		try {
			historico = row.historico ? JSON.parse(row.historico) : [];
		} catch {
			historico = [];
		}

		return {
			nome: row.name,
			valor: row.valor ?? 0,
			numero: row.numero ?? undefined,
			timestamp: row.timestamp ?? null,
			historico
		};
	},

	/**
	 * @param {Object} obj - donation object with {nome, valor, numero, timestamp, historico}
	 * @returns {Object}
	 */
	toRow(obj) {
		return {
			name: obj.nome,
			valor: obj.valor ?? 0,
			numero: obj.numero ?? null,
			timestamp: obj.timestamp ?? Date.now(),
			historico: JSON.stringify(obj.historico ?? [])
		};
	}
};

module.exports = DonationMapper;
