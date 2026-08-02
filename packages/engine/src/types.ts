export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the tool input */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  callId: string;
  content: string;
  isError?: boolean;
}

export type Msg =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls: ToolCall[] }
  | { role: "toolResults"; results: ToolResult[] };

export interface ChatResponse {
  text: string;
  toolCalls: ToolCall[];
  stopReason: string;
}

export interface Provider {
  chat(system: string, messages: Msg[], tools: ToolDef[]): Promise<ChatResponse>;
}

export interface AgentEvent {
  type: "thought" | "tool_call" | "tool_result" | "done" | "error";
  step: number;
  detail: string;
  /** Which agent emitted it — "main" for the orchestrator, else the executor name. */
  agent?: string;
}
