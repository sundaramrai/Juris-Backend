// src/services/cleanupService.js
const Chat = require("../models/Chat");

const cleanupEmptyChats = async () => {
    try {
        console.log("🧹 Running empty chat cleanup...");
        const result = await Chat.deleteMany({
            "messages": { $size: 0 }
        });
        if (result.deletedCount > 0) {
            console.log(`🧹 Cleanup completed: Removed ${result.deletedCount} empty chats`);
        } else {
            console.log("🧹 No empty chats to clean up");
        }
    } catch (error) {
        console.error("❌ Error during chat cleanup:", error);
    }
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