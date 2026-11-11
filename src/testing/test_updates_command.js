process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";
delete process.env.GITHUB_TOKEN;

/**
 * Testes do !updates (GeneralCommands) sem rede: GitHub e IA são stubs injetados.
 * Uso: node src/testing/test_updates_command.js
 */
const assert = require("assert");
const GeneralCommands = require("../functions/GeneralCommands");

const NOW = new Date("2026-11-11T23:40:00Z");
const SINCE = new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

function mkCommit(repo, n, date, message, { parents = 1, author = "moothz" } = {}) {
	const sha = `${repo.slice(0, 3)}${String(n).padStart(37, "0")}`;
	return {
		sha,
		html_url: `https://github.com/moothz/${repo}/commit/${sha}`,
		commit: { author: { name: author, date }, committer: { name: author, date }, message },
		parents: Array.from({ length: parents }, (_, i) => ({ sha: `p${i}` }))
	};
}

// Fixture no formato de GET /repos/{owner}/{repo}/commits (mais recente primeiro)
const FIXTURE = {
	"ravena-ai": [
		mkCommit(
			"ravena-ai",
			1,
			"2026-11-10T21:01:44Z",
			"feat(banco): modal de confirmacao e segunda chance de estorno\n\n- Modal fullscreen com backdrop blur para confirmacao de compra\n  e venda com saldos antes e depois\n- Segunda chance no extrato para desfazer transacoes [docs](https://x.y)\n- Terceiro item\n\nCo-Authored-By: Alguem <a@b.c>\nFoo-Session: https://exemplo/123"
		),
		mkCommit(
			"ravena-ai",
			2,
			"2026-11-09T14:25:22Z",
			"Merge pull request #31 from fulano/fix\n\nfix(waifu): casar",
			{ parents: 2 }
		),
		...Array.from({ length: 25 }, (_, i) =>
			mkCommit("ravena-ai", i + 100, `2026-11-0${9 - (i % 3)}T12:00:00Z`, `fix(pesca): ajuste ${i}`)
		)
	],
	waifuletes: [
		mkCommit(
			"waifuletes",
			1,
			"2026-11-10T10:00:00Z",
			"chore(deps-dev): bump vitest from 5.0.3 to 5.1.0\n\nBumps [vitest](https://github.com/x) from 5.0.3 to 5.1.0.\n---\nupdated-dependencies:\n...\n\nSigned-off-by: dependabot[bot] <x>",
			{ author: "dependabot[bot]" }
		),
		mkCommit("waifuletes", 2, "2026-11-11T09:00:00Z", "feat(hosting): adicionar taxa de hospedagem")
	],
	"jardim-das-sombras": []
};

function makeFakeHttp({
	failRepo = null,
	failStatus = 404,
	rateLimited = false,
	pageSize = 10
} = {}) {
	const calls = [];
	return {
		calls,
		async get(url, config = {}) {
			calls.push({ url, config });
			const u = new URL(url);
			const [, , owner, repo] = u.pathname.split("/");
			if (repo === failRepo) {
				const err = new Error(`Request failed with status code ${failStatus}`);
				err.response = {
					status: failStatus,
					headers: rateLimited ? { "x-ratelimit-remaining": "0" } : {}
				};
				throw err;
			}
			const params = config.params ?? Object.fromEntries(u.searchParams);
			const page = Number(params.page ?? 1);
			const all = (FIXTURE[repo] ?? []).filter(
				(c) => new Date(c.commit.committer.date) >= new Date(params.since)
			);
			const headers = {};
			if (page * pageSize < all.length) {
				const next = `https://api.github.com/repos/${owner}/${repo}/commits?since=${encodeURIComponent(params.since)}&per_page=100&page=${page + 1}`;
				headers.link = `<${next}>; rel="next", <https://api.github.com/repos/${owner}/${repo}/commits?page=9>; rel="last"`;
			}
			return { data: all.slice((page - 1) * pageSize, page * pageSize), headers };
		}
	};
}

function makeFakeLLM(mode = "ok") {
	const prompts = [];
	return {
		prompts,
		async getCompletion(opts) {
			prompts.push(opts);
			const repo = opts.prompt.match(/Repositório moothz\/([\w-]+)/)[1];
			if (mode === "hang") return new Promise(() => {});
			if (mode === "error") {
				return "Erro: Não foi possível gerar uma resposta. Por favor, tente novamente mais tarde.";
			}
			return `## Resumo\nNovidades do **${repo}** para os usuários nesta semana.`;
		}
	};
}

async function main() {
	console.log("=== TESTES DO !updates ===");
	const G = GeneralCommands;

	// 1. Normalização de commits
	const parsed = G.parseGitHubCommit(FIXTURE["ravena-ai"][0]);
	assert.strictEqual(parsed.title, "feat(banco): modal de confirmacao e segunda chance de estorno");
	assert.deepStrictEqual(parsed.body, [
		"Modal fullscreen com backdrop blur para confirmacao de compra e venda com saldos antes e depois",
		"Segunda chance no extrato para desfazer transacoes docs",
		"Terceiro item"
	]);
	assert.strictEqual(G.parseGitHubCommit(FIXTURE["ravena-ai"][1]).isMerge, true);
	assert.deepStrictEqual(G.parseGitHubCommit(FIXTURE.waifuletes[0]).body, []);
	console.log("✔ parseGitHubCommit (trailers, tópicos, merges, bots)");

	// 2. Busca com paginação e headers
	const http = makeFakeHttp();
	const fetched = await G.fetchRepoCommits(G.UPDATES_REPOS[0], { http, since: SINCE });
	assert.strictEqual(fetched.commits.length, 27);
	assert.strictEqual(http.calls.length, 3, "deve seguir o header Link");
	assert.strictEqual(http.calls[0].config.headers["User-Agent"], "ravena-bot");
	assert.strictEqual(http.calls[0].config.headers.Accept, "application/vnd.github+json");
	assert.strictEqual(http.calls[0].config.headers.Authorization, undefined);
	assert.strictEqual(http.calls[0].config.params.per_page, 100);
	const limited = await G.fetchRepoCommits(G.UPDATES_REPOS[0], {
		http: makeFakeHttp(),
		since: SINCE,
		token: "tok",
		maxPages: 2
	});
	assert.strictEqual(limited.truncated, true);
	const httpTok = makeFakeHttp();
	await G.fetchRepoCommits(G.UPDATES_REPOS[1], { http: httpTok, since: SINCE, token: "tok123" });
	assert.strictEqual(httpTok.calls[0].config.headers.Authorization, "Bearer tok123");
	console.log("✔ fetchRepoCommits (paginação, headers, token)");

	// 3. Fluxo completo
	const llm = makeFakeLLM();
	const content = await G.getUpdatesReport({
		http: makeFakeHttp(),
		llm,
		now: NOW,
		useCache: false
	});
	assert.strictEqual(llm.prompts.length, 2, "repo sem commits não chama a IA");
	assert.ok(!/Merge pull request|Co-Authored-By|-Session:/i.test(content));
	assert.ok(content.includes("🐦‍⬛ *ravena-ai* · 26 commits _(+1 merge)_"));
	assert.ok(content.includes("> Novidades do *ravena-ai* para os usuários nesta semana."));
	assert.ok(content.includes("> Nenhum commit nos últimos 7 dias."));
	assert.ok(content.includes("_…e mais 16 commits_"));
	assert.ok(content.includes("https://github.com/moothz/waifuletes/commits"));
	assert.ok(content.includes("resumos gerados por IA"));
	console.log("✔ getUpdatesReport (fluxo completo)");
	console.log(`\n${content}\n`);

	// 4. Falhas isoladas: 404, rate limit e IA com erro/timeout
	const failed = await G.getUpdatesReport({
		http: makeFakeHttp({ failRepo: "waifuletes", failStatus: 403, rateLimited: true }),
		llm: makeFakeLLM("hang"),
		llmTimeoutMs: 200,
		now: NOW,
		useCache: false
	});
	assert.ok(failed.includes("limite de consultas ao GitHub atingido"));
	assert.ok(failed.includes("> 1 novidade e 25 correções nesta semana."), "fallback por contagem");
	assert.ok(!failed.includes("resumos gerados por IA"));
	const notFound = await G.getUpdatesReport({
		http: makeFakeHttp({ failRepo: "ravena-ai" }),
		llm: makeFakeLLM("error"),
		now: NOW,
		useCache: false
	});
	assert.ok(notFound.includes("repositório não encontrado ou privado"));
	assert.ok(notFound.includes("> 1 novidade e 1 outra mudança nesta semana."));
	console.log("✔ falhas isoladas por repositório + fallback do resumo");

	// 5. Cache e deduplicação de chamadas simultâneas
	const cacheHttp = makeFakeHttp();
	const cacheLLM = makeFakeLLM();
	const [a, b] = await Promise.all([
		G.getUpdatesReport({ http: cacheHttp, llm: cacheLLM, now: NOW }),
		G.getUpdatesReport({ http: cacheHttp, llm: cacheLLM, now: NOW })
	]);
	const callsAfterFirst = cacheHttp.calls.length;
	const c = await G.getUpdatesReport({ http: cacheHttp, llm: cacheLLM, now: NOW });
	assert.strictEqual(a, b);
	assert.strictEqual(a, c);
	assert.strictEqual(cacheHttp.calls.length, callsAfterFirst);
	assert.strictEqual(cacheLLM.prompts.length, 2);
	console.log("✔ cache + deduplicação");

	// 6. Registro do comando
	const cmd = G.commands.find((command) => command.name === "updates");
	assert.ok(cmd, "!updates deve estar registrado");
	assert.deepStrictEqual(cmd.aliases, ["novidades", "atualizacoes", "atualizações"]);
	console.log("✔ comando registrado");
}

main()
	.then(() => {
		console.log("\n=== TODOS OS TESTES DO !updates PASSARAM ===");
		process.exit(0);
	})
	.catch((err) => {
		console.error(err);
		process.exit(1);
	});
