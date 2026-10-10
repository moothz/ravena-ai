const axios = require("axios");

const DEFAULT_PORT = 25565;
const STATUS_API_URL = "https://api.mcsrvstat.us/3";
const REQUEST_TIMEOUT_MS = 10000;
const USER_AGENT = "ravena-bot/1.0 (+https://github.com/moothz/ravena-ai)";

const HOSTNAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const IPV6_WITH_PORT_PATTERN = /^\[([0-9a-f:]+)\](?::(.*))?$/;
const MINECRAFT_FORMAT_CODE_PATTERN = /§[0-9a-fk-or]/gi;

class InvalidServerAddressError extends Error {}

function parsePort(rawPort) {
	if (rawPort === undefined) return DEFAULT_PORT;
	if (!/^\d{1,5}$/.test(rawPort)) throw new InvalidServerAddressError("Porta inválida");
	const port = Number(rawPort);
	if (port < 1 || port > 65535) throw new InvalidServerAddressError("Porta fora do intervalo");
	return port;
}

function splitHostAndPort(address) {
	const ipv6Match = address.match(IPV6_WITH_PORT_PATTERN);
	if (ipv6Match) return { host: ipv6Match[1], rawPort: ipv6Match[2] };

	const parts = address.split(":");
	if (parts.length > 2) throw new InvalidServerAddressError("Endereço inválido");
	const [host, rawPort] = parts;
	if (!HOSTNAME_PATTERN.test(host) || host.length > 253) {
		throw new InvalidServerAddressError("Host inválido");
	}
	return { host, rawPort };
}

/**
 * Converte "host[:porta]" em { host, port }. Sem porta, usa 25565.
 * @param {string} input
 * @returns {{host: string, port: number}}
 * @throws {InvalidServerAddressError}
 */
function parseServerAddress(input) {
	const address = String(input ?? "")
		.trim()
		.toLowerCase();
	if (!address) throw new InvalidServerAddressError("Endereço vazio");

	const { host, rawPort } = splitHostAndPort(address);
	return { host, port: parsePort(rawPort) };
}

function formatServerAddress({ host, port }) {
	const printableHost = host.includes(":") ? `[${host}]` : host;
	return `${printableHost}:${port}`;
}

/**
 * Consulta o status do servidor na api.mcsrvstat.us
 * @param {{host: string, port: number}} server
 * @returns {Promise<Object>} resposta crua da API
 */
async function fetchServerStatus(server) {
	const response = await axios.get(`${STATUS_API_URL}/${formatServerAddress(server)}`, {
		headers: { "User-Agent": USER_AGENT },
		timeout: REQUEST_TIMEOUT_MS
	});
	return response.data;
}

function cleanPlayerName(name) {
	return String(name ?? "")
		.replace(MINECRAFT_FORMAT_CODE_PATTERN, "")
		.trim();
}

/**
 * Junta os nicks de players.list e info.clean (alguns servidores listam jogadores ali)
 * @param {Object} statusData - resposta da API
 * @returns {string[]}
 */
function extractPlayerNames(statusData) {
	const listedNames = (statusData?.players?.list ?? []).map((player) => player?.name);
	const infoNames = statusData?.info?.clean ?? [];
	const names = [...listedNames, ...infoNames].map(cleanPlayerName).filter(Boolean);
	return [...new Set(names)];
}

function formatPlayerNames(names, onlineCount) {
	if (names.length === 0) return onlineCount > 0 ? "_(lista de nicks não disponível)_" : null;
	const hiddenCount = onlineCount - names.length;
	const joined = names.join(", ");
	return hiddenCount > 0 ? `${joined} e mais ${hiddenCount}` : joined;
}

/**
 * Monta a mensagem de status para o grupo
 * @param {{host: string, port: number}} server
 * @param {Object} statusData - resposta da API
 * @returns {string}
 */
function formatStatusMessage(server, statusData) {
	const address = formatServerAddress(server);
	if (!statusData?.online) return `🔴 O servidor *${address}* está offline.`;

	const onlineCount = statusData.players?.online ?? 0;
	const maxCount = statusData.players?.max ?? 0;
	const lines = [`🟢 *Servidor Minecraft* — ${address}`];
	if (statusData.version) lines.push(`🧱 Versão: ${statusData.version}`);
	lines.push(`👥 Jogadores: ${onlineCount}/${maxCount}`);

	const playerNames = formatPlayerNames(extractPlayerNames(statusData), onlineCount);
	if (playerNames) lines.push(`🎮 ${playerNames}`);

	return lines.join("\n");
}

module.exports = {
	DEFAULT_PORT,
	InvalidServerAddressError,
	parseServerAddress,
	formatServerAddress,
	fetchServerStatus,
	extractPlayerNames,
	formatStatusMessage
};
