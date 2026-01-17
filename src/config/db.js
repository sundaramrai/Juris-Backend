import mongoose from "mongoose";
import { EventEmitter } from "node:events";

const ConnectionState = Object.freeze({
    DISCONNECTED: 0,
    CONNECTED: 1,
    CONNECTING: 2,
    DISCONNECTING: 3,
});

const STATE_NAMES = Object.freeze({
    0: "disconnected",
    1: "connected",
    2: "connecting",
    3: "disconnecting",
});

const DEFAULT_CONFIG = Object.freeze({
    maxPoolSize: 10,
    socketTimeoutMS: 45000,
    connectTimeoutMS: 30000,
    serverSelectionTimeoutMS: 30000,
    maxReconnectAttempts: 10,
    baseReconnectDelayMs: 2000,
    maxReconnectDelayMs: 60000,
    healthCheckIntervalMs: 60000,
    pingTimeoutMs: 5000,
    maxPingFailures: 3,
});

class DatabaseManager extends EventEmitter {
    static #instance = null;

    #uri = null;
    #config = { ...DEFAULT_CONFIG };
    #state = {
        connected: false,
        shuttingDown: false,
        reconnecting: false,
        reconnectAttempts: 0,
        pingFailures: 0,
    };
    #timers = { healthCheck: null, reconnect: null };
    #connectionPromise = null;
    #metrics = {
        opened: 0,
        closed: 0,
        errors: 0,
        reconnects: 0,
        lastConnected: null,
        lastDisconnected: null,
        lastError: null,
    };

    constructor() {
        super();
        if (DatabaseManager.#instance) return DatabaseManager.#instance;
        DatabaseManager.#instance = this;
        this.#bindEvents();
        this.#bindProcessSignals();
    }

    static getInstance() {
        return DatabaseManager.#instance ?? new DatabaseManager();
    }

    async connect(uri = process.env.MONGO_URI, config = {}) {
        if (!uri) throw new Error("MongoDB URI required. Set MONGO_URI env variable.");

        this.#uri = uri;
        Object.assign(this.#config, config);

        const readyState = mongoose.connection.readyState;

        if (readyState === ConnectionState.CONNECTED) {
            this.#ensureHealthCheck();
            return mongoose.connection;
        }

        if (this.#connectionPromise) return this.#connectionPromise;

        this.#connectionPromise = this.#createConnection();
        try {
            return await this.#connectionPromise;
        } finally {
            this.#connectionPromise = null;
        }
    }

    async disconnect() {
        this.#state.shuttingDown = true;
        this.#clearTimers();

        if (mongoose.connection.readyState === ConnectionState.DISCONNECTED) return;

        try {
            await mongoose.disconnect();
            console.log("[DB] Disconnected gracefully");
        } catch (err) {
            console.error("[DB] Disconnect error:", err.message);
            throw err;
        }
    }

    async ensureConnection() {
        if (this.isReady()) return mongoose.connection;
        if (this.#uri) return this.connect(this.#uri);
        throw new Error("Database not initialized");
    }

    isReady() {
        return mongoose.connection.readyState === ConnectionState.CONNECTED;
    }

    getConnection() {
        return mongoose.connection;
    }

    getStatus() {
        const readyState = mongoose.connection.readyState;
        return {
            isConnected: this.#state.connected && readyState === ConnectionState.CONNECTED,
            readyState,
            stateName: STATE_NAMES[readyState] ?? "unknown",
            isReconnecting: this.#state.reconnecting,
            reconnectAttempts: this.#state.reconnectAttempts,
            healthCheckActive: !!this.#timers.healthCheck,
            metrics: { ...this.#metrics },
        };
    }

    async #createConnection() {
        const options = {
            maxPoolSize: this.#config.maxPoolSize,
            socketTimeoutMS: this.#config.socketTimeoutMS,
            connectTimeoutMS: this.#config.connectTimeoutMS,
            serverSelectionTimeoutMS: this.#config.serverSelectionTimeoutMS,
        };

        try {
            console.log("[DB] Connecting...");
            await mongoose.connect(this.#uri, options);
            console.log("[DB] Connected successfully");
            return mongoose.connection;
        } catch (err) {
            this.#recordError(err);
            throw err;
        }
    }

    #bindEvents() {
        const conn = mongoose.connection;
        conn.on("connected", () => this.#onConnected());
        conn.on("disconnected", () => this.#onDisconnected());
        conn.on("error", (err) => this.#onError(err));
        conn.on("reconnected", () => this.emit("reconnected"));
    }

    #bindProcessSignals() {
        const shutdown = async (signal) => {
            console.log(`[DB] ${signal} received, closing...`);
            await this.disconnect();
        };
        process.once("SIGINT", () => shutdown("SIGINT"));
        process.once("SIGTERM", () => shutdown("SIGTERM"));
    }

    #onConnected() {
        Object.assign(this.#state, {
            connected: true,
            reconnecting: false,
            reconnectAttempts: 0,
            pingFailures: 0,
        });
        this.#metrics.opened++;
        this.#metrics.lastConnected = new Date();
        this.#cancelReconnect();
        this.#startHealthCheck();
        console.log("[DB] Connection established");
        this.emit("connected");
    }

    #onDisconnected() {
        const wasConnected = this.#state.connected;
        this.#state.connected = false;
        this.#metrics.closed++;
        this.#metrics.lastDisconnected = new Date();
        this.#stopHealthCheck();
        console.log("[DB] Disconnected");

        if (wasConnected && !this.#state.shuttingDown && !this.#state.reconnecting) {
            this.emit("disconnected");
            this.#scheduleReconnect();
        }
    }

    #onError(err) {
        this.#recordError(err);
        console.error("[DB] Error:", err.message);
        this.emit("error", err);
    }

    #recordError(err) {
        this.#metrics.errors++;
        this.#metrics.lastError = { message: err.message, time: new Date() };
    }

    #startHealthCheck() {
        if (this.#timers.healthCheck) return;
        this.#timers.healthCheck = setInterval(() => this.#ping(), this.#config.healthCheckIntervalMs);
    }

    #stopHealthCheck() {
        if (this.#timers.healthCheck) {
            clearInterval(this.#timers.healthCheck);
            this.#timers.healthCheck = null;
        }
    }

    #ensureHealthCheck() {
        if (!this.#timers.healthCheck && this.#state.connected) this.#startHealthCheck();
    }

    async #ping() {
        if (mongoose.connection.readyState !== ConnectionState.CONNECTED) return;

        try {
            await Promise.race([
                mongoose.connection.db.admin().ping(),
                new Promise((_, reject) => setTimeout(() => reject(new Error("Ping timeout")), this.#config.pingTimeoutMs)),
            ]);
            this.#state.pingFailures = 0;
            this.emit("healthCheck", { healthy: true });
        } catch (err) {
            this.#state.pingFailures++;
            console.warn(`[DB] Ping failed (${this.#state.pingFailures}/${this.#config.maxPingFailures})`);

            if (this.#state.pingFailures >= this.#config.maxPingFailures) {
                console.error("[DB] Max ping failures, triggering reconnect");
                this.emit("healthCheck", { healthy: false });
                this.#onDisconnected();
            }
        }
    }

    #scheduleReconnect() {
        if (this.#timers.reconnect || this.#state.reconnecting || this.#state.shuttingDown) return;

        if (this.#state.reconnectAttempts >= this.#config.maxReconnectAttempts) {
            console.error(`[DB] Max reconnect attempts (${this.#config.maxReconnectAttempts}) reached`);
            this.emit("maxReconnectAttemptsReached");
            return;
        }

        this.#state.reconnecting = true;
        this.#state.reconnectAttempts++;
        this.#metrics.reconnects++;

        const delay = Math.min(
            this.#config.baseReconnectDelayMs * Math.pow(2, this.#state.reconnectAttempts - 1),
            this.#config.maxReconnectDelayMs
        );

        console.log(`[DB] Reconnecting in ${delay}ms (${this.#state.reconnectAttempts}/${this.#config.maxReconnectAttempts})`);

        this.#timers.reconnect = setTimeout(() => {
            this.#timers.reconnect = null;
            this.#attemptReconnect();
        }, delay);
    }

    async #attemptReconnect() {
        if (this.#state.shuttingDown) {
            this.#state.reconnecting = false;
            return;
        }

        if (mongoose.connection.readyState === ConnectionState.CONNECTED) {
            this.#state.reconnecting = false;
            this.#state.reconnectAttempts = 0;
            return;
        }

        try {
            console.log(`[DB] Reconnect attempt ${this.#state.reconnectAttempts}...`);

            if (mongoose.connection.readyState !== ConnectionState.DISCONNECTED) {
                try { await mongoose.disconnect(); } catch { }
            }

            await mongoose.connect(this.#uri, {
                maxPoolSize: this.#config.maxPoolSize,
                socketTimeoutMS: this.#config.socketTimeoutMS,
                connectTimeoutMS: this.#config.connectTimeoutMS,
                serverSelectionTimeoutMS: this.#config.serverSelectionTimeoutMS,
            });

            console.log("[DB] Reconnected successfully");
            this.#state.reconnecting = false;
        } catch (err) {
            console.error("[DB] Reconnect failed:", err.message);
            this.#scheduleReconnect();
        }
    }

    #cancelReconnect() {
        if (this.#timers.reconnect) {
            clearTimeout(this.#timers.reconnect);
            this.#timers.reconnect = null;
        }
        this.#state.reconnecting = false;
    }

    #clearTimers() {
        this.#stopHealthCheck();
        this.#cancelReconnect();
    }
}

const db = DatabaseManager.getInstance();

export default db;
export { DatabaseManager, ConnectionState };
