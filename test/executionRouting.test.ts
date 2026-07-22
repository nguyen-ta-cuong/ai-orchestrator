import { describe, expect, it } from "vitest";
import {
  ExecutionRoutingError,
  routeExecution,
  type ExecutionRoutingInput,
} from "../src/core/executionRouting.js";

function input(overrides: Partial<ExecutionRoutingInput> = {}): ExecutionRoutingInput {
  return {
    user: {
      mode: "automatic",
      maxMode: "lifecycle-dag",
      allowParallelWrites: false,
    },
    task: {
      category: "small-fix",
      risk: "low",
      expectedSteps: 2,
      independentBranchCount: 1,
      durabilityRequired: false,
      mutation: "write",
      writeIsolation: "none",
      parallelWriteSafety: "unverified",
    },
    ...overrides,
  };
}

describe("execution routing", () => {
  it("keeps simple low-risk tasks on the bounded fast path", () => {
    const decision = routeExecution(input());

    expect(decision).toMatchObject({
      mode: "fast",
      source: "automatic",
      parallelWrites: false,
      projectReductionApplied: false,
      reasonCodes: ["simple-low-risk"],
    });
    expect(decision.explanations[0]).toContain("low-risk");
  });

  it("routes durable or elevated-risk work through the sequential lifecycle", () => {
    expect(routeExecution(input({
      task: {
        category: "persistence-change",
        risk: "high",
        expectedSteps: 2,
        independentBranchCount: 1,
        durabilityRequired: true,
        mutation: "write",
        writeIsolation: "none",
        parallelWriteSafety: "unverified",
      },
    }))).toMatchObject({
      mode: "lifecycle-sequential",
      reasonCodes: ["durability-required", "elevated-risk"],
    });
  });

  it("does not trust a low risk label for a security-sensitive category", () => {
    expect(routeExecution(input({
      task: {
        category: "security-sensitive",
        risk: "low",
        expectedSteps: 2,
        independentBranchCount: 1,
        durabilityRequired: false,
        mutation: "write",
        writeIsolation: "none",
        parallelWriteSafety: "unverified",
      },
    }))).toMatchObject({
      mode: "lifecycle-sequential",
      reasonCodes: ["elevated-risk"],
    });
  });

  it("selects a DAG for useful independent branches without implying parallel writes", () => {
    const decision = routeExecution(input({
      task: {
        category: "read-only-analysis",
        risk: "low",
        expectedSteps: 5,
        independentBranchCount: 3,
        durabilityRequired: false,
        mutation: "read-only",
        writeIsolation: "none",
        parallelWriteSafety: "not-applicable",
      },
    }));

    expect(decision).toMatchObject({
      mode: "lifecycle-dag",
      parallelWrites: false,
      reasonCodes: ["independent-branches"],
    });
  });

  it("honors a trusted user pin ahead of repository reductions", () => {
    const decision = routeExecution(input({
      user: { mode: "lifecycle-dag", maxMode: "lifecycle-dag", allowParallelWrites: false },
      project: { requestedMode: "fast", maxMode: "fast", allowParallelWrites: true },
    }));

    expect(decision).toMatchObject({
      mode: "lifecycle-dag",
      source: "user-pin",
      parallelWrites: false,
      projectReductionApplied: false,
    });
    expect(decision.reasonCodes).toContain("user-pin");
    expect(decision.reasonCodes).toContain("project-mode-ignored-by-user-pin");
    expect(decision.reasonCodes).toContain("parallel-writes-user-permission-required");
  });

  it("lets repository policy reduce automatic DAG work but never expand it", () => {
    const complex = input({
      task: {
        category: "multi-file-feature",
        risk: "medium",
        expectedSteps: 8,
        independentBranchCount: 3,
        durabilityRequired: true,
        mutation: "write",
        writeIsolation: "worktree",
        parallelWriteSafety: "verified-disjoint",
      },
      project: { requestedMode: "lifecycle-sequential" },
    });
    expect(routeExecution(complex)).toMatchObject({
      mode: "lifecycle-sequential",
      projectReductionApplied: true,
      reasonCodes: expect.arrayContaining(["project-reduction"]),
    });

    const simple = input({ project: { requestedMode: "lifecycle-dag", maxMode: "lifecycle-dag" } });
    expect(routeExecution(simple)).toMatchObject({ mode: "fast", projectReductionApplied: false });
    expect(routeExecution(simple).reasonCodes).toContain("project-expansion-denied");
  });

  it("does not let a repository reduction bypass the derived durability floor", () => {
    const decision = routeExecution(input({
      task: {
        category: "security-sensitive",
        risk: "high",
        expectedSteps: 5,
        independentBranchCount: 1,
        durabilityRequired: true,
        mutation: "write",
        writeIsolation: "none",
        parallelWriteSafety: "unverified",
      },
      project: { requestedMode: "fast", maxMode: "fast" },
    }));

    expect(decision.mode).toBe("lifecycle-sequential");
    expect(decision.reasonCodes).toContain("project-reduction-denied-by-safety-floor");
  });

  it("enables isolated parallel writes only with trusted user permission", () => {
    const dagTask: ExecutionRoutingInput["task"] = {
      category: "multi-file-feature",
      risk: "medium",
      expectedSteps: 8,
      independentBranchCount: 3,
      durabilityRequired: true,
      mutation: "write",
      writeIsolation: "worktree",
      parallelWriteSafety: "verified-disjoint",
    };

    expect(routeExecution(input({ task: dagTask, project: { allowParallelWrites: true } }))).toMatchObject({
      mode: "lifecycle-dag",
      parallelWrites: false,
      reasonCodes: expect.arrayContaining(["parallel-writes-user-permission-required"]),
    });
    expect(routeExecution(input({
      task: dagTask,
      user: { mode: "automatic", maxMode: "lifecycle-dag", allowParallelWrites: true },
      project: { allowParallelWrites: true },
    }))).toMatchObject({
      mode: "lifecycle-dag",
      parallelWrites: true,
      reasonCodes: expect.arrayContaining(["parallel-writes-trusted-opt-in"]),
    });
    expect(routeExecution(input({
      task: dagTask,
      user: { mode: "automatic", maxMode: "lifecycle-dag", allowParallelWrites: true },
      project: { allowParallelWrites: false },
    }))).toMatchObject({
      parallelWrites: false,
      reasonCodes: expect.arrayContaining(["parallel-writes-project-disabled"]),
    });
  });

  it("requires worktree isolation even when parallel writes are trusted", () => {
    const decision = routeExecution(input({
      user: { mode: "automatic", maxMode: "lifecycle-dag", allowParallelWrites: true },
      task: {
        category: "multi-file-feature",
        risk: "medium",
        expectedSteps: 7,
        independentBranchCount: 2,
        durabilityRequired: true,
        mutation: "write",
        writeIsolation: "none",
        parallelWriteSafety: "verified-disjoint",
      },
    }));

    expect(decision.parallelWrites).toBe(false);
    expect(decision.reasonCodes).toContain("parallel-writes-worktree-required");
  });

  it("keeps declared conflicting writes sequential even across worktrees", () => {
    const decision = routeExecution(input({
      user: { mode: "automatic", maxMode: "lifecycle-dag", allowParallelWrites: true },
      task: {
        category: "conflicting-writes",
        risk: "medium",
        expectedSteps: 7,
        independentBranchCount: 2,
        durabilityRequired: true,
        mutation: "write",
        writeIsolation: "worktree",
        parallelWriteSafety: "conflicting",
      },
    }));

    expect(decision.parallelWrites).toBe(false);
    expect(decision.reasonCodes).toContain("parallel-writes-conflict-declared");
  });

  it("does not parallelize writes until disjoint write sets are independently verified", () => {
    const decision = routeExecution(input({
      user: { mode: "automatic", maxMode: "lifecycle-dag", allowParallelWrites: true },
      task: {
        category: "multi-file-feature",
        risk: "medium",
        expectedSteps: 7,
        independentBranchCount: 2,
        durabilityRequired: true,
        mutation: "write",
        writeIsolation: "worktree",
        parallelWriteSafety: "unverified",
      },
    }));

    expect(decision.parallelWrites).toBe(false);
    expect(decision.reasonCodes).toContain("parallel-writes-disjoint-write-sets-required");
  });

  it("fails closed for contradictory or malformed policy input", () => {
    expect(() => routeExecution(input({
      user: { mode: "lifecycle-dag", maxMode: "lifecycle-sequential", allowParallelWrites: false },
    }))).toThrowError(expect.objectContaining<Partial<ExecutionRoutingError>>({ code: "user-pin-exceeds-ceiling" }));

    expect(() => routeExecution({
      ...input(),
      task: { ...input().task, expectedSteps: 0 },
    })).toThrowError(expect.objectContaining<Partial<ExecutionRoutingError>>({ code: "invalid-input" }));

    expect(() => routeExecution({
      ...input(),
      project: { requestedMode: "fast", rawPrompt: "SECRET" },
    } as unknown as ExecutionRoutingInput)).toThrowError(expect.objectContaining<Partial<ExecutionRoutingError>>({
      code: "unexpected-field",
    }));

    const inherited = Object.create({ task: input().task }) as ExecutionRoutingInput;
    inherited.user = input().user;
    expect(() => routeExecution(inherited)).toThrowError(expect.objectContaining<Partial<ExecutionRoutingError>>({
      code: "invalid-input",
    }));

    const accessor = { ...input() };
    Object.defineProperty(accessor, "task", { enumerable: true, get: () => input().task });
    expect(() => routeExecution(accessor)).toThrowError(expect.objectContaining<Partial<ExecutionRoutingError>>({
      code: "invalid-input",
    }));

    const hidden = { ...input() };
    Object.defineProperty(hidden, "rawPrompt", { value: "SECRET", enumerable: false });
    expect(() => routeExecution(hidden)).toThrowError(expect.objectContaining<Partial<ExecutionRoutingError>>({
      code: "unexpected-field",
    }));

    expect(() => routeExecution(Object.assign({ ...input() }, { [Symbol("secret")]: "SECRET" })))
      .toThrowError(expect.objectContaining<Partial<ExecutionRoutingError>>({ code: "unexpected-field" }));
  });

  it.each([
    {
      mutation: "read-only",
      writeIsolation: "worktree",
      parallelWriteSafety: "not-applicable",
    },
    {
      mutation: "read-only",
      writeIsolation: "none",
      parallelWriteSafety: "verified-disjoint",
    },
    {
      mutation: "write",
      writeIsolation: "worktree",
      parallelWriteSafety: "not-applicable",
    },
  ] as const)("rejects contradictory mutation and write-safety features %#", (features) => {
    expect(() => routeExecution(input({
      task: {
        ...input().task,
        expectedSteps: 4,
        independentBranchCount: 2,
        ...features,
      },
    }))).toThrowError(expect.objectContaining<Partial<ExecutionRoutingError>>({ code: "invalid-input" }));
  });

  it("accepts verified-disjoint only for multiple non-conflicting BUILD branches", () => {
    expect(() => routeExecution(input({
      task: {
        ...input().task,
        parallelWriteSafety: "verified-disjoint",
      },
    }))).toThrowError(expect.objectContaining<Partial<ExecutionRoutingError>>({ code: "invalid-input" }));

    expect(() => routeExecution(input({
      task: {
        ...input().task,
        category: "conflicting-writes",
        expectedSteps: 4,
        independentBranchCount: 2,
        writeIsolation: "worktree",
        parallelWriteSafety: "verified-disjoint",
      },
    }))).toThrowError(expect.objectContaining<Partial<ExecutionRoutingError>>({ code: "invalid-input" }));

    expect(() => routeExecution(input({
      task: {
        ...input().task,
        expectedSteps: 4,
        independentBranchCount: 2,
        writeIsolation: "worktree",
        parallelWriteSafety: "conflicting",
      },
    }))).toThrowError(expect.objectContaining<Partial<ExecutionRoutingError>>({ code: "invalid-input" }));
  });
});
