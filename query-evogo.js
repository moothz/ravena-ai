/**
 * query-evogo.js
 * Ferramenta de debug para chamar a EvolutionGO API diretamente.
 * Espelha todos os métodos this.apiClient.* de WhatsAppBotEvoGo.js.
 *
 * Uso:
 *   node query-evogo.js <bot> <função> [args...]
 *
 * <bot>  Nome do bot definido em bots.json (campo "nome"). Obrigatório.
 *
 * Exemplos:
 *   node query-evogo.js ravenavip instanceStatus
 *   node query-evogo.js ravenavip groupInfo 120363000000000001@g.us
 *   node query-evogo.js ravenavip userInfo 5599999999999@s.whatsapp.net
 *   node query-evogo.js ravenavip blockList
 *   node query-evogo.js ravenavip listGroups
 *   node query-evogo.js ravenavip allInstances
 *   node query-evogo.js ravenavip sendText 5599999999999@s.whatsapp.net "Oi tudo bem?"
 *   node query-evogo.js ravenavip sendMedia 5599999999999@s.whatsapp.net https://example.com/img.jpg image
 *   node query-evogo.js ravenavip sendReaction 120363000@g.us MSG_ID_AQUI 👍
 *   node query-evogo.js ravenavip deleteMessage 120363000@g.us MSG_ID_AQUI true
 *   node query-evogo.js ravenavip groupLeave 120363000000000001@g.us
 *   node query-evogo.js ravenavip groupJoin INVITE_CODE
 *   node query-evogo.js ravenavip groupInviteInfo https://chat.whatsapp.com/XXXXXXXX
 *   node query-evogo.js ravenavip commonGroups 5599999999999@s.whatsapp.net
 *   node query-evogo.js ravenavip downloadMedia '{"imageMessage":{"url":"...","mimetype":"image/jpeg"}}'
 *   node query-evogo.js ravenavip profileStatus "Meu novo status"
 *   node query-evogo.js ravenavip updatePhoto https://example.com/foto.jpg
 *   node query-evogo.js ravenavip groupPhoto 120363000000000001@g.us https://example.com/foto.jpg
 *   node query-evogo.js ravenavip groupName 120363000000000001@g.us "Novo Nome do Grupo"
 *   node query-evogo.js ravenavip blockUser 5599999999999@s.whatsapp.net
 *   node query-evogo.js ravenavip unblockUser 5599999999999@s.whatsapp.net
 *   node query-evogo.js ravenavip instanceConnect
 *   node query-evogo.js ravenavip instancePair 55999999999
 *   node query-evogo.js ravenavip instanceQR
 *   node query-evogo.js ravenavip instanceLogout
 *   node query-evogo.js ravenavip getCurrentGroups
 */

require("dotenv").config();
const axios = require("axios");

// ─── Configuração ──────────────────────────────────────────────────────────────
const BASE_URL   = (process.env.EVOLUTION_GO_API_URL || "").replace(/\/$/, "");
const GLOBAL_KEY = process.env.EVOLUTION_GO_API_KEY;

// O nome do bot é o primeiro argumento posicional obrigatório
const BOT_NAME = process.argv[2];

const { INST_TOKEN, BOT_NOME } = (() => {
    try {
        const bots = JSON.parse(require("fs").readFileSync("bots.json", "utf8"));
        const available = bots.filter((b) => b.useEvoGo).map((b) => b.nome);

        if (!BOT_NAME) {
            console.error("[ERRO] Nome do bot é obrigatório como primeiro argumento.");
            console.error(`Uso: node query-evogo.js <bot> <função> [args...]`);
            console.error(`Bots EvoGo disponíveis: ${available.join(", ") || "(nenhum)"}`);
            process.exit(1);
        }

        const bot = bots.find((b) => b.useEvoGo && b.nome === BOT_NAME);
        if (!bot) {
            console.error(`[ERRO] Bot "${BOT_NAME}" não encontrado em bots.json.`);
            console.error(`Bots EvoGo disponíveis: ${available.join(", ") || "(nenhum)"}`);
            process.exit(1);
        }
        if (!bot.enabled) {
            console.warn(`[AVISO] Bot "${BOT_NAME}" existe mas não está habilitado (enabled: false). Continuando mesmo assim.`);
        }

        return { INST_TOKEN: bot.evolutionInstanceApiKey ?? null, BOT_NOME: bot.nome };
    } catch (err) {
        console.error("[ERRO] Falha ao ler bots.json:", err.message);
        process.exit(1);
    }
})();

if (!BASE_URL || !GLOBAL_KEY || !INST_TOKEN) {
    console.error("[ERRO] Variáveis não encontradas. Verifique:");
    console.error("  EVOLUTION_GO_API_URL =", BASE_URL  || "(vazio)");
    console.error("  EVOLUTION_GO_API_KEY =", GLOBAL_KEY ? "(ok)" : "(vazio)");
    console.error("  evolutionInstanceApiKey (bots.json) =", INST_TOKEN ? "(ok)" : "(não encontrado)");
    process.exit(1);
}

console.log(`[EvoGO Debug] Bot: ${BOT_NOME}`);
console.log(`[EvoGO Debug] Servidor: ${BASE_URL}`);
console.log(`[EvoGO Debug] GlobalKey: ${GLOBAL_KEY.substring(0, 8)}...`);
console.log(`[EvoGO Debug] InstToken: ${INST_TOKEN.substring(0, 8)}...`);
console.log("─".repeat(60));

// ─── Cliente HTTP ───────────────────────────────────────────────────────────────
const client = axios.create({ baseURL: BASE_URL });

const HEADERS_GLOBAL   = { apikey: GLOBAL_KEY,   "Content-Type": "application/json" };
const HEADERS_INSTANCE = { apikey: INST_TOKEN, "Content-Type": "application/json" };

async function apiGet(endpoint, params = {}, useGlobalKey = false) {
    const headers = useGlobalKey ? HEADERS_GLOBAL : HEADERS_INSTANCE;
    const res = await client.get(endpoint, { params, headers });
    return res.data;
}

async function apiPost(endpoint, body = {}, useGlobalKey = false) {
    const headers = useGlobalKey ? HEADERS_GLOBAL : HEADERS_INSTANCE;
    const res = await client.post(endpoint, body, { headers });
    return res.data;
}

async function apiPut(endpoint, body = {}, useGlobalKey = false) {
    const headers = useGlobalKey ? HEADERS_GLOBAL : HEADERS_INSTANCE;
    const res = await client.put(endpoint, body, { headers });
    return res.data;
}

async function apiDelete(endpoint, body = {}, useGlobalKey = false) {
    const headers = useGlobalKey ? HEADERS_GLOBAL : HEADERS_INSTANCE;
    const res = await client.delete(endpoint, { headers, data: body });
    return res.data;
}

// ─── Helpers ────────────────────────────────────────────────────────────────────
function dump(label, data) {
    console.log(`\n[${label}]`);
    console.log(JSON.stringify(data, null, 2));
}

function parseError(error) {
    const status  = error.response?.status;
    const data    = error.response?.data;
    const message = data?.message || error.message || "Erro desconhecido";
    console.error(`\n[ERRO HTTP ${status ?? "?"}] ${message}`);
    if (data) console.error("[Detalhes]", JSON.stringify(data, null, 2));
    console.error("[Stack]", error.stack ?? error);
}

// ─── Funções de API ─────────────────────────────────────────────────────────────

/** GET /instance/all — Lista todas as instâncias (usa GlobalKey) */
async function allInstances() {
    dump("allInstances", await apiGet("/instance/all", {}, true));
}

/** GET /instance/status — Status da instância */
async function instanceStatus() {
    dump("instanceStatus", await apiGet("/instance/status"));
}

/** POST /instance/connect — Conecta a instância */
async function instanceConnect(webhookUrl = null) {
    const url = webhookUrl ?? `${process.env.EVOGO_WEBHOOK_HOST}:${process.env.EVOGO_WEBHOOK_PORT}/webhook/evogo/debug`;
    dump("instanceConnect", await apiPost("/instance/connect", {
        webhookUrl: url,
        subscribe: ["MESSAGE", "SEND_MESSAGE", "READ_RECEIPT", "PRESENCE", "CHAT_PRESENCE",
                    "CALL", "CONNECTION", "LABEL", "CONTACT", "GROUP", "NEWSLETTER", "QRCODE"],
        websocketEnable: ""
    }));
}

/** POST /instance/pair — Solicita pairing code */
async function instancePair(phone) {
    dump("instancePair", await apiPost("/instance/pair", { phone }));
}

/** GET /instance/qr — Retorna QR Code atual */
async function instanceQR() {
    dump("instanceQR", await apiGet("/instance/qr", {}, false));
}

/** DELETE /instance/logout — Faz logout da instância */
async function instanceLogout() {
    dump("instanceLogout", await apiDelete("/instance/logout", {}, false));
}

/** POST /instance/create — Cria nova instância (usa GlobalKey) */
async function instanceCreate(name, token, webhookUrl) {
    dump("instanceCreate", await apiPost("/instance/create", {
        name,
        token,
        webhookUrl,
        webhookEvents: ["MESSAGE", "PRESENCE", "CALL", "CONNECTION", "QRCODE",
                        "CONTACT", "GROUP", "NEWSLETTER"]
    }, true));
}

/** PUT /instance/:id/advanced-settings — Configurações avançadas da instância */
async function instanceAdvSettings(instanceId, opts = {}) {
    const body = {
        alwaysOnline: opts.alwaysOnline ?? true,
        rejectCall:   opts.rejectCall   ?? true,
        readMessages: opts.readMessages ?? false,
        ignoreGroups: opts.ignoreGroups ?? false,
        ignoreStatus: opts.ignoreStatus ?? true
    };
    dump("instanceAdvSettings", await apiPut(`/instance/${instanceId}/advanced-settings`, body));
}

/** GET /group/list — Lista grupos */
async function listGroups() {
    dump("listGroups", await apiGet("/group/list"));
}

/** GET /group/myall — Grupos em que o bot está */
async function getCurrentGroups() {
    dump("getCurrentGroups", await apiGet("/group/myall"));
}

/** POST /group/info — Info de um grupo */
async function groupInfo(groupJid) {
    dump("groupInfo", await apiPost("/group/info", { groupJid }));
}

/** POST /group/leave — Sai de um grupo */
async function groupLeave(groupJid) {
    dump("groupLeave", await apiPost("/group/leave", { groupJid }));
}

/** POST /group/join — Entra em um grupo por código de convite */
async function groupJoin(code) {
    dump("groupJoin", await apiPost("/group/join", { code }));
}

/** POST /group/invite-info — Info sobre um link de convite */
async function groupInviteInfo(code) {
    const inviteLink = code.includes("chat.whatsapp.com") ? code : `https://chat.whatsapp.com/${code}`;
    dump("groupInviteInfo", await apiPost("/group/invite-info", { code: inviteLink }));
}

/** POST /group/name — Renomeia o grupo */
async function groupName(groupJid, name) {
    dump("groupName", await apiPost("/group/name", { groupJid, name }));
}

/** POST /group/photo — Atualiza foto do grupo */
async function groupPhoto(groupJid, imageUrlOrBase64) {
    dump("groupPhoto", await apiPost("/group/photo", { groupJid, image: imageUrlOrBase64 }));
}

/** POST /user/info — Info de um usuário */
async function userInfo(number) {
    // number deve ter @s.whatsapp.net
    const jid = number.includes("@") ? number : `${number}@s.whatsapp.net`;
    dump("userInfo", await apiPost("/user/info", { number: [jid] }));
}

/** GET /user/blocklist — Lista de contatos bloqueados */
async function blockList() {
    dump("blockList", await apiGet("/user/blocklist"));
}

/** POST /user/block — Bloqueia um usuário */
async function blockUser(number) {
    const jid = number.includes("@") ? number : `${number}@s.whatsapp.net`;
    dump("blockUser", await apiPost("/user/block", { number: jid }));
}

/** POST /user/unblock — Desbloqueia um usuário */
async function unblockUser(number) {
    const jid = number.includes("@") ? number : `${number}@s.whatsapp.net`;
    dump("unblockUser", await apiPost("/user/unblock", { number: jid }));
}

/** POST /user/profileStatus — Atualiza o status do perfil */
async function profileStatus(status) {
    dump("profileStatus", await apiPost("/user/profileStatus", { status }));
}

/** POST /user/photo — Atualiza a foto de perfil */
async function updatePhoto(imageUrlOrBase64) {
    dump("updatePhoto", await apiPost("/user/photo", { image: imageUrlOrBase64 }));
}

/** POST /chat/commonGroups — Grupos em comum com um usuário */
async function commonGroups(jid) {
    const jidCom = jid.includes("@") ? jid : `${jid}@s.whatsapp.net`;
    dump("commonGroups", await apiPost("/chat/commonGroups", { jid: jidCom }));
}

/** POST /send/text — Envia mensagem de texto */
async function sendText(number, text, quotedMessageId = null) {
    const body = { number, text, delay: 0 };
    if (quotedMessageId) body.quoted = { messageId: quotedMessageId };
    dump("sendText", await apiPost("/send/text", body));
}

/** POST /send/media — Envia mídia por URL */
async function sendMedia(number, url, type = "image", caption = null) {
    const body = { number, url, type, delay: 0 };
    if (caption) body.caption = caption;
    dump("sendMedia", await apiPost("/send/media", body));
}

/** POST /send/sticker — Envia sticker por URL */
async function sendSticker(number, stickerUrl) {
    dump("sendSticker", await apiPost("/send/sticker", { number, sticker: stickerUrl, delay: 0 }));
}

/** POST /send/location — Envia localização */
async function sendLocation(number, latitude, longitude, name = "", address = "") {
    dump("sendLocation", await apiPost("/send/location", { number, latitude, longitude, name, address, delay: 0 }));
}

/** POST /send/contact — Envia contato */
async function sendContact(number, fullName, phone) {
    dump("sendContact", await apiPost("/send/contact", { number, vcard: { fullName, phone }, delay: 0 }));
}

/** POST /send/poll — Envia enquete */
async function sendPoll(number, question, options, maxAnswer = 1) {
    dump("sendPoll", await apiPost("/send/poll", { number, question, options, maxAnswer, delay: 0 }));
}

/** POST /message/react — Envia reação a uma mensagem */
async function sendReaction(number, messageId, reaction) {
    dump("sendReaction", await apiPost("/message/react", { number, reaction, id: messageId, fromMe: false }));
}

/** POST /message/delete — Deleta uma mensagem */
async function deleteMessage(chat, messageId, fromMe = true, participant = null) {
    const body = { chat, messageId, fromMe };
    if (participant) body.participant = participant;
    dump("deleteMessage", await apiPost("/message/delete", body));
}

/** POST /message/downloadmedia — Faz download de mídia de uma mensagem */
async function downloadMedia(messageJson) {
    // messageJson: objeto message ou string JSON representando o campo Message da mensagem
    const message = typeof messageJson === "string" ? JSON.parse(messageJson) : messageJson;
    dump("downloadMedia", await apiPost("/message/downloadmedia", { message }));
}

// ─── Dispatch ───────────────────────────────────────────────────────────────────
const FUNCTIONS = {
    allInstances:        () => allInstances(),
    instanceStatus:      () => instanceStatus(),
    instanceConnect:     ([webhookUrl]) => instanceConnect(webhookUrl),
    instancePair:        ([phone]) => instancePair(phone),
    instanceQR:          () => instanceQR(),
    instanceLogout:      () => instanceLogout(),
    instanceCreate:      ([name, token, webhookUrl]) => instanceCreate(name, token, webhookUrl),
    instanceAdvSettings: ([instanceId]) => instanceAdvSettings(instanceId),

    listGroups:          () => listGroups(),
    getCurrentGroups:    () => getCurrentGroups(),
    groupInfo:           ([groupJid]) => groupInfo(groupJid),
    groupLeave:          ([groupJid]) => groupLeave(groupJid),
    groupJoin:           ([code]) => groupJoin(code),
    groupInviteInfo:     ([code]) => groupInviteInfo(code),
    groupName:           ([groupJid, name]) => groupName(groupJid, name),
    groupPhoto:          ([groupJid, imageUrl]) => groupPhoto(groupJid, imageUrl),

    userInfo:            ([number]) => userInfo(number),
    blockList:           () => blockList(),
    blockUser:           ([number]) => blockUser(number),
    unblockUser:         ([number]) => unblockUser(number),
    profileStatus:       ([status]) => profileStatus(status),
    updatePhoto:         ([imageUrl]) => updatePhoto(imageUrl),
    commonGroups:        ([jid]) => commonGroups(jid),

    sendText:            ([number, text, quotedId]) => sendText(number, text, quotedId),
    sendMedia:           ([number, url, type, caption]) => sendMedia(number, url, type, caption),
    sendSticker:         ([number, url]) => sendSticker(number, url),
    sendLocation:        ([number, lat, lon, name, addr]) => sendLocation(number, parseFloat(lat), parseFloat(lon), name, addr),
    sendContact:         ([number, fullName, phone]) => sendContact(number, fullName, phone),
    sendPoll:            ([number, question, ...opts]) => sendPoll(number, question, opts),
    sendReaction:        ([number, messageId, reaction]) => sendReaction(number, messageId, reaction),
    deleteMessage:       ([chat, messageId, fromMe, participant]) => deleteMessage(chat, messageId, fromMe !== "false", participant),
    downloadMedia:       ([messageJson]) => downloadMedia(messageJson),
};

async function main() {
    // argv[2] = bot name (already consumed above), argv[3] = função, argv[4+] = args
    const [,, , fnName, ...args] = process.argv;

    if (!fnName) {
        console.log("Funções disponíveis:\n");
        Object.keys(FUNCTIONS).forEach((f) => console.log(`  node query-evogo.js ${BOT_NOME} ${f}`));
        console.log("\nVeja exemplos no topo do arquivo.");
        process.exit(0);
    }

    const fn = FUNCTIONS[fnName];
    if (!fn) {
        console.error(`[ERRO] Função desconhecida: "${fnName}"`);
        console.error("Funções disponíveis:", Object.keys(FUNCTIONS).join(", "));
        process.exit(1);
    }

    try {
        await fn(args);
    } catch (error) {
        parseError(error);
        process.exit(1);
    }
}

main();
