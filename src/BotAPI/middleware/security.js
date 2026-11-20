/**
 * Cabeçalhos e checagens de segurança gerais da BotAPI.
 * Arquivo: src/BotAPI/middleware/security.js
 */

/**
 * Proíbe que outros sites ponham as páginas da Ravena num iframe (clickjacking).
 * A própria Ravena continua podendo: o Desktop OS e o painel /admin embutem telas
 * da mesma origem. X-Frame-Options fica para navegadores que não leem frame-ancestors.
 * @returns {import("express").RequestHandler}
 */
function createFrameAncestorsGuard() {
	return (req, res, next) => {
		res.setHeader("Content-Security-Policy", "frame-ancestors 'self'");
		res.setHeader("X-Frame-Options", "SAMEORIGIN");
		next();
	};
}

module.exports = { createFrameAncestorsGuard };
