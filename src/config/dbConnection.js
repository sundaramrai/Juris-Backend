// src/config/dbConnection.js
const mongoose = require('mongoose');
const EventEmitter = require('node:events');

const ConnectionState = {
    DISCONNECTED: 0,
    CONNECTED: 1,
    CONNECTING: 2,
    DISCONNECTING: 3
};

const STATE_DESCRIPTIONS = Object.freeze({
    [ConnectionState.DISCONNECTED]: 'disconnected',
    [ConnectionState.CONNECTED]: 'connected',
    [ConnectionState.CONNECTING]: 'connecting',
    [ConnectionState.DISCONNECTING]: 'disconnecting'
});

const DEFAULT_OPTIONS = Object.freeze({
    pingIntervalTime: 30000,
    maxReconnectAttempts: 50,
    reconnectInterval: 3000,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
    maxReconnectDelay: 60000
});

class MongoConnectionManager extends EventEmitter {
    constructor(uri, options = {}) {
        super();
        if (!uri) {
            throw new Error('MongoDB URI is required');
        }
        this.uri = uri;
        this.config = { ...DEFAULT_OPTIONS, ...options };
        this.reconnectAttempts = 0;
        this.isConnected = false;
        this.timers = {
            reconnect: null,
            ping: null
        };
        this.mongooseOptions = {
            serverSelectionTimeoutMS: this.config.serverSelectionTimeoutMS,
            socketTimeoutMS: this.config.socketTimeoutMS
        };
        this._initializeEventListeners();
    }

    _initializeEventListeners() {
        const conn = mongoose.connection;
        conn.on('connected', () => this._handleConnected());
        conn.on('disconnected', () => this._handleDisconnected());
        conn.on('error', (err) => this._handleError(err));
        conn.on('reconnected', () => {
            console.log('MongoDB reconnected');
            this.emit('reconnected');
        });
    }

    async connect() {
        const currentState = mongoose.connection.readyState;
        if (currentState === ConnectionState.CONNECTED) {
            console.log('MongoDB already connected');
            this._ensureHealthCheck();
            return mongoose.connection;
        }
        if (currentState === ConnectionState.CONNECTING) {
            console.log('MongoDB connection in progress');
            return this._waitForConnection();
        }
        try {
            console.log('Connecting to MongoDB...');
            await mongoose.connect(this.uri, this.mongooseOptions);
            return mongoose.connection;
        } catch (error) {
            console.error('MongoDB connection error:', error.message);
            this._scheduleReconnect();
            throw error;
        }
    }

    _waitForConnection() {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Connection timeout'));
            }, this.config.serverSelectionTimeoutMS);

            const checkConnection = () => {
                const state = mongoose.connection.readyState;
                if (state === ConnectionState.CONNECTED) {
                    clearTimeout(timeout);
                    resolve(mongoose.connection);
                } else if (state === ConnectionState.DISCONNECTED) {
                    clearTimeout(timeout);
                    reject(new Error('Connection failed'));
                } else {
                    setTimeout(checkConnection, 100);
                }
            };
            checkConnection();
        });
    }

    async disconnect() {
        this._clearAllTimers();
        if (mongoose.connection.readyState === ConnectionState.DISCONNECTED) {
            console.log('MongoDB already disconnected');
            return;
        }
        try {
            await mongoose.disconnect();
            console.log('MongoDB disconnected gracefully');
            this.emit('disconnected');
        } catch (error) {
            console.error('Error during disconnect:', error.message);
            throw error;
        }
    }

    async _ping() {
        if (mongoose.connection.readyState !== ConnectionState.CONNECTED) {
            return false;
        }
        try {
            await mongoose.connection.db.admin().ping();
            return true;
        } catch (error) {
            console.error('MongoDB ping failed:', error.message);
            if (this.isConnected) {
                this._handleDisconnected();
            }
            return false;
        }
    }

    _startHealthCheck() {
        if (this.timers.ping) {
            return;
        }
        this.timers.ping = setInterval(async () => {
            const isHealthy = await this._ping();
            this.emit('healthCheck', isHealthy);
        }, this.config.pingIntervalTime);
    }

    _stopHealthCheck() {
        if (this.timers.ping) {
            clearInterval(this.timers.ping);
            this.timers.ping = null;
        }
    }

    _ensureHealthCheck() {
        if (!this.timers.ping) {
            this._startHealthCheck();
        }
    }

    _handleConnected() {
        this.isConnected = true;
        this.reconnectAttempts = 0;
        console.log('MongoDB connection established');
        this._startHealthCheck();
        this.emit('connected');
    }

    _handleDisconnected() {
        const wasConnected = this.isConnected;
        this.isConnected = false;
        this._stopHealthCheck();
        if (wasConnected) {
            console.warn('MongoDB disconnected unexpectedly');
            this.emit('disconnected');
            this._scheduleReconnect();
        }
    }

    _handleError(error) {
        console.error('MongoDB connection error:', error.message);
        this.emit('error', error);
        if (this.isConnected) {
            this._handleDisconnected();
        }
    }

    _scheduleReconnect() {
        if (this.timers.reconnect) {
            return;
        }
        this.reconnectAttempts++;
        if (this.reconnectAttempts > this.config.maxReconnectAttempts) {
            const errorMsg = `Failed to reconnect after ${this.config.maxReconnectAttempts} attempts`;
            console.error(errorMsg);
            this.emit('maxReconnectAttemptsReached');
            return;
        }
        const exponentialDelay = this.config.reconnectInterval * Math.pow(2, this.reconnectAttempts - 1);
        const delay = Math.min(exponentialDelay, this.config.maxReconnectDelay);
        console.info(
            `Scheduling reconnection in ${delay}ms (attempt ${this.reconnectAttempts}/${this.config.maxReconnectAttempts})`
        );
        this.timers.reconnect = setTimeout(async () => {
            this.timers.reconnect = null;
            await this._attemptReconnect();
        }, delay);
    }

    async _attemptReconnect() {
        const currentState = mongoose.connection.readyState;
        try {
            if (currentState === ConnectionState.DISCONNECTED) {
                console.info('Attempting to reconnect to MongoDB...');
                await mongoose.connect(this.uri, this.mongooseOptions);
                console.info('MongoDB reconnection successful');
            } else if (currentState === ConnectionState.CONNECTED) {
                console.info('MongoDB already reconnected');
                this._handleConnected();
            } else {
                console.warn(`MongoDB in transitional state (${currentState}), forcing reconnect`);
                await this._forceReconnect();
            }
        } catch (error) {
            console.error('Reconnection failed:', error.message);
            this._scheduleReconnect();
        }
    }

    async _forceReconnect() {
        try {
            await mongoose.disconnect();
        } catch (err) {
            console.warn('Error during forced disconnect:', err.message);
        }
        await mongoose.connect(this.uri, this.mongooseOptions);
    }

    _clearAllTimers() {
        this._stopHealthCheck();
        if (this.timers.reconnect) {
            clearTimeout(this.timers.reconnect);
            this.timers.reconnect = null;
        }
    }

    getConnectionStatus() {
        const readyState = mongoose.connection.readyState;
        return {
            isConnected: this.isConnected,
            readyState,
            stateDescription: STATE_DESCRIPTIONS[readyState] || 'unknown',
            reconnectAttempts: this.reconnectAttempts,
            reconnectScheduled: !!this.timers.reconnect,
            healthCheckActive: !!this.timers.ping
        };
    }

    getConnection() {
        return mongoose.connection;
    }
}

const connectionUri = process.env.MONGO_URI;

if (!connectionUri) {
    console.error('MONGO_URI environment variable is not set!');
    throw new Error('MONGO_URI is required');
}

const connectionManager = new MongoConnectionManager(connectionUri, {
    pingIntervalTime: 30000,
    maxReconnectAttempts: 50,
    reconnectInterval: 3000,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000
});

module.exports = connectionManager;