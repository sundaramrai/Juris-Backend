class LockManager {
    constructor() {
        this.locks = new Map();
        this.pendingOperations = new Map();
        setInterval(() => this._cleanupStaleLocks(), 60000);
    }

    async acquireLock(documentId) {
        if (!documentId) return true;
        if (!this.locks.has(documentId)) {
            this.locks.set(documentId, {
                locked: true,
                timestamp: Date.now()
            });
            return true;
        }
        return new Promise(resolve => {
            const checkLock = () => {
                if (!this.locks.has(documentId) || !this.locks.get(documentId).locked) {
                    this.locks.set(documentId, {
                        locked: true,
                        timestamp: Date.now()
                    });
                    resolve(true);
                } else {
                    if (!this.pendingOperations.has(documentId)) {
                        this.pendingOperations.set(documentId, []);
                    }
                    this.pendingOperations.get(documentId).push(checkLock);
                    setTimeout(() => {
                        console.warn(`Lock timeout for document ${documentId}, forcing acquisition`);
                        this.locks.set(documentId, {
                            locked: true,
                            timestamp: Date.now()
                        });
                        resolve(true);
                    }, 3000);
                }
            };

            setTimeout(checkLock, 10);
        });
    }

    releaseLock(documentId) {
        if (!documentId || !this.locks.has(documentId)) return;
        const lockInfo = this.locks.get(documentId);
        lockInfo.locked = false;
        if (this.pendingOperations.has(documentId)) {
            const pending = this.pendingOperations.get(documentId);
            if (pending.length > 0) {
                const nextOperation = pending.shift();
                setTimeout(nextOperation, 0);
            }

            if (pending.length === 0) {
                this.pendingOperations.delete(documentId);
            }
        }
    }

    async withLock(documentId, fn) {
        try {
            await this.acquireLock(documentId);
            const result = await fn();
            return result;
        } finally {
            this.releaseLock(documentId);
        }
    }

    _cleanupStaleLocks() {
        const now = Date.now();
        for (const [docId, lockInfo] of this.locks.entries()) {
            if (now - lockInfo.timestamp > 60000) {
                console.warn(`Cleaning up stale lock for document ${docId}`);
                this.locks.delete(docId);
            }
        }
    }
}

const lockManager = new LockManager();
module.exports = lockManager;
