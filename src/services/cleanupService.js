// src/services/cleanupService.js
const Chat = require("../models/Chat");

const cleanupEmptyChats = async (retries = 3, delay = 5000) => {
    let attempts = 0;

    const executeCleanup = async () => {
        attempts++;
        try {
            console.log(`🧹 Running empty chat cleanup (attempt ${attempts}/${retries + 1})...`);
            const result = await Chat.deleteMany({
                "messages": { $size: 0 }
            }).maxTimeMS(30000);

            if (result.deletedCount > 0) {
                console.log(`🧹 Cleanup completed: Removed ${result.deletedCount} empty chats`);
            } else {
                console.log("🧹 No empty chats to clean up");
            }

            return true;
        } catch (error) {
            console.error(`❌ Error during chat cleanup (attempt ${attempts}/${retries + 1}):`, error);
            if (attempts <= retries &&
                (error.name === 'MongooseError' || error.message.includes('timed out'))) {
                console.log(`⏱️ Retrying in ${delay / 1000} seconds...`);
                return new Promise(resolve => setTimeout(() => resolve(executeCleanup()), delay));
            }

            console.error(error);
            return false;
        }
    };

    return executeCleanup();
};

const startCleanupInterval = (intervalMinutes = 60) => {
    cleanupEmptyChats();
    const cleanupInterval = setInterval(cleanupEmptyChats, intervalMinutes * 60 * 1000);
    console.log(`🧹 Chat cleanup service started (interval: ${intervalMinutes} minutes)`);
    return cleanupInterval;
};

module.exports = {
    cleanupEmptyChats,
    startCleanupInterval
};