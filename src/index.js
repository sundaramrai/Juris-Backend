// src/index.js
const app = require("./app");
const { connectDatabase } = require("./config");
require("dotenv").config();

const PORT = process.env.PORT || 3000;

// Connect to database
connectDatabase();

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`✅ API Endpoints available at http://localhost:${PORT}/api`);
});