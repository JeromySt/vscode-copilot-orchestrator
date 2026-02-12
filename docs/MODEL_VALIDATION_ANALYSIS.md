# Model Validation Analysis

## Current Architecture

### Schema Validation Flow
1. **Schema Compilation (Sync)** - `src/mcp/validation/validator.ts:38-48`
   - Schemas are compiled with Ajv at module load time
   - All schemas in `schemas.ts` are processed synchronously when validator module is imported
   - Compiled validators are cached in a Map for runtime use

2. **Model Schema Definition** - `src/mcp/validation/schemas.ts:108`
   - `workSpecObjectSchema.model` only has basic string validation: `{ type: 'string', maxLength: 100 }`
   - No enum validation against discovered models
   - Schema is static and cannot include dynamic model list

3. **Model Discovery (Async)** - `src/agent/modelDiscovery.ts:109`
   - `discoverAvailableModels()` runs `copilot --help` to parse available models
   - Results are cached with 1-hour TTL
   - Discovery is async and happens independently of schema compilation

4. **Tool Definition Generation** - `src/mcp/tools/planTools.ts:52-56`
   - `getPlanToolDefinitions()` calls `discoverAvailableModels()` 
   - Tool descriptions include discovered model enum in text: `Available models: ${modelEnum.join(', ')}`
   - But this is only descriptive - not enforced by schema validation

## The Gap

**Timing Mismatch**: Schemas are compiled synchronously at import time, but model discovery is async and happens later.

**Result**: The `workSpecObjectSchema.model` field cannot include an enum of valid models because:
1. Schema compilation happens before model discovery completes
2. Ajv schemas are compiled once and cached - they can't be dynamically updated
3. Model discovery may fail, leaving no fallback validation

## Current Behavior
- Any string ≤100 chars passes model validation in the schema
- Invalid model names are only caught later during execution
- Error occurs during job execution rather than at input validation time
- Poor user experience - late failure with less helpful error context

## Solution Options

### Option A: Make Schema Compilation Async
**Approach**: Delay schema compilation until after model discovery
- Modify validator.ts to export async `getValidator()` function
- Modify MCP server to await model discovery before compiling schemas
- Include dynamic model enum in workSpecObjectSchema

**Pros**: 
- True schema validation with correct model enum
- Single validation layer

**Cons**:
- Major architectural change - affects module loading
- All MCP tool handling becomes async
- Complexity in error handling if model discovery fails

### Option B: Post-Schema Validation Layer (RECOMMENDED)
**Approach**: Add model-specific validation after schema passes
- Keep existing sync schema compilation unchanged
- Add `validateModelField(modelId: string)` function in validator.ts
- Call this during MCP input processing after schema validation passes
- Use cached model discovery results with graceful fallback

**Pros**:
- Minimal changes to existing architecture  
- Better error messages with dynamic context
- Graceful degradation if model discovery fails
- Can validate other dynamic fields in future

**Cons**:
- Two-layer validation (schema + business rules)
- Slightly more complex validation flow

### Option C: Dynamic Schema Re-compilation
**Approach**: Re-compile schemas when model discovery completes
- Keep initial sync compilation with basic string validation
- Add `updateModelSchema()` function to re-compile with discovered models
- Cache multiple schema versions

**Pros**:
- Eventually achieves true schema validation
- Maintains sync initialization

**Cons**:
- Complex caching and versioning logic
- Race conditions between validation and re-compilation
- Still needs fallback for discovery failures

## Recommendation: Option B (Post-Schema Validation)

**Rationale**:
1. **Minimal Impact**: Doesn't require re-architecting module loading or async patterns
2. **Better UX**: Can provide context-aware error messages like "Model 'gpt-7' not found. Available: gpt-5, claude-sonnet-4.5"  
3. **Robust**: Graceful fallback if model discovery is unavailable
4. **Extensible**: Pattern can be reused for other dynamic validations
5. **Safe**: Preserves existing working validation for all other fields

## Implementation Plan

1. **Add model validation function** in `validator.ts`:
   ```typescript
   export async function validateModelField(modelId: string): Promise<ValidationResult>
   ```

2. **Integrate in MCP handlers** - call after schema validation:
   ```typescript
   const schemaResult = validateInput(toolName, input);
   if (!schemaResult.valid) return schemaResult;
   
   if (hasModelField(input)) {
     const modelResult = await validateModelField(input.work.model);
     if (!modelResult.valid) return modelResult;
   }
   ```

3. **Graceful degradation**: If model discovery fails, validate against fallback list or skip validation with warning

This approach maintains the existing proven architecture while adding targeted validation where needed.