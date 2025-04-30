const monitoringService = require('../services/monitoringService');

monitoringService.start();

function requestMonitoring(req, res, next) {
    const startTime = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - startTime;
        const statusCode = res.statusCode;
        const isSuccess = statusCode >= 200 && statusCode < 400;
        const isRateLimited = statusCode === 429;

        monitoringService.logRequest(isSuccess, isRateLimited);
        res.set('X-Response-Time', `${duration}ms`);
    });

    next();
}

module.exports = requestMonitoring;
