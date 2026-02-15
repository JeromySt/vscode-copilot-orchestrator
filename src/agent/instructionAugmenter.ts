/**
 * @fileoverview Instruction Augmenter — enriches agent instructions with skill context.
 *
 * Reads skill descriptions from .github/skills/ YAML frontmatter,
 * builds an augmentation prompt, and calls Copilot CLI to produce enriched
 * instructions for eligible {@link AgentSpec} nodes.
 *
 * @module agent/instructionAugmenter
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AgentSpec } from '../plan/types/specs';
import type { ICopilotRunner } from '../interfaces/ICopilotRunner';

// ============================================================================
// TYPES
// ============================================================================

/** Parsed skill metadata from YAML frontmatter. */
export interface SkillDescription {
  name: string;
  description: string;
}

/** A node eligible for instruction augmentation. */
export interface AugmentableNode {
  /** Unique node identifier. */
  id: string;
  /** The agent work spec whose instructions may be augmented. */
  work: AgentSpec;
}

/** Options for {@link augmentInstructions}. */
export interface AugmentInstructionsOptions {
  /** Nodes whose instructions should be considered for augmentation. */
  nodes: AugmentableNode[];
  /** Absolute path to the repository root. */
  repoPath: string;
  /** Copilot CLI runner for making augmentation calls. */
  runner: ICopilotRunner;
}

/** A single augmented instruction result from the CLI. */
export interface AugmentedResult {
  id: string;
  instructions: string;
}

// ============================================================================
// SKILL DISCOVERY
// ============================================================================

/**
 * Read skill descriptions from .github/skills/ subdirectories.
 *
 * Each skill folder should contain a SKILL.md with YAML frontmatter
 * delimited by --- containing at least name and description fields.
 *
 * @param repoPath - Absolute path to the repository root.
 * @returns Array of parsed skill descriptions (empty if none found).
 */
export function readSkillDescriptions(repoPath: string): SkillDescription[] {
  const skillsDir = path.join(repoPath, '.github', 'skills');
  if (!fs.existsSync(skillsDir)) {
    return [];
  }

  const skills: SkillDescription[] = [];

  let entries: string[];
  try {
    entries = fs.readdirSync(skillsDir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    const skillFile = path.join(skillsDir, entry, 'SKILL.md');
    if (!fs.existsSync(skillFile)) {
      continue;
    }

    try {
      const content = fs.readFileSync(skillFile, 'utf-8');
      const parsed = parseYamlFrontmatter(content);
      if (parsed.name && parsed.description) {
        skills.push({ name: parsed.name, description: parsed.description });
      }
    } catch {
      // Skip malformed skill files
    }
  }

  return skills;
}

/**
 * Parse YAML frontmatter from a Markdown file.
 * Splits on `---` delimiters and extracts key-value pairs.
 *
 * @internal Exported for testing.
 */
export function parseYamlFrontmatter(content: string): Record<string, string> {
  const result: Record<string, string> = {};

  const trimmed = content.trim();
  if (!trimmed.startsWith('---')) {
    return result;
  }

  const endIndex = trimmed.indexOf('---', 3);
  if (endIndex === -1) {
    return result;
  }

  const frontmatter = trimmed.substring(3, endIndex).trim();
  for (const line of frontmatter.split('\n')) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) {
      continue;
    }
    const key = line.substring(0, colonIndex).trim();
    let value = line.substring(colonIndex + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) {
      result[key] = value;
    }
  }

  return result;
}

// ============================================================================
// PROMPT BUILDING
// ============================================================================

/**
 * Build the augmentation prompt sent to Copilot CLI.
 * @internal Exported for testing.
 */
export function buildAugmentationPrompt(
  skills: SkillDescription[],
  nodes: AugmentableNode[],
): string {
  const skillsBlock = skills.length > 0
    ? skills.map(s => `- **${s.name}**: ${s.description}`).join('\n')
    : '(No project skills defined.)';

  const nodesBlock = nodes
    .map(n => `### Node "${n.id}"\n\`\`\`\n${n.work.instructions}\n\`\`\``)
    .join('\n\n');

  return `You are an instruction augmenter for a multi-agent orchestration system.
Your job is to enrich each agent's instructions by weaving in relevant skill descriptions
so the executing agent has full context about available project capabilities.

## Available Project Skills
${skillsBlock}

## Agent Tasks to Augment
${nodesBlock}

## Response Format
Respond with ONLY a JSON array. Each element must have "id" (matching the node id) and "instructions" (the enriched instructions). Do not include any other text.

Example:
[{"id": "node-1", "instructions": "Enriched instructions here..."}]`;
}

// ============================================================================
// OUTPUT PARSING
// ============================================================================

/**
 * Extract and parse a JSON array of {@link AugmentedResult} from CLI output.
 * @internal Exported for testing.
 */
export function parseAugmentedOutput(output: string): AugmentedResult[] {
  // Try to find a JSON array in the output
  const arrayStart = output.indexOf('[');
  const arrayEnd = output.lastIndexOf(']');
  if (arrayStart === -1 || arrayEnd === -1 || arrayEnd <= arrayStart) {
    return [];
  }

  try {
    const jsonStr = output.substring(arrayStart, arrayEnd + 1);
    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) {
      return [];
    }

    // Validate each element has id and instructions
    return parsed.filter(
      (item: unknown): item is AugmentedResult =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as any).id === 'string' &&
        typeof (item as any).instructions === 'string' &&
        (item as any).id.length > 0 &&
        (item as any).instructions.length > 0,
    );
  } catch {
    return [];
  }
}

// ============================================================================
// MAIN ENTRY POINT
// ============================================================================

/**
 * Augment agent instructions with project skill context.
 *
 * Filters eligible {@link AgentSpec} nodes (where `augmentInstructions !== false`),
 * reads skill descriptions from the repo, calls Copilot CLI to produce enriched
 * instructions, and applies the results in-place.
 *
 * **Anti-recursion**: If `process.env.ORCHESTRATOR_AUGMENTATION` is set, returns
 * immediately to prevent infinite loops when the augmenter's own CLI call triggers
 * re-entry.
 *
 * @param options - Augmentation options including nodes, repo path, and runner.
 */
export async function augmentInstructions(options: AugmentInstructionsOptions): Promise<void> {
  // Anti-recursion guard
  if (process.env.ORCHESTRATOR_AUGMENTATION) {
    return;
  }

  const { nodes, repoPath, runner } = options;

  // Filter eligible nodes
  const eligible = nodes.filter(n => n.work.augmentInstructions !== false);
  if (eligible.length === 0) {
    return;
  }

  // Read skill descriptions
  const skills = readSkillDescriptions(repoPath);

  // Build prompt
  const prompt = buildAugmentationPrompt(skills, eligible);

  // Collect CLI output
  const outputLines: string[] = [];

  // Set anti-recursion env var so child process won't re-augment
  const prevEnv = process.env.ORCHESTRATOR_AUGMENTATION;
  process.env.ORCHESTRATOR_AUGMENTATION = 'true';
  try {
    const result = await runner.run({
      cwd: repoPath,
      task: prompt,
      skipInstructionsFile: true,
      timeout: 30_000,
      maxTurns: 1,
      onOutput: (line) => outputLines.push(line),
    });

    if (!result.success) {
      return;
    }

    // Parse JSON from collected output
    const augmented = parseAugmentedOutput(outputLines.join('\n'));

    // Apply augmented instructions
    for (const aug of augmented) {
      const node = eligible.find(n => n.id === aug.id);
      if (node) {
        node.work.originalInstructions = node.work.instructions;
        node.work.instructions = aug.instructions;
      }
    }
  } finally {
    // Restore previous env state
    if (prevEnv === undefined) {
      delete process.env.ORCHESTRATOR_AUGMENTATION;
    } else {
      process.env.ORCHESTRATOR_AUGMENTATION = prevEnv;
    }
  }
}
