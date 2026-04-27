/**
 * LoadReportMapper.js
 * Converts between DB row columns and the load_report JS object shape.
 *
 * The existing report object shape (from LoadReport.js):
 * {
 *   botId, period: { start, end }, duration,
 *   messages: { receivedPrivate, receivedGroup, sentPrivate, sentGroup, messagesPerHour },
 *   responseTime: { average, max, count }
 * }
 */

const LoadReportMapper = {
	/**
	 * @param {Object} row
	 * @returns {Object} - Reconstructs the full report object shape
	 */
	fromRow(row) {
		if (!row) return null;

		// Reconstruct from json_data if available for full fidelity
		let report = {};
		if (row.json_data) {
			try {
				report = JSON.parse(row.json_data);
			} catch (e) {
				// Fallback to column data
			}
		}

		return {
			...report,
			botId: row.bot_id || report.botId,
			period: {
				start: row.timestamp_start ?? (report.period?.start || null),
				end: row.timestamp_end ?? (report.period?.end || null)
			},
			duration: row.duration ?? (report.duration || null),
			messages: {
				...(report.messages || {}),
				receivedPrivate: row.recv_private ?? (report.messages?.receivedPrivate || 0),
				receivedGroup: row.recv_group ?? (report.messages?.receivedGroup || 0),
				sentPrivate: row.sent_private ?? (report.messages?.sentPrivate || 0),
				sentGroup: row.sent_group ?? (report.messages?.sentGroup || 0),
				messagesPerHour: row.msgs_per_hour ?? (report.messages?.messagesPerHour || 0),
				totalReceived:
					report.messages?.totalReceived ?? (row.recv_private || 0) + (row.recv_group || 0),
				totalSent: report.messages?.totalSent ?? (row.sent_private || 0) + (row.sent_group || 0)
			},
			responseTime: {
				...(report.responseTime || {}),
				average: row.resp_avg ?? (report.responseTime?.average || 0),
				max: row.resp_max ?? (report.responseTime?.max || 0),
				count: row.resp_count ?? (report.responseTime?.count || 0)
			},
			groups: report.groups || {}
		};
	},

	/**
	 * @param {Object} report - Full report object
	 * @returns {Object} Named parameter map
	 */
	toRow(report) {
		return {
			bot_id: report.botId ?? null,
			timestamp_start: report.period?.start ?? null,
			timestamp_end: report.period?.end ?? null,
			duration: report.duration ?? null,
			recv_private: report.messages?.receivedPrivate ?? 0,
			recv_group: report.messages?.receivedGroup ?? 0,
			sent_private: report.messages?.sentPrivate ?? 0,
			sent_group: report.messages?.sentGroup ?? 0,
			msgs_per_hour: report.messages?.messagesPerHour ?? 0,
			resp_avg: report.responseTime?.average ?? 0,
			resp_max: report.responseTime?.max ?? 0,
			resp_count: report.responseTime?.count ?? 0
		};
	}
};

module.exports = LoadReportMapper;
