# Job Detail Panel - UI Design

## Overview
An elegant, intuitive interface for viewing job execution details with work history and multiple execution attempts.

## Visual Layout

```
┌─────────────────────────────────────────────────────────┐
│ ← Back to Jobs                                          │
│                                                          │
│ Fix Login Bug                           [running]       │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                                          │
│ WORK HISTORY                                             │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ ● Latest                                            │ │
│ │   Fix the validation logic and update tests...      │ │
│ │                                                      │ │
│ │ ○ Iteration 1                                       │ │
│ │   Address the failing postchecks by improving...    │ │
│ │                                                      │ │
│ │ ○ Original                                          │ │
│ │   Fix the login bug where users can't login with... │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                          │
│ EXECUTION ATTEMPTS                                       │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ #3  ● ● ●  1/25/2026 3:45 PM  (45s)            ▼  │ │ ◄─ Active attempt (blue border)
│ ├─────────────────────────────────────────────────────┤ │
│ │ Status: running                                     │ │
│ │ Attempt ID: a7f3c1d9...                             │ │
│ │ Session: b2e4f8a1... 📋                             │ │ ◄─ Click to copy
│ │ Work: Fix the validation logic and update tests...  │ │
│ │                                                      │ │
│ │ [Full Log] [Prechecks] [Work] [Postchecks]          │ │ ◄─ Tab navigation
│ │ ┌─────────────────────────────────────────────────┐ │ │
│ │ │ [orchestrator] Starting work step...            │ │ │
│ │ │ [copilot] Analyzing codebase...                 │ │ │
│ │ │ [copilot] Reading src/auth.ts...                │ │ │ ◄─ Log viewer (auto-scrolls)
│ │ │ [copilot] Creating fix...                       │ │ │
│ │ └─────────────────────────────────────────────────┘ │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                          │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ #2  ● ● ○  1/25/2026 3:42 PM  (38s)            ▼  │ │ ◄─ Collapsed (click to expand)
│ └─────────────────────────────────────────────────────┘ │
│                                                          │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ #1  ● ✗ ○  1/25/2026 3:40 PM  (35s)            ▼  │ │
│ └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

## Key Features

### 1. **Work History Timeline** (only shows if 2+ iterations)
- Visual timeline with connected dots
- Latest work highlighted with active state (blue)
- Previous iterations shown in chronological order
- Compact preview (120 chars) of each work instruction
- Labels: "Latest", "Iteration N", "Original"

### 2. **Execution Attempts** (expandable cards)
- Latest attempt auto-expands on load
- Each attempt shows:
  - **Badge**: #1, #2, #3 (sequential numbering)
  - **Step indicators**: 3 colored dots (●) for prechecks/work/postchecks
    - Green ● = success
    - Red ● = failed
    - Gray ● = skipped/pending
  - **Timestamp**: Human-readable date/time
  - **Duration**: e.g., "45s" or "running..."
  - **Chevron**: ▼ rotates when expanded

### 3. **Attempt Details** (expanded view)
- **Metadata grid**: Status, Attempt ID, Session ID, Work instruction
- **Clickable Session ID**: Click to copy full ID to clipboard
- **Log tabs**: Switch between Full/Prechecks/Work/Postchecks
- **Log viewer**: Terminal-style with auto-scroll
- **Lazy loading**: Logs only load when attempt is expanded

### 4. **Visual Hierarchy**
- Active attempt has blue border highlight
- Status colors match VS Code theme:
  - Running: Blue (progressBar)
  - Succeeded: Green (testing.iconPassed)
  - Failed: Red (errorForeground)
  - Canceled/Queued: Gray (descriptionForeground)

### 5. **Interaction Patterns**
- **Click attempt header**: Toggle expand/collapse
- **Click log tab**: Switch log section view
- **Click session ID**: Copy to clipboard
- **Click back button**: Return to job list
- **Hover states**: All interactive elements have hover feedback

## UX Principles Applied

1. **Progressive Disclosure**: Latest attempt shown by default, older attempts collapsed
2. **Visual Scanning**: Color-coded status indicators for instant comprehension
3. **Contextual Information**: Tooltips on step indicators show status
4. **Smooth Animations**: Chevron rotation, hover states for delightful feel
5. **Information Density**: Compact yet readable, no wasted space
6. **Accessibility**: Semantic HTML, proper contrast, keyboard navigation ready

## Theme Integration

Uses VS Code CSS variables for perfect theme matching:
- `--vscode-foreground`, `--vscode-background`
- `--vscode-panel-border`, `--vscode-list-hoverBackground`
- `--vscode-progressBar-background` (blue accent)
- `--vscode-errorForeground` (red), `--vscode-testing-iconPassed` (green)
- `--vscode-terminal-background`, `--vscode-terminal-foreground`

## Technical Implementation

- **Collapsible sections**: CSS-based with expanded/collapsed classes
- **Log loading**: On-demand via postMessage to extension
- **Section filtering**: Server-side parsing of log markers
- **Auto-scroll**: Latest logs always visible
- **State management**: currentJob stored in closure for tab switching
