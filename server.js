const app = require('./src/app');
const config = require('./src/config');
const dbManager = require('./src/utils/dbManager');

if (config.mongodb.uri) {
    dbManager.connect(config.mongodb.uri)
        .then(() => {
            console.log('Connected to MongoDB');
        })
        .catch(err => {
            console.error('MongoDB connection error:', err);
        });
}

const server = app.listen(config.port, () => {
    console.log(`Juris AI backend running on port ${config.port} in ${config.nodeEnv} mode`);
});

server.timeout = 120000;
server.keepAliveTimeout = 65000;

module.exports = server;
