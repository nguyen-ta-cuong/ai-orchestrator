import type { JudgeReport } from "./loop.js";

export function plannerPrompt(task: string, repoContext?: string): string {
  return [
    "You are the architect.",
    `Produce a numbered implementation plan for: ${task}`,
    "Explore the repository first. The plan must list files to change, the approach, edge cases, and exact validation commands. Do not write implementation code.",
    repoContext ? `\nRepository context:\n${repoContext}` : undefined,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function replanPrompt(
  task: string,
  previousPlan: string,
  diffSummary: string,
  judgeReports: JudgeReport[] | string,
): string {
  const reports = Array.isArray(judgeReports)
    ? judgeReports
        .map((report, index) => {
          const requiredFixes = report.requiredFixes ? `\nRequired fixes: ${report.requiredFixes}` : "";
          return `${index + 1}. Verdict: ${report.verdict}\nReasons: ${report.reasons}${requiredFixes}`;
        })
        .join("\n\n")
    : judgeReports;

  return [
    "You are the architect revising a failed implementation plan.",
    `Original task: ${task}`,
    `Previous plan:\n${previousPlan}`,
    `Current diff summary:\n${diffSummary}`,
    `Judge reports:\n${reports}`,
    "Produce a revised numbered implementation plan. Address every judge concern, list files to change, edge cases, and exact validation commands. Do not write implementation code.",
  ].join("\n\n");
}

export function coderPrompt(plan: string, judgeFeedback?: string): string {
  return [
    judgeFeedback
      ? `A reviewer rejected the previous attempt for these reasons — address every item:\n${judgeFeedback}`
      : undefined,
    "You are the implementer.",
    "Execute this plan exactly; deviate only when the plan conflicts with repository reality, and say so. Make the edits, run the validation commands from the plan, and fix failures before finishing.",
    `Plan:\n${plan}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function judgePrompt(task: string, plan: string, testCommand?: string): string {
  return [
    "You are the reviewer.",
    `Task:\n${task}`,
    `Plan:\n${plan}`,
    "Review the current git diff (`git diff` + `git diff --staged`) against the plan and the task.",
    testCommand ? `Run \`${testCommand}\`.` : "If no test command is available, inspect the diff carefully instead.",
    "Then call the `judge_verdict` tool exactly once with verdict approve or reject, concrete reasons, and requiredFixes when rejecting. Do not edit files.",
  ].join("\n\n");
}
