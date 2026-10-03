const bodyParser = require("body-parser");

const WEBHOOK_RATE_LIMIT = 120000;

/**
 * Gerenciador de servidor de webhooks de grupos para BotAPI
 */
function startWebhookServer(api) {
	if (!process.env.GROUP_WEBHOOKS) return;
	const port = process.env.GROUP_WEBHOOKS;
	if (!port) {
		api.webhookLogger.warn("GROUP_WEBHOOKS port not set. Webhook server disabled.");
		return;
	}

	api.webhookApp.use(bodyParser.json({ limit: "10mb" }));
	api.webhookApp.use(bodyParser.urlencoded({ extended: true, limit: "10mb" }));

	api.webhookApp.post("/:botId/:groupId", async (req, res) => {
		const { botId, groupId } = req.params;
		const body = req.body;
		const headers = req.headers;

		// Adiciona @g.us se estiver ausente
		const fullGroupId = groupId.includes("@") ? groupId : `${groupId}@g.us`;

		// Busca o bot
		const bot = api.bots.find((b) => b.id === botId);
		if (!bot) {
			return res.status(404).send("Bot not found");
		}

		// Busca webhooks configurados para o grupo
		const webhooks = api.webhooksCache.get(fullGroupId);
		if (!webhooks || webhooks.length === 0) {
			return res.status(404).send("No webhooks configured for this group");
		}

		// Encontra correspondência de webhook
		let matchedWebhook = null;
		for (const webhook of webhooks) {
			if (webhook.botId && webhook.botId !== botId) continue;

			const headerName = webhook.header.name.toLowerCase();
			const headerValue = webhook.header.value;
			const receivedValue = headers[headerName];

			if (!receivedValue) continue;

			if (webhook.headerValue === "include") {
				if (receivedValue.includes(headerValue)) {
					matchedWebhook = webhook;
					break;
				}
			} else {
				if (receivedValue === headerValue) {
					matchedWebhook = webhook;
					break;
				}
			}
		}

		if (!matchedWebhook) {
			api.webhookLogger.warn(`Webhook received for ${botId}/${fullGroupId} but no header matched.`);
			return res.status(401).send("Unauthorized: Header mismatch");
		}

		// Gera mensagem substituindo tags do template
		let message = matchedWebhook.template;
		message = message.replace(/{{([^}]+)}}/g, (match, key) => {
			const keys = key.trim().split(".");
			let value = body;
			for (const k of keys) {
				value = value ? value[k] : undefined;
			}
			return value !== undefined ? value : match;
		});

		api.webhookLogger.info(
			`Webhook matched: ${matchedWebhook.name} for ${fullGroupId}. Msg: ${message}`
		);

		handleWebhookMessage(api, bot, fullGroupId, message);
		res.send("ok");
	});

	try {
		api.webhookServer = api.webhookApp.listen(port, () => {
			api.webhookLogger.info(`Group Webhook Server listening on port ${port}`);
		});
	} catch (e) {
		api.webhookLogger.error("Failed to start webhook server:", e);
	}
}

function handleWebhookMessage(api, bot, groupId, message) {
	const key = `${bot.id}:${groupId}`;
	let rateData = api.webhookRateLimits.get(key);

	if (!rateData) {
		rateData = { lastSent: 0, buffer: [], timeout: null };
		api.webhookRateLimits.set(key, rateData);
	}

	const now = Date.now();
	if (rateData.buffer.length === 0 && now - rateData.lastSent > WEBHOOK_RATE_LIMIT) {
		sendWebhookMessage(api, bot, groupId, message);
		rateData.lastSent = Date.now();
	} else {
		rateData.buffer.push(message);

		if (!rateData.timeout) {
			const timeToWait = Math.max(0, WEBHOOK_RATE_LIMIT - (now - rateData.lastSent));

			rateData.timeout = setTimeout(() => {
				flushWebhookBuffer(api, bot, groupId, key);
			}, timeToWait);

			api.webhookLogger.info(`Buffered webhook for ${groupId}. Flush in ${timeToWait}ms`);
		}
	}
}

async function sendWebhookMessage(api, bot, groupId, message) {
	try {
		await bot.sendMessage(groupId, message);
	} catch (e) {
		api.webhookLogger.error(`Error sending webhook message to ${groupId}:`, e);
	}
}

function flushWebhookBuffer(api, bot, groupId, key) {
	const rateData = api.webhookRateLimits.get(key);
	if (!rateData) return;

	if (rateData.buffer.length > 0) {
		const combinedMessage = rateData.buffer.join("\n\n");
		sendWebhookMessage(api, bot, groupId, combinedMessage);
		rateData.lastSent = Date.now();
		rateData.buffer = [];
	}

	rateData.timeout = null;
}

module.exports = {
	WEBHOOK_RATE_LIMIT,
	startWebhookServer,
	handleWebhookMessage,
	sendWebhookMessage,
	flushWebhookBuffer
};
