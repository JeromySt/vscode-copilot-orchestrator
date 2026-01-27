
import * as cp from 'child_process';
export function isCopilotCliAvailable(): boolean {
  return cmdOk('gh copilot --help') || hasGhCopilot() || cmdOk('copilot --help') || cmdOk('github-copilot --help') || cmdOk('github-copilot-cli --help');
}
function cmdOk(cmd: string): boolean { try { cp.execSync(cmd, { stdio: 'ignore' }); return true; } catch { return false; } }
function hasGhCopilot(): boolean { try { const out = cp.execSync('gh extension list', { encoding: 'utf8' }); return /github\/gh-copilot/i.test(out); } catch { return false; } }
