import mongoose from "mongoose";

class DatabaseManager {
    maxRetries = 5;
    retryInterval = 5000;
    connectionOptions = {
        useNewUrlParser: true,
        useUnifiedTopology: true,
        serverSelectionTimeoutMS: 5000,
        poolSize: 10,
        socketTimeoutMS: 45000,
        keepAlive: true,
        keepAliveInitialDelay: 300000,
    };
    metrics = {
        connectionsOpened: 0,
        connectionsClosed: 0,
        connectionsErrored: 0,
        lastReconnectAttempt: null,
        lastConnectedTime: null,
        lastDisconnectedTime: null,
        currentStatus: "disconnected",
    };
    _shuttingDown = false;

    constructor() {
        this._setupListeners();
    }

    _setupListeners() {
        mongoose.connection.on("connected", () => {
            this.metrics.connectionsOpened++;
            this.metrics.lastConnectedTime = new Date();
            this.metrics.currentStatus = "connected";
            console.log("Successfully connected to MongoDB");
        });
        mongoose.connection.on("disconnected", () => {
            this.metrics.connectionsClosed++;
            this.metrics.lastDisconnectedTime = new Date();
            this.metrics.currentStatus = "disconnected";
            console.log("MongoDB disconnected");
            if (!this._shuttingDown) this._reconnect();
        });
        mongoose.connection.on("error", (err) => {
            this.metrics.connectionsErrored++;
            this.metrics.currentStatus = "errored";
            console.error("MongoDB connection error:", err);
        });
    }

    async _reconnect(attempt = 1) {
        if (attempt > this.maxRetries) {
            console.error(
                `Failed to reconnect to MongoDB after ${this.maxRetries} attempts`
            );
            return;
        }
        this.metrics.lastReconnectAttempt = new Date();
        this.metrics.currentStatus = "reconnecting";
        console.log(
            `Attempting to reconnect to MongoDB (${attempt}/${this.maxRetries})`
        );
        setTimeout(async () => {
            try {
                await this.connect(this.connectionString, attempt);
            } catch {
                this._reconnect(attempt + 1);
            }
        }, this.retryInterval);
    }

    async connect(connectionString, attempt = 1) {
        if (!connectionString)
            throw new Error("MongoDB connection string is required");
        this.connectionString = connectionString;
        if (mongoose.connection.readyState === 1) return mongoose.connection;
        try {
            await mongoose.connect(connectionString, this.connectionOptions);
            return mongoose.connection;
        } catch (err) {
            if (attempt < this.maxRetries) {
                console.error("Failed to connect to MongoDB, retrying...", err);
                await new Promise((res) => setTimeout(res, this.retryInterval));
                return this.connect(connectionString, attempt + 1);
            }
            console.error("Failed to connect to MongoDB:", err);
            throw err;
        }
    }

    async disconnect() {
        this._shuttingDown = true;
        if (mongoose.connection.readyState !== 0) {
            try {
                await mongoose.disconnect();
                console.log("Disconnected from MongoDB");
            } catch (err) {
                console.error("Error disconnecting from MongoDB:", err);
                throw err;
            }
        }
    }

    getConnection() {
        return mongoose.connection;
    }

    getConnectionStatus() {
        return {
            isConnected: mongoose.connection.readyState === 1,
            ...this.metrics,
            connectionState:
                mongoose.STATES[mongoose.connection.readyState] || "unknown",
        };
    }
}

const dbManager = new DatabaseManager();
export default dbManager;
