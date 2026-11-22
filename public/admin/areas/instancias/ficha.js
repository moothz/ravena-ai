/*
 * Instâncias › ficha (#/instancias/<nome>[/config|/extras|/pareamento]) e nova instância
 * (#/instancias/nova → rascunho → #/instancias/<rav-NNNN>/config).
 * Resumo com as ações; Configuração com todos os campos do bots.json da tela antiga; Extras em
 * 3 níveis. O que se edita fica num rascunho (comum.js) até "Salvar", que grava o bots.json
 * inteiro com confirmação no lugar.
 */

import {
	h,
	icon,
	lamp,
	pill,
	card,
	kv,
	empty,
	note,
	crumbs,
	subnav,
	field,
	errorNotice,
	confirmInline,
	toast,
	poll,
	preserveFocus,
	fmt,
	fmt2,
	plural,
	relTime,
	dateFmt,
	buildHash
} from "../../core.js";
import {
	PLATFORM_NAMES,
	botState,
	platformOf,
	isEnabled,
	formatPhone,
	chatUrl,
	showsCemiterio,
	cleanExtraKey,
	castExtra,
	generatePassword,
	newBot
} from "./modelo.js";
import {
	loadBots,
	botHref,
	listHref,
	botAction,
	saveAll,
	getDraft,
	addNewDraft,
	peekDraft,
	dropDraft,
	pendingDrafts,
	markDirty,
	outcomeBox
} from "./comum.js";
import { renderPareamento } from "./pareamento.js";

/* ── Nova instância ────────────────────────────────────────────── */

export async function renderNova(root, ctx) {
	let bots;
	try {
		bots = await loadBots(true);
	} catch (err) {
		root.append(errorNotice(err, "as instâncias (para escolher nome e porta livres)"));
		return;
	}
	const taken = [...bots, ...pendingDrafts().map(([, d]) => d.base)];
	const bot = newBot(taken);
	addNewDraft(bot);
	toast("Nova instância criada como desativada. Preencha os campos e salve.");
	ctx.navigate(botHref(bot.nome, "config"), { replace: true });
}

/* ── Ficha ─────────────────────────────────────────────────────── */

const TABS = (nome, plat, isNew) =>
	[
		{ id: "resumo", label: "Resumo", href: botHref(nome) },
		{ id: "config", label: "Configuração", href: botHref(nome, "config") },
		{ id: "extras", label: "Extras", href: botHref(nome, "extras") },
		!isNew && plat === "whatsapp"
			? { id: "pareamento", label: "Pareamento", href: botHref(nome, "pareamento") }
			: null
	].filter(Boolean);

export async function renderFicha(root, ctx) {
	const nome = ctx.segs[0];
	const tabReq = ctx.segs[1] || "resumo";
	let bots;
	let loadErr = null;
	try {
		bots = await loadBots();
	} catch (err) {
		loadErr = err;
		bots = [];
	}
	const server = bots.find((b) => b.nome === nome) || null;
	const pend = peekDraft(nome);
	const isNew = !server && !!(pend && pend.isNew);

	root.append(crumbs([{ label: "Instâncias", href: listHref() }, { label: nome }]));
	if (loadErr && !isNew) {
		root.append(errorNotice(loadErr, `a instância ${nome}`));
		return;
	}
	if (!server && !isNew) {
		root.append(
			card({
				body: [
					empty(
						`Não há instância chamada “${nome}”.`,
						"Ela pode ter sido renomeada ou o endereço está errado."
					),
					h("p", null, h("a", { class: "btn", href: listHref(), text: "Ver todas as instâncias" }))
				]
			})
		);
		return;
	}

	const draft = isNew ? pend : getDraft(server);
	const bot = server || draft.base;
	const plat = platformOf(bot);
	const tabs = TABS(nome, plat, isNew);
	const tab = tabs.some((t) => t.id === tabReq) ? tabReq : "resumo";
	const st = isNew ? { lamp: "off", word: "nova, não salva", pill: "att" } : botState(bot);

	root.append(
		h(
			"div",
			{ class: "inst-head" },
			h("h2", { class: "inst-name", text: bot.nomeExibir || bot.nome }),
			bot.nomeExibir && bot.nomeExibir !== bot.nome
				? h("span", { class: "mono faint", text: bot.nome })
				: null,
			lamp(st.lamp, st.word),
			h("span", { class: "pill", text: PLATFORM_NAMES[plat] })
		),
		subnav(tabs, tab, { label: `Seções de ${bot.nome}` })
	);

	if (tab === "pareamento") return renderPareamento(root, ctx, bot);
	if (tab === "config") return renderConfig(root, ctx, draft);
	if (tab === "extras") return renderExtras(root, ctx, draft);
	return renderResumo(root, ctx, bot, draft, isNew);
}

/* ── Resumo ────────────────────────────────────────────────────── */

function resumoCard(bot) {
	const st = botState(bot);
	const rt = bot.responseTime || {};
	const flags = [
		["privado", "privada"],
		["vip", "VIP"],
		["comunitario", "comunitária"],
		["banido", "marcada banida"],
		["ignorePV", "ignora PV"],
		["autoDownloadPV", "download automático no PV"],
		["pvAI", "IA no PV"],
		["ignoreInvites", "ignora convites"],
		["sendJoinInfo", "manda info ao entrar"]
	]
		.filter(([k]) => bot[k])
		.map(([, l]) => pill(l));
	if (bot.updateStatus !== false) flags.push(pill("atualiza recado"));
	return card({
		title: "Agora",
		body: kv([
			["Estado", lamp(st.lamp, st.word)],
			["Processo", bot.isLive ? "carregado neste servidor" : "não carregado (sem processo do bot)"],
			["Grupos", fmt(Number(bot.groupsCount) || 0)],
			["Mensagens/h", fmt(Math.round(Number(bot.msgsHr) || 0))],
			[
				"Resposta",
				Number(rt.avg) > 0
					? `média ${fmt2(Number(rt.avg))} s · máx. ${fmt2(Number(rt.max) || 0)} s`
					: "sem dado"
			],
			[
				"Última mensagem",
				bot.lastMessageReceived
					? `${relTime(bot.lastMessageReceived)} (${dateFmt(bot.lastMessageReceived)})`
					: "sem dado"
			],
			["Número", formatPhone(bot.numero)],
			["Prefixo", h("code", { text: bot.customPrefix || "!" })],
			["Webhook", bot.webhookPort ? `porta ${bot.webhookPort}` : "—"],
			["Marcas", flags.length ? h("span", { class: "inst-flags" }, flags) : "nenhuma"]
		])
	});
}

function renderResumo(root, ctx, bot, draft, isNew) {
	const name = bot.nomeExibir || bot.nome;
	if (isNew) {
		root.append(
			note(
				"Esta instância ainda não existe no bots.json. Preencha a ",
				h("a", { href: botHref(bot.nome, "config"), text: "Configuração" }),
				" e salve; as ações (reiniciar, pareamento) aparecem depois."
			)
		);
		return;
	}
	const out = outcomeBox();
	const acts = h("div", { class: "inst-actions" });
	const enabled = isEnabled(bot);

	const restart = h(
		"button",
		{ type: "button", class: "btn", "data-key": "restart" },
		icon("recarregar"),
		"Reiniciar"
	);
	acts.append(
		confirmInline(restart, {
			question: `Reiniciar ${name}?`,
			confirmLabel: "Reiniciar",
			onConfirm: async () => {
				try {
					const msg = await botAction(
						bot,
						`/restart/${encodeURIComponent(bot.nome)}`,
						`reiniciar ${name}`
					);
					out.set("ok", `Reinício de ${name}: ${msg || "pedido aceito"}.`);
					toast(`Reiniciando ${name}`, { kind: "ok" });
					setTimeout(() => ctx.refresh(), 2500);
				} catch (err) {
					out.set("error", err.message);
					return; // o motivo fica escrito na caixa; a confirmação fecha
				}
			}
		})
	);

	const toggle = h("button", {
		type: "button",
		class: `btn${enabled ? "" : " btn-primary"}`,
		"data-key": "toggle",
		text: enabled ? "Desativar" : "Reativar"
	});
	acts.append(
		confirmInline(toggle, {
			question: enabled
				? `Desativar ${name}? Ela para de ler e responder (enabled=false no bots.json).`
				: `Reativar ${name}? Grava enabled=true no bots.json.`,
			confirmLabel: enabled ? "Desativar" : "Reativar",
			danger: enabled,
			onConfirm: async () => {
				try {
					await saveAll({ patch: { [bot.nome]: { enabled: !enabled } } });
				} catch (err) {
					out.set("error", err.message);
					return; // o motivo fica escrito na caixa; a confirmação fecha
				}
				// O rascunho, se houver, acompanha a mudança.
				if (draft) draft.values.enabled = !enabled;
				toast(`${name} ${enabled ? "desativada" : "reativada"}`, { kind: "ok" });
				ctx.refresh();
			}
		})
	);

	if (platformOf(bot) === "whatsapp") {
		acts.append(
			h("a", {
				class: "btn",
				href: botHref(bot.nome, "pareamento"),
				"data-key": "pareamento",
				text: "QR code e reconexão"
			})
		);
	}
	acts.append(
		h("a", { class: "btn btn-quiet", href: buildHash("logs", [bot.nome]), text: "Logs" })
	);
	const chat = chatUrl(bot);
	if (chat)
		acts.append(
			h(
				"a",
				{ class: "btn btn-quiet", href: chat, target: "_blank", rel: "noopener" },
				"Abrir conversa",
				h("span", { class: "ext", "aria-hidden": "true", text: " ↗" }),
				h("span", { class: "sr-only", text: " (abre em outra aba)" })
			)
		);

	const logout = h("button", {
		type: "button",
		class: "btn btn-danger btn-quiet",
		"data-key": "logout",
		text: "Desconectar sessão"
	});
	acts.append(
		h("span", { class: "spacer" }),
		confirmInline(logout, {
			question: `Desconectar a sessão de ${name}? Depois é preciso parear de novo.`,
			confirmLabel: "Desconectar",
			onConfirm: async () => {
				try {
					const msg = await botAction(
						bot,
						`/logout/${encodeURIComponent(bot.nome)}`,
						`desconectar ${name}`
					);
					out.set("ok", `Logout de ${name}: ${msg || "feito"}.`);
					toast(`${name} desconectada`, { kind: "ok" });
					setTimeout(() => ctx.refresh(), 2500);
				} catch (err) {
					out.set("error", err.message);
					return; // o motivo fica escrito na caixa; a confirmação fecha
				}
			}
		})
	);

	const box = h("div", { class: "stack" }, resumoCard(bot));
	root.append(out.el, card({ title: "Ações", body: acts }), box);
	if (draft && draft.dirty)
		root.prepend(
			h(
				"div",
				{ class: "notice inst-pending", role: "status" },
				lamp("attention"),
				h(
					"span",
					null,
					"Há alterações não salvas na ",
					h("a", { href: botHref(bot.nome, "config"), text: "Configuração" }),
					"."
				)
			)
		);

	const stop = poll(async () => {
		if (root.querySelector(".confirm")) return;
		try {
			const fresh = (await loadBots(true)).find((b) => b.nome === bot.nome);
			if (fresh) await preserveFocus(box, () => box.replaceChildren(resumoCard(fresh)));
		} catch {
			/* tenta na próxima volta */
		}
	}, 30000);
	return stop;
}

/* ── Barra de salvar (Configuração e Extras) ───────────────────── */

function saveBar(ctx, draft) {
	const state = h("span", { class: "inst-save-state", "aria-live": "polite" });
	const out = outcomeBox();
	const others = () => pendingDrafts().filter(([n]) => n !== draft.base.nome);

	const save = h("button", {
		type: "button",
		class: "btn btn-primary",
		"data-key": "salvar",
		text: "Salvar"
	});
	confirmInline(save, {
		// Lida a cada clique: a pergunta diz se outras instâncias também têm rascunho.
		get question() {
			const n = others().length;
			return `Gravar o bots.json${n ? ` (com as alterações de mais ${plural(n, "instância", "instâncias")})` : ""}? Vale na hora.`;
		},
		confirmLabel: "Gravar bots.json",
		danger: false,
		onConfirm: async () => {
			let r;
			try {
				r = await saveAll();
			} catch (err) {
				out.set("error", err.message);
				return; // o motivo fica escrito na caixa; a confirmação fecha
			}
			out.clear();
			const nomeNovo = draft.isNew ? r.finalName[draft.base.nome] || draft.base.nome : null;
			toast(
				r.saved.length > 1
					? `${plural(r.saved.length, "instância salva", "instâncias salvas")} e sincronizadas`
					: `Instância '${nomeNovo || draft.base.nome}' salva e sincronizada`,
				{ kind: "ok" }
			);
			if (nomeNovo) ctx.navigate(botHref(nomeNovo), { replace: true });
			else ctx.refresh();
		}
	});

	const discard = h("button", {
		type: "button",
		class: "btn btn-quiet",
		"data-key": "descartar",
		text: draft.isNew ? "Descartar instância" : "Descartar alterações"
	});
	confirmInline(discard, {
		question: draft.isNew
			? "Descartar esta instância nova?"
			: "Descartar as alterações desta instância?",
		confirmLabel: "Descartar",
		onConfirm: () => {
			dropDraft(draft.base.nome);
			window.dispatchEvent(new CustomEvent("instancias:dirty"));
			toast("Alterações descartadas");
			if (draft.isNew) ctx.navigate(listHref(), { replace: true });
			else ctx.refresh();
		}
	});

	const sync = () => {
		state.replaceChildren(
			draft.dirty
				? lamp("attention", draft.isNew ? "nova, ainda não salva" : "alterações não salvas")
				: lamp("ok", "sem alterações")
		);
		discard.hidden = !draft.dirty;
		// Sem nada pendente (nem em outra instância), não há o que gravar.
		save.disabled = !pendingDrafts().length;
	};
	sync();
	window.addEventListener("instancias:dirty", sync);
	return {
		el: h(
			"div",
			{ class: "stack" },
			out.el,
			h("div", { class: "card inst-savebar" }, state, h("span", { class: "spacer" }), discard, save)
		),
		stop: () => window.removeEventListener("instancias:dirty", sync)
	};
}

/* ── Configuração ──────────────────────────────────────────────── */

function bindField(label, draft, name) {
	const c = label.querySelector("input, select, textarea");
	const ev = c.type === "checkbox" || c.tagName === "SELECT" ? "change" : "input";
	c.dataset.key = `cfg-${name}`;
	c.addEventListener(ev, () => {
		draft.values[name] = c.type === "checkbox" ? c.checked : c.value;
		markDirty(draft);
	});
	return label;
}

function renderConfig(root, ctx, draft) {
	const v = draft.values;
	const f = (o) => bindField(field({ ...o, value: v[o.name] }), draft, o.name);
	const flag = (name, label, hint) => f({ name, label, hint, type: "checkbox" });

	// Senha do painel: mostrar/ocultar e gerar.
	const pw = f({
		name: "managementPW",
		label: "Senha do painel (managementPW)",
		type: "password",
		hint: "Senha de acesso ao painel do grupo.",
		attrs: { autocomplete: "new-password" }
	});
	const pwInput = pw.querySelector("input");
	const showBtn = h("button", {
		type: "button",
		class: "btn btn-quiet",
		"aria-pressed": "false",
		text: "Mostrar"
	});
	showBtn.addEventListener("click", () => {
		const show = pwInput.type === "password";
		pwInput.type = show ? "text" : "password";
		showBtn.textContent = show ? "Ocultar" : "Mostrar";
		showBtn.setAttribute("aria-pressed", String(show));
	});
	const genBtn = h("button", { type: "button", class: "btn btn-quiet", text: "Gerar senha" });
	genBtn.addEventListener("click", () => {
		pwInput.value = generatePassword(16);
		pwInput.type = "text";
		showBtn.textContent = "Ocultar";
		showBtn.setAttribute("aria-pressed", "true");
		v.managementPW = pwInput.value;
		markDirty(draft);
		toast(`Nova senha gerada para '${v.nome}'. Lembre-se de salvar.`);
	});

	const platSel = f({
		name: "plataforma",
		label: "Plataforma",
		type: "select",
		wide: true,
		hint: "Define a plataforma desta instância; abaixo aparecem só os campos dela.",
		options: [
			{ value: "whatsapp", label: "WhatsApp" },
			{ value: "telegram", label: "Telegram" },
			{ value: "discord", label: "Discord" }
		]
	});

	const tg = card({
		title: "Telegram",
		body: h(
			"div",
			{ class: "form" },
			f({
				name: "telegramBotToken",
				label: "Token do bot (telegramBotToken)",
				type: "password",
				placeholder: "Token do BotFather",
				attrs: { autocomplete: "off" }
			}),
			f({
				name: "telegramBotName",
				label: "Nome do bot (telegramBotName)",
				placeholder: "ex: ravenosabot"
			}),
			f({
				name: "telegramBotId",
				label: "ID do bot (telegramBotId)",
				placeholder: "ex: 8402791288"
			}),
			f({
				name: "webhookHost",
				label: "Webhook host (webhookHost)",
				placeholder: "ex: rav-telegram.moothz.com"
			})
		)
	});
	const dc = card({
		title: "Discord",
		body: h(
			"div",
			{ class: "form" },
			f({
				name: "discordToken",
				label: "Token do bot (discordToken)",
				type: "password",
				wide: true,
				placeholder: "Token da aplicação no Discord Developer Portal",
				attrs: { autocomplete: "off" }
			})
		)
	});
	const syncPlat = () => {
		tg.hidden = v.plataforma !== "telegram";
		dc.hidden = v.plataforma !== "discord";
	};
	platSel.querySelector("select").addEventListener("change", syncPlat);

	const cem = card({
		title: "Cemitério (instância banida)",
		body: h(
			"div",
			{ class: "form" },
			f({
				name: "dataNascimento",
				label: "Data de nascimento (dataNascimento)",
				placeholder: "ex: 15/01/2023 ou 2023-01-15",
				hint: "Quando a botinha entrou em operação (opcional)."
			}),
			f({
				name: "dataMorte",
				label: "Data do ban (dataMorte)",
				placeholder: "ex: 20/11/2026 ou 2026-11-20",
				hint: "Quando a botinha foi banida (opcional)."
			})
		)
	});
	const syncCem = () => {
		cem.hidden = !showsCemiterio(v);
	};

	const privHint = h("span", { class: "fld-hint inst-priv-hint" });
	const syncPriv = () => {
		privHint.textContent = v.privado
			? "Bot privado: rate limit e atraso orgânico zerados por padrão."
			: "";
		privHint.hidden = !v.privado;
	};

	const flags = h(
		"div",
		{ class: "form inst-flags-form" },
		flag("enabled", "Instância ativa", "Habilita ou desativa a leitura e as respostas."),
		flag("privado", "Instância privada", "Restrita a grupos do proprietário."),
		flag("vip", "Bot VIP", "Atributos prioritários e limites VIP."),
		flag("comunitario", "Comunitária", "Mantida por membro da comunidade."),
		flag("ignorePV", "Ignorar PV", "Não responde mensagens privadas."),
		flag("autoDownloadPV", "Download automático no PV", "Baixa mídias de links enviados no PV."),
		flag("pvAI", "IA no privado (pvAI)", "Conversa com IA em mensagens privadas."),
		flag("ignoreInvites", "Ignorar convites", "Não entra automaticamente por links."),
		flag("updateStatus", "Atualizar status", "Atualiza o recado do perfil no agendador."),
		flag("sendJoinInfo", "Enviar info ao entrar", "Manda mensagem de boas-vindas ao grupo."),
		flag("banido", "Marcada banida", "Identifica instância com bloqueio oficial.")
	);
	flags.addEventListener("change", () => {
		syncCem();
		syncPriv();
	});

	const bar = saveBar(ctx, draft);
	root.append(
		card({ title: "Tipo de bot", body: h("div", { class: "form" }, platSel) }),
		card({
			title: "Identificação e acesso ao painel",
			body: h(
				"div",
				{ class: "form" },
				f({
					name: "nome",
					label: "Identificador único (nome)",
					required: true,
					placeholder: "ex: ravena1",
					hint: draft.isNew
						? "Nome único no bots.json; não muda depois de criada."
						: "Não editável depois de criada.",
					attrs: draft.isNew ? { spellcheck: "false" } : { readonly: true }
				}),
				f({
					name: "nomeExibir",
					label: "Nome de exibição (nomeExibir)",
					placeholder: "ex: Ravena VIP",
					hint: "Nome amigável nas saudações e menus."
				}),
				f({
					name: "numero",
					label: "Número de telefone (numero)",
					placeholder: "ex: 5511999999999",
					hint: "Número internacional sem símbolos (obrigatório, exceto no Discord).",
					attrs: { inputmode: "numeric" }
				}),
				f({
					name: "customPrefix",
					label: "Prefixo (customPrefix)",
					placeholder: "ex: ! ou /",
					hint: "Símbolo que aciona comandos nesta instância.",
					attrs: { maxlength: 3 }
				}),
				f({
					name: "managementUser",
					label: "Usuário do painel (managementUser)",
					placeholder: "ex: admin",
					hint: "Usuário de acesso a /manage.",
					attrs: { autocomplete: "off" }
				}),
				h("div", { class: "inst-pw" }, pw, h("div", { class: "inst-pw-acts" }, showBtn, genBtn))
			)
		}),
		card({ title: "Comportamento", body: flags }),
		cem,
		card({
			title: "Personalidade da IA e suporte",
			body: h(
				"div",
				{ class: "form" },
				f({
					name: "aiPersonality",
					label: "Personalidade da IA (aiPersonality)",
					type: "textarea",
					wide: true,
					rows: 4,
					placeholder: "ex: bem-humorada, debochada, formal…",
					hint: "Entra como contexto de sistema nos comandos de IA deste bot."
				}),
				f({
					name: "msgSuporte",
					label: "Mensagem de suporte (msgSuporte)",
					type: "textarea",
					wide: true,
					placeholder: "Mensagem enviada ao pedir suporte…",
					hint: "Texto de contato com o administrador."
				}),
				f({
					name: "numeroResponsavel",
					label: "Número do responsável (numeroResponsavel)",
					placeholder: "ex: 5511999998888",
					hint: "Contato do ADM ou dono desta ravena comunitária.",
					attrs: { inputmode: "numeric" }
				})
			)
		}),
		card({
			title: "Grupos e canais",
			body: h(
				"div",
				{ class: "form" },
				f({
					name: "grupoLogs",
					label: "Grupo de logs (grupoLogs)",
					placeholder: "ex: 1203634…@g.us",
					hint: "JID do grupo que recebe os logs."
				}),
				f({
					name: "grupoAvisos",
					label: "Grupo de avisos (grupoAvisos)",
					placeholder: "ex: 1203634…@g.us",
					hint: "JID do grupo de comunicados."
				}),
				f({
					name: "grupoInvites",
					label: "Grupo de convites (grupoInvites)",
					placeholder: "ex: 1203634…@g.us",
					hint: "JID do grupo de triagem de convites."
				}),
				f({
					name: "dossieGroups",
					label: "Grupo de dossiês (dossieGroups)",
					placeholder: "ex: 1203634…@g.us",
					hint: "JID para os dossiês automáticos."
				}),
				f({
					name: "webhookPort",
					label: "Porta do webhook (webhookPort)",
					type: "number",
					placeholder: "ex: 6200",
					hint: "Porta HTTP dos eventos do Whatsmeow Go."
				})
			)
		}),
		card({
			title: "Envio e limpeza",
			body: h(
				"div",
				{ class: "form" },
				f({
					name: "ratelimit",
					label: "Limite de envio por minuto (ratelimit)",
					type: "number",
					placeholder: "0 = sem limite",
					hint: "0 = sem limite. Sugerido: 15 para bots públicos. Reações valem 1/3 de mensagem; acima de 50% da cota os envios começam a atrasar.",
					attrs: { min: 0, max: 600, step: 1 }
				}),
				f({
					name: "delayMin",
					label: "Atraso orgânico mínimo, s (delayMin)",
					type: "number",
					hint: "Atraso mínimo antes de cada mensagem.",
					attrs: { min: 0, max: 5, step: "any" }
				}),
				f({
					name: "delayMax",
					label: "Atraso orgânico máximo, s (delayMax)",
					type: "number",
					hint: "O atraso é sorteado entre o mínimo e o máximo.",
					attrs: { min: 0, max: 5, step: "any" }
				}),
				f({
					name: "deleteMessagesInterval",
					label: "Limpeza de mensagens (deleteMessagesInterval)",
					placeholder: "false ou dias (ex: 3 ou 7)",
					hint: "false = nunca apaga; 3 = a cada 3 dias; 7 = semanal, às 03:30, pelo ClearChat."
				}),
				h("div", { class: "wide" }, privHint)
			)
		}),
		tg,
		dc,
		bar.el
	);
	syncPlat();
	syncCem();
	syncPriv();
	return bar.stop;
}

/* ── Extras (3 níveis) ─────────────────────────────────────────── */

function renderExtras(root, ctx, draft) {
	const list = h("div", { class: "stack" });
	const out = h("p", { class: "inst-inline-err", role: "alert" });

	function inlineAdd({ label, placeholder, button, onAdd, key }) {
		const input = h("input", {
			type: "text",
			placeholder,
			"aria-label": label,
			"data-key": key,
			spellcheck: "false",
			autocomplete: "off"
		});
		const err = h("span", { class: "inst-inline-err", role: "alert" });
		const go = () => {
			const problem = onAdd(input.value);
			if (problem) {
				err.textContent = problem;
				input.focus();
			} else {
				err.textContent = "";
				input.value = "";
			}
		};
		input.addEventListener("keydown", (ev) => {
			if (ev.key === "Enter") {
				ev.preventDefault();
				go();
			}
		});
		return h(
			"div",
			{ class: "inst-add" },
			h("span", { class: "search-box" }, input),
			h("button", { type: "button", class: "btn", text: button, onclick: go }),
			err
		);
	}

	function valueControl(p, label) {
		let c;
		if (p.type === "boolean") {
			c = h(
				"select",
				{ "aria-label": label },
				h("option", { value: "true", text: "true (verdadeiro)", selected: p.value === true }),
				h("option", { value: "false", text: "false (falso)", selected: p.value !== true })
			);
			c.addEventListener("change", () => {
				p.value = c.value === "true";
				markDirty(draft);
			});
		} else {
			c = h("input", {
				type: p.type === "number" ? "number" : "text",
				"aria-label": label,
				step: p.type === "number" ? "any" : null
			});
			c.value = p.type === "number" ? String(Number(p.value) || 0) : String(p.value ?? "");
			c.addEventListener("input", () => {
				p.value = p.type === "number" ? Number(c.value) || 0 : c.value;
				markDirty(draft);
			});
		}
		return c;
	}

	function propRow(cat, p) {
		const keyIn = h("input", {
			type: "text",
			"aria-label": `Nome da propriedade em ${cat.key}`,
			spellcheck: "false"
		});
		keyIn.value = p.key;
		keyIn.addEventListener("input", () => {
			p.key = keyIn.value;
			markDirty(draft);
		});
		const typeSel = h(
			"select",
			{ "aria-label": `Tipo de ${p.key || "propriedade"}` },
			[
				["string", "Texto"],
				["number", "Número"],
				["boolean", "Booleano"]
			].map(([val, l]) => h("option", { value: val, text: l, selected: p.type === val }))
		);
		const valBox = h(
			"span",
			{ class: "inst-prop-val" },
			valueControl(p, `Valor de ${p.key || "propriedade"}`)
		);
		typeSel.addEventListener("change", () => {
			p.value = castExtra(p.value, typeSel.value);
			p.type = typeSel.value;
			valBox.replaceChildren(valueControl(p, `Valor de ${p.key || "propriedade"}`));
			markDirty(draft);
		});
		const del = h("button", {
			type: "button",
			class: "btn btn-quiet btn-danger",
			"aria-label": `Excluir a propriedade ${p.key || ""}`,
			text: "Excluir",
			onclick: () => {
				cat.props.splice(cat.props.indexOf(p), 1);
				markDirty(draft);
				draw();
			}
		});
		return h("div", { class: "inst-prop" }, keyIn, typeSel, valBox, del);
	}

	function catCard(cat) {
		const delCat = h("button", {
			type: "button",
			class: "btn btn-quiet btn-danger",
			text: "Remover categoria"
		});
		confirmInline(delCat, {
			question: `Remover a categoria '${cat.key}' e todas as propriedades dela?`,
			confirmLabel: "Remover",
			onConfirm: () => {
				draft.extras.splice(draft.extras.indexOf(cat), 1);
				markDirty(draft);
				draw();
			}
		});
		return card({
			title: cat.key,
			actions: delCat,
			body: [
				cat.props.length
					? h(
							"div",
							{ class: "inst-props" },
							cat.props.map((p) => propRow(cat, p))
						)
					: h("p", { class: "muted", text: "Nenhuma propriedade nesta categoria." }),
				inlineAdd({
					label: `Nova propriedade em ${cat.key}`,
					placeholder: "nova propriedade",
					button: "Adicionar propriedade",
					key: `addprop-${cat.key}`,
					onAdd: (raw) => {
						const k = cleanExtraKey(raw);
						if (!k) return "Nome inválido: use letras, números, _ ou -.";
						if (cat.props.some((p) => p.key === k))
							return `A propriedade '${k}' já existe nesta categoria.`;
						cat.props.push({ key: k, type: "string", value: "" });
						markDirty(draft);
						draw();
						return null;
					}
				})
			]
		});
	}

	function draw() {
		preserveFocus(list, () =>
			list.replaceChildren(
				...(draft.extras.length
					? draft.extras.map(catCard)
					: [
							card({
								body: empty(
									"Nenhum parâmetro extra configurado.",
									"Crie uma categoria abaixo se precisar de regras extras (ex.: stickers.maxFiga)."
								)
							})
						])
			)
		);
	}

	const bar = saveBar(ctx, draft);
	root.append(
		note(
			"Extras em 3 níveis: extras → categoria → propriedade. Valores só de texto, número ou booleano."
		),
		list,
		card({
			title: "Nova categoria",
			body: inlineAdd({
				label: "Nome da nova categoria de extras",
				placeholder: "ex: stickers, jogos, ai",
				button: "Adicionar categoria",
				key: "addcat",
				onAdd: (raw) => {
					const k = cleanExtraKey(raw);
					if (!k) return "Nome inválido: use letras, números, _ ou -.";
					if (draft.extras.some((c) => c.key === k)) return `A categoria '${k}' já existe.`;
					draft.extras.push({ key: k, props: [] });
					markDirty(draft);
					draw();
					toast(`Categoria '${k}' adicionada aos extras`);
					return null;
				}
			})
		}),
		out,
		bar.el
	);
	draw();
	return bar.stop;
}
