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
  /**
   * True when the provider exhausted its refusal re-sampling and the final
   * sample still refused the protocol. Lets the agent loop treat the reply as
   * a refusal even when the text phrasing evades the detector, and lets an
   * exhausted refusal end the run as an honest failure — never a silent
   * success (the text-only path used to be taken as a final summary).
   */
  refused?: boolean;
}

export interface Provider {
  chat(system: string, messages: Msg[], tools: ToolDef[]): Promise<ChatResponse>;
}

export interface AgentEvent {
  type: "thought" | "tool_call" | "tool_result" | "done" | "error" | "paused" | "resumed" | "ws_write";
  step: number;
  detail: string;
  /** Which agent emitted it — "main" for the orchestrator, else the executor name. */
  agent?: string;
}
