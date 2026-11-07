/**
 * SoliBackendClient - Typed Client SDK for consuming Soli Standalone Backend
 */
export class SoliBackendClient {
    baseUrl;
    headers;
    constructor(options = {}) {
        this.baseUrl = (options.baseUrl || "http://localhost:4000").replace(/\/$/, "");
        this.headers = {
            "Content-Type": "application/json",
            ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
            ...(options.authToken ? { "x-soli-auth": options.authToken } : {}),
        };
    }
    // ---------------- Agent ----------------
    async sendMessage(params) {
        const res = await fetch(`${this.baseUrl}/api/agent/message`, {
            method: "POST",
            headers: this.headers,
            body: JSON.stringify(params),
        });
        if (!res.ok)
            throw new Error(`Agent error: ${res.statusText}`);
        return res.json();
    }
    async abortAgent(dotId) {
        const res = await fetch(`${this.baseUrl}/api/agent/abort`, {
            method: "POST",
            headers: this.headers,
            body: JSON.stringify({ dotId }),
        });
        return res.json();
    }
    // ---------------- Legal RAG & Docs ----------------
    async searchStatutes(query, act, limit = 5) {
        const q = new URLSearchParams({ q: query, limit: String(limit) });
        if (act)
            q.set("act", act);
        const res = await fetch(`${this.baseUrl}/api/legal/search?${q.toString()}`, {
            headers: this.headers,
        });
        return res.json();
    }
    async generateCourtPdf(pleadingData) {
        const res = await fetch(`${this.baseUrl}/api/legal/generate-pdf`, {
            method: "POST",
            headers: this.headers,
            body: JSON.stringify(pleadingData),
        });
        if (!res.ok)
            throw new Error("Failed to generate PDF");
        return res.blob();
    }
    // ---------------- Admin ----------------
    async getModels() {
        const res = await fetch(`${this.baseUrl}/api/admin/models`, { headers: this.headers });
        return res.json();
    }
    async getNodes() {
        const res = await fetch(`${this.baseUrl}/api/admin/nodes`, { headers: this.headers });
        return res.json();
    }
    async getDocuments(orgId, status) {
        const q = new URLSearchParams();
        if (orgId)
            q.set("orgId", orgId);
        if (status)
            q.set("status", status);
        const res = await fetch(`${this.baseUrl}/api/admin/documents?${q.toString()}`, { headers: this.headers });
        return res.json();
    }
    async getAnalytics(timeRange = "24h") {
        const res = await fetch(`${this.baseUrl}/api/admin/analytics?timeRange=${timeRange}`, { headers: this.headers });
        return res.json();
    }
    async getHealth() {
        const res = await fetch(`${this.baseUrl}/api/admin/health`, { headers: this.headers });
        return res.json();
    }
}
