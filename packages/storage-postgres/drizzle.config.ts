import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./packages/storage-postgres/src/schema.ts",
  out: "./packages/storage-postgres/drizzle",
});
