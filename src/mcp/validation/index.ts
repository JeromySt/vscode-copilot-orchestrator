/**
 * @fileoverview MCP Input Validation Module
 * 
 * Provides JSON Schema validation for all MCP tool inputs.
 * All input is treated as potentially malicious.
 * 
 * @module mcp/validation
 */

export { validateInput, hasSchema, getRegisteredTools, ValidationResult, validateAgentModels, validateAllowedUrls, validateAllowedFolders, validatePostchecksPresence } from './validator';
export { schemas } from './schemas';
