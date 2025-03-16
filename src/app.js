// src/app.js
const express = require("express");
const cors = require("cors");
require("dotenv").config();
const routes = require("./routes");

const app = express();

// Configure CORS
const corsOptions = {
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
};
app.use(cors(corsOptions));

// Middleware
app.use(express.json());

// API Routes
app.use("/api", routes);

module.exports = app;