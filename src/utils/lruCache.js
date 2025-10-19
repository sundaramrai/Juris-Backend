class LRUCache {
    constructor(options = {}) {
        this.cache = new Map();
        this.config = {
            maxSize: options.maxSize || 100,
            ttlMs: options.ttlMs || 15 * 60 * 1000,
            maxMemoryMB: options.maxMemoryMB || 100,
        };

        this.metrics = {
            hits: 0,
            misses: 0,
            evictions: 0,
            estimatedMemoryBytes: 0
        };
    }

    get(key) {
        const now = Date.now();
        const item = this.cache.get(key);

        if (!item || item.expiry < now) {
            if (item) this._removeItem(key);
            this.metrics.misses++;
            return undefined;
        }

        this.cache.delete(key);
        this.cache.set(key, item);
        this.metrics.hits++;
        return item.value;
    }

    set(key, value) {
        const now = Date.now();
        const itemSize = this._estimateSize(value);
        while (
            this.metrics.estimatedMemoryBytes + itemSize > this.config.maxMemoryMB * 1024 * 1024 &&
            this.cache.size > 0
        ) {
            this._evictOldest();
        }

        const existingItem = this.cache.get(key);
        if (existingItem) {
            this.metrics.estimatedMemoryBytes -= existingItem.size;
        }

        this.cache.set(key, {
            value,
            expiry: now + this.config.ttlMs,
            size: itemSize
        });

        this.metrics.estimatedMemoryBytes += itemSize;

        if (this.cache.size > this.config.maxSize) {
            this._evictOldest();
        }
    }

    delete(key) {
        return this._removeItem(key);
    }

    invalidatePrefix(prefix) {
        const keysToDelete = Array.from(this.cache.keys()).filter(key => key.startsWith(prefix));
        for (const key of keysToDelete) {
            this.delete(key);
        }
    }

    clear() {
        this.cache.clear();
        this.metrics.estimatedMemoryBytes = 0;
    }

    getStats() {
        const totalRequests = this.metrics.hits + this.metrics.misses;
        const hitRate = totalRequests > 0 ? this.metrics.hits / totalRequests : 0;

        return {
            size: this.cache.size,
            maxSize: this.config.maxSize,
            hits: this.metrics.hits,
            misses: this.metrics.misses,
            evictions: this.metrics.evictions,
            hitRate: (hitRate * 100).toFixed(2) + '%',
            memoryUsageMB: (this.metrics.estimatedMemoryBytes / (1024 * 1024)).toFixed(2),
            maxMemoryMB: this.config.maxMemoryMB
        };
    }

    _removeItem(key) {
        const item = this.cache.get(key);
        if (item) {
            this.metrics.estimatedMemoryBytes -= item.size;
            this.cache.delete(key);
            return true;
        }
        return false;
    }

    _evictOldest() {
        const oldestKey = this.cache.keys().next().value;
        if (oldestKey) {
            this._removeItem(oldestKey);
            this.metrics.evictions++;
        }
    }

    _estimateSize(obj) {
        try {
            return JSON.stringify(obj).length * 2;
        } catch {
            return 1024;
        }
    }
}

module.exports = LRUCache;
