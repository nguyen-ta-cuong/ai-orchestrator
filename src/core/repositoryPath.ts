const MAX_REPOSITORY_PATH_BYTES = 1_024;
const PORTABLE_SEGMENT = /^[A-Za-z0-9@+_,.-]+$/;
const PROTECTED_SEGMENTS = new Set([".git", ".ai-orchestrator"]);

/** Validate the portable repository-path subset shared by plans and Git inspection. */
export function requireBuildRepositoryPath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 ||
      Buffer.byteLength(value, "utf8") > MAX_REPOSITORY_PATH_BYTES || value !== value.normalize("NFC") ||
      value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/.test(value) || value.includes("\\") ||
      /[\u0000-\u001f\u007f*?\[\]{}]/.test(value)) {
    throw new Error(`${label} must be a contained relative canonical repository path in the portable subset`);
  }

  const parts = value.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === ".." ||
      !PORTABLE_SEGMENT.test(part) || part.endsWith(".") || isWindowsReservedPathSegment(part)) ||
      parts.join("/") !== value) {
    throw new Error(`${label} must be a contained relative canonical repository path in the portable subset`);
  }
  if (parts.some((part) => PROTECTED_SEGMENTS.has(part.toLowerCase()))) {
    throw new Error(`${label} targets a protected path`);
  }
  return value;
}

function isWindowsReservedPathSegment(segment: string): boolean {
  const base = segment.split(".", 1)[0]!.toLowerCase();
  return base === "con" || base === "prn" || base === "aux" || base === "nul" ||
    /^com[1-9]$/.test(base) || /^lpt[1-9]$/.test(base);
}
