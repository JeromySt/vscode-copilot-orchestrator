/**
 * @fileoverview Integration testing infrastructure for deterministic plan execution.
 *
 * Exports the scripted process spawner, process script library, and integration
 * test plan builder for exercising all orchestrator behaviors with controlled output.
 *
 * @module plan/testing
 */

export { ScriptedProcessSpawner, FakeChildProcess } from './scriptedProcessSpawner';
export { ScriptedCopilotRunner } from './scriptedCopilotRunner';
export {
  type ProcessScript,
  type ScriptedLine,
  type LogFileScript,
  type ScriptMatchCriteria,
  successfulAgentScript,
  successfulShellScript,
  failingShellScript,
  failThenSucceedScripts,
  alwaysFailsScript,
  noChangesScript,
  failingPostcheckScript,
  passingPostcheckScript,
  gitSuccessScript,
  sessionIdLines,
  statsLines,
  taskCompleteLines,
  contextPressureLogLines,
} from './processScripts';
export {
  buildIntegrationTestPlan,
  type IntegrationTestPlan,
} from './integrationTestPlanBuilder';
