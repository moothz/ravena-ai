const fs = require("fs").promises;
const path = require("path");
const Database = require("./Database");

class Status {
	/**
	 * Lê o arquivo de status dos serviços
	 * @returns {Promise<Object>} Objeto com o status dos serviços
	 */
	static async getServicesStatus() {
		try {
			const database = Database.getInstance();
			const servicesPath = path.join(database.databasePath, "services-status.json");
			const data = await fs.readFile(servicesPath, "utf8");
			return JSON.parse(data);
		} catch (error) {
			// Retorna status default (tudo down) em caso de erro
			return {
				whatsgoapi: "unknown",
				imagine: "down",
				llm: "down",
				whisper: "down",
				f5tts: "down"
			};
		}
	}
}

module.exports = Status;
