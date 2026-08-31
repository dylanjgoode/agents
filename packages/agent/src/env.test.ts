import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("dotenv", () => ({
  default: {
    config: vi.fn(() => ({ parsed: {} })),
  },
}));

const ENV_KEYS = [
  "ORG_ID",
  "PUBLIC_API_KEY",
  "PRIVATE_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_USE_RESPONSES_API",
  "MODEL",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_API_VERSION",
  "AZURE_OPENAI_BASE_PATH",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
] as const;

const originalEnv = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, originalEnv);
  vi.resetModules();
});

async function loadEnvModule() {
  vi.resetModules();
  return import("./env.js");
}

describe("env", () => {
  it("loads root .env then package-level .env via dotenv", async () => {
    const dotenv = await import("dotenv");
    await loadEnvModule();

    expect(dotenv.default.config).toHaveBeenCalledTimes(2);
    const firstCall = vi.mocked(dotenv.default.config).mock.calls[0]?.[0];
    expect(firstCall).toEqual(
      expect.objectContaining({
        path: expect.stringMatching(/\.env$/),
      }),
    );
    expect(
      path.normalize((firstCall as { path: string }).path),
    ).toMatch(/mongodb-agent-template[/\\]\.env$/);
    expect(vi.mocked(dotenv.default.config).mock.calls[1]?.[0]).toBeUndefined();
  });

  it("defaults Atlas keys to empty string and MODEL to gpt-4o", async () => {
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }

    const { env } = await loadEnvModule();

    expect(env.ORG_ID).toBe("");
    expect(env.PUBLIC_API_KEY).toBe("");
    expect(env.PRIVATE_API_KEY).toBe("");
    expect(env.MODEL).toBe("gpt-4o");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.AZURE_OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("reads Atlas and LLM values from process.env", async () => {
    process.env.ORG_ID = "org-123";
    process.env.PUBLIC_API_KEY = "pub";
    process.env.PRIVATE_API_KEY = "priv";
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.OPENAI_BASE_URL = "https://gateway.example/v1";
    process.env.OPENAI_USE_RESPONSES_API = "true";
    process.env.MODEL = "gpt-4.1";
    process.env.AZURE_OPENAI_API_KEY = "azure-key";
    process.env.AZURE_OPENAI_API_VERSION = "2024-10-21";
    process.env.AZURE_OPENAI_BASE_PATH = "https://example.openai.azure.com";
    process.env.ANTHROPIC_API_KEY = "claude-key";
    process.env.ANTHROPIC_BASE_URL = "https://anthropic.example";

    const { env } = await loadEnvModule();

    expect(env.ORG_ID).toBe("org-123");
    expect(env.PUBLIC_API_KEY).toBe("pub");
    expect(env.PRIVATE_API_KEY).toBe("priv");
    expect(env.OPENAI_API_KEY).toBe("sk-test");
    expect(env.OPENAI_BASE_URL).toBe("https://gateway.example/v1");
    expect(env.OPENAI_USE_RESPONSES_API).toBe("true");
    expect(env.MODEL).toBe("gpt-4.1");
    expect(env.AZURE_OPENAI_API_KEY).toBe("azure-key");
    expect(env.AZURE_OPENAI_API_VERSION).toBe("2024-10-21");
    expect(env.AZURE_OPENAI_BASE_PATH).toBe("https://example.openai.azure.com");
    expect(env.ANTHROPIC_API_KEY).toBe("claude-key");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://anthropic.example");
  });
});
