const mongoose = require('mongoose');
const os = require('os');

const POOL_SIZE = process.env.MONGO_POOL_SIZE || Math.max(5, Math.min(10, os.cpus().length * 2));
const CONNECT_TIMEOUT = 30000;
const SOCKET_TIMEOUT = 45000;

async function connectDatabase() {
  const uri = process.env.MONGO_URI;

  try {
    console.log(`Connecting to MongoDB with pool size: ${POOL_SIZE}`);

    await mongoose.connect(uri, {
      maxPoolSize: POOL_SIZE,
      minPoolSize: Math.max(2, Math.floor(POOL_SIZE / 4)),
      connectTimeoutMS: CONNECT_TIMEOUT,
      socketTimeoutMS: SOCKET_TIMEOUT,
      serverSelectionTimeoutMS: 5000,
      heartbeatFrequencyMS: 10000,
      retryWrites: true,
      retryReads: true,
      writeConcern: { w: 'majority' },
      readPreference: 'primaryPreferred'
    });
    mongoose.connection.on('error', (err) => {
      console.error('MongoDB connection error:', err);
    });

    mongoose.connection.on('disconnected', () => {
      console.warn('MongoDB disconnected. Attempting to reconnect...');
    });

    mongoose.connection.on('reconnected', () => {
      console.log('MongoDB reconnected successfully');
    });

    console.log('MongoDB connected successfully');
    return mongoose.connection;
  } catch (error) {
    console.error('MongoDB connection error:', error);
    throw error;
  }
}

async function createIndexes() {
  const connection = mongoose.connection;

  try {
    const collections = await connection.db.listCollections().toArray();
    const collectionNames = collections.map(c => c.name);

    if (collectionNames.includes('chats')) {
      console.log('Creating indexes for improved query performance...');
      await connection.db.collection('chats').createIndex({ userId: 1, createdAt: -1 });
      await connection.db.collection('chats').createIndex({ sessionId: 1 });
      console.log('Indexes created successfully');
    }
  } catch (error) {
    console.error('Error creating indexes:', error);
  }
}

module.exports = {
  connectDatabase: async () => {
    const conn = await connectDatabase();
    await createIndexes();
    return conn;
  },
  getConnection: () => mongoose.connection
};