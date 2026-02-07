/**
 * @fileoverview MCP Input Validator using Ajv
 * 
 * Provides strict JSON Schema validation for all MCP tool inputs.
 * All input is treated as potentially malicious and validated before processing.
 * 
 * @module mcp/validation/validator
 */

import Ajv, { ErrorObject, ValidateFunction } from 'ajv';
import { schemas } from './schemas';

// ============================================================================
// VALIDATOR SINGLETON
// ============================================================================

/**
 * Singleton Ajv instance configured for strict validation.
 * 
 * Configuration:
 * - allErrors: true - Collect all errors, not just the first
 * - strict: true - Enforce strict mode
 * - allowUnionTypes: true - Allow oneOf/anyOf for work specs
 * - removeAdditional: false - Don't silently remove unknown properties
 * - useDefaults: false - Don't modify input with defaults
 * - coerceTypes: false - Don't coerce types
 */
const ajv = new Ajv({
  allErrors: true,
  strict: true,
  allowUnionTypes: true,
  removeAdditional: false,
  useDefaults: false,
  coerceTypes: false,
  verbose: true,
});

// Compile all schemas
const validators: Map<string, ValidateFunction> = new Map();

for (const [toolName, schema] of Object.entries(schemas)) {
  try {
    const validate = ajv.compile(schema);
    validators.set(toolName, validate);
  } catch (error) {
    console.error(`Failed to compile schema for ${toolName}:`, error);
  }
}

// ============================================================================
// VALIDATION RESULT
// ============================================================================

/**
 * Result of schema validation
 */
export interface ValidationResult {
  /** Whether the input is valid */
  valid: boolean;
  /** Formatted error message if invalid */
  error?: string;
  /** Raw Ajv errors for debugging */
  errors?: ErrorObject[];
}

// ============================================================================
// ERROR FORMATTING
// ============================================================================

/**
 * Format Ajv errors into a human-readable message for LLM consumption.
 * 
 * Provides clear, actionable error messages that help the LLM understand
 * what went wrong and how to fix it.
 */
function formatErrors(errors: ErrorObject[] | null | undefined, toolName: string): string {
  if (!errors || errors.length === 0) {
    return 'Validation failed (no details available)';
  }

  const messages: string[] = [];
  const seenPaths = new Set<string>();

  for (const err of errors) {
    const path = err.instancePath || '/';
    
    // Deduplicate errors for the same path
    const key = `${path}:${err.keyword}`;
    if (seenPaths.has(key)) continue;
    seenPaths.add(key);

    // Format based on error keyword
    switch (err.keyword) {
      case 'required': {
        const field = (err.params as any).missingProperty;
        messages.push(`Missing required field '${field}' at ${path || 'root'}`);
        break;
      }
      case 'additionalProperties': {
        const prop = (err.params as any).additionalProperty;
        messages.push(
          `Unknown property '${prop}' at ${path || 'root'}. ` +
          `This property is not allowed. Check the schema for valid properties.`
        );
        break;
      }
      case 'type': {
        const expected = (err.params as any).type;
        messages.push(`Expected ${expected} at ${path}, got ${typeof err.data}`);
        break;
      }
      case 'pattern': {
        messages.push(
          `Invalid format at ${path}: '${err.data}'. ` +
          `Must match pattern: ${(err.params as any).pattern}`
        );
        break;
      }
      case 'enum': {
        const allowed = (err.params as any).allowedValues?.join(', ') || 'unknown';
        messages.push(`Invalid value at ${path}: '${err.data}'. Allowed: ${allowed}`);
        break;
      }
      case 'minLength':
        messages.push(`Value at ${path} is too short (min ${(err.params as any).limit} chars)`);
        break;
      case 'maxLength':
        messages.push(`Value at ${path} is too long (max ${(err.params as any).limit} chars)`);
        break;
      case 'minimum':
        messages.push(`Value at ${path} is too small (min ${(err.params as any).limit})`);
        break;
      case 'maximum':
        messages.push(`Value at ${path} is too large (max ${(err.params as any).limit})`);
        break;
      case 'maxItems':
        messages.push(`Array at ${path} has too many items (max ${(err.params as any).limit})`);
        break;
      case 'minItems':
        messages.push(`Array at ${path} has too few items (min ${(err.params as any).limit})`);
        break;
      case 'oneOf':
        messages.push(
          `Invalid value at ${path}: must match exactly one of the allowed formats. ` +
          `For 'work' field: use either a string command or an object with 'type' field.`
        );
        break;
      default:
        messages.push(`${err.keyword} error at ${path}: ${err.message}`);
    }
  }

  // Cap at 5 errors to avoid overwhelming the LLM
  const displayed = messages.slice(0, 5);
  const remaining = messages.length - displayed.length;
  
  let result = `Input validation failed for '${toolName}':\n- ${displayed.join('\n- ')}`;
  if (remaining > 0) {
    result += `\n... and ${remaining} more error(s)`;
  }
  
  return result;
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Validate MCP tool input against its JSON schema.
 * 
 * @param toolName - The MCP tool name (e.g., 'create_copilot_plan')
 * @param input - The raw input to validate
 * @returns Validation result with formatted error message if invalid
 * 
 * @example
 * ```ts
 * const result = validateInput('create_copilot_plan', args);
 * if (!result.valid) {
 *   return errorResult(result.error);
 * }
 * ```
 */
export function validateInput(toolName: string, input: unknown): ValidationResult {
  const validate = validators.get(toolName);
  
  if (!validate) {
    // No schema for this tool - skip validation
    // This allows tools without schemas to still work
    return { valid: true };
  }

  // Validate against schema
  const valid = validate(input);
  
  if (valid) {
    return { valid: true };
  }

  return {
    valid: false,
    error: formatErrors(validate.errors, toolName),
    errors: validate.errors || undefined,
  };
}

/**
 * Check if a tool has a registered schema for validation.
 * 
 * @param toolName - The MCP tool name
 * @returns true if the tool has a schema
 */
export function hasSchema(toolName: string): boolean {
  return validators.has(toolName);
}

/**
 * Get list of all tools with registered schemas.
 */
export function getRegisteredTools(): string[] {
  return [...validators.keys()];
}
