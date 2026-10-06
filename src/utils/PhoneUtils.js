"use strict";

/**
 * Utilitários para normalização e compatibilidade de números de telefone,
 * com suporte especial para números brasileiros (8 vs 9 dígitos após DDD).
 */
class PhoneUtils {
	/**
	 * Remove caracteres não numéricos e sufixos de JID (@s.whatsapp.net, @lid, :device)
	 * @param {string|number} phone
	 * @returns {string}
	 */
	static cleanPhone(phone) {
		if (!phone && phone !== 0) return "";
		return String(phone).split(/[@:]/)[0].replace(/\D/g, "");
	}

	/**
	 * Retorna lista de variantes possíveis para o número de telefone.
	 * Para números do Brasil (DDI 55), gera as versões de 12 e 13 dígitos
	 * (com e sem o '9' adicional após o DDD).
	 *
	 * Exemplos:
	 *   - "552492052933" (12 dígitos) -> ["552492052933", "5524992052933"]
	 *   - "5524992052933" (13 dígitos) -> ["5524992052933", "552492052933"]
	 *   - "5547988130617" (13 dígitos) -> ["5547988130617", "554788130617"]
	 *   - "554788130617" (12 dígitos) -> ["554788130617", "5547988130617"]
	 *
	 * @param {string|number} phone
	 * @returns {string[]}
	 */
	static getPhoneVariants(phone) {
		const clean = this.cleanPhone(phone);
		if (!clean) return [];

		const variants = new Set([clean]);

		// Brasil: DDI 55
		if (clean.startsWith("55")) {
			// 12 dígitos: 55 + DDD (2) + 8 dígitos
			if (clean.length === 12) {
				const ddd = clean.slice(2, 4);
				const rest = clean.slice(4);
				variants.add(`55${ddd}9${rest}`);
			}
			// 13 dígitos: 55 + DDD (2) + 9 + 8 dígitos
			else if (clean.length === 13 && clean[4] === "9") {
				const ddd = clean.slice(2, 4);
				const rest = clean.slice(5);
				variants.add(`55${ddd}${rest}`);
			}
		} else if (clean.length === 10) {
			// 10 dígitos sem DDI: DDD (2) + 8 dígitos
			const ddd = clean.slice(0, 2);
			const rest = clean.slice(2);
			variants.add(`55${clean}`);
			variants.add(`55${ddd}9${rest}`);
			variants.add(`${ddd}9${rest}`);
		} else if (clean.length === 11 && clean[2] === "9") {
			// 11 dígitos sem DDI: DDD (2) + 9 + 8 dígitos
			const ddd = clean.slice(0, 2);
			const rest = clean.slice(3);
			variants.add(`55${clean}`);
			variants.add(`55${ddd}${rest}`);
			variants.add(`${ddd}${rest}`);
		}

		return Array.from(variants);
	}

	/**
	 * Verifica se dois números de telefone são equivalentes (incluindo variações de 8/9 dígitos no Brasil).
	 * @param {string|number} phoneA
	 * @param {string|number} phoneB
	 * @returns {boolean}
	 */
	static isSamePhone(phoneA, phoneB) {
		const cleanA = this.cleanPhone(phoneA);
		const cleanB = this.cleanPhone(phoneB);

		if (!cleanA || !cleanB) return false;
		if (cleanA === cleanB) return true;

		const variantsA = this.getPhoneVariants(cleanA);
		return variantsA.includes(cleanB);
	}

	/**
	 * Verifica se um objeto de participante de grupo bate com o número de telefone informado.
	 * @param {Object} participant
	 * @param {string|number} phone
	 * @returns {boolean}
	 */
	static matchesParticipant(participant, phone) {
		if (!participant || !phone) return false;
		const variants = this.getPhoneVariants(phone);
		if (variants.length === 0) return false;

		const candidateFields = [
			participant.PhoneNumber,
			participant.phoneNumber,
			participant.JID,
			participant.jid,
			participant.id?._serialized,
			participant.id
		];

		for (const field of candidateFields) {
			if (!field) continue;
			const clean = this.cleanPhone(field);
			if (clean && variants.includes(clean)) {
				return true;
			}
		}

		return false;
	}
}

module.exports = PhoneUtils;
