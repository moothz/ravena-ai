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
    }
};

window.Api = Api;
