# Duration Formatting Unit Test - Quick Reference

## File Location
```
src/test/unit/ui/planDetailPanelDuration.unit.test.ts
```

## What's Tested
The `formatDurationMs()` function from `src/ui/templates/helpers.ts` that converts milliseconds to human-readable duration strings.

## Test Execution

### Run all duration tests:
```bash
npx mocha out/test/unit/ui/planDetailPanelDuration.unit.test.js --reporter spec
```

### Run after compilation:
```bash
npm run compile:tsc  # Compiles TypeScript
npx mocha out/test/unit/ui/planDetailPanelDuration.unit.test.js --reporter spec
```

### With npm test suite:
```bash
npm test -- --grep "planDetailPanelDuration"
```

## Test Breakdown

### Test Suite Structure (6 categories, 24 tests total)

| Category | Tests | Examples |
|----------|-------|----------|
| Sub-second durations | 2 | `"< 1s"` for 0-999ms |
| Seconds only | 3 | `"45s"`, `"1s"`, `"59s"` |
| Minutes and seconds | 5 | `"2m 30s"`, `"1m 0s"` |
| Hours and minutes | 5 | `"5h 17m"`, `"1h 1m"` (no seconds) |
| Edge cases | 4 | Boundary testing, large values |
| Real-world scenarios | 5 | Typical plan execution times |

## Function Behavior Reference

### Input/Output Examples
```
0ms              → "< 1s"
1ms              → "< 1s"
500ms            → "< 1s"
999ms            → "< 1s"
1000ms           → "1s"
45000ms          → "45s"
60000ms          → "1m 0s"
150000ms         → "2m 30s"
3600000ms        → "1h 0m"
19020000ms       → "5h 17m"
```

### Format Rules
1. **< 1 second:** Always shows "< 1s" for durations < 1000ms
2. **Seconds:** Shows seconds alone for 1-59 seconds
3. **Minutes:** Shows minutes and seconds for 1-59 minutes (format: "Nm Ss")
4. **Hours:** Shows hours and minutes only (NO seconds) for durations >= 1 hour (format: "Nh Nm")

## Key Test Insights

✅ All 24 tests pass  
✅ Pure function - no mocks needed  
✅ Follows Mocha TDD pattern  
✅ Uses Node.js assert module  
✅ TypeScript compilation successful  

## Common Use Cases in Tests

### Testing sub-1-second durations
```typescript
assert.strictEqual(formatDurationMs(234), '< 1s');
assert.strictEqual(formatDurationMs(999), '< 1s');
```

### Testing seconds-only durations
```typescript
assert.strictEqual(formatDurationMs(45000), '45s');
assert.strictEqual(formatDurationMs(5000), '5s');
```

### Testing minutes with seconds
```typescript
assert.strictEqual(formatDurationMs(150000), '2m 30s');  // 2.5 minutes
assert.strictEqual(formatDurationMs(125000), '2m 5s');   // 2 min 5 sec
```

### Testing hours (note: seconds omitted)
```typescript
assert.strictEqual(formatDurationMs(19020000), '5h 17m');  // 5h 17m format
assert.strictEqual(formatDurationMs(3600000), '1h 0m');    // 1 hour
```

## Design Notes

- The function is used in the plan detail panel for real-time elapsed time display
- Duration updates occur via 1-second refresh interval in the tree provider
- The function automatically truncates seconds when displaying hours for cleaner UI
- No dependencies to mock - pure function takes milliseconds and returns string
