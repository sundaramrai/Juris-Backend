import { appConfig } from "../config/app.js";

class ErrorHandler {
    constructor() {
        this.errorLog = [];
        this.maxLogSize = 1000;
    }

    logError(err, req) {
        const errorDetails = {
            timestamp: new Date().toISOString(),
            error: err.message,
            stack: err.stack,
            path: req.path,
            method: req.method,
            ip: req.ip,
            userAgent: req.get("user-agent"),
            body: this._sanitizeRequestBody(req.body),
        };

        console.error(
            `[ERROR] ${errorDetails.timestamp} - ${errorDetails.method} ${errorDetails.path} - ${errorDetails.error}`
        );
        this.errorLog.unshift(errorDetails);
        if (this.errorLog.length > this.maxLogSize) {
            this.errorLog.pop();
        }

        return errorDetails;
    }

    _sanitizeRequestBody(body) {
        if (!body) return {};
        const sanitized = { ...body };
        const sensitiveFields = [
            "password",
            "token",
            "apiKey",
            "secret",
            "creditCard",
        ];
        for (const field of sensitiveFields) {
            if (field in sanitized) {
                sanitized[field] = "[REDACTED]";
            }
        }

        return sanitized;
    }

    getErrorMiddleware() {
        return (err, req, res, next) => {
            const errorDetails = this.logError(err, req);
            const statusCode = err.statusCode || 500;
            const isDevelopment = process.env.NODE_ENV !== "production";

            const errorResponse = {
                error: true,
                message:
                    statusCode === 500
                        ? "An unexpected error occurred. Our team has been notified."
                        : err.message,
                errorId: errorDetails.timestamp,
            };

            if (isDevelopment && err.stack) {
                errorResponse.stack = err.stack;
            }

            res.status(statusCode).json(errorResponse);
        };
    }

    getRecentErrors(limit = 50) {
        return this.errorLog.slice(0, limit);
    }
}

const errorHandler = new ErrorHandler();

export { errorHandler };
export const errorMiddleware = errorHandler.getErrorMiddleware();

export function handle404(req, res) {
    res.status(404).json({ error: "Route not found" });
}

export function handleError(err, req, res, next) {
    if (!appConfig.isProduction) console.error(err);
    res.status(err.status || 500).json({
        error: appConfig.isProduction ? "Internal server error" : err.message,
    });
}
