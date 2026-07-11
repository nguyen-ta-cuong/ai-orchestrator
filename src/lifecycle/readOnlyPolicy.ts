const SAFE_INSPECTION_COMMANDS = [
  /^(?:pwd|ls|grep|head|tail|wc|cat)(?:\s+[^;&|><`$()]*)?$/,
  /^rg(?:\s+[^;&|><`$()]*)?$/,
  /^git\s+(?:status|diff|show|log|rev-parse|ls-files)(?:\s+[^;&|><`$()]*)?$/,
];

const MUTATING_OR_EXECUTING_OPTIONS = /(?:^|\s)(?:--output(?:=|\s)|--ext-diff\b|--textconv\b|--pre(?:=|\s)|--hostname-bin(?:=|\s)|-o(?:\s|$))/;

export function isReadOnlyLifecycleCommand(command: string, testCommand?: string): boolean {
  const normalized = command.trim().replace(/\s+/g, " ");
  if (!normalized || /[;&|><`]|\$\(|\r|\n/.test(normalized)) return false;
  if (MUTATING_OR_EXECUTING_OPTIONS.test(normalized)) return false;
  if (testCommand && normalized === testCommand) return true;
  return SAFE_INSPECTION_COMMANDS.some((pattern) => pattern.test(normalized));
}
