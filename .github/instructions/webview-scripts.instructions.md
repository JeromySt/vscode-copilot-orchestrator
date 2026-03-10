---
applyTo: "src/ui/**"
---

# Webview Script Architecture

## Rule: NEVER put JavaScript logic inside template literals

All webview JavaScript **must** live in proper `.ts` files under `src/ui/webview/`, compiled by esbuild as browser-target IIFE bundles. Template literal `<script>` blocks caused persistent escaping bugs (regex literals, backslashes, and special characters are mangled by esbuild when embedded in template strings).

### Allowed in `scriptsTemplate.ts` files

Only **data injection** — serializing server-side data into the page:

```typescript
export function renderFooScripts(data: FooData, nonce: string): string {
  return `<script nonce="${nonce}">
    window.Orca.initFooPanel({ data: ${safeJson(data)} });
  </script>`;
}
```

### NOT allowed in `scriptsTemplate.ts` or any template literal

- ❌ Class definitions
- ❌ Function definitions (beyond the single init call)
- ❌ Regex literals (`/pattern/g`)
- ❌ Event listeners or DOM manipulation
- ❌ Control logic, loops, conditionals  
- ❌ `String.fromCharCode()` workarounds for escaping

### Where logic goes instead

| What | Where |
|------|-------|
| Panel-specific classes and functions | `src/ui/webview/<panelName>Panel.ts` |
| Reusable UI controls | `src/ui/webview/controls/<controlName>.ts` |
| Entry point that exports to `window.Orca` | `src/ui/webview/entries/<bundle>.ts` |
| Bundled output loaded via `<script src>` | `dist/webview/<bundle>.js` |

### Pattern for new panels

1. Create `src/ui/webview/<panelName>Panel.ts` with an `export function init<PanelName>Panel(config)` entry point
2. Import and re-export it from `src/ui/webview/entries/<bundle>.ts` into the `Orca` namespace
3. Add the entry point to `esbuild.js` webview entryPoints if it's a new bundle
4. The `scriptsTemplate.ts` only calls `window.Orca.init<PanelName>Panel({ ... })` with serialized JSON

### Why this matters

Template literals in TypeScript are processed by esbuild, which:
- Strips backslashes from regex literals (`\[` → `[`, `\/` → `/`)
- Converts escape sequences (`\n`, `\t`) prematurely
- Can break `</script>` detection in nested strings

Proper `.ts` files are compiled as real JavaScript — regex, escapes, and all syntax work correctly.

### Reference implementation

- **Correct**: `src/ui/webview/releasePanel.ts` + `src/ui/templates/release/scriptsTemplate.ts` (data-only)
- **Needs migration**: `src/ui/templates/plansView/scriptsTemplate.ts` (~1200 lines inline)
- **Needs migration**: `src/ui/templates/activePR/scriptsTemplate.ts` (~100 lines inline)

### Existing panels that follow the pattern

- `nodeDetail` — modular sub-templates under `src/ui/templates/nodeDetail/scripts/`
- `planDetail` — modular sub-templates under `src/ui/templates/planDetail/scripts/`
- `release` — fully extracted to `src/ui/webview/releasePanel.ts`
