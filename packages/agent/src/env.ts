import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 1. Load root .env (for shared Atlas & LLM keys across the monorepo)
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

// 2. Load package-level .env if present (for package-specific overrides)
dotenv.config();

export const env = {
  // Atlas Admin API
  ORG_ID: process.env.ORG_ID ?? "",
  PUBLIC_API_KEY: process.env.PUBLIC_API_KEY ?? "",
  PRIVATE_API_KEY: process.env.PRIVATE_API_KEY ?? "",

  // LLM Config
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  MODEL: process.env.MODEL ?? "gpt-4o",

  // Optional Azure OpenAI
  AZURE_OPENAI_API_KEY: process.env.AZURE_OPENAI_API_KEY,
  AZURE_OPENAI_API_VERSION: process.env.AZURE_OPENAI_API_VERSION,
  AZURE_OPENAI_BASE_PATH: process.env.AZURE_OPENAI_BASE_PATH,

  // Optional Anthropic
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
};
