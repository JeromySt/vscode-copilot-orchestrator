/**
 * @fileoverview Copilot CLI plugin and custom agent discovery.
 *
 * Provides functionality to:
 * - List installed Copilot CLI plugins (`copilot plugin list`)
 * - Discover custom agent files (`~/.copilot/agents/*.agent.md`)
 * - Validate agent/plugin availability
 * - Install missing plugins (`copilot plugin install <source>`)
 *
 * @module agent/pluginDiscovery
 */

import * as fs from 'fs';
import * as path from 'path';
import type { IProcessSpawner } from '../interfaces/IProcessSpawner';
import type { IEnvironment } from '../interfaces/IEnvironment';
import { Logger } from '../core/logger';

const log = Logger.for('jobs');

/** Represents an installed Copilot CLI plugin. */
export interface InstalledPlugin {
  name: string;
  source?: string;
}

/** Represents a custom agent file (.agent.md). */
export interface CustomAgent {
  name: string;
  filePath: string;
}

/** Result of agent availability check. */
export interface AgentAvailabilityResult {
  available: boolean;
  /** Where the agent was found: 'plugin', 'custom-agent', or undefined if not found */
  source?: 'plugin' | 'custom-agent';
  /** For plugins: the source identifier for install */
  installSource?: string;
}

/** Result of a plugin install attempt. */
export interface PluginInstallResult {
  success: boolean;
  error?: string;
}

/**
 * Parse the output of `copilot plugin list` into structured data.
 *
 * Expected format (one plugin per line):
 * ```
 * name-of-plugin (source: owner/repo)
 * another-plugin (source: plugin@marketplace)
 * ```
 * If output is "No plugins installed." or empty, returns empty array.
 */
export function parsePluginListOutput(output: string): InstalledPlugin[] {
  const plugins: InstalledPlugin[] = [];
  const lines = output.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  for (const line of lines) {
    // Skip "No plugins installed" or help text
    if (line.startsWith('No plugins') || line.startsWith('Use ')) {
      continue;
    }
    // Parse "name (source: xxx)" format
    const match = line.match(/^([^\s(]+)\s*(?:\(source:\s*(.+?)\))?/);
    if (match) {
      plugins.push({
        name: match[1],
        source: match[2]?.trim(),
      });
    }
  }
  return plugins;
}

/**
 * List installed Copilot CLI plugins by running `copilot plugin list`.
 */
export async function listInstalledPlugins(
  spawner: IProcessSpawner,
): Promise<InstalledPlugin[]> {
  try {
    const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
      let stdout = '';
      let stderr = '';
      const proc = spawner.spawn('copilot', ['plugin', 'list'], { stdio: 'pipe' });

      proc.stdout?.on('data', (data: Buffer | string) => { stdout += data.toString(); });
      proc.stderr?.on('data', (data: Buffer | string) => { stderr += data.toString(); });
      proc.on('close', (code: number | null) => {
        resolve({ stdout, stderr, exitCode: code ?? 1 });
      });
      proc.on('error', () => {
        resolve({ stdout, stderr, exitCode: 1 });
      });

      // Timeout after 15 seconds
      setTimeout(() => {
        try { proc.kill?.(); } catch { /* ignore */ }
        resolve({ stdout, stderr, exitCode: 1 });
      }, 15_000);
    });

    if (result.exitCode !== 0) {
      log.warn(`copilot plugin list failed (exit ${result.exitCode}): ${result.stderr}`);
      return [];
    }

    return parsePluginListOutput(result.stdout);
  } catch (err: any) {
    log.warn(`Failed to list plugins: ${err.message}`);
    return [];
  }
}

/**
 * Discover custom agent files in known directories.
 *
 * Scans:
 * - `~/.copilot/agents/` (user-level)
 * - `.github/agents/` (repo-level, relative to cwd)
 *
 * Agent files must end with `.agent.md` or `.md` and contain YAML frontmatter with a `name` field.
 */
export function discoverCustomAgents(
  env: IEnvironment,
  repoCwd?: string,
): CustomAgent[] {
  const agents: CustomAgent[] = [];

  // User-level agents: ~/.copilot/agents/
  const homeDir = env.env['HOME'] || env.env['USERPROFILE'] || '';
  if (homeDir) {
    const userAgentDir = path.join(homeDir, '.copilot', 'agents');
    agents.push(...scanAgentDirectory(userAgentDir));
  }

  // Repo-level agents: .github/agents/
  if (repoCwd) {
    const repoAgentDir = path.join(repoCwd, '.github', 'agents');
    agents.push(...scanAgentDirectory(repoAgentDir));
  }

  return agents;
}

/**
 * Scan a directory for agent files and extract their names.
 */
function scanAgentDirectory(dirPath: string): CustomAgent[] {
  const agents: CustomAgent[] = [];
  try {
    if (!fs.existsSync(dirPath)) { return agents; }
    const entries = fs.readdirSync(dirPath);
    for (const entry of entries) {
      if (!entry.endsWith('.agent.md') && !entry.endsWith('.md')) { continue; }
      const filePath = path.join(dirPath, entry);
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) { continue; }

      // Extract name from frontmatter or filename
      const name = extractAgentName(filePath, entry);
      if (name) {
        agents.push({ name, filePath });
      }
    }
  } catch {
    // Directory not readable — skip silently
  }
  return agents;
}

/**
 * Extract agent name from YAML frontmatter or filename.
 */
function extractAgentName(filePath: string, fileName: string): string | undefined {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    // Look for YAML frontmatter: ---\nname: agent-name\n---
    const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (frontmatterMatch) {
      const nameMatch = frontmatterMatch[1].match(/^name:\s*['"]?([^'"{\n]+?)['"]?\s*$/m);
      if (nameMatch) { return nameMatch[1].trim(); }
    }
  } catch {
    // File not readable
  }
  // Fallback: derive name from filename
  // "k8s-assistant.agent.md" → "k8s-assistant"
  // "my-agent.md" → "my-agent"
  return fileName.replace(/\.agent\.md$/, '').replace(/\.md$/, '') || undefined;
}

/**
 * Check if a given agent name is available (either as installed plugin or custom agent).
 */
export async function isAgentAvailable(
  agentName: string,
  spawner: IProcessSpawner,
  env: IEnvironment,
  repoCwd?: string,
): Promise<AgentAvailabilityResult> {
  // Check installed plugins first
  const plugins = await listInstalledPlugins(spawner);
  const pluginMatch = plugins.find(p =>
    p.name === agentName || p.name.toLowerCase() === agentName.toLowerCase()
  );
  if (pluginMatch) {
    return { available: true, source: 'plugin', installSource: pluginMatch.source };
  }

  // Check custom agent files
  const customAgents = discoverCustomAgents(env, repoCwd);
  const agentMatch = customAgents.find(a =>
    a.name === agentName || a.name.toLowerCase() === agentName.toLowerCase()
  );
  if (agentMatch) {
    return { available: true, source: 'custom-agent' };
  }

  return { available: false };
}

/**
 * Attempt to install a Copilot CLI plugin.
 *
 * @param source Plugin source (e.g. "plugin@marketplace", "owner/repo", "owner/repo:path")
 */
export async function installPlugin(
  source: string,
  spawner: IProcessSpawner,
): Promise<PluginInstallResult> {
  try {
    const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
      let stdout = '';
      let stderr = '';
      const proc = spawner.spawn('copilot', ['plugin', 'install', source], { stdio: 'pipe' });

      proc.stdout?.on('data', (data: Buffer | string) => { stdout += data.toString(); });
      proc.stderr?.on('data', (data: Buffer | string) => { stderr += data.toString(); });
      proc.on('close', (code: number | null) => {
        resolve({ stdout, stderr, exitCode: code ?? 1 });
      });
      proc.on('error', (err: Error) => {
        resolve({ stdout, stderr: err.message, exitCode: 1 });
      });

      // Timeout after 60 seconds for install
      setTimeout(() => {
        try { proc.kill?.(); } catch { /* ignore */ }
        resolve({ stdout, stderr: 'Plugin install timed out after 60 seconds', exitCode: 1 });
      }, 60_000);
    });

    if (result.exitCode === 0) {
      log.info(`Successfully installed plugin: ${source}`);
      return { success: true };
    }

    const errorMsg = result.stderr || result.stdout || `Exit code ${result.exitCode}`;
    log.warn(`Failed to install plugin '${source}': ${errorMsg}`);
    return { success: false, error: errorMsg };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
