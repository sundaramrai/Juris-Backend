export const appConfig = {
    port: process.env.PORT || 3000,
    nodeEnv: process.env.NODE_ENV || "development",
    isProduction: process.env.NODE_ENV === "production",
    isVercel: process.env.VERCEL === "1",
    corsOrigins: new Set(
        (process.env.CORS_ORIGINS || "")
            .split(",")
            .map((origin) => origin.trim())
            .filter(Boolean)
    ),
    limits: {
        json: "10mb",
        urlencoded: "10mb",
    },
    rateLimit: {
        windowMs: 15 * 60 * 1000,
        productionMax: 100,
        developmentMax: 1000,
    },
    timeouts: {
        keepAlive: 65000,
        headers: 66000,
    },
};
