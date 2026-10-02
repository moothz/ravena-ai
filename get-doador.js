/**
 * get-doador.js
 * Script para buscar informações de doadores por número ou nome no banco de dados.
 */
process.env.DISABLE_STICKER_SCRAPER_TIMER = "true";
process.env.DISABLE_ACTIVITY = "true";

const Database = require('./src/utils/Database');

function formatBRL(value) {
	const num = Number(value) || 0;
	return `R$ ${num.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDonationCount(historico, totalValor) {
	if (!Array.isArray(historico) || historico.length === 0) {
		return formatBRL(totalValor);
	}
	const count = historico.length;
	const values = historico.map(h => Number(h.valor) || 0);
	const allSame = values.every(v => v === values[0]);

	if (allSame && count > 0) {
		return `${formatBRL(totalValor)} (${count} doaç${count > 1 ? 'ões' : 'ão'} de ${formatBRL(values[0])})`;
	}
	return `${formatBRL(totalValor)} (${count} doaç${count > 1 ? 'ões' : 'ão'})`;
}

async function main() {
	const query = process.argv.slice(2).join(' ').trim();
	if (!query) {
		console.log('Nenhum termo de busca fornecido.');
		process.exit(1);
	}

	const db = Database.getInstance();
	const donations = await db.getDonations();

	const queryDigits = query.replace(/\D/g, '');
	const queryLower = query.toLowerCase();

	const matches = donations.filter(donor => {
		const name = (donor.nome || '').toLowerCase();
		const number = donor.numero ? String(donor.numero) : '';
		const numberDigits = number.replace(/\D/g, '');

		// 1. Busca por número (se o termo de busca e o doador possuírem ao menos 4 dígitos)
		if (queryDigits.length >= 4 && numberDigits.length >= 4) {
			if (numberDigits === queryDigits || numberDigits.includes(queryDigits) || queryDigits.includes(numberDigits)) {
				return true;
			}
		}

		// 2. Busca por nome (substring case-insensitive)
		if (name.includes(queryLower)) {
			return true;
		}

		// 3. Busca por string no campo número formatado
		if (number && number.toLowerCase().includes(queryLower)) {
			return true;
		}

		return false;
	});

	if (matches.length === 0) {
		console.log(`Nenhum doador encontrado para a busca "${query}".`);
		process.exit(0);
	}

	matches.forEach((donor, idx) => {
		if (idx > 0) console.log('\n---\n');
		const donorNumeroDisplay = donor.numero || 'Não informado';
		const valorFormatado = formatDonationCount(donor.historico, donor.valor);

		console.log(`O doador associado ao número/nome "${query}" é ${donor.nome}.\n`);
		console.log(`### Detalhes do Doador:`);
		console.log(`- Nome: ${donor.nome}`);
		console.log(`- Número: ${donorNumeroDisplay}`);
		console.log(`- Valor Total Doado: ${valorFormatado}`);
	});

	process.exit(0);
}

main().catch(err => {
	console.error('Erro ao buscar doador:', err);
	process.exit(1);
});
