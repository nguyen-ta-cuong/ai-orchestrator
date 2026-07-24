export interface ReviewedCommandInvocation {
  command: string;
  args: readonly string[];
}

export interface ReviewedCommandRegistry {
  allows(commands: readonly string[]): boolean;
  resolve(command: string): Readonly<ReviewedCommandInvocation>;
}

const DETECTED_TEST_COMMANDS = Object.freeze(new Map<string, Readonly<ReviewedCommandInvocation>>([
  ["npm test", Object.freeze({ command: "npm", args: Object.freeze(["test"]) })],
  ["pytest", Object.freeze({ command: "pytest", args: Object.freeze([]) })],
  ["cargo test", Object.freeze({ command: "cargo", args: Object.freeze(["test"]) })],
  ["go test ./...", Object.freeze({ command: "go", args: Object.freeze(["test", "./..."]) })],
]));

/**
 * Resolve only the fixed command emitted by detectTestCommand(). BUILD plans
 * are model-authored control data, so even a human-skipped (`--yolo`) PLAN may
 * never widen this registry or obtain a generic shell.
 */
export function createReviewedCommandRegistry(
  detectedTestCommand: string | undefined,
): Readonly<ReviewedCommandRegistry> {
  const allowed = detectedTestCommand === undefined
    ? undefined
    : DETECTED_TEST_COMMANDS.get(detectedTestCommand);
  if (detectedTestCommand !== undefined && allowed === undefined) {
    throw new Error("Detected BUILD test command is not a fixed trusted invocation");
  }
  return Object.freeze({
    allows(commands: readonly string[]): boolean {
      return allowed !== undefined && commands.length === 1 && commands[0] === detectedTestCommand;
    },
    resolve(command: string): Readonly<ReviewedCommandInvocation> {
      if (allowed === undefined || command !== detectedTestCommand) {
        throw new Error("BUILD reviewed command is not in the fixed trusted command registry");
      }
      return allowed;
    },
  });
}

export async function executeReviewedCommand<T>(
  registry: Readonly<ReviewedCommandRegistry>,
  exec: (
    command: string,
    args: string[],
    options: Readonly<{ cwd: string; timeout?: number; signal?: AbortSignal }>,
  ) => Promise<T>,
  command: string,
  options: Readonly<{ cwd: string; timeoutMs: number; signal?: AbortSignal }>,
): Promise<T> {
  const invocation = registry.resolve(command);
  return exec(invocation.command, [...invocation.args], {
    cwd: options.cwd,
    timeout: options.timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}
