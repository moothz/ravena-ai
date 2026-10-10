const net = require("net");
const dns = require("dns").promises;
const axios = require("axios");

const DEFAULT_PORT = 25565;
const STATUS_API_URL = "https://api.mcsrvstat.us/3";
const DIRECT_PING_TIMEOUT_MS = 3500;
const REQUEST_TIMEOUT_MS = 10000;
const USER_AGENT = "ravena-bot/1.0 (+https://github.com/moothz/ravena-ai)";

const HOSTNAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const IPV6_WITH_PORT_PATTERN = /^\[([0-9a-f:]+)\](?::(.*))?$/;
const MINECRAFT_FORMAT_CODE_PATTERN = /§[0-9a-fk-or]/gi;
const VALID_PLAYER_NAME_PATTERN = /^[.a-zA-Z0-9_]{2,20}$/;

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

// ===========================================================================
// Protocolo Nativo Server List Ping (Minecraft 1.7+)
// ===========================================================================

function writeVarInt(value) {
	const bytes = [];
	let v = value;
	while (true) {
		if ((v & ~0x7f) === 0) {
			bytes.push(v);
			break;
		}
		bytes.push((v & 0x7f) | 0x80);
		v >>>= 7;
	}
	return Buffer.from(bytes);
}

function readVarInt(buffer, offset = 0) {
	let value = 0;
	let length = 0;
	let currentByte;
	while (true) {
		if (offset + length >= buffer.length) {
			return { value: 0, length: 0, incomplete: true };
		}
		currentByte = buffer[offset + length];
		value |= (currentByte & 0x7f) << (length * 7);
		length++;
		if (length > 5) throw new Error("VarInt muito grande");
		if ((currentByte & 0x80) !== 0x80) break;
	}
	return { value, length, incomplete: false };
}

function buildHandshakePacket(host, port, protocolVersion = 47) {
	const hostBuffer = Buffer.from(host, "utf8");
	const hostLengthVarInt = writeVarInt(hostBuffer.length);
	const portBuffer = Buffer.alloc(2);
	portBuffer.writeUInt16BE(port, 0);

	const packetId = writeVarInt(0x00);
	const protoVarInt = writeVarInt(protocolVersion);
	const nextState = writeVarInt(0x01); // 1 = Status

	const payload = Buffer.concat([
		packetId,
		protoVarInt,
		hostLengthVarInt,
		hostBuffer,
		portBuffer,
		nextState
	]);
	const packetLength = writeVarInt(payload.length);
	return Buffer.concat([packetLength, payload]);
}

function buildStatusRequestPacket() {
	return Buffer.from([0x01, 0x00]);
}

async function resolveMinecraftSrv(host) {
	if (/^\[?[0-9a-f:.]+\]?$/i.test(host) || host === "localhost") {
		return null;
	}
	try {
		const records = await dns.resolveSrv(`_minecraft._tcp.${host}`);
		if (records && records.length > 0) {
			return { host: records[0].name, port: records[0].port };
		}
	} catch {
		// Sem registro SRV ou erro de DNS
	}
	return null;
}

function pingDirectSocket(targetHost, targetPort, timeoutMs = DIRECT_PING_TIMEOUT_MS) {
	return new Promise((resolve, reject) => {
		const socket = new net.Socket();
		let buffer = Buffer.alloc(0);
		let resolved = false;

		const cleanup = () => {
			socket.removeAllListeners();
			socket.destroy();
		};

		socket.setTimeout(timeoutMs);

		socket.on("timeout", () => {
			cleanup();
			reject(new Error(`Timeout de conexão após ${timeoutMs}ms`));
		});

		socket.on("error", (err) => {
			cleanup();
			reject(err);
		});

		socket.connect(targetPort, targetHost, () => {
			try {
				const handshake = buildHandshakePacket(targetHost, targetPort);
				const statusRequest = buildStatusRequestPacket();
				socket.write(Buffer.concat([handshake, statusRequest]));
			} catch (err) {
				cleanup();
				reject(err);
			}
		});

		socket.on("data", (chunk) => {
			buffer = Buffer.concat([buffer, chunk]);
			if (buffer.length < 3) return;

			try {
				let offset = 0;
				const packetLengthInfo = readVarInt(buffer, offset);
				if (packetLengthInfo.incomplete) return;
				offset += packetLengthInfo.length;

				if (buffer.length < offset + packetLengthInfo.value) return;

				const packetIdInfo = readVarInt(buffer, offset);
				if (packetIdInfo.incomplete) return;
				offset += packetIdInfo.length;

				if (packetIdInfo.value !== 0x00) {
					cleanup();
					return reject(new Error(`Packet ID inesperado: ${packetIdInfo.value}`));
				}

				const stringLengthInfo = readVarInt(buffer, offset);
				if (stringLengthInfo.incomplete) return;
				offset += stringLengthInfo.length;

				if (buffer.length < offset + stringLengthInfo.value) return;

				const jsonStr = buffer.toString("utf8", offset, offset + stringLengthInfo.value);
				cleanup();
				resolved = true;
				resolve(JSON.parse(jsonStr));
			} catch (err) {
				cleanup();
				reject(err);
			}
		});

		socket.on("close", () => {
			if (!resolved) {
				cleanup();
				reject(new Error("Conexão encerrada pelo servidor"));
			}
		});
	});
}

/**
 * Executa o ping nativo direto via TCP socket
 * @param {{host: string, port: number}} server
 * @param {number} timeoutMs
 * @returns {Promise<Object>}
 */
async function pingDirectMinecraftServer(server, timeoutMs = DIRECT_PING_TIMEOUT_MS) {
	let connectHost = server.host;
	let connectPort = server.port;

	const srv = await resolveMinecraftSrv(server.host);
	if (srv) {
		connectHost = srv.host;
		connectPort = srv.port;
	}

	const raw = await pingDirectSocket(connectHost, connectPort, timeoutMs);

	const onlineCount = Number(raw.players?.online) || 0;
	const maxCount = Number(raw.players?.max) || 0;
	const sampleList = Array.isArray(raw.players?.sample)
		? raw.players.sample.map((p) => ({ name: p.name, uuid: p.id }))
		: [];

	return {
		online: true,
		version: typeof raw.version?.name === "string" ? raw.version.name : null,
		players: {
			online: onlineCount,
			max: maxCount,
			list: sampleList
		},
		direct: true
	};
}

/**
 * Consulta a API externa como fallback
 * @param {{host: string, port: number}} server
 * @returns {Promise<Object>}
 */
async function fetchServerStatusFromApi(server) {
	const response = await axios.get(`${STATUS_API_URL}/${formatServerAddress(server)}`, {
		headers: { "User-Agent": USER_AGENT },
		timeout: REQUEST_TIMEOUT_MS
	});
	return response.data;
}

/**
 * Consulta o status do servidor Minecraft (priorizando conexão direta com fallback para API)
 * @param {{host: string, port: number}} server
 * @returns {Promise<Object>}
 */
async function fetchServerStatus(server) {
	try {
		return await pingDirectMinecraftServer(server);
	} catch {
		return await fetchServerStatusFromApi(server);
	}
}

function cleanPlayerName(name) {
	return String(name ?? "")
		.replace(MINECRAFT_FORMAT_CODE_PATTERN, "")
		.trim();
}

/**
 * Extrai e sanitiza os nicks de jogadores online
 * @param {Object} statusData - resposta do ping direto ou da API
 * @returns {string[]}
 */
function extractPlayerNames(statusData) {
	const listedNames = (statusData?.players?.list ?? []).map((player) => player?.name);
	const sampleNames = (statusData?.players?.sample ?? []).map((player) => player?.name);
	const rawInfoNames = (statusData?.info?.clean ?? []).filter((name) =>
		VALID_PLAYER_NAME_PATTERN.test(cleanPlayerName(name))
	);
	const names = [...listedNames, ...sampleNames, ...rawInfoNames]
		.map(cleanPlayerName)
		.filter((name) => VALID_PLAYER_NAME_PATTERN.test(name));
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
 * @param {Object} statusData - resposta do ping ou da API
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
	pingDirectMinecraftServer,
	fetchServerStatusFromApi,
	fetchServerStatus,
	extractPlayerNames,
	formatStatusMessage
};
