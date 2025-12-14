import cors from "cors";
import compression from "compression";
import compressible from "compressible";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import mongoSanitize from "express-mongo-sanitize";
import express from "express";
import { appConfig } from "../config/app.js";

const helmetConfig = {
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            scriptSrc: ["'self'"],
            imgSrc: ["'self'", "data:", "https:"],
        },
    },
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
};

const createCorsMiddleware = () => {
    const originCache = new Map();
    return cors({
        origin: (origin, callback) => {
            if (!origin) return callback(null, true);
            if (originCache.has(origin))
                return callback(null, originCache.get(origin));

            const isAllowed =
                (!appConfig.isProduction && origin.startsWith("http://localhost:")) ||
                appConfig.corsOrigins.has(origin);

            originCache.set(origin, isAllowed);
            callback(null, isAllowed);
        },
        credentials: true,
    });
};

const createRateLimitMiddleware = () =>
    rateLimit({
        windowMs: appConfig.rateLimit.windowMs,
        max: appConfig.isProduction
            ? appConfig.rateLimit.productionMax
            : appConfig.rateLimit.developmentMax,
        standardHeaders: true,
        legacyHeaders: false,
        skip: (req) =>
            !appConfig.isProduction && req.ip === "127.0.0.1",
    });

const createCompressionMiddleware = () =>
    compression({
        filter: (req, res) => {
            if (req.headers["x-no-compression"]) return false;
            const contentType =
                typeof res.getHeader === "function"
                    ? res.getHeader("Content-Type")
                    : undefined;
            return compressible(contentType);
        },
        level: 6,
    });

export function setupMiddleware(app) {
    if (appConfig.isProduction) app.set("trust proxy", 1);

    app.use(helmet(helmetConfig));
    app.use("/api", createRateLimitMiddleware());
    app.use(createCompressionMiddleware());
    app.use(createCorsMiddleware());
    app.use(express.json({ limit: appConfig.limits.json }));
    app.use(express.urlencoded({ extended: true, limit: appConfig.limits.urlencoded }));
    app.use(mongoSanitize({ replaceWith: "_" }));
}
