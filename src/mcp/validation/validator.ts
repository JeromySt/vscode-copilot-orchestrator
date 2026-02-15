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
import { getCachedModels } from '../../agent/modelDiscovery';

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

// ============================================================================
// SHARED HELPERS
// ============================================================================

/**
 * Try to parse a value as a JSON object if it's a string.
 * 
 * Work specs can arrive as either parsed objects or JSON-encoded strings,
 * depending on the MCP tool schema. This helper ensures validation always
 * sees the parsed object form.
 * 
 * @param value - The value to potentially parse
 * @returns The parsed object if it was a JSON string, otherwise the original value
 */
function tryParseWorkSpec(value: unknown): unknown {
  if (typeof value === 'string' && ((value.startsWith('{') && value.endsWith('}')) || (value.startsWith('[') && value.endsWith(']')))) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

// ============================================================================
// MODEL VALIDATION
// ============================================================================

/**
 * Recursively extract all model values from work specifications in input args.
 */
function extractModelValues(obj: any, path: string = ''): Array<{ value: string; path: string }> {
  const models: Array<{ value: string; path: string }> = [];
  
  if (!obj || typeof obj !== 'object') {
    return models;
  }
  
  // Check if current object is an agent work spec with a model
  if (obj.type === 'agent' && typeof obj.model === 'string') {
    models.push({ value: obj.model, path: path ? `${path}.model` : 'model' });
  }
  
  // Recursively search in arrays and objects
  for (const [key, value] of Object.entries(obj)) {
    const currentPath = path ? `${path}.${key}` : key;
    const parsed = tryParseWorkSpec(value);
    
    if (Array.isArray(parsed)) {
      for (let i = 0; i < parsed.length; i++) {
        const itemPath = `${currentPath}[${i}]`;
        models.push(...extractModelValues(parsed[i], itemPath));
      }
    } else if (parsed && typeof parsed === 'object') {
      models.push(...extractModelValues(parsed, currentPath));
    }
  }
  
  return models;
}

/**
 * Validate that all model names in agent work specifications are valid.
 * 
 * @param args - The MCP tool arguments to validate
 * @param toolName - The tool name for error formatting
 * @returns Validation result indicating success or failure with detailed error message
 */
export async function validateAgentModels(args: any, toolName: string): Promise<ValidationResult> {
  try {
    const modelReferences = extractModelValues(args);
    
    if (modelReferences.length === 0) {
      // No models to validate
      return { valid: true };
    }
    
    // Get available models
    const modelDiscovery = await getCachedModels();
    const validModelIds = modelDiscovery.models.map(m => m.id);
    
    if (validModelIds.length === 0) {
      return {
        valid: false,
        error: `Model validation failed: No models available from GitHub Copilot CLI. Please check your CLI installation and authentication.`,
      };
    }
    
    // Check each model reference
    const invalidModels: Array<{ value: string; path: string }> = [];
    
    for (const { value, path } of modelReferences) {
      if (!validModelIds.includes(value)) {
        invalidModels.push({ value, path });
      }
    }
    
    if (invalidModels.length > 0) {
      const errors = invalidModels.map(({ value, path }) => 
        `Invalid model '${value}' at field '${path}'`
      );
      
      return {
        valid: false,
        error: `Model validation failed for '${toolName}':\n- ${errors.join('\n- ')}\n\nValid models: ${validModelIds.join(', ')}`,
      };
    }
    
    return { valid: true };
  } catch (error: any) {
    return {
      valid: false,
      error: `Model validation error: ${error.message || 'Unknown error during model validation'}`,
    };
  }
}

/**
 * Validate that allowedUrls are well-formed HTTP/HTTPS URLs.
 * 
 * Security: Prevents non-HTTP schemes that could bypass security:
 * - file:// could access local filesystem
 * - javascript: could execute code
 * - data: could embed malicious content
 * 
 * Allowed formats:
 * - Full URL: https://api.example.com/v1/
 * - Domain only: api.example.com (implies HTTPS)
 * - With wildcards: *.example.com
 * 
 * @param input - The validated input object (after schema validation)
 * @param toolName - Tool name for error context
 * @returns Validation result with detailed errors for invalid URLs
 */
export async function validateAllowedUrls(
  input: unknown,
  toolName: string
): Promise<ValidationResult> {
  const errors: string[] = [];
  
  // Regex for valid URL patterns:
  // 1. Full HTTP/HTTPS URL
  // 2. Domain with optional wildcard prefix and optional path
  const VALID_URL_PATTERN = /^(https?:\/\/[^\s/$.?#][^\s]*|\*?\.?[a-zA-Z0-9][-a-zA-Z0-9]*(?:\.[a-zA-Z0-9][-a-zA-Z0-9]*)+(?:\/[^\s]*)?)$/;
  
  // Blocked schemes for security
  const BLOCKED_SCHEMES = ['file:', 'javascript:', 'data:', 'vbscript:', 'about:', 'blob:'];
  
  function checkUrls(urls: unknown, jsonPath: string): void {
    if (!Array.isArray(urls)) return;
    
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      if (typeof url !== 'string') continue;
      
      const fullPath = `${jsonPath}[${i}]`;
      const lowerUrl = url.toLowerCase();
      
      // Check for blocked schemes
      let blockedScheme = false;
      for (const scheme of BLOCKED_SCHEMES) {
        if (lowerUrl.startsWith(scheme)) {
          errors.push(
            `Blocked URL scheme at ${fullPath}: '${url}'. ` +
            `Only HTTP/HTTPS URLs are allowed. Blocked schemes: ${BLOCKED_SCHEMES.join(', ')}`
          );
          blockedScheme = true;
          break;
        }
      }
      if (blockedScheme) continue;
      
      // If it has a scheme, must be http or https
      if (url.includes('://')) {
        if (!lowerUrl.startsWith('http://') && !lowerUrl.startsWith('https://')) {
          errors.push(
            `Invalid URL scheme at ${fullPath}: '${url}'. ` +
            `Only http:// and https:// schemes are allowed.`
          );
          continue;
        }
        
        // Validate URL is parseable
        try {
          new URL(url);
        } catch {
          errors.push(
            `Malformed URL at ${fullPath}: '${url}'. ` +
            `URL must be a valid HTTP/HTTPS URL.`
          );
          continue;
        }
      } else {
        // Domain-only format: validate it looks like a domain
        // Allow: example.com, *.example.com, api.example.com/path
        if (!VALID_URL_PATTERN.test(url)) {
          errors.push(
            `Invalid URL format at ${fullPath}: '${url}'. ` +
            `Must be a valid HTTP/HTTPS URL or domain (e.g., 'api.example.com', '*.example.com').`
          );
        }
      }
    }
  }
  
  function traverseForUrls(obj: unknown, jsonPath: string): void {
    if (!obj || typeof obj !== 'object') return;
    const record = obj as Record<string, unknown>;
    
    // Check work specs for allowedUrls (parse JSON strings for security)
    const workFields = ['work', 'prechecks', 'postchecks', 'newWork', 'newPrechecks', 'newPostchecks'];
    for (const field of workFields) {
      const parsed = tryParseWorkSpec(record[field]);
      if (parsed && typeof parsed === 'object') {
        const spec = parsed as Record<string, unknown>;
        if (spec.type === 'agent' && spec.allowedUrls) {
          checkUrls(spec.allowedUrls, `${jsonPath}/${field}/allowedUrls`);
        }
      }
    }
    
    // Recurse into jobs, groups, nodes arrays
    if (Array.isArray(record.jobs)) {
      record.jobs.forEach((job, i) => traverseForUrls(job, `${jsonPath}/jobs/${i}`));
    }
    if (Array.isArray(record.groups)) {
      record.groups.forEach((group, i) => traverseForUrls(group, `${jsonPath}/groups/${i}`));
    }
    if (Array.isArray(record.nodes)) {
      record.nodes.forEach((node, i) => traverseForUrls(node, `${jsonPath}/nodes/${i}`));
    }
  }
  
  traverseForUrls(input, '');
  
  if (errors.length > 0) {
    return {
      valid: false,
      error: `URL validation failed for '${toolName}':\n- ${errors.join('\n- ')}`
    };
  }
  
  return { valid: true };
}

/**
 * Validate that allowedFolders are valid absolute paths that exist.
 * 
 * Security: Ensures agents only have access to valid, existing directories:
 * - All paths must be absolute
 * - All paths must exist on the filesystem
 * - Prevents directory traversal attempts
 * 
 * @param input - The validated input object (after schema validation)
 * @param toolName - Tool name for error context
 * @returns Validation result with detailed errors for invalid folders
 */
export async function validateAllowedFolders(
  input: unknown,
  toolName: string
): Promise<ValidationResult> {
  const errors: string[] = [];
  const fs = await import('fs/promises');
  const path = await import('path');
  
  async function checkFolders(folders: unknown, jsonPath: string): Promise<void> {
    if (!Array.isArray(folders)) return;
    
    for (let i = 0; i < folders.length; i++) {
      const folder = folders[i];
      if (typeof folder !== 'string') continue;
      
      const fullPath = `${jsonPath}[${i}]`;
      
      // Must be an absolute path
      if (!path.isAbsolute(folder)) {
        errors.push(
          `Folder path at ${fullPath} must be absolute: '${folder}'. ` +
          `Relative paths are not allowed for security reasons.`
        );
        continue;
      }
      
      // Check if the path exists
      try {
        const stat = await fs.stat(folder);
        if (!stat.isDirectory()) {
          errors.push(
            `Path at ${fullPath} is not a directory: '${folder}'. ` +
            `Only existing directories are allowed.`
          );
        }
      } catch {
        errors.push(
          `Folder path at ${fullPath} does not exist: '${folder}'. ` +
          `All allowed folders must exist on the filesystem.`
        );
      }
    }
  }
  
  async function traverseForFolders(obj: unknown, jsonPath: string): Promise<void> {
    if (!obj || typeof obj !== 'object') return;
    const record = obj as Record<string, unknown>;
    
    // Check work specs for allowedFolders (parse JSON strings for security)
    const workFields = ['work', 'prechecks', 'postchecks', 'newWork', 'newPrechecks', 'newPostchecks'];
    for (const field of workFields) {
      const parsed = tryParseWorkSpec(record[field]);
      if (parsed && typeof parsed === 'object') {
        const spec = parsed as Record<string, unknown>;
        if (spec.type === 'agent' && spec.allowedFolders) {
          await checkFolders(spec.allowedFolders, `${jsonPath}/${field}/allowedFolders`);
        }
      }
    }
    
    // Recurse into jobs, groups, nodes arrays
    if (Array.isArray(record.jobs)) {
      for (let i = 0; i < record.jobs.length; i++) {
        await traverseForFolders(record.jobs[i], `${jsonPath}/jobs/${i}`);
      }
    }
    if (Array.isArray(record.groups)) {
      for (let i = 0; i < record.groups.length; i++) {
        await traverseForFolders(record.groups[i], `${jsonPath}/groups/${i}`);
      }
    }
    if (Array.isArray(record.nodes)) {
      for (let i = 0; i < record.nodes.length; i++) {
        await traverseForFolders(record.nodes[i], `${jsonPath}/nodes/${i}`);
      }
    }
  }
  
  await traverseForFolders(input, '');
  
  if (errors.length > 0) {
    return {
      valid: false,
      error: `Folder validation failed for '${toolName}':\n- ${errors.join('\n- ')}`
    };
  }
  
  return { valid: true };
}
