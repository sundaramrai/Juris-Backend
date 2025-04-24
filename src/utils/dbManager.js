const mongoose = require('mongoose');

class DatabaseManager {
    constructor() {
        this.isConnected = false;
        this.connectionAttempts = 0;
        this.maxRetries = 5;
        this.retryInterval = 5000;
        this.connectionOptions = {
            useNewUrlParser: true,
            useUnifiedTopology: true,
            serverSelectionTimeoutMS: 5000,
            poolSize: 10,
            socketTimeoutMS: 45000,
            keepAlive: true,
            keepAliveInitialDelay: 300000
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

        mongoose.connection.on('connected', () => this._handleConnected());
        mongoose.connection.on('disconnected', () => this._handleDisconnected());
        mongoose.connection.on('error', (err) => this._handleError(err));
    }

    _handleConnected() {
        this.isConnected = true;
        this.metrics.connectionsOpened++;
        this.metrics.lastConnectedTime = new Date();
        this.metrics.currentStatus = 'connected';
        this.connectionAttempts = 0;
        console.log('Successfully connected to MongoDB');
    }

    _handleDisconnected() {
        this.isConnected = false;
        this.metrics.connectionsClosed++;
        this.metrics.lastDisconnectedTime = new Date();
        this.metrics.currentStatus = 'disconnected';
        console.log('MongoDB disconnected');

        if (!this._shuttingDown) {
            this._reconnect();
        }
    }

    _handleError(err) {
        this.metrics.connectionsErrored++;
        console.error('MongoDB connection error:', err);

        if (this.isConnected) {
            this.isConnected = false;
            this.metrics.currentStatus = 'errored';
        }
    }

    async _reconnect() {
        if (this.connectionAttempts >= this.maxRetries) {
            console.error(`Failed to reconnect to MongoDB after ${this.maxRetries} attempts`);
            return;
        }

        this.connectionAttempts++;
        this.metrics.lastReconnectAttempt = new Date();
        this.metrics.currentStatus = 'reconnecting';
        console.log(`Attempting to reconnect to MongoDB (${this.connectionAttempts}/${this.maxRetries})`);

        try {
            await this.connect(this.connectionString);
        } catch (err) {
            console.error('Reconnection attempt failed:', err);
            setTimeout(() => this._reconnect(), this.retryInterval);
        }
    }

    async connect(connectionString) {
        if (!connectionString) {
            throw new Error('MongoDB connection string is required');
        }

        this.connectionString = connectionString;

        try {
            if (!this.isConnected) {
                await mongoose.connect(connectionString, this.connectionOptions);
                this.isConnected = true;
            }
            return mongoose.connection;
        } catch (err) {
            console.error('Failed to connect to MongoDB:', err);
            throw err;
        }
    }

    async disconnect() {
        this._shuttingDown = true;
        if (this.isConnected) {
            try {
                await mongoose.disconnect();
                this.isConnected = false;
                console.log('Disconnected from MongoDB');
            } catch (err) {
                console.error('Error disconnecting from MongoDB:', err);
                throw err;
            }
        }
    }

    getConnection() {
        return mongoose.connection;
    }

    getConnectionStatus() {
        return {
            isConnected: this.isConnected,
            ...this.metrics,
            connectionStats: mongoose.connection.db ?
                mongoose.connection.db.serverConfig.s.coreTopology.s.state :
                'unavailable'
        };
    }
}

const dbManager = new DatabaseManager();
module.exports = dbManager;
