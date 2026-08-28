# Scope: MongoDB Data Explorer Agent

This is an AI agent that can be used to explore and query MongoDB databases hosted on MongoDB Atlas.

## Framework
[Langgraph.ts](https://docs.langchain.com/oss/javascript/langgraph/overview) for agent framework  
1. Also using DeepAgents: [https://docs.langchain.com/oss/javascript/deepagents/overview](https://docs.langchain.com/oss/javascript/deepagents/overview)   
   1. We will use it — we want the harness (filesystem, subagents, planning, skills progressive disclosure), not just a MCP tool loop. Use `createDeepAgent` on top of LangGraph.ts.

## Functionality 

### Tools

Tools from the Atlas MCP server. See https://www.mongodb.com/docs/mcp-server/tools/

Include all tools in the following categories:
1. MCP Server Atlas Tools
2. MCP Server database tools
3. MCP server assistant tools

Note: MCP server local Atlas tools are not included.

#### Authentication

1. For auth, we should be able to use this flow from within the agent: https://www.mongodb.com/docs/mcp-server/get-started/?ai-client=ai-frameworks-clients
   1. Note: this is the aspect that i'd been most concerned about, but we seem to have a clean path forward here.   
   2. We will need to have user provide atlas `ORG_ID`, `PUBLIC_API_KEY`, `PRIVATE_API_KEY`.  
   3. Note that the [MCP auth requires us to provide a CIDR range or IP address](https://www.mongodb.com/docs/mcp-server/get-started/?ai-client=ai-frameworks-clients#create-your-mcp-configuration) that requests are coming from.
2. This package actually already implements the logic flow that goes from API key to working MCP: https://github.com/mongodb-js/mongodb-mcp-server/tree/main/packages/mongodb-atlas-mcp-remote
   
   You can implement similar logic in our agent.

### System Prompt

See [sys-prompt-draft.md](sys-prompt-draft.md) for a draft system prompt.

Note that this was adapted from the DeepAtlas Skunkworks agent: https://github.com/mongodb/ai-assistant/pull/268 


### Skills

Let's also load in the MongoDB Agent Skills via DeepAgents skills / `createSkillsMiddleware`, assuming it's easy. 

Link to skills: https://github.com/mongodb/agent-skills


### LLM

1. User brings own LLM API key, and provide as a Magenta secret  
1. For sake of configurability, we can use env vars.
   1. **Requirement:** support OpenAI env vars. `ChatOpenAI` reads `OPENAI_API_KEY`, and base URL from `OPENAI_BASE_URL`. Same for `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` + ChatAnthropic.
   2. LangGraph itself does not pick up keys — the model packages do. We still have to construct a model, or use `initChatModel` / `createAgent({ model: "openai:..." })`.
   3. Need to support different OpenAI API flavors (vanilla OpenAI, Azure, other OpenAI-compatible endpoints). At a minimum that's base URL. AzureChatOpenAI also reads `AZURE_OPENAI_*` (`AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_API_VERSION`, `AZURE_OPENAI_BASE_PATH`, etc.) if we use the dedicated Azure client.
   4. Didn't find public Magenta docs on whether secrets land as env vars.

## Deployment

### Local Deployment

Have a local deployment that can be used to test the agent. It should be visually compelling, but doesn't need to be prod-ready.

Refer to: https://docs.langchain.com/oss/javascript/langchain/frontend/integrations/overview

### Magenta Deployment (later)

we'll use mongodb's new agentic platform (aka magenta).

let's not worry bout this for now!

can borrow extensively from DeepAtlas Skunkworks project: https://github.com/mongodb/ai-assistant/pull/268 

some notes on the agentic platform as an interface:
1. Agentic CLI: can invoke with the `agentic invoke` command. Docs here: [https://feature-agentic-plat--docs-on-nextjs.netlify.app/docs/agentic-platform/invoke-agent/\#invoke-an-agent-from-the-cli](https://feature-agentic-plat--docs-on-nextjs.netlify.app/docs/agentic-platform/invoke-agent/#invoke-an-agent-from-the-cli)   
   1. Would be nice if there were a TUI too. Can discuss building this with Magenta team. If they don't wanna build, we can consider for V1  
2. UI: Use the Magenta chat UI for v0  
   1. Note that this is the only UI we can use without setting up a custom client and or server  
   2. 
3. for atlas mcp, Magenta egress IPs exist (docs say so) but the actual IPs/CIDRs are not published. still TODO: get the list from Magenta team and actually try this against a deployed agent.
   1. Atlas Managed MCP requires the caller's IP/CIDR on the MCP config `ipAccessList`
   2. Local: allowlist the dev machine IP (DeepAtlas does this via 403 / `curl ifconfig.me` / `atlas accessLists create --currentIp`)
   3. Magenta: same MCP `ipAccessList`, but with Magenta platform egress IPs. `agentic atlas setup` auto-allowlists Magenta on the cluster *it* provisions for platform state — that does **not** cover the user's MCP config. Docs: https://feature-agentic-plat--docs-on-nextjs.netlify.app/docs/agentic-platform/get-started 