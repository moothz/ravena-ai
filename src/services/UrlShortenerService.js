const axios = require("axios");
const Logger = require("../utils/Logger");

class UrlShortenerService {
	constructor() {
		this.logger = new Logger("url-shortener");
		this.endpoint = (process.env.SINK_URL || "https://s.moothz.win").replace(/\/+$/, "");
	}

	/**
	 * Retorna o token de autenticação configurado
	 * @returns {string}
	 */
	getToken() {
		return process.env.NUXT_SITE_TOKEN || "";
	}

	/**
	 * Encurta uma URL utilizando o serviço Sink (https://s.moothz.win)
	 * @param {string} url - URL longa para encurtar
	 * @returns {Promise<string>} - URL encurtada ou a URL original em caso de erro
	 */
	async shorten(url) {
		if (!url || typeof url !== "string") {
			return url;
		}

		const token = this.getToken();
		if (!token) {
			this.logger.debug("NUXT_SITE_TOKEN não configurado, mantendo URL original");
			return url;
		}

		if (url.startsWith(this.endpoint)) {
			return url;
		}

		try {
			const response = await axios.post(
				`${this.endpoint}/api/link/create`,
				{ url },
				{
					headers: {
						Authorization: `Bearer ${token}`,
						"Content-Type": "application/json"
					},
					timeout: 5000
				}
			);

			if (response.data?.shortLink) {
				this.logger.debug(`URL encurtada com sucesso: ${response.data.shortLink}`);
				return response.data.shortLink;
			}

			if (response.data?.link?.slug) {
				const shortLink = `${this.endpoint}/${response.data.link.slug}`;
				this.logger.debug(`URL encurtada com sucesso via slug: ${shortLink}`);
				return shortLink;
			}

			return url;
		} catch (error) {
			const errorMsg = error?.response?.data?.message || error?.message;
			this.logger.warn(`Falha ao encurtar URL no Sink (${this.endpoint}): ${errorMsg}`);
			return url;
		}
	}
}

const instance = new UrlShortenerService();
module.exports = instance;
