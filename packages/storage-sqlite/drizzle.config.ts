import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./packages/storage-sqlite/src/schema.ts",
  out: "./packages/storage-sqlite/drizzle",
});
