const telemetry = require("../telemetry");

const BASE_DELAY_MS = 2000;
const MAX_DELAY_MS = 60000;
const MAX_CONSECUTIVE_REJECTIONS = 3;

const FAILURE_LABELS = {
	conflict: "conflito com outra instância ou webhook",
	rate_limited: "limite de requisições",
	http_error: "erro HTTP",
	network: "erro de rede"
};

function failureKind(status, isTelegramReply, error) {
	if (isTelegramReply && (status === 401 || status === 404)) return "token_rejected";
	if (status === 409) return "conflict";
	if (status === 429) return "rate_limited";
	if (status) return "http_error";
	if (error.code === "ECONNABORTED" || error.message.includes("timeout")) return "timeout";
	return "network";
}

function classifyFailure(error) {
	const response = error.response;
	const body = response?.data ?? response?.body;
	const isTelegramReply = body?.ok === false;
	const status = isTelegramReply ? body.error_code : (response?.status ?? response?.statusCode);
	return {
		kind: failureKind(status, isTelegramReply, error),
		status,
		detail: isTelegramReply
			? `${status} ${body.description}`
			: status
				? `HTTP ${status}`
				: error.message,
		retryAfterMs: isTelegramReply ? (body.parameters?.retry_after ?? 0) * 1000 : 0
	};
}

class TelegramPollingBackoff {
	constructor({ loop, logger, token, tokenSource }) {
		this.loop = loop;
		this.logger = logger;
		this.token = token;
		this.tokenSource = tokenSource;
		this.succeed();
	}

	static isTokenRejected(error) {
		return classifyFailure(error).kind === "token_rejected";
	}

	redact(text) {
		return text.replaceAll(this.token, "***");
	}

	fail(error) {
		const failure = classifyFailure(error);
		this.attempts++;
		this.rejections = failure.kind === "token_rejected" ? this.rejections + 1 : 0;

		if (this.rejections >= MAX_CONSECUTIVE_REJECTIONS) {
			this._report("stopped", failure, () =>
				this.logger.error(
					`[polling] O Telegram recusou o token (${this.redact(failure.detail)}) em ${this.rejections} tentativas seguidas. Conexão parada até reiniciar a ravena. Confira ${this.tokenSource}.`
				)
			);
			return null;
		}

		const backoffMs = Math.min(BASE_DELAY_MS * 2 ** (this.attempts - 1), MAX_DELAY_MS);
		const delayMs = Math.max(backoffMs, failure.retryAfterMs);

		const isSilent = failure.kind === "token_rejected" || failure.kind === "timeout";
		if (!isSilent && failure.kind !== this.reportedFailure?.kind) {
			this.reportedFailure = failure;
			this._report("failing", failure, () =>
				this.logger.warn(
					`[polling] Falha na busca de atualizações do Telegram: ${FAILURE_LABELS[failure.kind]} (${this.redact(failure.detail)}). Nova tentativa em ${delayMs / 1000} s, com espera crescente. Repetições não são registradas.`
				)
			);
		}
		return delayMs;
	}

	succeed() {
		if (this.reportedFailure) {
			this._report("recovered", this.reportedFailure, () =>
				this.logger.info(
					`[polling] O Telegram voltou a responder após ${this.attempts} falha(s) seguida(s).`
				)
			);
		}
		this.attempts = 0;
		this.rejections = 0;
		this.reportedFailure = null;
	}

	_report(state, failure, writeLog) {
		telemetry.withSpan(
			"telegram polling.state",
			{
				root: true,
				attributes: {
					"ravena.telegram.polling.loop": this.loop,
					"ravena.telegram.polling.state": state,
					"ravena.telegram.polling.failure": failure.kind,
					"ravena.telegram.polling.status": failure.status,
					"ravena.telegram.polling.attempts": this.attempts,
					"app.outcome": state === "recovered" ? "ok" : "error"
				}
			},
			writeLog
		);
	}
}

module.exports = TelegramPollingBackoff;
