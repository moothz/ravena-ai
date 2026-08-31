// formatters.js - Utility formatters for dates, currency, phone numbers, and numbers

const Formatters = {
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
    }
};

window.Formatters = Formatters;
