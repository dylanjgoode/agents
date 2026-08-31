import { beforeEach, describe, expect, it, vi } from "vitest";

const envState = vi.hoisted(() => ({
  OPENAI_API_KEY: undefined as string | undefined,
  OPENAI_BASE_URL: undefined as string | undefined,
  OPENAI_USE_RESPONSES_API: undefined as string | undefined,
  MODEL: "gpt-4o" as string | undefined,
  AZURE_OPENAI_API_KEY: undefined as string | undefined,
  AZURE_OPENAI_API_VERSION: undefined as string | undefined,
  AZURE_OPENAI_BASE_PATH: undefined as string | undefined,
  ANTHROPIC_API_KEY: undefined as string | undefined,
  ANTHROPIC_BASE_URL: undefined as string | undefined,
}));

vi.mock("./env.js", () => ({
  env: envState,
}));

vi.mock("@langchain/openai", () => ({
  ChatOpenAI: vi.fn(function ChatOpenAI(this: unknown, opts: unknown) {
    Object.assign(this as object, { options: opts });
  }),
  AzureChatOpenAI: vi.fn(function AzureChatOpenAI(this: unknown, opts: unknown) {
    Object.assign(this as object, { options: opts });
  }),
}));

vi.mock("@langchain/anthropic", () => ({
  ChatAnthropic: vi.fn(function ChatAnthropic(this: unknown, opts: unknown) {
    Object.assign(this as object, { options: opts });
  }),
}));

import { AzureChatOpenAI, ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { createChatModel } from "./llm.js";

function resetEnvState() {
  envState.OPENAI_API_KEY = undefined;
  envState.OPENAI_BASE_URL = undefined;
  envState.OPENAI_USE_RESPONSES_API = undefined;
  envState.MODEL = "gpt-4o";
  envState.AZURE_OPENAI_API_KEY = undefined;
  envState.AZURE_OPENAI_API_VERSION = undefined;
  envState.AZURE_OPENAI_BASE_PATH = undefined;
  envState.ANTHROPIC_API_KEY = undefined;
  envState.ANTHROPIC_BASE_URL = undefined;
  delete process.env.MODEL;
  delete process.env.AZURE_OPENAI_API_DEPLOYMENT_NAME;
}

describe("createChatModel", () => {
  beforeEach(() => {
    resetEnvState();
    vi.clearAllMocks();
  });

  it("constructs ChatOpenAI when OPENAI_API_KEY is set", () => {
    envState.OPENAI_API_KEY = "sk-openai";

    const model = createChatModel();

    expect(ChatOpenAI).toHaveBeenCalledOnce();
    expect(ChatOpenAI).toHaveBeenCalledWith({
      apiKey: "sk-openai",
      model: "gpt-4o",
    });
    expect(model).toBeInstanceOf(ChatOpenAI);
    expect(AzureChatOpenAI).not.toHaveBeenCalled();
    expect(ChatAnthropic).not.toHaveBeenCalled();
  });

  it("passes OPENAI_BASE_URL as configuration.baseURL", () => {
    envState.OPENAI_API_KEY = "sk-openai";
    envState.OPENAI_BASE_URL = "https://gateway.example/v1";
    process.env.MODEL = "gpt-4.1-mini";

    createChatModel();

    expect(ChatOpenAI).toHaveBeenCalledWith({
      apiKey: "sk-openai",
      model: "gpt-4.1-mini",
      configuration: { baseURL: "https://gateway.example/v1" },
    });
  });

  it("uses the Responses API for GPT-5 reasoning models with tools", () => {
    envState.OPENAI_API_KEY = "sk-openai";
    process.env.MODEL = "gpt-5.6-luna";

    createChatModel();

    expect(ChatOpenAI).toHaveBeenCalledWith({
      apiKey: "sk-openai",
      model: "gpt-5.6-luna",
      useResponsesApi: true,
    });
  });

  it("allows Responses API auto-detection to be overridden for compatible gateways", () => {
    envState.OPENAI_API_KEY = "sk-openai";
    envState.OPENAI_BASE_URL = "https://gateway.example/v1";
    envState.OPENAI_USE_RESPONSES_API = "false";
    process.env.MODEL = "gpt-5.6-luna";

    createChatModel();

    expect(ChatOpenAI).toHaveBeenCalledWith({
      apiKey: "sk-openai",
      model: "gpt-5.6-luna",
      useResponsesApi: false,
      configuration: { baseURL: "https://gateway.example/v1" },
    });
  });

  it("prefers OpenAI when Azure and Anthropic keys are also set", () => {
    envState.OPENAI_API_KEY = "sk-openai";
    envState.AZURE_OPENAI_API_KEY = "azure";
    envState.ANTHROPIC_API_KEY = "claude";

    createChatModel();

    expect(ChatOpenAI).toHaveBeenCalledOnce();
    expect(AzureChatOpenAI).not.toHaveBeenCalled();
    expect(ChatAnthropic).not.toHaveBeenCalled();
  });

  it("constructs AzureChatOpenAI when only Azure credentials are set", () => {
    envState.AZURE_OPENAI_API_KEY = "azure-key";
    envState.AZURE_OPENAI_API_VERSION = "2024-10-21";
    envState.AZURE_OPENAI_BASE_PATH = "https://example.openai.azure.com";
    process.env.AZURE_OPENAI_API_DEPLOYMENT_NAME = "my-deployment";
    process.env.MODEL = "gpt-4o";

    createChatModel();

    expect(AzureChatOpenAI).toHaveBeenCalledWith({
      azureOpenAIApiKey: "azure-key",
      azureOpenAIApiVersion: "2024-10-21",
      azureOpenAIBasePath: "https://example.openai.azure.com",
      azureOpenAIApiDeploymentName: "my-deployment",
      model: "gpt-4o",
    });
    expect(ChatOpenAI).not.toHaveBeenCalled();
  });

  it("uses MODEL as Azure deployment name when AZURE_OPENAI_API_DEPLOYMENT_NAME is unset", () => {
    envState.AZURE_OPENAI_API_KEY = "azure-key";
    process.env.MODEL = "gpt-4o-mini";

    createChatModel();

    expect(AzureChatOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        azureOpenAIApiDeploymentName: "gpt-4o-mini",
        model: "gpt-4o-mini",
      }),
    );
  });

  it("constructs ChatAnthropic with default model when only Anthropic is set", () => {
    envState.ANTHROPIC_API_KEY = "claude-key";

    createChatModel();

    expect(ChatAnthropic).toHaveBeenCalledWith({
      apiKey: "claude-key",
      model: "claude-sonnet-4-5",
    });
  });

  it("passes ANTHROPIC_BASE_URL and explicit MODEL to ChatAnthropic", () => {
    envState.ANTHROPIC_API_KEY = "claude-key";
    envState.ANTHROPIC_BASE_URL = "https://anthropic.example";
    process.env.MODEL = "claude-opus-4-6";

    createChatModel();

    expect(ChatAnthropic).toHaveBeenCalledWith({
      apiKey: "claude-key",
      model: "claude-opus-4-6",
      anthropicApiUrl: "https://anthropic.example",
    });
  });

  it("throws when no LLM credentials are present", () => {
    expect(() => createChatModel()).toThrow(
      /No LLM credentials found\. Set OPENAI_API_KEY, AZURE_OPENAI_API_KEY, or ANTHROPIC_API_KEY/,
    );
  });
});
