import { AzureChatOpenAI, ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { env } from "./env.js";

const DEFAULT_OPENAI_MODEL = "gpt-4o";
const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-5";

export type ChatModel = ChatOpenAI | AzureChatOpenAI | ChatAnthropic;

function responsesApiSetting(model: string): boolean | undefined {
  const configured = env.OPENAI_USE_RESPONSES_API?.trim().toLowerCase();

  if (configured === "true") return true;
  if (configured === "false") return false;
  if (configured && configured !== "auto") {
    throw new Error(
      "OPENAI_USE_RESPONSES_API must be 'auto', 'true', or 'false'.",
    );
  }

  const isReasoningModel =
    /^o\d/.test(model) ||
    (model.startsWith("gpt-5") && !model.startsWith("gpt-5-chat"));
  return isReasoningModel ? true : undefined;
}

/**
 * Build a tool-calling chat model from process env.
 *
 * Priority: `OPENAI_API_KEY` → `AZURE_OPENAI_API_KEY` → `ANTHROPIC_API_KEY`.
 * `MODEL` defaults to gpt-4o for OpenAI/Azure; Anthropic uses claude-sonnet-4-5
 * unless `MODEL` is set explicitly.
 */
export function createChatModel(): ChatModel {
  const explicitModel = process.env.MODEL;
  const openaiKey = env.OPENAI_API_KEY;
  const azureKey = env.AZURE_OPENAI_API_KEY;
  const anthropicKey = env.ANTHROPIC_API_KEY;

  if (openaiKey) {
    const model = explicitModel ?? env.MODEL ?? DEFAULT_OPENAI_MODEL;
    const useResponsesApi = responsesApiSetting(model);
    return new ChatOpenAI({
      apiKey: openaiKey,
      model,
      ...(useResponsesApi !== undefined ? { useResponsesApi } : {}),
      ...(env.OPENAI_BASE_URL
        ? { configuration: { baseURL: env.OPENAI_BASE_URL } }
        : {}),
    });
  }

  if (azureKey) {
    const model = explicitModel ?? env.MODEL ?? DEFAULT_OPENAI_MODEL;
    const useResponsesApi = responsesApiSetting(model);
    return new AzureChatOpenAI({
      azureOpenAIApiKey: azureKey,
      azureOpenAIApiVersion: env.AZURE_OPENAI_API_VERSION,
      azureOpenAIBasePath: env.AZURE_OPENAI_BASE_PATH,
      azureOpenAIApiDeploymentName:
        process.env.AZURE_OPENAI_API_DEPLOYMENT_NAME ??
        explicitModel ??
        DEFAULT_OPENAI_MODEL,
      model,
      ...(useResponsesApi !== undefined ? { useResponsesApi } : {}),
    });
  }

  if (anthropicKey) {
    return new ChatAnthropic({
      apiKey: anthropicKey,
      model: explicitModel ?? DEFAULT_ANTHROPIC_MODEL,
      ...(env.ANTHROPIC_BASE_URL
        ? { anthropicApiUrl: env.ANTHROPIC_BASE_URL }
        : {}),
    });
  }

  throw new Error(
    "No LLM credentials found. Set OPENAI_API_KEY, AZURE_OPENAI_API_KEY, or ANTHROPIC_API_KEY.",
  );
}
