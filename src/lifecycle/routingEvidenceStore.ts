import { existsSync, lstatSync, mkdirSync, realpathSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, parse, relative, resolve } from "node:path";
import { validateRoutingEvidenceEvent, type RoutingEvidenceEvent } from "../core/routingEvidence.js";
import type { RunPaths } from "./artifacts.js";

export interface AppendRoutingEvidenceInput {
  runPaths: RunPaths;
  event: RoutingEvidenceEvent;
  userStoreRoot?: string;
}

export interface ReadRoutingEvidenceResult {
  events: RoutingEvidenceEvent[];
  warnings: string[];
}

export interface RoutingBudgetLedgerEvent {
  version: 1;
  eventId: string;
  runId: string;
  recordedAt: string;
  outcome: "stage-started" | "stage-ended";
  estimatedUsd?: number;
  observedUsd?: number;
}

const MAX_EVIDENCE_LINE_BYTES = 256 * 1024;

export function appendRoutingEvidenceEvent(input: AppendRoutingEvidenceInput): void {
  const validation = validateRoutingEvidenceEvent(input.event);
  if (!validation.ok) throw new Error(`routing evidence event is invalid: ${validation.error}`);
  appendJsonLine(input.runPaths.evidence, input.event);
  if (input.userStoreRoot) {
    appendJsonLine(join(input.userStoreRoot, "events.jsonl"), input.event);
  }
}

export function appendUserRoutingEvidenceEvent(userStoreRoot: string, event: RoutingEvidenceEvent): void {
  const validation = validateRoutingEvidenceEvent(event);
  if (!validation.ok) throw new Error(`routing evidence event is invalid: ${validation.error}`);
  appendJsonLine(join(userStoreRoot, "events.jsonl"), event);
}

export function appendRoutingBudgetLedgerEvent(userStoreRoot: string, event: RoutingBudgetLedgerEvent): void {
  validateBudgetLedgerEvent(event);
  appendJsonLine(join(userStoreRoot, "budget.jsonl"), event);
}

export function readRoutingBudgetLedger(path: string): RoutingBudgetLedgerEvent[] {
  if (!existsSync(path)) return [];
  const events: RoutingBudgetLedgerEvent[] = [];
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line) continue;
    try {
      const value = JSON.parse(line) as RoutingBudgetLedgerEvent;
      validateBudgetLedgerEvent(value);
      events.push(value);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`routing budget ledger is corrupt: ${message}`);
    }
  }
  return events;
}

export function readRoutingEvidenceEvents(path: string): ReadRoutingEvidenceResult {
  if (!existsSync(path)) return { events: [], warnings: [] };
  const events: RoutingEvidenceEvent[] = [];
  const warnings: string[] = [];
  const corruptLines: string[] = [];
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    if (line.length === 0) return;
    if (Buffer.byteLength(line, "utf8") > MAX_EVIDENCE_LINE_BYTES) {
      warnings.push(`line ${index + 1} exceeds ${MAX_EVIDENCE_LINE_BYTES} bytes`);
      corruptLines.push(line);
      return;
    }
    try {
      const parsed = JSON.parse(line) as unknown;
      const validation = validateRoutingEvidenceEvent(parsed);
      if (!validation.ok || !validation.event) {
        warnings.push(`line ${index + 1} is invalid: ${validation.error}`);
        corruptLines.push(line);
        return;
      }
      events.push(validation.event);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`line ${index + 1} is not JSON: ${message}`);
      corruptLines.push(line);
    }
  });
  if (corruptLines.length > 0) {
    writeFileSync(`${path}.quarantine`, `${corruptLines.join("\n")}\n`);
  }
  return { events, warnings };
}

export function resolveUserEvidenceRoot(home = homedir(), configured = "routing-evidence"): string {
  if (configured.trim().length === 0 || isAbsolute(configured) || configured.startsWith("/") || configured.startsWith("\\") || /^[A-Za-z]:/.test(configured)) {
    throw new Error("routing evidence user store must be inside the user ai-orchestrator directory");
  }
  const base = join(home, ".ai-orchestrator");
  mkdirSync(base, { recursive: true });
  const realBase = realpathSync(base);
  const root = join(realBase, ...normalizeRelativePath(configured).split("/"));
  assertNoSymlinkComponents(root);
  if (existsSync(root)) {
    const realRoot = realpathSync(root);
    const inside = relative(realBase, realRoot);
    if (inside.length === 0 || inside.startsWith("..") || isAbsolute(inside)) {
      throw new Error("routing evidence user store must stay inside the user ai-orchestrator directory");
    }
  }
  return root;
}

function appendJsonLine(path: string, value: { eventId: string }): void {
  const line = JSON.stringify(value);
  if (Buffer.byteLength(line, "utf8") > MAX_EVIDENCE_LINE_BYTES) {
    throw new Error(`routing evidence event exceeds ${MAX_EVIDENCE_LINE_BYTES} bytes`);
  }
  assertNoSymlinkComponents(path);
  mkdirSync(join(path, ".."), { recursive: true });
  assertNoSymlinkComponents(path);
  if (existsSync(path)) {
    const existing = statSync(path);
    if (!existing.isFile()) throw new Error(`routing evidence path is not a file: ${path}`);
    const duplicate = readFileSync(path, "utf8").split(/\r?\n/).some((existingLine) => {
      if (!existingLine) return false;
      try {
        return (JSON.parse(existingLine) as { eventId?: unknown }).eventId === value.eventId;
      } catch {
        return false;
      }
    });
    if (duplicate) return;
  }
  writeFileSync(path, `${line}\n`, { flag: "a" });
}

function validateBudgetLedgerEvent(event: RoutingBudgetLedgerEvent): void {
  if (event.version !== 1 || !event.eventId || !event.runId || !event.recordedAt ||
    (event.outcome !== "stage-started" && event.outcome !== "stage-ended") ||
    (event.estimatedUsd !== undefined && (!Number.isFinite(event.estimatedUsd) || event.estimatedUsd < 0)) ||
    (event.observedUsd !== undefined && (!Number.isFinite(event.observedUsd) || event.observedUsd < 0))) {
    throw new Error("routing budget ledger event is invalid");
  }
}

function assertNoSymlinkComponents(target: string): void {
  const absolute = resolve(target);
  const root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(/[\\/]+/).filter(Boolean)) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error(`routing evidence path must not contain symlinks: ${current}`);
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

function normalizeRelativePath(value: string): string {
  const stack: string[] = [];
  for (const part of value.split(/[\\/]+/)) {
    if (part.length === 0 || part === ".") continue;
    if (part === "..") {
      throw new Error("routing evidence user store must stay inside the user ai-orchestrator directory");
    }
    if (/[\u0000-\u001f\u007f]/.test(part)) {
      throw new Error("routing evidence user store must not contain control characters");
    }
    stack.push(part);
  }
  if (stack.length === 0) throw new Error("routing evidence user store must be inside the user ai-orchestrator directory");
  return stack.join("/");
}
