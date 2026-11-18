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

		let extra = {};
		if (row.json_data) {
			try {
				extra = JSON.parse(row.json_data);
			} catch {
				extra = {};
			}
		}

		const bonusesProcessed = extra.bonusesProcessedAmount ?? 0;
		const runasProcessed = extra.runasProcessedAmount ?? extra.zinthosProcessedAmount ?? 0;
		const rollsProcessed = extra.rollsProcessedAmount ?? 0;
		const dailyMarryProcessed = extra.dailyMarryProcessedAmount ?? 0;

		return {
			...extra,
			nome: row.name,
			valor: row.valor ?? 0,
			numero: row.numero ?? undefined,
			timestamp: row.timestamp ?? null,
			historico,
			bonusesProcessedAmount: bonusesProcessed,
			runasProcessedAmount: runasProcessed,
			zinthosProcessedAmount: runasProcessed,
			rollsProcessedAmount: rollsProcessed,
			dailyMarryProcessedAmount: dailyMarryProcessed
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
