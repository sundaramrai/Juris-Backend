import express from "express";
import os from "node:os";
import { errorHandler } from "../middleware/errorHandler.js";
import lockManager from "../utils/lockManager.js";
import dbManager from "../utils/dbManager.js";
import {
    getServiceMetrics,
    checkGeminiApiStatus,
} from "../services/aiService.js";

const router = express.Router();

let systemInfoCache = null,
    systemInfoCacheTime = 0;
const CACHE_TTL = 30000;

const getBasicSystemInfo = () => ({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
});

const getMemoryInfo = () => {
    const mem = process.memoryUsage();
    return {
        total: os.totalmem(),
        free: os.freemem(),
        used: os.totalmem() - os.freemem(),
        rss: mem.rss,
        heapTotal: mem.heapTotal,
        heapUsed: mem.heapUsed,
        external: mem.external,
    };
};

const getSystemInfo = () => ({
    cpu: {
        model: os.cpus()[0].model,
        cores: os.cpus().length,
        loadAvg: os.loadavg(),
    },
    os: {
        platform: os.platform(),
        release: os.release(),
        hostname: os.hostname(),
    },
    process: {
        pid: process.pid,
        versions: process.versions,
        env: process.env.NODE_ENV,
    },
});

const getDatabaseStatus = () => {
    try {
        return dbManager.getConnectionStatus();
    } catch (err) {
        return { status: "error", message: err.message };
    }
};

const getCompleteSystemInfo = async () => {
    const now = Date.now();
    if (systemInfoCache && now - systemInfoCacheTime < CACHE_TTL)
        return systemInfoCache;

    const aiStatus = await checkGeminiApiStatus();
    const systemInfo = {
        ...getBasicSystemInfo(),
        memory: getMemoryInfo(),
        ...getSystemInfo(),
        aiService: {
            status: aiStatus ? "up" : "down",
            metrics: getServiceMetrics(),
        },
        lockManager: lockManager.getMetrics(),
        database: getDatabaseStatus(),
    };

    systemInfoCache = systemInfo;
    systemInfoCacheTime = now;
    return systemInfo;
};

router.get("/", (req, res) =>
    res.status(200).json({ status: "up", timestamp: new Date().toISOString() })
);

router.get("/system", async (req, res) => {
    try {
        const info = await getCompleteSystemInfo();
        res.status(200).json(info);
    } catch (err) {
        console.error("Health check error:", err);
        res.status(500).json({ status: "error", message: err.message });
    }
});

router.get("/errors", (req, res) => {
    try {
        const apiKey = req.query.key;
        const isAdmin = apiKey && apiKey === process.env.ADMIN_API_KEY;
        const isDev = process.env.NODE_ENV !== "production";
        if (!isDev && !isAdmin)
            return res.status(403).json({ error: "Unauthorized access" });

        const limit = Number.parseInt(req.query.limit) || 50;
        if (Number.isNaN(limit) || limit <= 0)
            return res.status(400).json({ error: "Invalid limit parameter" });

        const errors = errorHandler.getRecentErrors(limit);
        res.status(200).json({ count: errors.length, errors });
    } catch (err) {
        console.error("Error retrieving error logs:", err);
        res
            .status(500)
            .json({ status: "error", message: "Failed to retrieve error logs" });
    }
});

export default router;
