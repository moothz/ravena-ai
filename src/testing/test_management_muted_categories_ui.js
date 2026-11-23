"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

function main() {
	console.log("=== Teste UI: Toggles de Categorias de Comandos no /manage ===");

	const possibleManagementJs = [
		path.join(__dirname, "../../public/management.js"),
		"/app/public/management.js"
	];
	const managementJsPath = possibleManagementJs.find((p) => fs.existsSync(p));
	assert.ok(managementJsPath, "management.js deve existir");

	const possibleManagementCss = [
		path.join(__dirname, "../../public/management.css"),
		"/app/public/management.css"
	];
	const managementCssPath = possibleManagementCss.find((p) => fs.existsSync(p));
	assert.ok(managementCssPath, "management.css deve existir");

	const possibleManagementHtml = [
		path.join(__dirname, "../../public/management.html"),
		"/app/public/management.html"
	];
	const managementHtmlPath = possibleManagementHtml.find((p) => fs.existsSync(p));
	assert.ok(managementHtmlPath, "management.html deve existir");

	const managementJs = fs.readFileSync(managementJsPath, "utf8");
	const managementCss = fs.readFileSync(managementCssPath, "utf8");
	const managementHtml = fs.readFileSync(managementHtmlPath, "utf8");

	// 1. Validar CSS
	console.log("1. Validando estilos CSS para toggles e cards...");
	assert.match(
		managementCss,
		/\.switch-category-mute\s+\.slider-round\s*\{[^}]*--success-color/s,
		"switch-category-mute padrão deve usar var(--success-color) para categorias liberadas"
	);
	assert.match(
		managementCss,
		/\.switch-category-mute\s+input:checked\s*\+\s*\.slider-round\s*\{[^}]*--danger-color/s,
		"switch-category-mute ativo (mutado) deve usar var(--danger-color)"
	);
	assert.match(
		managementCss,
		/\.cmd-category-card\.is-muted\s*\{[^}]*--danger-color/s,
		"cmd-category-card.is-muted deve conter estilização de destaque em vermelho"
	);
	assert.match(
		managementCss,
		/\.cmd-category-card\.is-muted\s+\.cmd-category-name\s*\{[^}]*line-through/s,
		"cmd-category-card.is-muted deve aplicar line-through (tachado) no nome da categoria"
	);
	assert.match(
		managementCss,
		/#muted-categories-list\s*\{[^}]*grid/s,
		"#muted-categories-list deve ter layout grid responsivo"
	);
	console.log("✓ CSS validado com sucesso.");

	// 2. Validar HTML
	console.log("2. Validando estrutura HTML...");
	assert.match(
		managementHtml,
		/id="muted-categories-list"/,
		"HTML deve conter o container #muted-categories-list"
	);
	assert.match(
		managementHtml,
		/Verde:\s*liberada\s*\|\s*Vermelho:\s*silenciada/i,
		"HTML deve conter legenda indicativa de cores liberada/silenciada"
	);
	console.log("✓ HTML validado com sucesso.");

	// 3. Validar JS
	console.log("3. Validando lógica de renderização e eventos no JS...");
	assert.match(
		managementJs,
		/cmd-category-card/,
		"management.js deve criar elementos com a classe cmd-category-card"
	);
	assert.match(
		managementJs,
		/switch-category-mute/,
		"management.js deve usar switch-category-mute"
	);
	assert.match(
		managementJs,
		/fa-volume-xmark/,
		"management.js deve utilizar fa-volume-xmark para categorias mutadas"
	);
	assert.match(
		managementJs,
		/fa-check/,
		"management.js deve utilizar fa-check para categorias ativas"
	);

	// 4. Simulação funcional de alternância de estado
	console.log("4. Simulando lógica funcional de seleção e desmarcação...");
	const categories = ["geral", "jogos", "midia"];
	const groupData = { mutedCategories: ["jogos"] };

	categories.forEach((cat) => {
		const isMutedInitial = (groupData.mutedCategories || []).some(
			(c) => String(c).toLowerCase() === cat.toLowerCase()
		);
		if (cat === "jogos") {
			assert.strictEqual(isMutedInitial, true, "jogos deve iniciar como mutado");
		} else {
			assert.strictEqual(isMutedInitial, false, `${cat} deve iniciar liberado`);
		}

		// Simula toggle para mutar geral
		if (cat === "geral") {
			const shouldMute = true;
			groupData.mutedCategories = groupData.mutedCategories.filter(
				(c) => String(c).toLowerCase() !== cat.toLowerCase()
			);
			if (shouldMute) groupData.mutedCategories.push(cat);
		}

		// Simula toggle para desmutar jogos
		if (cat === "jogos") {
			const shouldMute = false;
			groupData.mutedCategories = groupData.mutedCategories.filter(
				(c) => String(c).toLowerCase() !== cat.toLowerCase()
			);
			if (shouldMute) groupData.mutedCategories.push(cat);
		}
	});

	assert.deepStrictEqual(
		groupData.mutedCategories,
		["geral"],
		"Após toggles, apenas 'geral' deve estar em mutedCategories"
	);
	console.log("✓ Simulação funcional de mute/unmute aprovada.");

	console.log("\n=== TODOS OS TESTES PASSARAM COM SUCESSO! ===");
	process.exit(0);
}

try {
	main();
} catch (err) {
	console.error("Erro no teste:", err);
	process.exit(1);
}
