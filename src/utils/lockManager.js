class LockManager {
    constructor() {
        this.locks = new Map();
        this.waitingQueue = new Map();
        this.lockTimeout = 30000;
        this.cleanupInterval = setInterval(() => this._cleanupStaleLocks(), 10000);
        this.metrics = {
            acquiredCount: 0,
            contentionCount: 0,
            timeoutCount: 0,
            avgWaitTime: 0,
            totalWaitTime: 0,
            waitCount: 0
        };
    }

    async acquireLock(documentId, timeoutMs = this.lockTimeout) {
        if (!documentId) throw new Error('Document ID is required');

        const startTime = Date.now();
        if (this.locks.has(documentId)) {
            this.metrics.contentionCount++;
            if (!this.waitingQueue.has(documentId)) {
                this.waitingQueue.set(documentId, []);
            }
            const waitPromise = new Promise((resolve, reject) => {
                const waitInfo = {
                    resolve,
                    reject,
                    timestamp: Date.now(),
                    timeout: setTimeout(() => {
                        const queue = this.waitingQueue.get(documentId);
                        if (queue) {
                            const index = queue.findIndex(w => w === waitInfo);
                            if (index !== -1) {
                                queue.splice(index, 1);
                                if (queue.length === 0) {
                                    this.waitingQueue.delete(documentId);
                                }
                            }
                        }
                        this.metrics.timeoutCount++;
                        reject(new Error(`Lock acquisition timed out after ${timeoutMs}ms for document ${documentId}`));
                    }, timeoutMs)
                };

                this.waitingQueue.get(documentId).push(waitInfo);
            });

            try {
                await waitPromise;
                const waitTime = Date.now() - startTime;
                this.metrics.totalWaitTime += waitTime;
                this.metrics.waitCount++;
                this.metrics.avgWaitTime = this.metrics.totalWaitTime / this.metrics.waitCount;
            } catch (err) {
                throw err;
            }
        }

        this.locks.set(documentId, {
            timestamp: Date.now(),
            owner: Math.random().toString(36).substring(2, 15)
        });
        this.metrics.acquiredCount++;

        return this.locks.get(documentId).owner;
    }

    releaseLock(documentId, lockOwner) {
        if (!documentId) return false;

        const lockInfo = this.locks.get(documentId);
        if (!lockInfo || (lockOwner && lockInfo.owner !== lockOwner)) {
            return false;
        }

        this.locks.delete(documentId);

        const waitQueue = this.waitingQueue.get(documentId);
        if (waitQueue && waitQueue.length > 0) {
            const nextWaiter = waitQueue.shift();
            clearTimeout(nextWaiter.timeout);
            nextWaiter.resolve();

            if (waitQueue.length === 0) {
                this.waitingQueue.delete(documentId);
            }
        }

        return true;
    }

    async withLock(documentId, fn, timeoutMs = this.lockTimeout) {
        let lockOwner;
        try {
            lockOwner = await this.acquireLock(documentId, timeoutMs);
            const result = await fn();
            return result;
        } finally {
            if (lockOwner) {
                this.releaseLock(documentId, lockOwner);
            }
        }
    }

    _cleanupStaleLocks() {
        const now = Date.now();
        let cleanedCount = 0;

        for (const [docId, lockInfo] of this.locks.entries()) {
            if (now - lockInfo.timestamp > this.lockTimeout) {
                console.warn(`Cleaning up stale lock for document ${docId} after ${(now - lockInfo.timestamp) / 1000}s`);
                this.releaseLock(docId);
                cleanedCount++;
            }
        }

        if (cleanedCount > 0) {
            console.log(`Cleaned up ${cleanedCount} stale locks`);
        }
    }

    getMetrics() {
        return {
            ...this.metrics,
            activeLocks: this.locks.size,
            waitingQueues: this.waitingQueue.size,
            waitingProcesses: Array.from(this.waitingQueue.values()).reduce((sum, queue) => sum + queue.length, 0)
        };
    }
}

const lockManager = new LockManager();
module.exports = lockManager;
