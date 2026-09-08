export interface AgenticClientConfig {
  baseUrl: string;
  apiKey?: string;
  projectId: string;
  workspaceId: string;
  invokeTarget?: "gateway" | "local";
}

export interface AgentActionRequest {
  name: string;
  args: Record<string, unknown>;
  description?: string;
}

export interface AgentInterrupt {
  id: string;
  actionRequests: AgentActionRequest[];
}

export type ReviewDecision =
  | { type: "approve" }
  | { type: "reject"; message?: string };

export interface CompletedInvocation {
  kind: "completed";
  response: string;
  sessionId: string;
  executionId?: string;
}

export interface SuspendedInvocation {
  kind: "suspended";
  sessionId: string;
  executionId: string;
  interrupts: AgentInterrupt[];
  resumeSchema?: Record<string, unknown>;
}

export type InvocationResult = CompletedInvocation | SuspendedInvocation;

export interface InvocationProgress {
  content: string;
  phase?: string;
  toolName?: string;
  status?: string;
}

export type InvocationProgressHandler = (
  progress: InvocationProgress,
) => void | Promise<void>;

export interface InvokeInput {
  message: string;
  slackUserId: string;
  sessionId?: string;
}

export interface ResumeInput {
  sessionId: string;
  interruptId: string;
  decision: ReviewDecision | ReviewDecision[];
  additionalInterrupts?: Array<{
    interruptId: string;
    decision: ReviewDecision | ReviewDecision[];
  }>;
  slackUserId: string;
}
