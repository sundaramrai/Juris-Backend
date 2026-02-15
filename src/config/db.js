import mongoose from "mongoose";

class DatabaseManager {
    static #instance;
    #uri;
    #reconnecting = false;
    #shuttingDown = false;

    constructor() {
        if (DatabaseManager.#instance) {
            throw new Error("Use DatabaseManager.getInstance() instead of new DatabaseManager()");
        }
        DatabaseManager.#instance = this;
        this.#init();
    }

    static getInstance() {
        if (!DatabaseManager.#instance) {
            DatabaseManager.#instance = new DatabaseManager();
        }
        return DatabaseManager.#instance;
    }

    async connect(uri = process.env.MONGO_URI) {
        if (!uri) throw new Error("MongoDB URI required");

        this.#uri = uri;
        const { readyState } = mongoose.connection;

        if (readyState === 1) return mongoose.connection;
        if (readyState === 2) return new Promise(r => mongoose.connection.once("connected", r));

        return mongoose.connect(uri, {
            maxPoolSize: 10,
            socketTimeoutMS: 45000,
            serverSelectionTimeoutMS: 30000,
        });
    }

    async disconnect() {
        this.#shuttingDown = true;
        if (mongoose.connection.readyState) await mongoose.disconnect();
    }

    isReady() {
        return mongoose.connection.readyState === 1;
    }

    #init() {
        mongoose.connection
            .on("disconnected", () => !this.#shuttingDown && this.#reconnect())
            .on("error", (err) => console.error("[DB] Error:", err.message));

        process.once("SIGINT", () => this.disconnect().then(() => process.exit(0)));
        process.once("SIGTERM", () => this.disconnect().then(() => process.exit(0)));
    }

    async #reconnect(attempt = 1) {
        if (this.#reconnecting || this.#shuttingDown || attempt > 5) return;

        this.#reconnecting = true;
        const delay = Math.min(1000 * 2 ** attempt, 30000);

        await new Promise(r => setTimeout(r, delay));

        try {
            if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
            await mongoose.connect(this.#uri);
            this.#reconnecting = false;
        } catch {
            this.#reconnecting = false;
            this.#reconnect(attempt + 1);
        }
    }
}

export default DatabaseManager.getInstance();
export { DatabaseManager };