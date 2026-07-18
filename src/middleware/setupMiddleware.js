import cors from "cors";
import compression from "compression";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import express from "express";
import querystring from "node:querystring";
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
            return compression.filter(req, res);
        },
        level: 6,
    });

const PROHIBITED_KEY_PATTERN = /^\$|\./;
const PROHIBITED_KEY_REPLACER = /^\$|\./g;
const REPLACE_WITH = "_";

const isPlainObject = (value) =>
    value !== null && typeof value === "object" && !Array.isArray(value);

const sanitizeObject = (target) => {
    if (!target || typeof target !== "object") return target;

    if (Array.isArray(target)) {
        target.forEach(sanitizeObject);
        return target;
    }

    for (const key of Object.keys(target)) {
        const value = target[key];

        if (PROHIBITED_KEY_PATTERN.test(key)) {
            delete target[key];
            const sanitizedKey = key.replace(PROHIBITED_KEY_REPLACER, REPLACE_WITH);

            if (
                sanitizedKey !== "__proto__" &&
                sanitizedKey !== "constructor" &&
                sanitizedKey !== "prototype"
            ) {
                target[sanitizedKey] = value;
                sanitizeObject(target[sanitizedKey]);
            }

            continue;
        }

        if (Array.isArray(value) || isPlainObject(value)) sanitizeObject(value);
    }

    return target;
};

const parseSanitizedQuery = (query) => sanitizeObject(querystring.parse(query));

const sanitizeRequestBody = (req, res, next) => {
    sanitizeObject(req.body);
    next();
};

export function setupMiddleware(app) {
    if (appConfig.isProduction) app.set("trust proxy", 1);

    app.set("query parser", parseSanitizedQuery);
    app.use(helmet(helmetConfig));
    app.use("/api", createRateLimitMiddleware());
    app.use(createCompressionMiddleware());
    app.use(createCorsMiddleware());
    app.use(express.json({ limit: appConfig.limits.json }));
    app.use(express.urlencoded({ extended: true, limit: appConfig.limits.urlencoded }));
    app.use(sanitizeRequestBody);
}
