import { connectDatabase } from "../config/database.js";

let isDbConnected = false;

export async function initializeDatabase() {
    if (!isDbConnected) {
        await connectDatabase();
        isDbConnected = true;
    }
}
