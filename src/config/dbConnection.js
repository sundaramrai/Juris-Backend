const mongoose = require('mongoose');
const os = require('os');

class DatabaseConnection {
    constructor() {
        this.connection = null;
        this.connectionStatus = {
            isConnected: false,
            lastConnectedAt: null,
            lastDisconnectedAt: null,
            connectionAttempts: 0,
            reconnections: 0,
            errors: []
        };
        this.errorHistory = [];
        this.maxErrorHistoryLength = 10;
    }

    async connect() {
        const uri = process.env.MONGO_URI;

        if (!uri) {
            throw new Error('MONGO_URI environment variable is not defined');
        }
        try {
            this.connectionStatus.connectionAttempts++;
            const POOL_SIZE = process.env.MONGO_POOL_SIZE || Math.max(5, Math.min(10, os.cpus().length * 2));
            console.log(`Connecting to MongoDB with pool size: ${POOL_SIZE}`);

            if (this.connection) {
                return this.connection;
            }

            mongoose.connection.on('connected', () => {
                this.connectionStatus.isConnected = true;
                this.connectionStatus.lastConnectedAt = new Date();
                console.log('MongoDB connected successfully');
            });

            mongoose.connection.on('disconnected', () => {
                this.connectionStatus.isConnected = false;
                this.connectionStatus.lastDisconnectedAt = new Date();
                console.log('MongoDB disconnected');
            });

            mongoose.connection.on('error', (err) => {
                this.logError(err);
                console.error('MongoDB connection error:', err);
            });

            mongoose.connection.on('reconnected', () => {
                this.connectionStatus.reconnections++;
                this.connectionStatus.isConnected = true;
                this.connectionStatus.lastConnectedAt = new Date();
                console.log('MongoDB reconnected successfully');
            });

            await mongoose.connect(uri, {
                maxPoolSize: POOL_SIZE,
                minPoolSize: Math.max(2, Math.floor(POOL_SIZE / 4)),
                connectTimeoutMS: 30000,
                socketTimeoutMS: 45000,
                serverSelectionTimeoutMS: 5000,
                heartbeatFrequencyMS: 10000,
                retryWrites: true,
                retryReads: true,
                writeConcern: { w: 'majority' },
                readPreference: 'primaryPreferred'
            });

            this.connection = mongoose.connection;
            return this.connection;
        } catch (error) {
            this.logError(error);
            console.error('Database connection error:', error);
            throw error;
        }
    }

    logError(error) {
        const errorInfo = {
            message: error.message,
            name: error.name,
            timestamp: new Date(),
            stack: error.stack
        };

        this.errorHistory.unshift(errorInfo);

        if (this.errorHistory.length > this.maxErrorHistoryLength) {
            this.errorHistory.pop();
        }

        this.connectionStatus.errors = this.errorHistory.map(e => ({
            message: e.message,
            timestamp: e.timestamp
        }));
    }

    getConnectionStatus() {
        return {
            ...this.connectionStatus,
            readyState: this.connection ? this.connection.readyState : 0,
            readyStateText: this.getReadyStateText(),
            database: this.connection ? this.connection.name : null,
            host: this.connection ? this.connection.host : null,
            errorCount: this.errorHistory.length
        };
    }

    getReadyStateText() {
        const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];
        return states[this.connection ? this.connection.readyState : 0];
    }

    async createIndexes() {
        if (!this.connection || this.connection.readyState !== 1) {
            throw new Error('Database not connected');
        }

        try {
            const collections = await this.connection.db.listCollections().toArray();
            const collectionNames = collections.map(c => c.name);

            if (collectionNames.includes('chats')) {
                console.log('Creating indexes for improved query performance...');
                await this.connection.db.collection('chats').createIndex({ userId: 1, createdAt: -1 });
                await this.connection.db.collection('chats').createIndex({ sessionId: 1 });
                await this.connection.db.collection('chats').createIndex({ updatedAt: -1 });
                await this.connection.db.collection('chats').createIndex({ title: 'text' });
                console.log('Indexes created successfully');
            }

            if (collectionNames.includes('users')) {
                console.log('Creating indexes for users collection...');
                await this.connection.db.collection('users').createIndex({ email: 1 }, { unique: true });
                await this.connection.db.collection('users').createIndex({ username: 1 });
                console.log('User indexes created successfully');
            }
        } catch (error) {
            console.error('Error creating indexes:', error);
            this.logError(error);
            throw error;
        }
    }

    async closeConnection() {
        if (this.connection) {
            try {
                await mongoose.disconnect();
                this.connection = null;
                this.connectionStatus.isConnected = false;
                this.connectionStatus.lastDisconnectedAt = new Date();
                console.log('MongoDB connection closed');
            } catch (error) {
                this.logError(error);
                console.error('Error closing MongoDB connection:', error);
                throw error;
            }
        }
    }
}

const dbConnection = new DatabaseConnection();
module.exports = dbConnection;
