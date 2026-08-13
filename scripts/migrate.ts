import dotenv from "dotenv";
import pino from "pino";
import {
  DATABASE_SCHEMA_VERSION,
  createDatabasePool,
  runDatabaseMigrations,
  verifyDatabaseSchema,
} from "../src/server/databaseMigrations.js";

dotenv.config();

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  base: {
    service: "atomflow-migrate",
    env: process.env.NODE_ENV || "development",
  },
});

const migrate = async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL environment variable must be set before running migrations");
  }

  const pool = createDatabasePool(logger);
  try {
    await pool.query("SELECT 1");
    await runDatabaseMigrations(pool, logger);
    const ready = await verifyDatabaseSchema(pool);
    if (!ready) {
      throw new Error(`Database schema verification failed for ${DATABASE_SCHEMA_VERSION}`);
    }
    logger.info({ module: "db", schemaVersion: DATABASE_SCHEMA_VERSION }, "Database schema is ready");
  } finally {
    await pool.end();
  }
};

migrate().catch(error => {
  logger.fatal({ err: error, module: "db" }, "Database migration command failed");
  process.exitCode = 1;
});
