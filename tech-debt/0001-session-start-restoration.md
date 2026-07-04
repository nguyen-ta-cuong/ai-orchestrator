# Tech Debt — session_start restoration follow-ups

Source: fable-5 judge review of PR #2 (branch `implement-milestone-2`, HEAD `52788d6`, 2026-07-04).
Verdict was **approve**; these findings are non-blocking and deferred for later cleanup.

## 1. [minor] Inaccurate restore notification on the `!latest` path

- **Where:** `extensions/orchestrator.ts` (~line 113), `session_start` handler.
- **Issue:** The notification "Previous ai-orchestrator run belonged to another session; original model restored and state reset." is emitted even on the `else` sub-path where `isRestorePending(state)` is false and no model was actually restored (e.g. a run started while `ctx.model` was undefined).
- **Fix:** Branch the message — omit the "original model restored" clause when `!isRestorePending(state)`, e.g. "Previous ai-orchestrator run belonged to another session; state reset."

## 2. [nit] `restorePendingSessionState` double-persists and leaks old run state onto the new branch

- **Where:** `extensions/orchestrator.ts` (~lines 511–518).
- **Issue:** `restorePendingSessionState` persists twice: once inside `restoreToolsAfterJudge` (when `toolsBeforeJudge` is set) and again after clearing both fields. In the `!latest` path this also copies the previous session's full run state (task/plan/judgeReports) as an intermediate entry onto the new branch. Harmless (last entry is authoritative via `.pop()`), but noisy/leaky.
- **Fix:** Clear both fields in a single spread and persist once — inline the tool restoration (`pi.setActiveTools(...)` / `deactivateJudgeVerdictTool()`) without the intermediate persist.

## 3. [nit] `runtime` not cleared on the active-`latest` reset path

- **Where:** `extensions/orchestrator.ts` (~lines 125–127), `session_start` handler.
- **Issue:** The "Previous ai-orchestrator run was interrupted; state reset." path resets `state` but does not clear `runtime`, while the `!latest` path does. Stale `runtime` is functionally harmless (`startRun` reloads config; `updateUi` only uses it for a label when non-idle), but the asymmetry is inconsistent.
- **Fix:** Add `runtime = undefined;` in the active-`latest` reset branch for parity.
