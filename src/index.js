import "dotenv/config";

import express from "express";
import { validateEnvVars } from "./utils/validation.js";
import { setupMiddleware } from "./middleware/setupMiddleware.js";
import { handle404, handleError } from "./middleware/errorHandler.js";
import db from "./config/db.js";
import { startServer } from "./utils/serverLifecycle.js";
import { appConfig } from "./config/app.js";
import routes from "./routes/index.js";

validateEnvVars();

const app = express();

setupMiddleware(app);

app.use("/api", routes);
app.use(handle404);
app.use(handleError);


await db.connect();

if (!appConfig.isVercel) {
  startServer(app, appConfig.port);
}

export default app;
