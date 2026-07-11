declare module "@earendil-works/pi-ai" {
  export function StringEnum<T extends readonly string[]>(values: T): unknown;
}

declare module "typebox" {
  export const Type: {
    Object(properties: Record<string, unknown>, options?: Record<string, unknown>): unknown;
    String(options?: Record<string, unknown>): unknown;
    Array(schema: unknown, options?: Record<string, unknown>): unknown;
    Optional(schema: unknown): unknown;
  };
}

declare module "@earendil-works/pi-coding-agent" {
  export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

  export interface ModelInfo {
    provider: string;
    id: string;
  }

  export interface ModelRegistry {
    find(provider: string, model: string): ModelInfo | undefined;
    getAvailable(): ModelInfo[];
  }

  export interface SessionManager {
    getBranch(): Array<{ type: string; customType?: string; data?: unknown }>;
  }

  export interface ExtensionUI {
    select<T extends string>(prompt: string, options: readonly T[]): Promise<T>;
    editor(prompt: string, initialValue: string): Promise<string | undefined>;
    confirm(title: string, message: string): Promise<boolean>;
    notify(message: string, level?: "info" | "warning" | "error"): void;
    setStatus(key: string, value: string | undefined): void;
    setWidget(key: string, value: string[] | undefined): void;
  }

  export interface ExtensionContext {
    cwd: string;
    hasUI: boolean;
    model?: ModelInfo;
    modelRegistry: ModelRegistry;
    sessionManager: SessionManager;
    signal?: AbortSignal;
    ui: ExtensionUI;
    isIdle(): boolean;
    abort(): void;
  }

  export interface ExtensionCommandContext extends ExtensionContext {
    waitForIdle(): Promise<void>;
  }

  export interface AgentEndEvent {
    messages: unknown[];
  }

  export interface ToolCallEvent {
    toolName: string;
    input: Record<string, unknown>;
  }

  export interface ExecResult {
    stdout: string;
    stderr: string;
    code: number;
    killed?: boolean;
  }

  export interface ToolExecuteResult {
    content?: Array<{ type: string; text: string }>;
    details?: unknown;
    terminate?: boolean;
  }

  export interface ExtensionAPI {
    registerFlag(name: string, config: { description: string; type: "boolean"; default: boolean }): void;
    registerTool(config: {
      name: string;
      label?: string;
      description?: string;
      promptSnippet?: string;
      promptGuidelines?: string[];
      parameters?: unknown;
      execute(toolCallId: string, params: any): Promise<ToolExecuteResult>;
    }): void;
    registerCommand(name: string, config: {
      description?: string;
      handler(args: string, ctx: ExtensionCommandContext): Promise<void> | void;
    }): void;
    on(event: "session_start", handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void): void;
    on(event: "session_shutdown", handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void): void;
    on(event: "agent_end", handler: (event: AgentEndEvent, ctx: ExtensionContext) => Promise<void> | void): void;
    on(event: "agent_settled", handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void): void;
    on(event: "tool_call", handler: (event: ToolCallEvent) => Promise<{ block: boolean; reason: string } | void> | { block: boolean; reason: string } | void): void;
    getThinkingLevel(): ThinkingLevel;
    setThinkingLevel(level: ThinkingLevel): void;
    getFlag(name: string): unknown;
    setModel(model: ModelInfo): Promise<boolean>;
    sendUserMessage(message: string, options?: { deliverAs?: "followUp" }): void;
    sendMessage(message: { customType: string; content: string; display?: boolean; details?: unknown }, options?: { triggerTurn?: boolean }): void;
    appendEntry(customType: string, data: unknown): void;
    getActiveTools(): string[];
    setActiveTools(tools: readonly string[]): void;
    exec(command: string, args: string[], options?: { timeout?: number; signal?: AbortSignal }): Promise<ExecResult>;
  }
}
