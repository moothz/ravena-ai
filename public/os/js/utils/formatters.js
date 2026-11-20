// formatters.js - Utility formatters for dates, currency, phone numbers, and numbers

const Formatters = {
    /**
     * Escapa texto para interpolação segura em innerHTML/atributos.
     * Nomes e mensagens de doadores vêm de terceiros (webhook do tipa.ai) e não podem virar HTML.
     * @param {*} value
     * @returns {string}
     */
    escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, (c) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        })[c]);
    },

    currency(val) {
        return new Intl.NumberFormat('pt-BR', {
            style: 'currency',
            currency: 'BRL',
            maximumFractionDigits: 2
        }).format(val || 0);
    },

    currencyCompact(val) {
        return new Intl.NumberFormat('pt-BR', {
            style: 'currency',
            currency: 'BRL',
            maximumFractionDigits: 0
        }).format(val || 0);
    },

    number(val) {
        return new Intl.NumberFormat('pt-BR').format(val || 0);
    },

    formatTime(timestamp) {
        if (!timestamp) return 'Nunca';
        const date = new Date(timestamp);
        return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    },

    formatDateTime(timestamp) {
        if (!timestamp) return 'Nunca';
        const date = new Date(timestamp);
        return date.toLocaleString('pt-BR');
    },

    formatDate(timestamp) {
        if (!timestamp) return '';
        const date = new Date(timestamp);
        return date.toLocaleDateString('pt-BR');
    },

    getTimeSinceLastMessage(timestamp) {
        if (!timestamp) return Infinity;
        const now = Date.now();
        const diff = now - timestamp;
        return Math.floor(diff / 1000 / 60); // minutes
    },

    formatTimeSince(minutes) {
        if (minutes === Infinity) return 'Sem atividade registrada';
        if (minutes < 1) return 'Ativa agora ✨';
        
        let timeText = '';
        if (minutes < 60) {
            timeText = `${minutes} ${minutes === 1 ? 'minuto' : 'minutos'}`;
        } else {
            const hours = Math.floor(minutes / 60);
            if (hours < 24) {
                timeText = `${hours} ${hours === 1 ? 'hora' : 'horas'}`;
            } else {
                const days = Math.floor(hours / 24);
                timeText = `${days} ${days === 1 ? 'dia' : 'dias'}`;
            }
        }

        if (minutes < 15) {
            return `Ativa há ${timeText}`;
        } else {
            return `Sem atividade há ${timeText}`;
        }
    },

    formatPhoneNumber(number) {
        if (!number || typeof number !== 'string') return '';
        const clean = number.replace(/\D/g, '');
        if (clean.length >= 12 && clean.startsWith('55')) {
            const country = clean.substring(0, 2);
            const ddd = clean.substring(2, 4);
            const part1 = clean.substring(4, clean.length - 4);
            const part2 = clean.substring(clean.length - 4);
            return `+${country} (${ddd}) ${part1}-${part2}`;
        }
        return number;
    },

    formatWhatsAppUrl(phoneNumber) {
        if (!phoneNumber) return '#';
        const cleanNumber = String(phoneNumber).replace(/\D/g, '');
        return `https://wa.me/${cleanNumber}`;
    },

    formatWhatsAppMarkup(text) {
        if (!text || typeof text !== 'string') return '';

        let escaped = this.escapeHtml(text);

        // Blocos de código multilinhas (```codigo```)
        const codeBlocks = [];
        escaped = escaped.replace(/```([\s\S]*?)```/g, (match, code) => {
            const id = codeBlocks.length;
            codeBlocks.push(`<pre style="background: rgba(0,0,0,0.5); padding: 8px 10px; border-radius: 4px; overflow-x: auto; font-family: monospace;"><code>${code}</code></pre>`);
            return `\x00CODEBLOCK_${id}\x00`;
        });

        // Código inline (`codigo`)
        const inlineCodes = [];
        escaped = escaped.replace(/`([^`\n]+?)`/g, (match, code) => {
            const id = inlineCodes.length;
            inlineCodes.push(`<code style="background: rgba(0,0,0,0.4); padding: 2px 5px; border-radius: 3px; font-family: monospace;">${code}</code>`);
            return `\x00INLINECODE_${id}\x00`;
        });

        // Citações / Quotes (> texto)
        const lines = escaped.split('\n');
        const processedLines = [];
        let quoteBuffer = [];

        const flushQuotes = () => {
            if (quoteBuffer.length > 0) {
                processedLines.push(`<blockquote style="border-left: 3px solid var(--neon-cyan); margin: 6px 0; padding-left: 8px; color: #bbb;">${quoteBuffer.join('<br>')}</blockquote>`);
                quoteBuffer = [];
            }
        };

        for (const line of lines) {
            const match = line.match(/^(&gt;|>)\s?(.*)$/);
            if (match) {
                quoteBuffer.push(match[2]);
            } else {
                flushQuotes();
                processedLines.push(line);
            }
        }
        flushQuotes();
        escaped = processedLines.join('\n');

        // Negrito (*texto*)
        escaped = escaped.replace(/(^|[\s>(~_])\*([^*\n]+?)\*(?=[^\w*]|$)/g, (m, p, inner) => {
            if (/^\s*$/.test(inner)) return m;
            return `${p}<strong>${inner}</strong>`;
        });

        // Itálico (_texto_)
        escaped = escaped.replace(/(^|[\s>(~*])_([^_\n]+?)_(?=[^\w_]|$)/g, (m, p, inner) => {
            if (/^\s*$/.test(inner)) return m;
            return `${p}<em>${inner}</em>`;
        });

        // Tachado (~texto~)
        escaped = escaped.replace(/(^|[\s>(_*])~([^~\n]+?)~(?=[^\w~]|$)/g, (m, p, inner) => {
            if (/^\s*$/.test(inner)) return m;
            return `${p}<del>${inner}</del>`;
        });

        // URLs clicáveis
        escaped = escaped.replace(
            /(https?:\/\/[^\s<]+)/gi,
            '<a href="$1" target="_blank" rel="noopener noreferrer" style="color: var(--neon-cyan); text-decoration: underline;">$1</a>'
        );

        // Restaura blocos de código
        escaped = escaped.replace(/\x00CODEBLOCK_(\d+)\x00/g, (m, id) => codeBlocks[Number(id)] || '');
        escaped = escaped.replace(
            /\x00INLINECODE_(\d+)\x00/g,
            (m, id) => inlineCodes[Number(id)] || ''
        );

        // Quebras de linha (\n -> <br>)
        escaped = escaped.replace(/\n/g, '<br>');

        return escaped;
    },

    parseDate(str) {
        if (!str) return null;
        if (typeof str === 'number') {
            const d = new Date(str);
            return isNaN(d.getTime()) ? null : d;
        }
        const s = String(str).trim();
        const dmy = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
        if (dmy) {
            const d = new Date(parseInt(dmy[3], 10), parseInt(dmy[2], 10) - 1, parseInt(dmy[1], 10));
            return isNaN(d.getTime()) ? null : d;
        }
        const d = new Date(s);
        return isNaN(d.getTime()) ? null : d;
    },

    calculateLifetime(startDate, endDate) {
        const d1 = this.parseDate(startDate);
        const d2 = this.parseDate(endDate);
        if (!d1 || !d2) return null;

        let start = d1;
        let end = d2;
        if (start > end) {
            start = d2;
            end = d1;
        }

        let years = end.getFullYear() - start.getFullYear();
        let months = end.getMonth() - start.getMonth();
        let days = end.getDate() - start.getDate();

        if (days < 0) {
            months--;
            const prevMonthDate = new Date(end.getFullYear(), end.getMonth(), 0);
            days += prevMonthDate.getDate();
        }
        if (months < 0) {
            years--;
            months += 12;
        }

        const parts = [];
        if (years > 0) parts.push(`${years} ${years === 1 ? 'ano' : 'anos'}`);
        if (months > 0) parts.push(`${months} ${months === 1 ? 'mês' : 'meses'}`);
        if (days > 0 || parts.length === 0) parts.push(`${days} ${days === 1 ? 'dia' : 'dias'}`);

        return parts.join(', ');
    }
};

window.Formatters = Formatters;
