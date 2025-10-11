const mongoose = require('mongoose');
const EventEmitter = require('events');

class DatabaseManager extends EventEmitter {
    constructor(config = {}) {
        super();

        this.config = {
            maxRetries: config.maxRetries || 5,
            retryInterval: config.retryInterval || 5000,
            serverSelectionTimeoutMS: config.serverSelectionTimeoutMS || 5000,
            socketTimeoutMS: config.socketTimeoutMS || 45000,
            poolSize: config.poolSize || 10,
            keepAliveInitialDelay: config.keepAliveInitialDelay || 300000
        };

        this.state = {
            isConnected: false,
            isShuttingDown: false,
            connectionAttempts: 0,
            connectionString: null
        };

        this.metrics = {
            connectionsOpened: 0,
            connectionsClosed: 0,
            connectionsErrored: 0,
            lastReconnectAttempt: null,
            lastConnectedTime: null,
            lastDisconnectedTime: null,
            currentStatus: 'disconnected'
        };

        this._initializeEventHandlers();
    }

    _initializeEventHandlers() {
        const connection = mongoose.connection;

        connection.on('connected', () => this._handleConnected());
        connection.on('disconnected', () => this._handleDisconnected());
        connection.on('error', (err) => this._handleError(err));
        connection.on('reconnected', () => this._handleReconnected());
    }

    _handleConnected() {
        this.state.isConnected = true;
        this.state.connectionAttempts = 0;

        this.metrics.connectionsOpened++;
        this.metrics.lastConnectedTime = new Date();
        this.metrics.currentStatus = 'connected';

        console.log('✓ Successfully connected to MongoDB');
        this.emit('connected');
    }

    _handleReconnected() {
        console.log('✓ Reconnected to MongoDB');
        this.emit('reconnected');
    }

    _handleDisconnected() {
        this.state.isConnected = false;

        this.metrics.connectionsClosed++;
        this.metrics.lastDisconnectedTime = new Date();
        this.metrics.currentStatus = 'disconnected';

        console.log('⚠ MongoDB disconnected');
        this.emit('disconnected');

        if (!this.state.isShuttingDown) {
            this._scheduleReconnect();
        }
    }

    _handleError(err) {
        this.metrics.connectionsErrored++;
        this.metrics.currentStatus = 'errored';

        console.error('✗ MongoDB connection error:', err.message);
        this.emit('error', err);

        if (this.state.isConnected) {
            this.state.isConnected = false;
        }
    }

    _scheduleReconnect() {
        if (this.state.connectionAttempts >= this.config.maxRetries) {
            const msg = `Failed to reconnect after ${this.config.maxRetries} attempts`;
            console.error(`✗ ${msg}`);
            this.emit('maxRetriesReached');
            return;
        }

        this.state.connectionAttempts++;
        this.metrics.lastReconnectAttempt = new Date();
        this.metrics.currentStatus = 'reconnecting';

        console.log(
            `⟳ Reconnection attempt ${this.state.connectionAttempts}/${this.config.maxRetries}...`
        );

        setTimeout(() => this._attemptReconnect(), this.config.retryInterval);
    }

    async _attemptReconnect() {
        try {
            await this.connect(this.state.connectionString);
        } catch (err) {
            console.error('✗ Reconnection failed:', err.message);
            this._scheduleReconnect();
        }
    }

    _buildConnectionOptions() {
        return {
            serverSelectionTimeoutMS: this.config.serverSelectionTimeoutMS,
            socketTimeoutMS: this.config.socketTimeoutMS,
            maxPoolSize: this.config.poolSize,
            minPoolSize: Math.floor(this.config.poolSize / 2),
            keepAlive: true,
            keepAliveInitialDelay: this.config.keepAliveInitialDelay
        };
    }

    async connect(connectionString) {
        if (!connectionString) {
            throw new Error('MongoDB connection string is required');
        }

        if (this.state.isConnected && mongoose.connection.readyState === 1) {
            console.log('Already connected to MongoDB');
            return mongoose.connection;
        }

        this.state.connectionString = connectionString;

        try {
            const options = this._buildConnectionOptions();
            await mongoose.connect(connectionString, options);
            return mongoose.connection;
        } catch (err) {
            console.error('✗ Failed to connect to MongoDB:', err.message);
            throw err;
        }
    }

    async disconnect() {
        this.state.isShuttingDown = true;

        if (mongoose.connection.readyState !== 0) {
            try {
                await mongoose.disconnect();
                this.state.isConnected = false;
                console.log('✓ Gracefully disconnected from MongoDB');
            } catch (err) {
                console.error('✗ Error during disconnect:', err.message);
                throw err;
            }
        }
    }

    getConnection() {
        if (mongoose.connection.readyState !== 1) {
            console.warn('⚠ Connection is not ready');
        }
        return mongoose.connection;
    }

    getStatus() {
        const readyStates = {
            0: 'disconnected',
            1: 'connected',
            2: 'connecting',
            3: 'disconnecting'
        };

        return {
            isConnected: this.state.isConnected,
            readyState: readyStates[mongoose.connection.readyState],
            ...this.metrics,
            database: mongoose.connection.db?.databaseName || null,
            host: mongoose.connection.host || null
        };
    }

    async healthCheck() {
        try {
            if (!this.state.isConnected) {
                return { healthy: false, reason: 'Not connected' };
            }

            await mongoose.connection.db.admin().ping();
            return { healthy: true, timestamp: new Date() };
        } catch (err) {
            return { healthy: false, reason: err.message };
        }
    }

    resetMetrics() {
        Object.keys(this.metrics).forEach(key => {
            if (typeof this.metrics[key] === 'number') {
                this.metrics[key] = 0;
            } else {
                this.metrics[key] = null;
            }
        });
        this.metrics.currentStatus = this.state.isConnected ? 'connected' : 'disconnected';
    }
}

const dbManager = new DatabaseManager();

module.exports = dbManager;
module.exports.DatabaseManager = DatabaseManager;