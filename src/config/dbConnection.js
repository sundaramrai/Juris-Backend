const mongoose = require('mongoose');

class MongoConnectionManager {
    constructor(uri, options = {}) {
        this.uri = uri;
        this.options = {
            useNewUrlParser: true,
            useUnifiedTopology: true,
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 45000,
            ...options
        };
        this.isConnected = false;
        this.reconnectTimer = null;
        this.pingInterval = null;
        this.pingIntervalTime = options.pingIntervalTime || 30000;
        this.maxReconnectAttempts = options.maxReconnectAttempts || 10;
        this.reconnectAttempts = 0;
        this.reconnectInterval = options.reconnectInterval || 5000;

        mongoose.connection.on('connected', () => this._handleConnected());
        mongoose.connection.on('disconnected', () => this._handleDisconnected());
        mongoose.connection.on('error', (err) => this._handleError(err));
    }

    async connect() {
        if (mongoose.connection.readyState === 1) {
            console.log('MongoDB already connected');
            this.isConnected = true;
            this._startPing();
            return mongoose.connection;
        }

        try {
            console.log('Connecting to MongoDB...');
            await mongoose.connect(this.uri, this.options);
            console.log('MongoDB connection established');
            return mongoose.connection;
        } catch (error) {
            console.error('MongoDB connection error:', error);
            this._scheduleReconnect();
            throw error;
        }
    }

    async disconnect() {
        this._stopPing();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (mongoose.connection.readyState !== 0) {
            await mongoose.disconnect();
            console.log('MongoDB disconnected');
        }
    }

    async _ping() {
        if (mongoose.connection.readyState !== 1) {
            console.warn('Ping failed: MongoDB not connected');
            return;
        }

        try {
            await mongoose.connection.db.admin().ping();
        } catch (error) {
            console.error('MongoDB ping failed:', error);
            if (this.isConnected) {
                this._handleDisconnected();
            }
        }
    }

    _startPing() {
        if (this.pingInterval) {
            return;
        }

        this.pingInterval = setInterval(() => {
            this._ping().catch(err => {
                console.error('Error during MongoDB ping:', err);
            });
        }, this.pingIntervalTime);
    }

    _stopPing() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
    }

    _handleConnected() {
        this.isConnected = true;
        this.reconnectAttempts = 0;
        console.log('MongoDB connection established');
        this._startPing();
    }

    _handleDisconnected() {
        const wasConnected = this.isConnected;
        this.isConnected = false;

        this._stopPing();

        if (wasConnected) {
            console.warn('MongoDB disconnected');
        }

        this._scheduleReconnect();
    }

    _handleError(error) {
        console.error('MongoDB connection error:', error);
        if (this.isConnected) {
            this._handleDisconnected();
        }
    }

    _scheduleReconnect() {
        if (this.reconnectTimer) {
            return;
        }

        this.reconnectAttempts++;

        if (this.reconnectAttempts > this.maxReconnectAttempts) {
            console.error(`Failed to reconnect to MongoDB after ${this.maxReconnectAttempts} attempts`);
            return;
        }

        const delay = this.reconnectInterval * Math.min(Math.pow(2, this.reconnectAttempts - 1), 10);

        console.info(`Scheduling MongoDB reconnection in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = null;

            try {
                if (mongoose.connection.readyState === 0) {
                    console.info('Attempting to reconnect to MongoDB...');
                    await mongoose.connect(this.uri, this.options);
                    console.info('MongoDB reconnection successful');
                } else if (mongoose.connection.readyState === 1) {
                    console.info('MongoDB already reconnected');
                    this._handleConnected();
                } else {
                    console.warn(`MongoDB in state ${mongoose.connection.readyState}, forcing reconnect`);
                    try {
                        await mongoose.disconnect();
                    } catch (err) {
                        console.warn("Error during disconnect:", err.message);
                    }
                    await mongoose.connect(this.uri, this.options);
                }
            } catch (error) {
                console.error('MongoDB reconnection error:', error);
                this._scheduleReconnect();
            }
        }, delay);
    }

    getConnectionStatus() {
        return {
            isConnected: this.isConnected,
            readyState: mongoose.connection.readyState,
            reconnectAttempts: this.reconnectAttempts,
            reconnectScheduled: !!this.reconnectTimer,
            stateDescription: this._getReadyStateDescription(mongoose.connection.readyState)
        };
    }

    _getReadyStateDescription(state) {
        const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];
        return states[state] || 'unknown';
    }
}

const connectionUri = process.env.MONGO_URI;
if (!connectionUri) {
    console.error('MONGO_URI environment variable is not set!');
}

const connectionManager = new MongoConnectionManager(
    connectionUri,
    {
        pingIntervalTime: 30000,
        maxReconnectAttempts: 50,
        reconnectInterval: 3000
    }
);

module.exports = connectionManager;
