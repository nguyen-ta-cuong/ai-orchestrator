import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_BUILD_PLAN_LIMITS,
  compileBuildPlan,
  type BuildNode,
  type BuildPlan,
  type BuildPlanLimits,
} from "../src/core/buildPlan.js";

function output(
  id: string,
  kind: BuildNode["outputContracts"][number]["kind"] = "artifact",
  validation: BuildNode["outputContracts"][number]["validation"] = "sha256",
) {
  return {
    id,
    kind,
    validation,
    ...(validation === "structured" || validation === "reviewed-command" || validation === "human-review"
      ? { validatorRef: `${id}-validator` }
      : {}),
  };
}

function node(id: string, overrides: Partial<BuildNode> = {}): BuildNode {
  return {
    id,
    handler: "inspect",
    priority: 0,
    inputContracts: [],
    outputContracts: [output(`${id}-output`)],
    toolPolicy: "read-only",
    sideEffect: "read",
    workspace: "shared",
    idempotency: "read-replay-safe",
    resourceLocks: [],
    writeSet: [],
    retryLimit: 0,
    timeoutMs: 1_000,
    ...overrides,
  };
}

function plan(): BuildPlan {
  return {
    schemaVersion: 1,
    id: "feature-build",
    planVersion: 1,
    summary: "Inspect, design, build isolated candidates, validate, and request integration review.",
    entry: "inspect",
    exit: "integrate",
    nodes: [
      node("inspect", {
        priority: 20,
        outputContracts: [output("inventory")],
        resourceLocks: [{ kind: "logical", value: "repository", mode: "shared" }],
      }),
      node("design", {
        handler: "design",
        priority: 10,
        inputContracts: ["inventory"],
        outputContracts: [output("design")],
      }),
      node("implement-a", {
        handler: "implement",
        priority: 5,
        inputContracts: ["design"],
        outputContracts: [output("patch-a", "file-set")],
        toolPolicy: "declared-writes",
        sideEffect: "write",
        workspace: "isolated-worktree",
        idempotency: "keyed",
        resourceLocks: [{ kind: "path", value: "src/a.ts", mode: "exclusive" }],
        writeSet: ["src/a.ts"],
        retryLimit: 1,
      }),
      node("implement-b", {
        handler: "implement",
        priority: 5,
        inputContracts: ["design"],
        outputContracts: [output("patch-b", "file-set")],
        toolPolicy: "declared-writes",
        sideEffect: "write",
        workspace: "isolated-worktree",
        idempotency: "keyed",
        resourceLocks: [{ kind: "path", value: "src/b.ts", mode: "exclusive" }],
        writeSet: ["src/b.ts"],
        retryLimit: 1,
      }),
      node("validate-a", {
        handler: "validate",
        priority: 2,
        inputContracts: ["patch-a"],
        outputContracts: [output("verification-a", "evidence", "reviewed-command")],
        toolPolicy: "reviewed-validation",
        workspace: "isolated-worktree",
        targetWorktreeNodeId: "implement-a",
      }),
      node("validate-b", {
        handler: "validate",
        priority: 2,
        inputContracts: ["patch-b"],
        outputContracts: [output("verification-b", "evidence", "reviewed-command")],
        toolPolicy: "reviewed-validation",
        workspace: "isolated-worktree",
        targetWorktreeNodeId: "implement-b",
      }),
      node("integrate", {
        handler: "integrate",
        inputContracts: ["verification-a", "verification-b"],
        outputContracts: [output("integration-decision", "evidence", "human-review")],
        toolPolicy: "human-integration",
        sideEffect: "external",
        idempotency: "none",
      }),
    ],
    dependencies: [
      { from: "inspect", to: "design", contracts: ["inventory"] },
      { from: "design", to: "implement-a", contracts: ["design"] },
      { from: "design", to: "implement-b", contracts: ["design"] },
      { from: "implement-a", to: "validate-a", contracts: ["patch-a"] },
      { from: "implement-b", to: "validate-b", contracts: ["patch-b"] },
      { from: "validate-a", to: "integrate", contracts: ["verification-a"] },
      { from: "validate-b", to: "integrate", contracts: ["verification-b"] },
    ],
    joins: [{ nodeId: "integrate", mode: "all_of" }],
  };
}

function limits(overrides: Partial<BuildPlanLimits>): BuildPlanLimits {
  return { ...DEFAULT_BUILD_PLAN_LIMITS, ...overrides };
}

describe("compileBuildPlan", () => {
  it("strictly validates, canonicalizes, hashes, and freezes a BUILD plan without mutating input", () => {
    const input = plan();
    input.nodes.reverse();
    input.dependencies.reverse();
    const before = structuredClone(input);

    const compiled = compileBuildPlan(input);

    expect(input).toEqual(before);
    expect(compiled.plan.nodes.map(({ id }) => id)).toEqual([
      "design", "implement-a", "implement-b", "inspect", "integrate", "validate-a", "validate-b",
    ]);
    expect(compiled.plan.dependencies.map(({ from, to }) => `${from}->${to}`)).toEqual([
      "design->implement-a",
      "design->implement-b",
      "implement-a->validate-a",
      "implement-b->validate-b",
      "inspect->design",
      "validate-a->integrate",
      "validate-b->integrate",
    ]);
    expect(compiled.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(compiled.hash).toBe(createHash("sha256").update(compiled.canonicalJson).digest("hex"));
    expect(Object.isFrozen(compiled)).toBe(true);
    expect(Object.isFrozen(compiled.plan)).toBe(true);
    expect(Object.isFrozen(compiled.plan.nodes[0])).toBe(true);
    expect(Object.isFrozen(compiled.nodePolicies["implement-a"]?.writeSet)).toBe(true);
  });

  it("produces the same hash and graph from semantically identical ordering", () => {
    const left = plan();
    const right = plan();
    right.nodes.reverse();
    right.dependencies.reverse();
    right.joins.reverse();
    for (const selected of right.nodes) {
      selected.inputContracts.reverse();
      selected.outputContracts.reverse();
      selected.resourceLocks.reverse();
      selected.writeSet.reverse();
    }
    for (const dependency of right.dependencies) dependency.contracts.reverse();

    const first = compileBuildPlan(left);
    const second = compileBuildPlan(right);

    expect(second.hash).toBe(first.hash);
    expect(second.canonicalJson).toBe(first.canonicalJson);
    expect(second.graph.definition).toEqual(first.graph.definition);
    expect(compileBuildPlan({ ...left, summary: `${left.summary} Changed.` }).hash).not.toBe(first.hash);
  });

  it("derives an exact GraphDefinition v1 DAG and adapter-friendly priority metadata", () => {
    const compiled = compileBuildPlan(plan());

    expect(compiled.graph.definition).toMatchObject({
      schemaVersion: 1,
      id: "feature-build",
      version: compiled.hash,
      kind: "dag",
      entry: "inspect",
    });
    expect(Object.keys(compiled.graph.definition)).toEqual(["schemaVersion", "id", "version", "kind", "entry", "nodes", "edges"]);
    expect(compiled.graph.nodesById.get("integrate")).toMatchObject({ terminal: false, handler: "integrate" });
    expect(compiled.graph.nodesById.get("build-complete")).toMatchObject({ terminal: true, sideEffect: "none" });
    expect(compiled.graph.topologicalOrder?.at(-1)).toBe("build-complete");
    expect(compiled.schedulerMetadata).toEqual({
      priorities: {
        design: 10,
        "implement-a": 5,
        "implement-b": 5,
        inspect: 20,
        integrate: 0,
        "validate-a": 2,
        "validate-b": 2,
      },
    });
    expect(compiled.graph.nodesById.get("validate-a")).toMatchObject({
      inputContracts: ["patch-a"],
      outputContracts: ["verification-a"],
      sideEffect: "read",
    });
    const fanOutEvents = compiled.graph.outgoingByNode.get("design")?.map(({ event }) => event) ?? [];
    expect(fanOutEvents).toEqual(["dependency-implement-a", "dependency-implement-b"]);
    expect(new Set(fanOutEvents).size).toBe(fanOutEvents.length);
  });

  it("rejects unknown fields at every schema boundary", () => {
    const cases: unknown[] = [
      { ...plan(), extra: true },
      { ...plan(), nodes: [{ ...plan().nodes[0]!, extra: true }, ...plan().nodes.slice(1)] },
      {
        ...plan(),
        nodes: [
          ...plan().nodes.slice(0, 2),
          {
            ...plan().nodes[2]!,
            resourceLocks: [{ ...plan().nodes[2]!.resourceLocks[0]!, extra: true }],
          },
          ...plan().nodes.slice(3),
        ],
      },
      { ...plan(), dependencies: [{ ...plan().dependencies[0]!, extra: true }, ...plan().dependencies.slice(1)] },
      { ...plan(), joins: [{ ...plan().joins[0]!, extra: true }] },
    ];

    for (const value of cases) expect(() => compileBuildPlan(value)).toThrow(/unsupported fields/);
  });

  it("rejects accessor-backed, sparse, and custom-prototype inputs without evaluating them", () => {
    let accessed = false;
    const accessorPlan = plan() as BuildPlan;
    Object.defineProperty(accessorPlan, "summary", {
      enumerable: true,
      get: () => {
        accessed = true;
        return "must not be evaluated";
      },
    });
    expect(() => compileBuildPlan(accessorPlan)).toThrow(/plain object|data propert/i);
    expect(accessed).toBe(false);

    class HostileNodes extends Array<BuildNode> {}
    expect(() => compileBuildPlan({ ...plan(), nodes: new HostileNodes(...plan().nodes) })).toThrow(/array/i);

    const sparseNodes = Array<BuildNode>(plan().nodes.length);
    sparseNodes[0] = plan().nodes[0]!;
    expect(() => compileBuildPlan({ ...plan(), nodes: sparseNodes })).toThrow(/dense|array/i);
  });

  it("requires declared all_of joins and exact dependency contract bindings", () => {
    const missingJoin = plan();
    missingJoin.joins = [];
    expect(() => compileBuildPlan(missingJoin)).toThrow(/all_of join.*integrate/);

    const speculative = plan() as unknown as { joins: { nodeId: string; mode: string }[] };
    speculative.joins = [{ nodeId: "integrate", mode: "first_success" }];
    expect(() => compileBuildPlan(speculative)).toThrow(/join mode/);

    const wrongSource = plan();
    wrongSource.dependencies[0]!.contracts = ["verification"];
    expect(() => compileBuildPlan(wrongSource)).toThrow(/source.*output contract/);

    const unresolvedInput = plan();
    unresolvedInput.nodes.find(({ id }) => id === "validate-a")!.inputContracts.push("unbound");
    expect(() => compileBuildPlan(unresolvedInput)).toThrow(/input contract.*unbound.*not bound/);

    const duplicateEdge = plan();
    duplicateEdge.dependencies.push({ ...duplicateEdge.dependencies[0]!, contracts: ["inventory"] });
    expect(() => compileBuildPlan(duplicateEdge)).toThrow(/duplicate dependency/);

    const cycle = plan();
    cycle.dependencies.push({ from: "integrate", to: "inspect", contracts: ["integration-decision"] });
    cycle.nodes.find(({ id }) => id === "inspect")!.inputContracts.push("integration-decision");
    expect(() => compileBuildPlan(cycle)).toThrow(/entry.*incoming|cycle/);
  });

  it("enforces handler, tool, side-effect, workspace, path, and resource-lock policy", () => {
    const invalidPolicies: Array<[string, (value: BuildPlan) => void, RegExp]> = [
      ["unknown handler", (value) => { value.nodes[0]!.handler = "other" as BuildNode["handler"]; }, /handler/],
      ["read node writes", (value) => { value.nodes[0]!.writeSet = ["src/escape.ts"]; }, /write set/],
      ["implement is read-only", (value) => { value.nodes[2]!.toolPolicy = "read-only"; }, /tool policy/],
      ["implement is non-writing", (value) => { value.nodes[2]!.sideEffect = "read"; }, /side-effect/],
      ["unknown idempotency", (value) => { value.nodes[2]!.idempotency = "sometimes" as BuildNode["idempotency"]; }, /idempotency/],
      ["write retry is not keyed", (value) => { value.nodes[2]!.idempotency = "none"; }, /retry.*idempotency|idempotency.*retry/],
      ["external retry is not keyed", (value) => { value.nodes.find(({ id }) => id === "integrate")!.retryLimit = 1; }, /retry.*idempotency|idempotency.*retry/],
      ["write claims read replay", (value) => { value.nodes[2]!.idempotency = "read-replay-safe"; }, /read-replay-safe/],
      ["integrate is irreversible", (value) => { value.nodes.find(({ id }) => id === "integrate")!.sideEffect = "irreversible"; }, /irreversible/],
      ["external before exit", (value) => {
        value.nodes[0]!.handler = "integrate";
        value.nodes[0]!.toolPolicy = "human-integration";
        value.nodes[0]!.sideEffect = "external";
        value.nodes[0]!.idempotency = "none";
        value.nodes[0]!.outputContracts[0]!.validation = "human-review";
        value.nodes[0]!.outputContracts[0]!.validatorRef = "forged-human-gate";
      }, /external.*exit|integrate.*exit/],
      ["absolute write", (value) => { value.nodes[2]!.writeSet = ["/tmp/a.ts"]; }, /contained relative/],
      ["traversal", (value) => { value.nodes[2]!.writeSet = ["../a.ts"]; }, /contained relative/],
      ["glob", (value) => { value.nodes[2]!.writeSet = ["src/*.ts"]; }, /canonical repository path/],
      ["dot segment", (value) => { value.nodes[2]!.writeSet = ["src/./a.ts"]; }, /canonical repository path/],
      ["doubled separator", (value) => { value.nodes[2]!.writeSet = ["src//a.ts"]; }, /canonical repository path/],
      ["trailing separator", (value) => { value.nodes[2]!.writeSet = ["src/a.ts/"]; }, /canonical repository path/],
      ["git metadata", (value) => { value.nodes[2]!.writeSet = [".git/config"]; }, /protected path/],
      ["unlocked write", (value) => { value.nodes[2]!.resourceLocks = []; }, /exclusive path resource/],
      ["shared write lock", (value) => { value.nodes[2]!.resourceLocks[0]!.mode = "shared"; }, /exclusive path resource/],
      ["bad logical resource", (value) => { value.nodes[0]!.resourceLocks[0]!.value = "Bad Resource"; }, /logical resource/],
    ];

    for (const [label, mutate, expected] of invalidPolicies) {
      const value = plan();
      mutate(value);
      expect(() => compileBuildPlan(value), label).toThrow(expected);
    }
  });

  it("rejects non-NFC repository paths before hashing plan identity", () => {
    const input = plan();
    const implement = input.nodes.find(({ id }) => id === "implement-a")!;
    implement.writeSet = ["src/e\u0301.ts"];
    implement.resourceLocks = [{ kind: "path", value: "src/e\u0301.ts", mode: "exclusive" }];

    expect(() => compileBuildPlan(input)).toThrow(/canonical repository path/i);
  });

  it("rejects entry inputs because DAG genesis has no predecessor provenance", () => {
    const input = plan();
    input.nodes.find(({ id }) => id === input.entry)!.inputContracts = ["ambient-task"];

    expect(() => compileBuildPlan(input)).toThrow(/entry.*input contract/i);
  });

  it("rejects case-folded and ancestor write overlap between unordered nodes", () => {
    for (const [left, right] of [
      ["src/Feature.ts", "src/feature.ts"],
      ["src/shared", "src/shared/file.ts"],
    ]) {
      const value = plan();
      const first = value.nodes.find(({ id }) => id === "implement-a")!;
      const second = value.nodes.find(({ id }) => id === "implement-b")!;
      first.writeSet = [left];
      first.resourceLocks = [{ kind: "path", value: left, mode: "exclusive" }];
      second.writeSet = [right];
      second.resourceLocks = [{ kind: "path", value: right, mode: "exclusive" }];
      expect(() => compileBuildPlan(value)).toThrow(/overlapping write paths/);
    }
  });

  it("requires isolated writers to terminate at an explicit human integration node", () => {
    const value = plan();
    value.exit = "validate-a";
    value.nodes = value.nodes.filter(({ id }) => id !== "integrate");
    value.dependencies = value.dependencies.filter(({ to }) => to !== "integrate");
    value.joins = [];

    expect(() => compileBuildPlan(value)).toThrow(/isolated.*human integration|integration.*isolated/i);
  });

  it("requires each isolated candidate to be validated inside its explicitly targeted worktree", () => {
    const sharedValidation = plan();
    const shared = sharedValidation.nodes.find(({ id }) => id === "validate-a")!;
    shared.workspace = "shared";
    delete shared.targetWorktreeNodeId;
    expect(() => compileBuildPlan(sharedValidation)).toThrow(/shared validation.*isolated|target.*worktree/i);

    const missingTarget = plan();
    const validate = missingTarget.nodes.find(({ id }) => id === "validate-a")!;
    delete validate.targetWorktreeNodeId;
    expect(() => compileBuildPlan(missingTarget)).toThrow(/target worktree/i);
  });

  it("rejects filesystem-ambiguous Unicode and Windows-trailing path forms", () => {
    for (const path of ["src/σ.ts", "src/file.", "src/name "]) {
      const value = plan();
      const implement = value.nodes.find(({ id }) => id === "implement-a")!;
      implement.writeSet = [path];
      implement.resourceLocks = [{ kind: "path", value: path, mode: "exclusive" }];
      expect(() => compileBuildPlan(value), path).toThrow(/portable|canonical repository path/i);
    }
  });

  it("rejects protected repository metadata in every path segment", () => {
    for (const path of ["src/.git/config", "src/.ai-orchestrator/state.json"]) {
      const value = plan();
      const implement = value.nodes.find(({ id }) => id === "implement-a")!;
      implement.writeSet = [path];
      implement.resourceLocks = [{ kind: "path", value: path, mode: "exclusive" }];
      expect(() => compileBuildPlan(value), path).toThrow(/protected path/i);
    }
  });

  it.each([
    ["nodes", { maxNodes: 5 }, /node limit/],
    ["dependencies", { maxDependencies: 5 }, /dependency limit/],
    ["fan-out", { maxFanOut: 1 }, /fan-out limit/],
    ["contracts", { maxContractsPerNode: 1 }, /contract limit/],
    ["resource locks", { maxResourceLocksPerNode: 0 }, /resource-lock limit/],
    ["write paths", { maxWritePathsPerNode: 0 }, /write-path limit/],
    ["declared paths", { maxTotalDeclaredPaths: 3 }, /declared-path limit/],
    ["write nodes", { maxWriteNodes: 1 }, /write-node limit/],
    ["external nodes", { maxExternalNodes: 0 }, /external-node limit/],
    ["retry limit", { maxRetryLimit: 0 }, /retry limit/],
    ["timeout", { maxTimeoutMs: 999 }, /timeout limit/],
  ] satisfies Array<[string, Partial<BuildPlanLimits>, RegExp]>)
  ("enforces the %s ceiling before compilation", (_label, override, expected) => {
    expect(() => compileBuildPlan(plan(), limits(override))).toThrow(expected);
  });

  it("rejects malformed limits rather than silently widening policy", () => {
    expect(() => compileBuildPlan(plan(), limits({ maxNodes: Number.POSITIVE_INFINITY }))).toThrow(/build-plan limit maxNodes/);
    expect(() => compileBuildPlan(plan(), limits({ maxPriority: -1 }))).toThrow(/build-plan limit maxPriority/);
    expect(() => compileBuildPlan(plan(), { ...DEFAULT_BUILD_PLAN_LIMITS, unknown: 1 } as BuildPlanLimits)).toThrow(
      /unsupported fields/,
    );
  });

  it("bounds identifiers before canonicalization and hashing", () => {
    expect(() => compileBuildPlan({ ...plan(), id: `a${"b".repeat(256)}` })).toThrow(/bounded canonical identifier/i);
  });
});
