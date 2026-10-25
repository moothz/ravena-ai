/**
 * ShadowGardenClient.js
 *
 * Cliente de Integração com o Microsserviço RESTful do Jardim das Sombras (Fazenda).
 * Utiliza fetch nativo do Node 20 LTS.
 */

class ShadowGardenClient {
	constructor(
		baseUrl = process.env.JARDIM_API_URL || "http://host.docker.internal:3040",
		apiKey = process.env.JARDIM_API_KEY || "jardim_secret_api_key_2026"
	) {
		this.baseUrl = baseUrl.replace(/\/+$/, "");
		this.apiKey = apiKey;
	}

	_headers() {
		return {
			"Content-Type": "application/json",
			"x-api-key": this.apiKey
		};
	}

	async _handleResponse(res, fallbackError) {
		if (!res.ok) {
			const err = await res.json().catch(() => ({}));
			const msg =
				err.message ||
				(err.error && typeof err.error === "object" ? err.error.message : err.error) ||
				`${fallbackError} (HTTP ${res.status})`;
			const error = new Error(msg);
			error.status = res.status;
			throw error;
		}
		return await res.json();
	}

	/**
	 * Busca status completo da fazenda (canteiros, moedas, estatísticas, inventário e buffs)
	 * @param {string} userId
	 */
	async getStatus(userId) {
		const res = await fetch(`${this.baseUrl}/farm/${encodeURIComponent(userId)}`, {
			headers: this._headers()
		});
		return this._handleResponse(res, "Falha ao buscar status da fazenda");
	}

	/**
	 * Obtém imagem renderizada 1024x1024 em Buffer binário PNG
	 * @param {string} userId
	 * @param {boolean} withTooltips
	 * @param {Object} [extraParams]
	 */
	async getImageBuffer(userId, withTooltips = true, extraParams = {}) {
		const params = new URLSearchParams();
		if (withTooltips) params.set("tooltips", "true");
		if (extraParams.timeOverride) params.set("time_override", extraParams.timeOverride);
		if (extraParams.tooltipStyle) params.set("tooltip_style", String(extraParams.tooltipStyle));
		if (extraParams.userName) params.set("user_name", extraParams.userName);
		if (extraParams.headerStyle) params.set("header_style", String(extraParams.headerStyle));
		if (extraParams.harvestedSlots) params.set("harvested_slots", extraParams.harvestedSlots);
		if (extraParams.plantedSlots) params.set("planted_slots", extraParams.plantedSlots);

		const query = params.toString() ? `?${params.toString()}` : "";
		const url = `${this.baseUrl}/farm/${encodeURIComponent(userId)}/image${query}`;
		const res = await fetch(url, {
			headers: this._headers()
		});
		if (!res.ok) {
			throw new Error(`Falha ao obter imagem da fazenda: HTTP ${res.status}`);
		}
		const arrayBuffer = await res.arrayBuffer();
		return Buffer.from(arrayBuffer);
	}

	/**
	 * Planta uma semente em canteiro específico ou em todos os livres
	 * @param {string} userId
	 * @param {string|number} itemId
	 * @param {number|null} [slot]
	 * @param {number|null} [amount]
	 */
	async plant(userId, itemId, slot = null, amount = null) {
		const body = { itemId };
		if (slot !== null && slot !== undefined) body.slot = slot;
		if (amount !== null && amount !== undefined) body.amount = amount;

		const res = await fetch(`${this.baseUrl}/farm/${encodeURIComponent(userId)}/plant`, {
			method: "POST",
			headers: this._headers(),
			body: JSON.stringify(body)
		});
		return this._handleResponse(res, "Falha ao plantar semente");
	}

	/**
	 * Colhe plantas prontas e limpa canteiros secos
	 * @param {string} userId
	 * @param {number|null} [slot]
	 * @param {boolean} [all=true]
	 */
	async harvest(userId, slot = null, all = true) {
		const body = { all };
		if (slot !== null && slot !== undefined) {
			body.slot = slot;
			body.all = false;
		}

		const res = await fetch(`${this.baseUrl}/farm/${encodeURIComponent(userId)}/harvest`, {
			method: "POST",
			headers: this._headers(),
			body: JSON.stringify(body)
		});
		return this._handleResponse(res, "Falha ao colher plantas");
	}

	/**
	 * Consome um elixir da mochila
	 * @param {string} userId
	 * @param {string|number} itemId
	 * @param {number|null} [slot]
	 */
	async useConsumable(userId, itemId, slot = null) {
		const body = { itemId };
		if (slot !== null && slot !== undefined) body.slot = slot;

		const res = await fetch(`${this.baseUrl}/farm/${encodeURIComponent(userId)}/use`, {
			method: "POST",
			headers: this._headers(),
			body: JSON.stringify(body)
		});
		return this._handleResponse(res, "Falha ao usar elixir");
	}

	/**
	 * Reivindica a Sacola do Coveiro (bônus diário)
	 * @param {string} userId
	 */
	async claimDaily(userId) {
		const res = await fetch(`${this.baseUrl}/farm/${encodeURIComponent(userId)}/daily`, {
			method: "POST",
			headers: this._headers(),
			body: JSON.stringify({})
		});
		return this._handleResponse(res, "Falha ao resgatar recompensa diária");
	}

	/**
	 * Retorna catálogo da loja com limites diários
	 * @param {string} userId
	 */
	async getShop(userId) {
		const res = await fetch(`${this.baseUrl}/shop?user_id=${encodeURIComponent(userId)}`, {
			headers: this._headers()
		});
		return this._handleResponse(res, "Falha ao carregar catálogo da loja");
	}

	/**
	 * Compra item na loja
	 * @param {string} userId
	 * @param {string|number} itemId
	 * @param {number} [quantity=1]
	 */
	async buy(userId, itemId, quantity = 1) {
		const res = await fetch(`${this.baseUrl}/shop/buy/${encodeURIComponent(userId)}`, {
			method: "POST",
			headers: this._headers(),
			body: JSON.stringify({ itemId, quantity })
		});
		return this._handleResponse(res, "Falha ao comprar item");
	}

	/**
	 * Retorna inventário ordenado do jogador
	 * @param {string} userId
	 */
	async getInventory(userId) {
		const res = await fetch(`${this.baseUrl}/inventory/${encodeURIComponent(userId)}`, {
			headers: this._headers()
		});
		return this._handleResponse(res, "Falha ao buscar inventário");
	}

	/**
	 * Totais cumulativos de colheita por planta (fonte de verdade do evento de colheita).
	 * Usado para creditar bônus sem depender do inventário, que zera quando o jogador vende.
	 * @param {string} userId
	 * @returns {Promise<{ userId: string, totals: Array<{ itemId: string, totalHarvested: number, updatedAt: string }> }>}
	 */
	async getHarvestTotals(userId) {
		const res = await fetch(`${this.baseUrl}/farm/${encodeURIComponent(userId)}/harvest-totals`, {
			headers: this._headers()
		});
		return this._handleResponse(res, "Falha ao buscar totais de colheita");
	}

	/**
	 * Vende colheitas do inventário
	 * @param {string} userId
	 * @param {Object} options - { all: boolean, itemId?: string, quantity?: number }
	 */
	async sell(userId, options = {}) {
		const res = await fetch(`${this.baseUrl}/farm/${encodeURIComponent(userId)}/sell`, {
			method: "POST",
			headers: this._headers(),
			body: JSON.stringify(options)
		});
		return this._handleResponse(res, "Falha ao vender colheitas");
	}

	/**
	 * Posiciona item decorativo no terreno
	 * @param {string} userId
	 * @param {Object} options - { decorId, slotIndex, x, y }
	 */
	async decorate(userId, options = {}) {
		const res = await fetch(`${this.baseUrl}/farm/${encodeURIComponent(userId)}/decorate`, {
			method: "POST",
			headers: this._headers(),
			body: JSON.stringify(options)
		});
		return this._handleResponse(res, "Falha ao posicionar enfeite");
	}

	/**
	 * Retorna link seguro de acesso ao painel Farm Admin
	 * @param {string} userId
	 */
	async getAdminUrl(userId) {
		const res = await fetch(`${this.baseUrl}/farm/${encodeURIComponent(userId)}/admin-url`, {
			headers: this._headers()
		});
		return this._handleResponse(res, "Falha ao gerar link do Farm Admin");
	}

	/**
	 * Ranking dos jogadores com mais moedas
	 * @param {number} [limit=20]
	 */
	async getWealthRanking(limit = 20) {
		const res = await fetch(`${this.baseUrl}/rankings/wealth?limit=${limit}`, {
			headers: this._headers()
		});
		return this._handleResponse(res, "Falha ao buscar ranking de riqueza");
	}

	/**
	 * Ranking dos jogadores com mais colheitas
	 * @param {number} [limit=20]
	 */
	async getFarmersRanking(limit = 20) {
		const res = await fetch(`${this.baseUrl}/rankings/farmers?limit=${limit}`, {
			headers: this._headers()
		});
		return this._handleResponse(res, "Falha ao buscar ranking de colheitas");
	}

	/**
	 * Busca dados consolidados de todos os jogadores para o resumo semanal
	 * Caso a rota /rankings/digest retorne 404, cai para /rankings/farmers
	 */
	async getDigestStats() {
		try {
			const res = await fetch(`${this.baseUrl}/rankings/digest`, {
				headers: this._headers()
			});
			if (res.ok) {
				return await res.json();
			}
		} catch (_) {}

		// Fallback gracioso para /rankings/farmers e /rankings/wealth
		const [farmersRes, wealthRes] = await Promise.all([
			this.getFarmersRanking(50).catch(() => ({ ranking: [] })),
			this.getWealthRanking(1).catch(() => ({ ranking: [] }))
		]);

		const farmers = farmersRes?.ranking || [];
		const wealthiest = wealthRes?.ranking?.[0] || null;

		return {
			players: farmers.map((f) => ({
				id: f.userId,
				coins: f.coins || 0,
				totalHarvested: f.totalHarvested || 0,
				totalPlanted: f.totalPlanted || 0,
				totalWithered: 0
			})),
			topCrop: null,
			topDecorator: null,
			richest: wealthiest ? { id: wealthiest.userId, coins: wealthiest.coins } : null
		};
	}

	/**
	 * Concede moedas, itens ou decorações via painel administrativo
	 * @param {string} userId
	 * @param {Object} options - { coins, itemId, amount, reason }
	 */
	async adminGive(userId, options = {}) {
		const res = await fetch(`${this.baseUrl}/admin/give`, {
			method: "POST",
			headers: this._headers(),
			body: JSON.stringify({ userId, ...options })
		});
		return this._handleResponse(res, "Falha ao conceder itens via admin");
	}

	/**
	 * Aplica buffs permanentes ou temporários na fazenda
	 * @param {string} userId
	 * @param {Object} options - { type, value, durationHours, source }
	 */
	async adminBuff(userId, options = {}) {
		await this.getStatus(userId).catch(() => {});
		const res = await fetch(`${this.baseUrl}/admin/buff`, {
			method: "POST",
			headers: this._headers(),
			body: JSON.stringify({ userId, ...options })
		});
		return this._handleResponse(res, "Falha ao aplicar buff via admin");
	}

	/**
	 * Transfere itens entre jogadores atomicamente
	 * @param {string} fromUserId
	 * @param {string} toUserId
	 * @param {Array<{ itemId: string, amount: number }>} items
	 */
	async transferItems(fromUserId, toUserId, items) {
		const res = await fetch(`${this.baseUrl}/admin/transfer`, {
			method: "POST",
			headers: this._headers(),
			body: JSON.stringify({ fromUserId, toUserId, items })
		});
		return this._handleResponse(res, "Falha ao transferir itens da fazenda");
	}

	/**
	 * Obtém textos e configurações públicas do jogo (nome, emojis, tooltips)
	 */
	async getTexts() {
		const res = await fetch(`${this.baseUrl}/texts`);
		return await res.json();
	}
}

module.exports = ShadowGardenClient;
