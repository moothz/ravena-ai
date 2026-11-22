/*
 * Pessoas e grupos: junta as antigas /dossies (dossiês da memória da IA, RME) e
 * /groups-dossier (histórico das análises de moderação dos grupos). Só leitura.
 *
 * Rotas:
 *   #/pessoas                lista de pessoas      (GET /api/dossies/users?q=&limit=50)
 *   #/pessoas/grupos         lista de grupos       (GET /api/dossies/groups?q=&limit=50
 *                                                   + GET /api/groups-dossier, juntas pelo id)
 *   #/pessoas/pessoa/<id>    Dossiê 360º           (GET /api/dossies/user/:id; "Abrir no Banco"
 *                                                   via GET /api/games/bank/admin/users?q=)
 *   #/pessoas/grupo/<id>     ficha do grupo        (as duas leituras dos grupos)
 *   ?q=                      busca (vale para as duas abas, como o campo único da tela antiga)
 * Paridade item a item: scratchpad/paridade-pessoas.md.
 */

import {
	h,
	api,
	settle,
	subnav,
	searchBox,
	card,
	rows,
	rowItem,
	loadAreaCss,
	kv,
	tiles,
	crumbs,
	pill,
	note,
	empty,
	icon,
	errorNotice,
	buildHash,
	dateFmt,
	fmt,
	plural
} from "../core.js";
import {
	LIST_LIMIT,
	riskLevel,
	scoreText,
	parseTopics,
	mergeGroups,
	searchGroups,
	bankCandidates,
	pickBankAccount,
	platformLabel,
	personId,
	toMs
} from "./pessoas/lib.js";

const AREA = "pessoas";
const enc = encodeURIComponent;

/** Aba ativa a partir da sub-rota. */
function tabOf(segs) {
	const s = segs[0];
	return s === "grupos" || s === "grupo" ? "grupos" : "pessoas";
}

const listHash = (tab, q) => buildHash(AREA, tab === "grupos" ? ["grupos"] : [], q ? { q } : null);

/** Pílula da nota de risco, sempre com a palavra (nunca só cor). */
function riskPill(score, prefix = "risco") {
	const r = riskLevel(score);
	if (!r.level) return pill(`${prefix} —`);
	return pill(`${prefix} ${r.level} ${scoreText(score)}`, r.kind);
}

function retryButton(ctx) {
	return h(
		"button",
		{ type: "button", class: "btn", "data-key": "tentar", onclick: () => ctx.refresh() },
		icon("recarregar"),
		"Tentar novamente"
	);
}

const failure = (err, what, ctx) =>
	h("div", { class: "stack" }, errorNotice(err, what), h("div", null, retryButton(ctx)));

const kg = (n) =>
	new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(
		Number(n) || 0
	);
const brl = (n) =>
	new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(n) || 0);
const when = (v) => {
	const ms = toMs(v);
	return ms ? dateFmt(ms) : "—";
};
const mono = (text) => h("span", { class: "mono", text: String(text ?? "—") });

/* ── Lista de pessoas ──────────────────────────────────────────── */

async function renderPeople(root, ctx, q) {
	root.append(
		searchBox({
			label: "Buscar pessoa",
			placeholder: "Buscar por nome, número, LID ou id canônico",
			value: q,
			delay: 300,
			onSearch: (v) => ctx.navigate(listHash("pessoas", v), { replace: true })
		})
	);
	let users;
	try {
		users = await api(`/api/dossies/users?q=${enc(q)}&limit=${LIST_LIMIT}`);
	} catch (err) {
		root.append(failure(err, "a lista de pessoas", ctx));
		return;
	}
	if (!Array.isArray(users) || !users.length) {
		root.append(
			card({
				body: empty("Nenhuma pessoa encontrada na memória.", q ? `Nada com “${q}”.` : null)
			})
		);
		return;
	}
	root.append(
		rows(
			users.map((u) => {
				const id = personId(u);
				const line1 = [platformLabel(u.platform)];
				if (Number(u.facts_count) > 0)
					line1.push(plural(Number(u.facts_count), "fato IA", "fatos IA"));
				return rowItem({
					icon: "pessoas",
					title: u.display_name || "Membro",
					status: h(
						"span",
						{ class: "pz-subs" },
						h("span", { class: "rw-sub", text: line1.join(" · ") }),
						h("span", {
							class: "rw-sub mono pz-ids",
							text: `ID ${u.platform_id || "—"} · canônico ${u.canonical_user_id || "—"}`
						})
					),
					href: buildHash(AREA, ["pessoa", id]),
					key: `pessoa-${id}`
				});
			}),
			{ label: "Pessoas" }
		)
	);
	if (users.length >= LIST_LIMIT) {
		root.append(
			note(
				`Mostrando as ${LIST_LIMIT} primeiras (mais fatos primeiro). Refine a busca para achar outras.`
			)
		);
	}
}

/* ── Lista de grupos ───────────────────────────────────────────── */

/**
 * Perfis (busca do servidor), análises (todas) e, com busca na lista, também os perfis sem
 * busca: a busca pode casar só nas análises e a nota do grupo ainda precisa do perfil.
 */
async function loadGroups(q, { withAll = false } = {}) {
	const s = await settle({
		profiles: api(`/api/dossies/groups?q=${enc(q)}&limit=${LIST_LIMIT}`),
		analyses: api("/api/groups-dossier"),
		...(withAll && q ? { all: api(`/api/dossies/groups?q=&limit=${LIST_LIMIT}`) } : {})
	});
	const analyses = Array.isArray(s.analyses) ? s.analyses : [];
	return {
		s,
		analyses,
		profiles: Array.isArray(s.profiles) ? s.profiles : [],
		all: Array.isArray(s.all) ? s.all : []
	};
}

function groupStatus(g) {
	const bits = [];
	if (g.dossiers !== null) bits.push(plural(g.dossiers, "dossiê", "dossiês"));
	if (g.analysesCount !== null) bits.push(plural(g.analysesCount, "análise", "análises"));
	if (g.reports) bits.push(plural(g.reports, "alerta", "alertas"));
	if (g.bot) bits.push(g.bot);
	return h(
		"span",
		{ class: "rw-sub pz-line" },
		riskPill(g.score),
		h("span", { text: bits.join(" · ") })
	);
}

async function renderGroups(root, ctx, q) {
	root.append(
		searchBox({
			label: "Buscar grupo",
			placeholder: "Buscar grupo por nome, id, tópico ou resumo",
			value: q,
			delay: 300,
			onSearch: (v) => ctx.navigate(listHash("grupos", v), { replace: true })
		})
	);
	const { s, analyses, profiles, all } = await loadGroups(q, { withAll: true });
	if (s.profilesError && s.analysesError) {
		root.append(failure(s.profilesError, "a lista de grupos", ctx));
		return;
	}
	if (s.profilesError)
		root.append(errorNotice(s.profilesError, "os perfis de grupo da memória (RME)"));
	if (s.analysesError)
		root.append(errorNotice(s.analysesError, "o histórico de análises dos grupos"));

	const list = searchGroups({ matched: profiles, all, analyses, q });
	root.append(
		note(
			"Ordenados pela nota de risco, maior primeiro. Junta o perfil que a IA mantém de cada grupo e o histórico das análises de moderação, refeito sozinho a cada 10.000 novos caracteres."
		)
	);
	if (!list.length) {
		root.append(
			card({ body: empty("Nenhum grupo encontrado na memória.", q ? `Nada com “${q}”.` : null) })
		);
		return;
	}
	root.append(
		rows(
			list.map((g) =>
				rowItem({
					icon: "pessoas",
					title: g.name,
					status: groupStatus(g),
					href: buildHash(AREA, ["grupo", g.id]),
					key: `grupo-${g.id}`
				})
			),
			{ label: "Grupos" }
		)
	);
	if (profiles.length >= LIST_LIMIT) {
		root.append(
			note(
				`A memória devolveu os ${LIST_LIMIT} primeiros perfis. Refine a busca para achar outros.`
			)
		);
	}
}

/* ── Ficha do grupo ────────────────────────────────────────────── */

async function renderGroup(root, ctx, id) {
	const { s, analyses, profiles } = await loadGroups(id);
	const profile = profiles.find((p) => String(p.group_id) === id) || null;
	const analysis = analyses.find((a) => String(a.id) === id) || null;
	const g = mergeGroups(profile ? [profile] : [], analysis ? [analysis] : [])[0] || null;

	root.append(crumbs([{ label: "Grupos", href: listHash("grupos") }, { label: g ? g.name : id }]));
	if (s.profilesError && s.analysesError) {
		root.append(failure(s.profilesError, "o dossiê do grupo", ctx));
		return;
	}
	if (s.profilesError)
		root.append(errorNotice(s.profilesError, "o perfil do grupo na memória (RME)"));
	if (s.analysesError) root.append(errorNotice(s.analysesError, "o histórico de análises"));
	if (!g) {
		root.append(
			card({
				body: [
					empty("Este grupo não tem dossiê na memória nem análise registrada."),
					kv([["ID", mono(id)]])
				]
			})
		);
		return;
	}

	// Resumo: números das duas fontes.
	const summaryPairs = [["ID", mono(g.id)]];
	if (g.bot) summaryPairs.push(["Instância", g.bot]);
	if (analysis) {
		summaryPairs.push(["Caracteres analisados", fmt(Number(analysis.total_chars) || 0)]);
		summaryPairs.push(["Pendentes", `${fmt(Number(analysis.pending_chars) || 0)} caracteres`]);
	}
	root.append(
		card({
			title: g.name,
			pill: riskPill(g.score),
			body: [
				tiles([
					profile
						? {
								label: "Risco (memória)",
								value: scoreText(g.profileScore),
								detail: riskLevel(g.profileScore).level || ""
							}
						: null,
					analysis
						? {
								label: "Média das análises",
								value: scoreText(g.avg),
								detail: riskLevel(g.avg).level || ""
							}
						: null,
					analysis
						? { label: "Maior nota", value: scoreText(g.max), detail: riskLevel(g.max).level || "" }
						: null,
					profile
						? {
								label: "Dossiês",
								value: fmt(g.dossiers),
								detail: g.reports ? `${fmt(g.reports)} com alerta` : "nenhum alerta"
							}
						: null
				]),
				kv(summaryPairs)
			]
		})
	);

	// Perfil vivo da memória (antiga /dossies, aba Grupos).
	if (profile) {
		const topics = parseTopics(profile.frequent_topics);
		const pairs = [
			["Vibe", h("em", { text: profile.vibe_summary || "descontraído" })],
			["Último resumo", profile.latest_summary || "Nenhum resumo recente gerado."],
			[
				"Tópicos recorrentes",
				topics.length
					? h(
							"span",
							{ class: "pz-pills" },
							topics.map((t) => pill(t))
						)
					: h("span", { class: "muted", text: "Não catalogados" })
			]
		];
		if (profile.group_rules_culture) pairs.push(["Cultura e regras", profile.group_rules_culture]);
		if (profile.bot_personality_hint)
			pairs.push(["Dica de personalidade", profile.bot_personality_hint]);
		if (Number(profile.total_messages_analyzed) > 0)
			pairs.push(["Mensagens analisadas", fmt(Number(profile.total_messages_analyzed))]);
		if (toMs(profile.last_summarized_at))
			pairs.push(["Resumo gerado em", when(profile.last_summarized_at)]);
		root.append(card({ title: "Perfil na memória da IA", body: kv(pairs) }));
	} else {
		root.append(
			card({
				title: "Perfil na memória da IA",
				body: empty("Sem perfil deste grupo na memória (RME).")
			})
		);
	}

	// Histórico de análises (antiga /groups-dossier).
	const history = (analysis && analysis.history) || [];
	root.append(
		card({
			title: "Histórico de análises",
			pill: history.length ? pill(plural(history.length, "análise", "análises")) : null,
			body: history.length
				? h(
						"ol",
						{ class: "pz-history" },
						history.map((d, i) =>
							h(
								"li",
								{ class: `pz-hist${i === 0 ? " latest" : ""}` },
								h(
									"div",
									{ class: "pz-hist-hd" },
									h("span", {
										class: "label",
										text: i === 0 ? "Última análise" : when(d.created_at)
									}),
									i === 0 ? h("span", { class: "faint", text: when(d.created_at) }) : null,
									h("span", { class: "spacer" }),
									riskPill(d.problematic_score, "nota")
								),
								kv([
									["Tipo", d.type || "—"],
									["Resumo", d.summary || "—"]
								])
							)
						)
					)
				: empty("Sem análises no histórico de moderação deste grupo.")
		})
	);
}

/* ── Ficha da pessoa (Dossiê 360º) ─────────────────────────────── */

/** Preenche o lugar do botão "Abrir no Banco" depois de consultar o RavenaBank. */
async function fillBank(slot, d) {
	const candidates = bankCandidates(d);
	const set = (...nodes) => slot.replaceChildren(...nodes);
	if (!candidates.length) {
		set(h("span", { class: "muted pz-bank", text: "sem número para procurar no Banco" }));
		return;
	}
	const s = await settle(
		Object.fromEntries(
			candidates.map((c, i) => [`c${i}`, api(`/api/games/bank/admin/users?q=${enc(c)}&limit=100`)])
		)
	);
	const users = candidates.flatMap(
		(_, i) => (s[`c${i}`] && s[`c${i}`].data && s[`c${i}`].data.users) || []
	);
	const acc = pickBankAccount(users, candidates);
	if (acc) {
		set(
			h("a", {
				class: "btn",
				href: buildHash("banco", ["jogador", acc.userId]),
				"data-key": "abrir-banco",
				text: "Abrir no Banco"
			})
		);
		return;
	}
	const err = candidates.map((_, i) => s[`c${i}Error`]).find(Boolean);
	set(
		h("span", {
			class: "muted pz-bank",
			text: err ? `Banco: não deu para consultar (${err.message})` : "sem conta no Banco"
		})
	);
}

function gamesBlock(g) {
	const items = [];
	if (g.fishing) {
		items.push({
			label: "Pesca",
			value: `${fmt(Number(g.fishing.total_catches) || 0)} peixes`,
			detail: `${kg(g.fishing.total_weight)} kg acumulados`
		});
	}
	if (g.slots) {
		items.push({
			label: "Cassino / slots",
			value: `${fmt(Number(g.slots.coins) || 0)} fichas`,
			detail: `${fmt(Number(g.slots.total_bets) || 0)} apostas`
		});
	}
	if (g.donation && Number(g.donation.valor) > 0) {
		items.push({
			label: "Apoiador / doador",
			value: brl(g.donation.valor),
			detail: "doador registrado"
		});
	}
	if (Array.isArray(g.relationships) && g.relationships.length) {
		const r = g.relationships[0];
		items.push({
			label: "Relacionamento",
			value: `${r.tipo} (${r.status})`,
			detail: plural(Number(r.coisas_count) || 0, "interação", "interações")
		});
	}
	const extra = [];
	if (Array.isArray(g.ranking) && g.ranking.length) {
		extra.push([
			"Ranking de mensagens",
			h(
				"ul",
				{ class: "pz-list" },
				g.ranking.map((r) =>
					h(
						"li",
						null,
						mono(r.group_id),
						` · ${plural(Number(r.count) || 0, "mensagem", "mensagens")}`
					)
				)
			)
		]);
	}
	if (Array.isArray(g.afk) && g.afk.length) {
		extra.push([
			"AFK recentes",
			h(
				"ul",
				{ class: "pz-list" },
				g.afk.map((a) => h("li", null, `${when(a.entered_at)}${a.reason ? ` · ${a.reason}` : ""}`))
			)
		]);
	}
	if (!items.length && !extra.length) return empty("Sem atividade nos jogos registrada.");
	return [items.length ? tiles(items) : null, extra.length ? kv(extra) : null];
}

async function renderPerson(root, ctx, id) {
	let d;
	try {
		d = await api(`/api/dossies/user/${enc(id)}`);
	} catch (err) {
		root.append(crumbs([{ label: "Pessoas", href: listHash("pessoas") }, { label: id }]));
		if (err && err.status === 404) {
			root.append(
				card({ body: [empty("Esta pessoa não está na memória."), kv([["Procurado", mono(id)]])] })
			);
		} else {
			root.append(failure(err, "o dossiê", ctx));
		}
		return;
	}
	const name = d.display_name || d.canonical_user_id || id;
	root.append(crumbs([{ label: "Pessoas", href: listHash("pessoas") }, { label: name }]));

	const bankSlot = h(
		"span",
		{ class: "pz-bank-slot" },
		h("span", { class: "muted pz-bank", text: "procurando conta no Banco…" })
	);
	fillBank(bankSlot, d).catch(() =>
		bankSlot.replaceChildren(
			h("span", { class: "muted pz-bank", text: "Banco: não deu para consultar" })
		)
	);

	const identities = Array.isArray(d.identities) ? d.identities : [];
	root.append(
		card({
			title: `Dossiê 360º: ${name}`,
			actions: bankSlot,
			body: [
				kv([["ID canônico", mono(d.canonical_user_id)]]),
				h("h3", { class: "pz-sub", text: "Identidades e vinculações" }),
				identities.length
					? h(
							"ul",
							{ class: "pz-list" },
							identities.map((i) =>
								h(
									"li",
									null,
									`[${i.platform}] `,
									h("b", { text: `${i.id_type}: ` }),
									mono(i.platform_id),
									i.display_name
										? h("span", { class: "muted", text: ` · ${i.display_name}` })
										: null
								)
							)
						)
					: h("p", { class: "muted pz-p", text: "Nenhuma identidade adicional vinculada" })
			]
		})
	);

	root.append(card({ title: "Atividade nos jogos e economia", body: gamesBlock(d.games || {}) }));

	const facts = Array.isArray(d.facts) ? d.facts : [];
	root.append(
		card({
			title: "Fatos e curiosidades memorizados (global)",
			pill: facts.length ? pill(plural(facts.length, "fato", "fatos")) : null,
			body: facts.length
				? h(
						"ul",
						{ class: "pz-facts" },
						facts.map((f) =>
							h(
								"li",
								null,
								pill(f.category || "geral"),
								h("span", { class: "pz-fact", text: f.fact_text }),
								h("span", {
									class: "faint pz-date",
									text: f.last_confirmed_at ? when(f.last_confirmed_at) : ""
								})
							)
						)
					)
				: empty("Nenhum fato semântico extraído pela IA ainda.")
		})
	);

	const groups = Array.isArray(d.active_groups) ? d.active_groups : [];
	// Nome dos grupos pelas duas listas (mesmas leituras da aba Grupos, em cache); sem nome, o id.
	const names = new Map();
	if (groups.length) {
		const { profiles, analyses } = await loadGroups("");
		for (const g of mergeGroups(profiles, analyses)) if (g.name !== g.id) names.set(g.id, g.name);
	}
	root.append(
		groups.length
			? h(
					"section",
					{ class: "stack pz-groups", "aria-label": "Atividade em grupos" },
					h("h2", { class: "sec-label", text: "Atividade em grupos" }),
					rows(
						groups.map((ag) =>
							rowItem({
								icon: "pessoas",
								title: names.get(String(ag.target_id)) || ag.target_id,
								status: [
									names.has(String(ag.target_id)) ? ag.target_id : null,
									plural(Number(ag.msgs_count) || 0, "mensagem recente", "mensagens recentes")
								]
									.filter(Boolean)
									.join(" · "),
								href: buildHash(AREA, ["grupo", ag.target_id]),
								key: `ag-${ag.target_id}`
							})
						),
						{ label: "Grupos onde a pessoa falou" }
					)
				)
			: card({
					title: "Atividade em grupos",
					body: empty("Sem atividade recente em grupos registrada no buffer")
				})
	);
}

/* ── Área ──────────────────────────────────────────────────────── */

export default {
	id: AREA,
	group: "Pessoas",
	title: "Pessoas e grupos",
	desc: "Dossiês de pessoas e grupos (o resumo que a IA mantém) e histórico de moderação.",
	summary: () => ({ text: "dossiês de pessoas e grupos" }),
	async render(root, ctx) {
		loadAreaCss("pessoas", "/admin/areas/pessoas.css?v=2");
		const tab = tabOf(ctx.segs);
		const q = (ctx.params.get("q") || "").trim();
		ctx.head.append(
			subnav(
				[
					{ id: "pessoas", label: "Pessoas", href: listHash("pessoas", q) },
					{ id: "grupos", label: "Grupos", href: listHash("grupos", q) }
				],
				tab,
				{ label: "Seções de Pessoas e grupos" }
			),
			h(
				"button",
				{
					type: "button",
					class: "btn btn-quiet",
					"data-key": "atualizar",
					onclick: () => ctx.refresh()
				},
				icon("recarregar"),
				h("span", { class: "btn-label", text: "Atualizar" })
			)
		);
		root.classList.add("stack", "pz");
		const [kind, id] = ctx.segs;
		if (kind === "pessoa" && id) return void (await renderPerson(root, ctx, id));
		if (kind === "grupo" && id) return void (await renderGroup(root, ctx, id));
		if (tab === "grupos") return void (await renderGroups(root, ctx, q));
		return void (await renderPeople(root, ctx, q));
	}
};
