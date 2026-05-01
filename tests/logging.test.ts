/**
 * Static regression checks for structured logging.
 *
 * Run: npx tsx tests/logging.test.ts
 */

import { existsSync, readFileSync } from "fs";
import path from "path";

type Check = {
  name: string;
  run: () => void;
};

const root = process.cwd();
const serverPath = path.join(root, "server.ts");
const frontendLoggerPath = path.join(root, "src", "utils", "logger.ts");
const clientFiles = [
  "src/context/AppContext.tsx",
  "src/pages/DiscoverPage.tsx",
  "src/components/ReaderModal.tsx",
  "src/components/Nav.tsx",
];

function readProjectFile(relativePath: string): string {
  return readFileSync(path.join(root, relativePath), "utf-8");
}

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertNoConsoleCalls(relativePath: string) {
  const source = readProjectFile(relativePath);
  const consoleCallPattern = /\bconsole\.(log|warn|error|info|debug)\s*\(/;
  assert(!consoleCallPattern.test(source), `${relativePath} should not call console.* directly`);
}

const checks: Check[] = [
  {
    name: "server uses pino and pino-http",
    run: () => {
      const server = readFileSync(serverPath, "utf-8");
      assert(/from\s+["']pino["']/.test(server), "server.ts should import pino");
      assert(/from\s+["']pino-http["']/.test(server), "server.ts should import pino-http");
      assert(/pinoHttp\s*\(/.test(server), "server.ts should mount pino-http middleware");
    },
  },
  {
    name: "server exposes client log endpoint",
    run: () => {
      const server = readFileSync(serverPath, "utf-8");
      assert(/app\.post\(["']\/api\/log["']/.test(server), "server.ts should define POST /api/log");
      assert(/\[CLIENT\]/.test(server), "client logs should include a [CLIENT] marker");
    },
  },
  {
    name: "server has no direct console calls",
    run: () => assertNoConsoleCalls("server.ts"),
  },
  {
    name: "OTP codes are masked for production logs",
    run: () => {
      const server = readFileSync(serverPath, "utf-8");
      assert(/formatOtpForLog/.test(server), "server.ts should use formatOtpForLog");
      assert(/logOtpEvent\(["']login["'],\s*email,\s*code\)/.test(server), "login OTP logs should use logOtpEvent");
      assert(/logOtpEvent\(["']registration["'],\s*email,\s*code\)/.test(server), "registration OTP logs should use logOtpEvent");
      assert(!/console\.log\(`\[AUTH\][^`]*\$\{code\}`\)/.test(server), "OTP log messages should not interpolate full code");
    },
  },
  {
    name: "frontend logger reports errors to backend",
    run: () => {
      assert(existsSync(frontendLoggerPath), "src/utils/logger.ts should exist");
      const logger = readFileSync(frontendLoggerPath, "utf-8");
      assert(/sendBeacon/.test(logger), "frontend logger should use sendBeacon");
      assert(/\/api\/log/.test(logger), "frontend logger should report to /api/log");
    },
  },
  {
    name: "selected frontend files have no direct console calls",
    run: () => {
      for (const file of clientFiles) {
        assertNoConsoleCalls(file);
      }
    },
  },
];

let passed = 0;
let failed = 0;

console.log("\n=== Structured Logging Static Tests ===\n");

for (const check of checks) {
  try {
    check.run();
    passed++;
    console.log(`  PASS: ${check.name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL: ${check.name}`);
    console.error(`        ${(error as Error).message}`);
  }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
