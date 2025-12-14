import { appConfig } from "../config/app.js";

export function startServer(app, port) {
    const server = app.listen(port, () => {
        console.log(`Server running on port ${port} (${appConfig.nodeEnv})`);
    });

    server.keepAliveTimeout = appConfig.timeouts.keepAlive;
    server.headersTimeout = appConfig.timeouts.headers;

    if (!appConfig.isVercel) {
        setupGracefulShutdown(server);
    }

    return server;
}

function setupGracefulShutdown(server) {
    const shutdown = async () => {
        console.log("Shutting down gracefully...");
        server.close(() => process.exit(0));
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}
