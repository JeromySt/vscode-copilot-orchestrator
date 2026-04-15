---
applyTo: "src/mcp/**"
---

# MCP Tool Registration Checklist

When adding a new MCP tool to the orchestrator, ALL of the following must be completed
or the tool will silently fail to appear in the MCP server's tool listing.

## Required Files (4 touchpoints)

### 1. Handler — `src/mcp/handlers/plan/<toolName>Handler.ts`

Create the handler function:

```typescript
import { PlanHandlerContext, lookupPlan } from '../utils';

export async function handleMyNewTool(args: any, ctx: PlanHandlerContext): Promise<any> {
  const { planId, ...rest } = args;
  const plan = await lookupPlan(ctx, planId);
  // ... implementation ...
  return { success: true, /* results */ };
}
```

**Key patterns:**
- `lookupPlan(ctx, planId)` — argument order is `(ctx, planId)`, NOT `(planId, ctx)`
- Plan jobs are accessed via `plan.jobs` (Map<string, PlanJob>), NOT `plan.nodes`
- Node specs are written via `ctx.PlanRepository.writeNodeSpec(planId, nodeId, spec)`
- Export the handler from `src/mcp/handlers/plan/index.ts`

### 2. Tool Definition — `src/mcp/tools/jobTools.ts` (or `planTools.ts`)

Add the tool definition INSIDE the returned array of `getJobToolDefinitions()` or
`getPlanToolDefinitions()`:

```typescript
{
  name: 'my_new_copilot_tool',
  description: 'What it does. Include usage guidance.',
  inputSchema: {
    type: 'object',
    properties: {
      planId: { type: 'string', description: 'The plan ID' },
      // ... other properties
    },
    required: ['planId']
  }
}
```

**The tool definition MUST be inside the `return [...]` array.** If it's defined
outside the array, it won't be included in the MCP server's tool listing.

### 3. Handler Switch — `src/mcp/handler.ts`

Two changes required:

**a) Import the handler:**
```typescript
import { handleMyNewTool } from './handlers/plan/myNewToolHandler';
```
(Or add to the existing destructured import from `'./handlers/plan'`)

**b) Add the case to the switch:**
```typescript
case 'my_new_copilot_tool':
  result = await handleMyNewTool(args || {}, this.context);
  break;
```

### 4. Validation Schema — `src/mcp/validation/schemas.ts`

**THIS IS THE STEP MOST LIKELY TO BE FORGOTTEN OR BREAK SILENTLY.**

Two changes required:

**a) Define the schema:**
```typescript
export const myNewToolSchema = {
  $id: 'my_new_copilot_tool',
  type: 'object',
  properties: {
    planId: { type: 'string', minLength: 1, maxLength: 100 },
    // ... mirror the inputSchema from step 2
  },
  required: ['planId'],
  additionalProperties: false
} as const;
```

**b) Register in the `schemas` object (bottom of file):**
```typescript
export const schemas: Record<string, any> = {
  // ... existing entries ...
  my_new_copilot_tool: myNewToolSchema,
};
```

## Critical Gotchas

### Tool List Caching (THE #1 GOTCHA)

VS Code's MCP client caches the tool list from `tools/list`. If the server's
`initialize` response declares `capabilities: { tools: {} }` (without `listChanged`),
VS Code will **never re-query the tool list** — even across window reloads.

The fix is in `src/mcp/handler.ts` — the `handleInitialize` method MUST return:
```typescript
capabilities: { tools: { listChanged: true } }
```

Without this, adding a new tool definition to `getJobToolDefinitions()` will compile
and bundle correctly but the tool will **never appear** in Copilot's tool list because
VS Code uses the cached list from before the tool existed.

### Ajv Strict Mode Restrictions

The validator uses Ajv with `strict: true`. These keywords will cause **silent
compilation failure** — the schema won't register, and the tool won't appear:

| Forbidden | Use Instead |
|-----------|-------------|
| `nullable: true` | Remove it — make the field optional by omitting from `required` |
| `{ type: 'string', nullable: true }` | `{ type: 'string' }` (just don't require it) |
| `$id` in schema | Remove it — Ajv strict mode rejects `$id` as unknown keyword. Other schemas have it but it may depend on Ajv version. |
| `patternProperties` | Use `additionalProperties` with a type |
| Custom keywords | Not supported in strict mode |

**If the schema fails to compile**, Ajv logs `Failed to compile schema for <tool>`
to console but does NOT throw — the tool silently disappears from the listing.

### Validation is Optional

The handler switch (`src/mcp/handler.ts`) uses `if (hasSchema(name))` before
validating. A missing schema does NOT block the tool — it just skips validation.
However, the schema failing to compile DOES remove the tool from `getRegisteredTools()`,
which may affect other systems that check registered tools.

### Re-export from Index

The handler must be re-exported from `src/mcp/handlers/plan/index.ts`:
```typescript
export { handleMyNewTool } from './myNewToolHandler';
```

## Testing the Registration

After all 4 files are modified:

1. `npm run compile` — must pass with zero errors
2. `npm run local-install` — package and install the extension
3. **Reload VS Code** (`Developer: Reload Window`)
4. In Copilot chat, the tool should appear in tool search
5. If it doesn't appear, check the extension host console for `Failed to compile schema`

## File Summary

| Step | File | What |
|------|------|------|
| 1 | `src/mcp/handlers/plan/<name>Handler.ts` | Handler implementation |
| 1b | `src/mcp/handlers/plan/index.ts` | Re-export handler |
| 2 | `src/mcp/tools/jobTools.ts` | Tool definition (name, description, inputSchema) |
| 3 | `src/mcp/handler.ts` | Import + switch case routing |
| 4 | `src/mcp/validation/schemas.ts` | Ajv schema definition + registry entry |
| 5 | Reload VS Code | Required for MCP server to pick up new tool |
