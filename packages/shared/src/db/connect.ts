import mongoose from "mongoose";
import { loadEnv } from "../env.js";

let _connected = false;

export async function connectDb(): Promise<typeof mongoose> {
  if (_connected) return mongoose;
  const env = loadEnv();

  // Mongoose 8: bufferCommands=false fails fast if not yet connected,
  // surfacing real connection errors instead of hanging silently.
  mongoose.set("bufferCommands", false);
  mongoose.set("strictQuery", true);

  await mongoose.connect(env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10_000,
    socketTimeoutMS: 45_000,
    maxPoolSize: 50,
  });

  _connected = true;
  return mongoose;
}

export async function closeDb(): Promise<void> {
  if (!_connected) return;
  await mongoose.disconnect();
  _connected = false;
}

export function isDbConnected(): boolean {
  return _connected && mongoose.connection.readyState === 1; // 1 = connected
}

export { mongoose };
