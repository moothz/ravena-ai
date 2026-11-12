// api.js - API client helper for backend communication

const Api = {
    async get(endpoint) {
        const res = await fetch(endpoint, { credentials: 'same-origin' });
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }
        return res.json();
    },

    async post(endpoint, body) {
        const isFormData = body instanceof FormData;
        const options = {
            method: 'POST',
            credentials: 'same-origin',
            body: isFormData ? body : JSON.stringify(body)
        };
        if (!isFormData) {
            options.headers = { 'Content-Type': 'application/json' };
        }
        const res = await fetch(endpoint, options);
        if (!res.ok) {
            let errorText = res.statusText;
            try {
                const errData = await res.json();
                if (errData.error) errorText = errData.error;
            } catch (e) {}
            throw new Error(errorText || `Erro HTTP ${res.status}`);
        }
        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
            return res.json();
        } else if (contentType.includes('image/') || contentType.includes('audio/')) {
            return res.blob();
        } else {
            return res.text();
        }
    },

    _scriptPromises: {},

    /**
     * Carrega um script externo sob demanda (uma única vez por URL).
     * Usado para bibliotecas pesadas que só algumas janelas precisam (ex: Highcharts).
     * @param {string} src
     * @returns {Promise<void>}
     */
    loadScript(src) {
        if (!this._scriptPromises[src]) {
            this._scriptPromises[src] = new Promise((resolve, reject) => {
                const el = document.createElement('script');
                el.src = src;
                el.async = true;
                el.onload = () => resolve();
                el.onerror = () => {
                    delete this._scriptPromises[src];
                    el.remove();
                    reject(new Error(`Falha ao carregar ${src}`));
                };
                document.head.appendChild(el);
            });
        }
        return this._scriptPromises[src];
    }
};

window.Api = Api;
