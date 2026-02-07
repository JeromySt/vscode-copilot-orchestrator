# Groups in Copilot Orchestrator

Groups provide **visual hierarchy** and **namespace isolation** for organizing jobs in a Plan. They have no impact on execution order - only jobs have dependencies.

## Key Concepts

### Groups Are Visual Only
- Groups render as nested boxes in the Mermaid diagram
- Each group shows aggregate status (all succeeded = green, any running = blue, etc.)
- Groups do NOT have dependencies - jobs describe the full dependency graph

### Namespace Isolation
- Producer IDs only need to be unique within their group
- Same `producer_id` can exist in different groups
- Groups form hierarchical paths: `phase1/collection/count-files`

### Dependency Resolution
| Dependency Format | Resolution |
|-------------------|------------|
| `"sibling-job"` (no `/`) | Qualified with current group: `mygroup/sibling-job` |
| `"other-group/job"` | Used as-is |
| `"phase1/analysis/done"` | Used as-is (fully qualified) |

## Example

```json
{
  "name": "Multi-Phase Build",
  "jobs": [],
  "groups": [
    {
      "name": "phase1",
      "groups": [
        {
          "name": "collection",
          "jobs": [
            {
              "producer_id": "count-files",
              "task": "Count all source files",
              "dependencies": [],
              "work": "(Get-ChildItem -Recurse -File).Count"
            },
            {
              "producer_id": "count-dirs",
              "task": "Count all directories",
              "dependencies": [],
              "work": "(Get-ChildItem -Recurse -Directory).Count"
            }
          ]
        },
        {
          "name": "analysis",
          "jobs": [
            {
              "producer_id": "analyze-structure",
              "task": "Analyze code structure",
              "dependencies": [
                "collection/count-files",
                "collection/count-dirs"
              ],
              "work": "Write-Output 'Analysis complete'"
            }
          ]
        }
      ]
    },
    {
      "name": "phase2",
      "groups": [
        {
          "name": "reporting",
          "jobs": [
            {
              "producer_id": "generate-report",
              "task": "Generate final report",
              "dependencies": [
                "phase1/analysis/analyze-structure"
              ],
              "work": "Write-Output 'Report generated'"
            }
          ]
        }
      ]
    }
  ]
}
```

## Resulting DAG

The above flattens to these jobs with qualified producer IDs:

| Qualified Producer ID | Group Path | Dependencies |
|-----------------------|------------|--------------|
| `phase1/collection/count-files` | `phase1/collection` | (none) |
| `phase1/collection/count-dirs` | `phase1/collection` | (none) |
| `phase1/analysis/analyze-structure` | `phase1/analysis` | `phase1/collection/count-files`, `phase1/collection/count-dirs` |
| `phase2/reporting/generate-report` | `phase2/reporting` | `phase1/analysis/analyze-structure` |

## Visual Rendering

Groups render as nested Mermaid subgraphs:

```
📦 phase1
  📦 collection
    ✓ count-files | 2s
    ✓ count-dirs | 1s
  📦 analysis
    ✓ analyze-structure | 3s
📦 phase2
  📦 reporting
    ⏳ generate-report
```

Each group box shows status-based styling:
- **Pending** (gray dashed border): No jobs started
- **Running** (blue border): At least one job running
- **Succeeded** (green border): All jobs succeeded  
- **Failed** (red border): Any job failed
- **Partial** (amber border): Mix of succeeded and failed

## Best Practices

1. **Use groups for logical organization**: Phases, components, feature areas
2. **Keep producer_ids short**: The full path provides context
3. **Use explicit cross-group dependencies**: Always use qualified paths for clarity
4. **Group root jobs start immediately**: Jobs with `dependencies: []` run when the plan starts

## Common Patterns

### Sequential Phases
```json
{
  "groups": [
    { "name": "build", "jobs": [...] },
    { "name": "test", "jobs": [{ "dependencies": ["build/compile"] }] },
    { "name": "deploy", "jobs": [{ "dependencies": ["test/run-tests"] }] }
  ]
}
```

### Parallel Components with Converging Finish
```json
{
  "groups": [
    { "name": "backend", "jobs": [{ "producer_id": "build", "dependencies": [] }] },
    { "name": "frontend", "jobs": [{ "producer_id": "build", "dependencies": [] }] },
    { "name": "integration", "jobs": [{ 
      "producer_id": "test", 
      "dependencies": ["backend/build", "frontend/build"] 
    }] }
  ]
}
```

### Deeply Nested Hierarchy
```json
{
  "groups": [{
    "name": "services",
    "groups": [
      { "name": "auth", "groups": [{ "name": "oauth", "jobs": [...] }] },
      { "name": "payments", "groups": [{ "name": "stripe", "jobs": [...] }] }
    ]
  }]
}
```

Jobs in `services/auth/oauth/validate` can reference `../payments/stripe/init` as:
`services/payments/stripe/init` (always from root)
