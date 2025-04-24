const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const path = require('path');
const { errorMiddleware } = require('./middleware/errorHandler');
const rateLimiter = require('./middleware/rateLimiter');
const dbManager = require('./utils/dbManager');

const chatRoutes = require('./routes/chat');
const healthCheckRoutes = require('./routes/healthCheck');

const app = express();

app.use(helmet());
app.use(compression());
app.use(morgan('combined'));
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

app.use('/api/chat', rateLimiter.middleware());

app.use('/api/chat', chatRoutes);
app.use('/api/health', healthCheckRoutes);

app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
    res.status(404).json({
        error: true,
        message: 'Not found'
    });
});

app.use(errorMiddleware);

process.on('SIGINT', async () => {
    console.log('Received SIGINT. Shutting down gracefully...');
    await dbManager.disconnect();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('Received SIGTERM. Shutting down gracefully...');
    await dbManager.disconnect();
    process.exit(0);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    process.exit(1);
});

module.exports = app;
