"use strict";
/**
 * @fileoverview Work Specification Types
 *
 * Defines the types for specifying what work a job node should execute:
 * direct process spawning, shell commands, or AI agent delegation.
 *
 * @module plan/types/specs
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeWorkSpec = normalizeWorkSpec;
/**
 * Normalize a {@link WorkSpec} to its structured form.
 *
 * Handles backwards compatibility with the legacy string format:
 * - Strings starting with `@agent` become an {@link AgentSpec}.
 * - Other strings become a {@link ShellSpec}.
 * - Structured specs pass through unchanged.
 *
 * @param spec - The work spec to normalize, or `undefined`.
 * @returns The structured spec, or `undefined` if input was `undefined`.
 *
 * @example
 * ```typescript
 * normalizeWorkSpec('npm test');           // → { type: 'shell', command: 'npm test' }
 * normalizeWorkSpec('@agent fix the bug'); // → { type: 'agent', instructions: 'fix the bug' }
 * normalizeWorkSpec(undefined);            // → undefined
 * ```
 */
function normalizeWorkSpec(spec) {
    if (spec === undefined) {
        return undefined;
    }
    if (typeof spec === 'string') {
        // Legacy string format
        if (spec.startsWith('@agent')) {
            const instructions = spec.replace(/^@agent\s*/i, '').trim();
            return {
                type: 'agent',
                instructions: instructions || 'Complete the task as specified',
            };
        }
        // Default to shell command
        return {
            type: 'shell',
            command: spec,
        };
    }
    return spec;
}
