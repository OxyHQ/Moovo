import mongoose from 'mongoose';
import { log } from './logger.js';

const APP_NAME = "moovo";

function getDatabaseName(): string {
  const env = process.env.NODE_ENV || "development";
  return `${APP_NAME}-${env}`;
}

// Singleton promise to ensure only one connection attempt at a time
let connectionPromise: Promise<typeof mongoose> | null = null;
let listenersRegistered = false;

function setupConnectionListeners(): void {
  if (listenersRegistered) return;
  listenersRegistered = true;

  const conn = mongoose.connection;

  conn.on('connected', () => {
    log.general.info('MongoDB connected');
  });

  conn.on('disconnected', () => {
    log.general.warn('MongoDB disconnected — mongoose will attempt to reconnect');
    connectionPromise = null;
  });

  conn.on('reconnected', () => {
    log.general.info('MongoDB reconnected');
  });

  conn.on('error', (err) => {
    log.general.error({ err }, 'MongoDB connection error');
  });
}

/**
 * Whether Mongo is part of this deployment's configuration at all.
 *
 * This is the ONE definition; `routes/health.ts` reads it rather than keeping a
 * second copy, because two representations of one fact can disagree and the
 * place that must not happen is a readiness probe deciding whether a task
 * receives traffic.
 *
 * It asks whether the environment SUPPLIES a URI, not what the URI says. That
 * distinction used to be impossible here: `connectDB` defaulted the value to
 * `mongodb://localhost:27017/moovo`, so the connection string was never empty
 * and absence was undetectable. Removing the secret from a task definition then
 * did not disable Mongo — it repointed it at localhost inside the container,
 * where nothing answers, and every task exited after the 10s server-selection
 * timeout. A defaulted config value cannot answer "was this configured".
 */
export function mongoIsConfigured(): boolean {
  return Boolean(process.env.MONGODB_URI);
}

export async function connectDB() {
  // Read MONGODB_URI here, after dotenv.config() has been called.
  const MONGODB_URI = process.env.MONGODB_URI;

  // No localhost default: callers must ask `mongoIsConfigured()` first, so
  // reaching this without a URI is a programming error rather than a reason to
  // dial a host that is not there.
  if (!MONGODB_URI) {
    throw new Error('connectDB() called with no MONGODB_URI; guard it with mongoIsConfigured()');
  }

  // If already connected, return the mongoose instance
  if (mongoose.connection.readyState === 1) {
    return mongoose;
  }

  // If a connection attempt is in progress, wait for it
  if (connectionPromise) {
    return connectionPromise;
  }

  const dbName = getDatabaseName();

  // Create a new connection
  const opts = {
    dbName,
    bufferCommands: false,
    maxPoolSize: 50,
    serverSelectionTimeoutMS: 10000, // Increased from 5s to 10s for production
    socketTimeoutMS: 45000,
    heartbeatFrequencyMS: 10000, // Check connection health every 10s
  };

  // Register connection event listeners before connecting
  setupConnectionListeners();

  log.general.info('Connecting to MongoDB...');

  connectionPromise = mongoose.connect(MONGODB_URI, opts)
    .then((mongooseInstance) => {
      log.general.info('MongoDB connected successfully');
      return mongooseInstance;
    })
    .catch((err) => {
      log.general.error({ err }, 'Error connecting to MongoDB');
      connectionPromise = null; // Reset to allow retry
      throw err;
    });

  return connectionPromise;
}

// Función auxiliar para verificar si la conexión está activa
export function isConnected() {
  return mongoose.connection.readyState === 1;
}
