const Database = require("../utils/Database");
const Logger = require("../utils/Logger");
const LLMService = require("./LLMService");

class StatsService {
	constructor() {
		this.logger = new Logger("stats-service");
		this.database = Database.getInstance();
		this.LLM_DB = "llm_stats";
		this.MEDIA_DB = "media_stats";
	}

	async getLLMStats(startDate = 0) {
		try {
			// Query filtering by timestamp if startDate is provided
			const query =
				startDate > 0
					? `SELECT * FROM usage_stats WHERE timestamp >= ?`
					: `SELECT * FROM usage_stats`;

			const params = startDate > 0 ? [startDate] : [];

			const rows = await this.database.dbAll(this.LLM_DB, query, params);

			const stats = {
				total_requests: 0,
				total_failures: 0,
				total_input_tokens: 0,
				total_output_tokens: 0,
				by_type: {
					text: { requests: 0, failures: 0, input_tokens: 0, output_tokens: 0 },
					image: { requests: 0, failures: 0, input_tokens: 0, output_tokens: 0 },
					video: { requests: 0, failures: 0, input_tokens: 0, output_tokens: 0 }
				},
				by_provider: {}
			};

			for (const row of rows) {
				const isSuccess = row.is_success !== 0;

				if (isSuccess) {
					stats.total_requests++;
					stats.total_input_tokens += row.input_tokens;
					stats.total_output_tokens += row.output_tokens;
				} else {
					stats.total_failures++;
				}

				const type = row.request_type || "text";
				if (!stats.by_type[type]) {
					stats.by_type[type] = {
						requests: 0,
						failures: 0,
						input_tokens: 0,
						output_tokens: 0
					};
				}

				if (isSuccess) {
					stats.by_type[type].requests++;
					stats.by_type[type].input_tokens += row.input_tokens;
					stats.by_type[type].output_tokens += row.output_tokens;
				} else {
					stats.by_type[type].failures++;
				}

				const provider = row.provider || "Unknown";
				if (!stats.by_provider[provider]) {
					stats.by_provider[provider] = {
						requests: 0,
						failures: 0,
						input_tokens: 0,
						output_tokens: 0
					};
				}

				if (isSuccess) {
					stats.by_provider[provider].requests++;
					stats.by_provider[provider].input_tokens += row.input_tokens;
					stats.by_provider[provider].output_tokens += row.output_tokens;
				} else {
					stats.by_provider[provider].failures++;
				}
			}

			return stats;
		} catch (e) {
			this.logger.error("Error getting LLM stats:", e);
			return {};
		}
	}

	getQueueStatus() {
		return LLMService.getInstance().getQueueStatus();
	}

	async getStatsByRange() {
		const now = Date.now();
		const day = 24 * 60 * 60 * 1000;
		const ranges = {
			"1d": now - day,
			"7d": now - 7 * day,
			"15d": now - 15 * day,
			"30d": now - 30 * day
		};

		const result = {
			queue: this.getQueueStatus(),
			ranges: {}
		};

		for (const [key, startDate] of Object.entries(ranges)) {
			result.ranges[key] = await this.getLLMStats(startDate);
		}

		return result;
	}

	async getComfyStats() {
		try {
			const rows = await this.database.dbAll(this.MEDIA_DB, "SELECT * FROM comfy_stats");

			const stats = {
				total_images: 0,
				by_resolution: {},
				by_model: {}
			};

			for (const row of rows) {
				const count = row.count || 1;
				stats.total_images += count;

				const res = row.resolution || "unknown";
				if (!stats.by_resolution[res]) stats.by_resolution[res] = 0;
				stats.by_resolution[res] += count;

				const model = row.model || "unknown";
				if (!stats.by_model[model]) stats.by_model[model] = 0;
				stats.by_model[model] += count;
			}

			return stats;
		} catch (e) {
			this.logger.error("Error getting ComfyUI stats:", e);
			return {};
		}
	}

	async getSpeechStats() {
		try {
			const ttsRows = await this.database.dbAll(
				this.MEDIA_DB,
				"SELECT * FROM speech_generation_stats"
			);
			const sttRows = await this.database.dbAll(
				this.MEDIA_DB,
				"SELECT * FROM speech_transcription_stats"
			);

			const stats = {
				tts: {
					total_requests: 0,
					total_chars: 0,
					total_words: 0,
					total_duration_sec: 0,
					total_processing_time_ms: 0,
					avg_processing_time_ms: 0
				},
				stt: {
					total_requests: 0,
					total_chars: 0,
					total_words: 0,
					total_duration_sec: 0,
					total_processing_time_ms: 0,
					avg_processing_time_ms: 0
				}
			};

			// Process TTS
			for (const row of ttsRows) {
				stats.tts.total_requests++;
				stats.tts.total_chars += row.char_count || 0;
				stats.tts.total_words += row.word_count || 0;
				stats.tts.total_duration_sec += row.duration_sec || 0;
				stats.tts.total_processing_time_ms += row.processing_time_ms || 0;
			}
			if (stats.tts.total_requests > 0) {
				stats.tts.avg_processing_time_ms =
					stats.tts.total_processing_time_ms / stats.tts.total_requests;
			}

			// Process STT
			for (const row of sttRows) {
				stats.stt.total_requests++;
				stats.stt.total_chars += row.char_count || 0;
				stats.stt.total_words += row.word_count || 0;
				stats.stt.total_duration_sec += row.duration_sec || 0;
				stats.stt.total_processing_time_ms += row.processing_time_ms || 0;
			}
			if (stats.stt.total_requests > 0) {
				stats.stt.avg_processing_time_ms =
					stats.stt.total_processing_time_ms / stats.stt.total_requests;
			}

			return stats;
		} catch (e) {
			this.logger.error("Error getting Speech stats:", e);
			return {};
		}
	}

	async getBonsaiStats() {
		try {
			const rows = await this.database.dbAll("bonsai_stats", "SELECT * FROM bonsai_stats");

			const stats = {
				total_images: 0,
				by_resolution: {},
				by_model: {}
			};

			for (const row of rows) {
				const count = row.count || 1;
				stats.total_images += count;

				const res = row.resolution || "unknown";
				if (!stats.by_resolution[res]) stats.by_resolution[res] = 0;
				stats.by_resolution[res] += count;

				const model = row.model || "unknown";
				if (!stats.by_model[model]) stats.by_model[model] = 0;
				stats.by_model[model] += count;
			}

			return stats;
		} catch (e) {
			this.logger.error("Error getting Bonsai stats:", e);
			return {};
		}
	}

	async getAllStats() {
		return {
			llm: await this.getLLMStats(),
			comfyui: await this.getComfyStats(),
			bonsai: await this.getBonsaiStats(),
			speech: await this.getSpeechStats()
		};
	}
}

module.exports = StatsService;
