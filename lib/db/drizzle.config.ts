import { defineConfig } from "drizzle-kit";
import fs from "fs";
import path from "path";

// drizzle-kit does not load .env itself, so fall back to the repo-root .env
// file when DATABASE_URL is not already in the environment.
if (!process.env.DATABASE_URL) {
  const envFile = path.join(__dirname, "../../.env");
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
      }
    }
  }
}

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

export default defineConfig({
  // drizzle-kit globs schema paths, which requires forward slashes on Windows
  schema: path.join(__dirname, "./src/schema/index.ts").replace(/\\/g, "/"),
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
