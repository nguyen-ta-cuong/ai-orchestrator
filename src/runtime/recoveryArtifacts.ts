import { createHash } from "node:crypto";
import {
  validateRecoveryAuthority,
  validateRecoveryLedger,
  type RecoveryAuthority,
  type RecoveryLedger,
} from "../core/recovery.js";
import type { GraphCheckpointRef } from "../core/scheduler.js";

export interface RecoveryArtifactBinding {
  version: 1;
  semanticRef: string;
  sha256: string;
  sizeBytes: number;
  storageRef: Readonly<GraphCheckpointRef>;
}

export interface AuthenticatedRecoveryArtifacts {
  ledger: Readonly<RecoveryLedger>;
  bindings: readonly Readonly<RecoveryArtifactBinding>[];
}

const SHA256 = /^[a-f0-9]{64}$/;
const PORTABLE_SEGMENT = /^[A-Za-z0-9@+_,.-]+$/;
const MAX_REFERENCE_LENGTH = 256;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
// Authentication is deliberately capped across unique stored objects, not only
// per binding. This prevents a valid-looking ledger from forcing unbounded I/O.
const MAX_TOTAL_RECOVERY_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_BINDINGS = 4_096;
const PROTECTED_SEGMENTS = new Set([".git", ".ai-orchestrator"]);

export function authenticateRecoveryArtifacts(input: {
  authority: RecoveryAuthority;
  ledger: RecoveryLedger;
  bindings: readonly RecoveryArtifactBinding[];
  readArtifact: (reference: GraphCheckpointRef) => Uint8Array;
}): AuthenticatedRecoveryArtifacts {
  const authority = validateRecoveryAuthority(input.authority);
  const ledger = validateRecoveryLedger(input.ledger, authority);
  if (!Array.isArray(input.bindings) || input.bindings.length > MAX_BINDINGS ||
      Object.keys(input.bindings).length !== input.bindings.length) {
    throw new Error("Recovery artifact bindings must be a bounded dense array");
  }
  const bindings = input.bindings.map(validateRecoveryArtifactBinding);
  const required = requiredRecoveryArtifacts(ledger, authority);
  const byReference = new Map<string, RecoveryArtifactBinding>();
  for (const binding of bindings) {
    if (byReference.has(binding.semanticRef)) {
      throw new Error(`Recovery artifact reference is duplicated: ${binding.semanticRef}`);
    }
    byReference.set(binding.semanticRef, binding);
  }

  for (const [semanticRef, expectedHash] of required) {
    const binding = byReference.get(semanticRef);
    if (!binding) throw new Error(`Recovery artifact is missing: ${semanticRef}`);
    if (expectedHash !== undefined && binding.sha256 !== expectedHash) {
      throw new Error(`Recovery artifact hash does not match ${semanticRef}`);
    }
  }
  for (const binding of bindings) {
    if (!required.has(binding.semanticRef)) {
      throw new Error(`Recovery artifact is not referenced by authority: ${binding.semanticRef}`);
    }
  }

  const uniqueStorage = new Map<string, RecoveryArtifactBinding>();
  let totalUniqueBytes = 0;
  for (const binding of bindings) {
    const previous = uniqueStorage.get(binding.storageRef.path);
    if (previous) {
      if (previous.storageRef.sha256 !== binding.storageRef.sha256 ||
          previous.storageRef.sizeBytes !== binding.storageRef.sizeBytes) {
        throw new Error(`Recovery artifact storage reference is inconsistent: ${binding.storageRef.path}`);
      }
      continue;
    }
    uniqueStorage.set(binding.storageRef.path, binding);
    totalUniqueBytes += binding.storageRef.sizeBytes;
    if (totalUniqueBytes > MAX_TOTAL_RECOVERY_ARTIFACT_BYTES) {
      throw new Error("Recovery artifacts exceed the aggregate storage byte budget");
    }
  }

  for (const binding of uniqueStorage.values()) {
    const bytes = Buffer.from(input.readArtifact(binding.storageRef));
    if (bytes.byteLength !== binding.sizeBytes || sha256(bytes) !== binding.sha256) {
      throw new Error(`Recovery artifact bytes do not match ${binding.semanticRef}`);
    }
  }
  return Object.freeze({ ledger, bindings: Object.freeze(bindings) });
}

export function validateRecoveryArtifactBinding(value: unknown): RecoveryArtifactBinding {
  const record = requireRecord(value, "recovery artifact binding");
  assertExactKeys(record, ["version", "semanticRef", "sha256", "sizeBytes", "storageRef"], "recovery artifact binding");
  if (record.version !== 1) throw new Error("Recovery artifact binding version must be 1");
  const semanticRef = requirePortableReference(record.semanticRef, "recovery artifact semanticRef");
  const sha256Value = requireHash(record.sha256, "recovery artifact sha256");
  const sizeBytes = requireSize(record.sizeBytes, "recovery artifact sizeBytes");
  const storageRecord = requireRecord(record.storageRef, "recovery artifact storageRef");
  assertExactKeys(storageRecord, ["path", "sha256", "sizeBytes"], "recovery artifact storageRef");
  const storageRef = Object.freeze({
    path: requireMutationPath(storageRecord.path),
    sha256: requireHash(storageRecord.sha256, "recovery artifact storageRef.sha256"),
    sizeBytes: requireSize(storageRecord.sizeBytes, "recovery artifact storageRef.sizeBytes"),
  });
  if (storageRef.path !== `mutations/${storageRef.sha256}.json`) {
    throw new Error("Recovery artifact storageRef.path does not match its SHA-256 digest");
  }
  if (storageRef.sha256 !== sha256Value || storageRef.sizeBytes !== sizeBytes) {
    throw new Error("Recovery artifact storage reference does not match its semantic binding");
  }
  return Object.freeze({ version: 1, semanticRef, sha256: sha256Value, sizeBytes, storageRef });
}

export function recoveryArtifactBinding(
  semanticRef: string,
  storageRef: GraphCheckpointRef,
): RecoveryArtifactBinding {
  return validateRecoveryArtifactBinding({
    version: 1,
    semanticRef,
    sha256: storageRef.sha256,
    sizeBytes: storageRef.sizeBytes,
    storageRef,
  });
}

function requiredRecoveryArtifacts(
  ledger: RecoveryLedger,
  authority: RecoveryAuthority,
): Map<string, string | undefined> {
  const required = new Map<string, string | undefined>();
  addRequirement(required, `plan-versions/${authority.activePlanVersion}/graph.json`, authority.graphDigest);
  addRequirement(required, `plan-versions/${authority.activePlanVersion}/plan.md`, authority.activePlanHash);
  for (const record of ledger.records) {
    if (record.kind === "registration") {
      for (const artifactHash of record.failure.artifactHashes) {
        const matchingReference = [...required.entries()].find(([, hash]) => hash === artifactHash)?.[0];
        if (!matchingReference) {
          addRequirement(required, `plan-versions/${record.failure.planVersion}/evidence/${artifactHash}.bin`, artifactHash);
        }
      }
      continue;
    }
    if (record.kind === "decision" && record.directive) {
      addRequirement(required, record.directive.diagnosisRef, record.directive.diagnosisHash);
      for (const reference of record.directive.evidenceRefs) addRequirement(required, reference, undefined);
      continue;
    }
    if (record.kind === "successor") {
      addRequirement(required, record.event.graphRef, record.event.graphHash);
      addRequirement(required, record.event.planRef, record.event.planHash);
      if (record.event.phase === "approved" || record.event.phase === "activated") {
        addRequirement(required, record.event.approvalRef, record.event.approvalHash);
      }
      continue;
    }
    if (record.kind === "release") {
      addRequirement(required, record.release.evidenceRef, record.release.evidenceHash);
    }
  }
  return required;
}

function addRequirement(target: Map<string, string | undefined>, reference: string, hash: string | undefined): void {
  const previous = target.get(reference);
  if (target.has(reference)) {
    if (previous !== undefined && hash !== undefined && previous !== hash) {
      throw new Error(`Recovery artifact reference changed its immutable hash: ${reference}`);
    }
    target.set(reference, previous ?? hash);
    return;
  }
  target.set(reference, hash);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain object`);
  }
  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable) continue;
    if (!("value" in descriptor)) throw new Error(`${label}.${key} must be an own data property`);
    result[key] = descriptor.value;
  }
  return result;
}

function assertExactKeys(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label} has unexpected or missing fields`);
}

function requireHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} must be a SHA-256 digest`);
  return value;
}

function requireSize(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_ARTIFACT_BYTES) {
    throw new Error(`${label} is invalid`);
  }
  return value as number;
}

function requirePortableReference(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > MAX_REFERENCE_LENGTH || value.startsWith("/") || value.includes("\\")) {
    throw new Error(`${label} is not a portable relative path`);
  }
  const parts = value.split("/");
  if (parts.length < 2 || parts.some((part) =>
    !PORTABLE_SEGMENT.test(part) || part === "." || part === ".." || PROTECTED_SEGMENTS.has(part))) {
    throw new Error(`${label} is not a portable relative path`);
  }
  return value;
}

function requireMutationPath(value: unknown): string {
  if (typeof value !== "string" || !/^mutations\/[a-f0-9]{64}\.json$/.test(value)) {
    throw new Error("Recovery artifact storageRef.path must be a content-addressed mutation artifact");
  }
  return value;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
