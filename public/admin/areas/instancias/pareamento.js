/*
 * Instâncias › ficha › Pareamento (#/instancias/<nome>/pareamento), só WhatsApp.
 * É a página /qrcode/<nome> dentro do painel: estado da conexão, QR code e código de pareamento
 * ao vivo (SSE /qrcode-stream), início automático do fluxo (/qrcode-initconnect) e as ações
 * Tentar reconectar, Recriar e Desconectar. Mesmas rotas e o mesmo comportamento da página
 * antiga (inclusive: ao fechar, o servidor reagenda o apagamento da instância desconectada).
 */

import { h, lamp, card, note, confirmInline, toast } from "../../core.js";
import { botAction, botFetch, botAuth, explain, outcomeBox } from "./comum.js";

/** src seguro para o QR (data:image/… ou base64 puro). */
export function qrSrc(code) {
	const s = String(code || "");
	if (/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/.test(s)) return s;
	if (/^[A-Za-z0-9+/=\s]+$/.test(s) && s.length > 20) return `data:image/png;base64,${s}`;
	return null;
}

export async function renderPareamento(root, ctx, bot) {
	const id = encodeURIComponent(bot.nome);
	const name = bot.nomeExibir || bot.nome;
	const out = outcomeBox();
	const msg = h("p", { class: "inst-pair-msg", role: "status", "aria-live": "polite" });
	const say = (text) => {
		msg.textContent = text || "";
	};
	const timers = [];
	let es = null;
	let closed = false;

	// Ações (as mesmas da página antiga).
	const reconnect = h("button", {
		type: "button",
		class: "btn btn-primary",
		"data-key": "reconectar",
		text: "Tentar reconectar",
		onclick: async () => {
			reconnect.disabled = true;
			say("Tentando reconectar a sessão existente…");
			try {
				const m = await botAction(bot, `/reconnect/${id}`, `reconectar ${name}`);
				say(`Comando de reconexão enviado${m ? ` (${m})` : ""}. Verificando o estado…`);
				timers.push(setTimeout(() => ctx.refresh(), 3000));
			} catch (err) {
				say("");
				out.set("error", err.message);
			} finally {
				reconnect.disabled = false;
			}
		}
	});
	const recreate = h("button", {
		type: "button",
		class: "btn",
		"data-key": "recriar",
		text: "Recriar instância"
	});
	confirmInline(recreate, {
		question:
			"Apagar e recriar esta instância na WhatsGoAPI? A atual é apagada e uma nova é criada.",
		confirmLabel: "Recriar",
		onConfirm: async () => {
			say("Recriando a instância na WhatsGoAPI…");
			try {
				await botAction(bot, `/recreate/${id}`, `recriar ${name}`);
			} catch (err) {
				say("");
				out.set("error", err.message);
				return; // o motivo fica escrito na caixa; a confirmação fecha
			}
			toast("Instância recriada", { kind: "ok" });
			say("Instância recriada. Atualizando…");
			timers.push(setTimeout(() => ctx.refresh(), 1500));
		}
	});
	const logout = h("button", {
		type: "button",
		class: "btn btn-danger btn-quiet",
		"data-key": "desconectar",
		text: "Desconectar"
	});
	confirmInline(logout, {
		question: `Desconectar a sessão de ${name}?`,
		confirmLabel: "Desconectar",
		onConfirm: async () => {
			say("Desconectando…");
			try {
				await botAction(bot, `/logout/${id}`, `desconectar ${name}`);
			} catch (err) {
				say("");
				out.set("error", err.message);
				return; // o motivo fica escrito na caixa; a confirmação fecha
			}
			toast(`${name} desconectada`, { kind: "ok" });
			ctx.refresh();
		}
	});
	const refresh = h("button", {
		type: "button",
		class: "btn btn-quiet",
		text: "Atualizar",
		onclick: () => ctx.refresh()
	});
	const actions = h(
		"div",
		{ class: "inst-actions" },
		reconnect,
		recreate,
		refresh,
		h("span", { class: "spacer" }),
		logout
	);
	const tip = note(
		"Tentar reconectar: use antes de recriar, principalmente quando o bot ficou muitas horas fora do ar."
	);
	const legacy = h(
		"p",
		{ class: "faint inst-legacy" },
		"Página antiga de pareamento: ",
		h("a", {
			href: `/qrcode/${id}`,
			target: "_blank",
			rel: "noopener",
			text: `/qrcode/${bot.nome} ↗`
		})
	);

	// Sem o bot carregado neste processo, as rotas respondem 404: explica antes de tentar.
	if (!bot.isLive) {
		root.append(
			h(
				"div",
				{ class: "notice", role: "note" },
				lamp("off"),
				h("span", {
					text: "O processo desta instância não está carregado neste servidor (ela foi criada ou reativada depois da subida, ou está desativada). O pareamento só funciona com o bot de pé: reinicie a Ravena e volte aqui."
				})
			),
			out.el,
			card({ title: "Ações", body: [actions, msg] }),
			tip,
			legacy
		);
		return () => timers.forEach(clearTimeout);
	}

	// Estado da conexão.
	let st;
	try {
		st = await botFetch(bot, `/qrcode-status/${id}`);
	} catch (err) {
		root.append(
			h(
				"div",
				{ class: "notice error", role: "alert" },
				lamp("down"),
				h("span", { text: explain(err, "consultar a conexão desta instância na WhatsGoAPI") })
			),
			out.el,
			card({ title: "Ações", body: [actions, msg] }),
			tip,
			legacy
		);
		return () => timers.forEach(clearTimeout);
	}
	const connected = !!st.connected;
	const exists = !!st.instanceExists;
	const badge = connected
		? lamp("ok", "conectado")
		: !exists
			? lamp("attention", "sem instância na WhatsGoAPI")
			: lamp("down", "desconectado");

	const qrImg = h("img", { class: "inst-qr", alt: `QR code para parear ${name}` });
	qrImg.hidden = true;
	const qrWait = h("p", { class: "muted", text: "Aguardando o QR code…" });
	const pairCode = h("output", {
		class: "inst-pair-code mono",
		"aria-label": "Código de pareamento",
		text: "—"
	});
	const apply = (d) => {
		if (!d) return;
		const src = qrSrc(d.qrCode);
		if (src) {
			qrImg.src = src;
			qrImg.hidden = false;
			qrWait.hidden = true;
		}
		const code = d.pairingCode || d.code || "";
		if (code) pairCode.textContent = String(code);
	};

	const parts = [out.el, card({ title: "Conexão", pill: badge, body: [actions, msg] })];
	if (!connected) {
		parts.push(
			h(
				"div",
				{ class: "notice", role: "note" },
				lamp("attention"),
				h("span", {
					text: "Desconectada por mais de 15 minutos, a instância é apagada automaticamente."
				})
			)
		);
		if (exists) {
			parts.push(
				h(
					"div",
					{ class: "inst-pair-grid" },
					card({ title: "QR code", body: h("div", { class: "inst-qr-box" }, qrImg, qrWait) }),
					card({
						title: "Código de pareamento",
						body: [
							pairCode,
							h("p", {
								class: "fld-hint",
								text: "No WhatsApp: Aparelhos conectados › Conectar com número de telefone."
							})
						]
					})
				)
			);
		}
	}
	parts.push(tip, legacy);
	root.append(...parts);

	// Verificação periódica: muda de estado → redesenha (4 s desconectado, 5 s conectado).
	const check = async () => {
		if (closed || root.querySelector(".confirm")) return;
		try {
			const d = await botFetch(bot, `/qrcode-status/${id}`);
			if (!!d.connected !== connected && !closed) ctx.refresh();
		} catch {
			/* a próxima volta tenta de novo */
		}
	};
	const iv = setInterval(check, connected ? 5000 : 4000);

	if (!connected && !exists) {
		say('A instância não existe na WhatsGoAPI. Use "Tentar reconectar" ou "Recriar instância".');
	}
	if (!connected && exists) {
		const start = () => {
			if (closed) return;
			const auth = botAuth(bot);
			// EventSource não manda cabeçalho: a credencial vai no ?auth= (como a página /qrcode).
			es = new EventSource(
				`/qrcode-stream/${id}${auth ? `?auth=${encodeURIComponent(auth)}` : ""}`
			);
			es.onmessage = (e) => {
				let d;
				try {
					d = JSON.parse(e.data);
				} catch {
					return;
				}
				if (d.type === "qr_update") apply(d);
				else if (d.type === "connected") {
					toast(`${name} conectada`, { kind: "ok" });
					ctx.refresh();
				} else if (d.type === "instance_deleted") {
					say(
						"A instância foi apagada no servidor (ficou desconectada tempo demais). Use Recriar."
					);
				}
			};
			es.onerror = () => {
				if (es) es.close();
				es = null;
				if (!closed) timers.push(setTimeout(start, 5000));
			};
		};
		start();
		say("Iniciando conexão…");
		// Sem await: a tela aparece já, e o QR chega pelo SSE ou pela resposta.
		botFetch(bot, `/qrcode-initconnect/${id}`).then(
			(d) => {
				if (closed) return;
				if (d.connected || (d.extra && d.extra.ok)) ctx.refresh();
				else {
					if (d.extra && d.extra.connectData) apply(d.extra.connectData);
					say("Fluxo de conexão iniciado. Leia o QR code ou use o código no celular.");
				}
			},
			(err) => {
				if (closed) return;
				say("");
				out.set("error", explain(err, "iniciar a conexão"));
			}
		);
	}

	return () => {
		closed = true;
		clearInterval(iv);
		timers.forEach(clearTimeout);
		if (es) es.close();
	};
}
