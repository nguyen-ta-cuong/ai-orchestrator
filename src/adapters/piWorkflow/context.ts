import type { OrchestratorConfig } from "../../core/config.js";

export interface PiWorkflowCapabilities {
  sendPrompt(prompt: string): void;
  notify(message: string, level: "info" | "warning" | "error"): void;
  confirm(title: string, message: string): Promise<boolean>;
  setActiveTools(tools: readonly string[]): void;
}

export interface PiNodeContext<State> {
  runId: string;
  cwd: string;
  config: Readonly<OrchestratorConfig>;
  graphVersion: string;
  capabilities: PiWorkflowCapabilities;
  ownsRun(runId: string, expectedNode: string): boolean;
  persist(state: State, evidence?: Record<string, string | number | boolean | null>): void;
  restoreIfOwner(runId: string): Promise<void>;
}

export type PiNodeHandler<State, Event, Output = unknown> = (
  state: Readonly<State>,
  context: PiNodeContext<State>,
) => Promise<{ event: Event; output?: Output; evidence?: Record<string, string | number | boolean | null> }>;

export type PiNodeHandlerRegistry<State, Event> = ReadonlyMap<string, PiNodeHandler<State, Event>>;
