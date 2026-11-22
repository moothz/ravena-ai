// src/utils/communityLinks.js
/**
 * Retorna os links oficiais de comunidade, grupos e redes sociais a partir do .env
 * com fallbacks seguros.
 */
function getCommunityLinks() {
	return {
		community: process.env.LINK_COMUNIDADE || "https://chat.whatsapp.com/IUPXJokwjP2FZg0MlCoB5d",
		grupao: process.env.LINK_GRUPO_INTERACAO || "https://chat.whatsapp.com/CUYg45Q48Uc5uBvjiyCmiX",
		channel:
			process.env.LINK_GRUPO_AVISOS || "https://whatsapp.com/channel/0029VbBwXS7K5cDI4P8okp2f",
		telegramBot: process.env.TELEGRAM_INVITE_LINK || "https://t.me/ravenosabot",
		telegramCommunity: process.env.TELEGRAM_COMMUNITY || "https://t.me/+x242TMlPD4s2OTVh",
		discordBot:
			process.env.DISCORD_INVITE_LINK ||
			"https://discord.com/oauth2/authorize?client_id=1434519453416030369&permissions=5136918325222464&integration_type=0&scope=bot+applications.commands",
		discordCommunity: process.env.DISCORD_COMMUNITY || "https://discord.gg/39aAwUFRt",
		creator: process.env.LINK_CRIADOR || process.env.LINK_SUPORTE || "https://wa.me/555596424307",
		github: process.env.LINK_GITHUB || "https://github.com/moothz/ravena-ai",
		donation: process.env.DONATION_LINK || "https://tipa.ai/moothz"
	};
}

module.exports = { getCommunityLinks };
