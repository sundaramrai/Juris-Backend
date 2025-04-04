// src/utils/validation.js
function validateEnvVars() {
    const requiredEnvVars = [
      "MONGO_URI",
      "JWT_SECRET",
      "GEMINI_API_KEY",
      "ENCRYPTION_KEY",
      "USERNAME_HASH_SALT",
      "EMAIL_USER",
      "EMAIL_PASS",
      "OTP_SECRET"
    ];
    const missingVars = requiredEnvVars.filter(key => !process.env[key]);
    if (missingVars.length > 0) {
      console.error("Missing environment variables:", missingVars.join(', '));
      process.exit(1);
    }
  }
  
module.exports = { validateEnvVars };