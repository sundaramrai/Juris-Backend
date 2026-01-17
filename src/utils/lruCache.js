class LRUCache {
    constructor(options = {}) {
        this.cache = new Map();
        this.maxSize = options.maxSize || 100;
        this.ttlMs = options.ttlMs || 15 * 60 * 1000;
        this.stats = { hits: 0, misses: 0, evictions: 0 };
        this.accessOrder = [];
    }

    get(key) {
        if (!this.cache.has(key)) {
            this.stats.misses++;
            return undefined;
        }

        const entry = this.cache.get(key);
        if (Date.now() - entry.timestamp > this.ttlMs) {
            this.delete(key);
            this.stats.misses++;
            return undefined;
        }

        this._updateAccess(key);
        this.stats.hits++;
        return entry.value;
    }

    set(key, value) {
        if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
            this._evict();
        }

        this._updateAccess(key);
        this.cache.set(key, { value, timestamp: Date.now() });
        return this;
    }

    delete(key) {
        if (this.cache.delete(key)) {
            const idx = this.accessOrder.indexOf(key);
            if (idx > -1) this.accessOrder.splice(idx, 1);
            return true;
        }
        return false;
    }

    invalidatePrefix(prefix) {
        const keys = Array.from(this.cache.keys()).filter(k => k.startsWith(prefix));
        keys.forEach(k => this.delete(k));
    }

    clear() {
        this.cache.clear();
        this.accessOrder = [];
        this.stats = { hits: 0, misses: 0, evictions: 0 };
    }

    getStats() {
        const total = this.stats.hits + this.stats.misses;
        return {
            size: this.cache.size,
            maxSize: this.maxSize,
            hitRate: total > 0 ? ((this.stats.hits / total) * 100).toFixed(2) + "%" : "0%",
            ...this.stats
        };
    }

    _updateAccess(key) {
        const idx = this.accessOrder.indexOf(key);
        if (idx > -1) this.accessOrder.splice(idx, 1);
        this.accessOrder.push(key);
    }

    _evict() {
        const key = this.accessOrder.shift();
        if (key) {
            this.cache.delete(key);
            this.stats.evictions++;
        }
    }
}

export default LRUCache;
