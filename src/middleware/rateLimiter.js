class RateLimiter {
    constructor() {
        this.requests = new Map();
        this.ipLimits = new Map();
        this.defaultLimits = {
            windowMs: 60 * 1000,
            maxRequests: 60,
        };
    }

    _getClientIp(req) {
        return (
            req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
            req.socket.remoteAddress
        );
    }

    setLimit(ip, maxRequests, windowMs = this.defaultLimits.windowMs) {
        this.ipLimits.set(ip, { maxRequests, windowMs });
    }

    resetLimit(ip) {
        this.requests.delete(ip);
        this.ipLimits.delete(ip);
    }

    middleware() {
        return (req, res, next) => {
            const ip = this._getClientIp(req);
            const now = Date.now();
            const limits = this.ipLimits.get(ip) || this.defaultLimits;
            const { windowMs, maxRequests } = limits;

            if (!this.requests.has(ip)) {
                this.requests.set(ip, []);
            }
            const requests = this.requests.get(ip);

            const validRequests = requests.filter(
                (timestamp) => now - timestamp < windowMs
            );
            if (validRequests.length >= maxRequests) {
                return res.status(429).json({
                    error: "Too many requests, please try again later",
                    retryAfter: Math.ceil((validRequests[0] + windowMs - now) / 1000),
                });
            }

            validRequests.push(now);
            this.requests.set(ip, validRequests);
            res.setHeader("X-RateLimit-Limit", maxRequests);
            res.setHeader(
                "X-RateLimit-Remaining",
                maxRequests - validRequests.length
            );
            res.setHeader("X-RateLimit-Reset", Math.ceil((now + windowMs) / 1000));

            next();
        };
    }

    getStats() {
        const stats = {
            totalTrackedIps: this.requests.size,
            customLimits: this.ipLimits.size,
            ipDetails: {},
        };

        for (const [ip, requests] of this.requests.entries()) {
            const limits = this.ipLimits.get(ip) || this.defaultLimits;
            stats.ipDetails[ip] = {
                currentRequests: requests.length,
                maxRequests: limits.maxRequests,
                windowMs: limits.windowMs,
                remaining: limits.maxRequests - requests.length,
            };
        }

        return stats;
    }
}

const rateLimiter = new RateLimiter();
export default rateLimiter;
