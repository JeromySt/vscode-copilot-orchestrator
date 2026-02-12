# Security Validation Gap Analysis

## Overview

This document analyzes security gaps in the current validation logic for `allowedFolders` and `allowedUrls` fields in the Copilot Orchestrator work specifications. While these fields have basic schema validation, they lack critical security validations that could lead to security vulnerabilities and operational issues.

## Current Validation State

### Schema-Only Validation (`src/mcp/validation/schemas.ts`)

The `workSpecObjectSchema` currently provides basic structural validation:

```typescript
allowedFolders: {
  type: 'array',
  items: { type: 'string', maxLength: 500 },
  maxItems: 20
},
allowedUrls: {
  type: 'array', 
  items: { type: 'string', maxLength: 500 },
  maxItems: 50,
  description: 'URLs or URL patterns the agent is allowed to access. Default: none (no network access).'
}
```

**What is currently validated:**
- Data types (arrays of strings)
- String length limits (500 characters)
- Array size limits (20 folders, 50 URLs)

## Security Gaps Identified

### 1. allowedFolders - Path Existence and Security

**Current Behavior:**
- Schema accepts any string as a valid folder path
- `CopilotCliRunner.buildCommand()` performs runtime validation:
  - Requires absolute paths (`path.isAbsolute()`)
  - Checks path existence (`fs.existsSync()`)
  - Logs warnings for invalid paths but continues execution

**Security Risks:**

1. **Typo Tolerance Risk**: Invalid paths due to typos are silently ignored, potentially leaving agents without expected access to legitimate resources.

2. **Race Condition Risk**: Paths that don't exist during validation could be created later with malicious content, especially problematic in shared/containerized environments.

3. **Directory Traversal Risk**: While `path.resolve()` is used for normalization, there's no validation that resolved paths stay within expected boundaries.

**Example Attack Scenarios:**
```typescript
// Typo in allowed folder - silently ignored
allowedFolders: ["/usr/local/bim"]  // Should be "/usr/local/bin"

// Non-existent path that could be created later
allowedFolders: ["/tmp/malicious-drop-zone"]  // Created by attacker after validation

// Path traversal attempts (currently handled by path.resolve)
allowedFolders: ["/safe/path/../../../etc/passwd"]
```

### 2. allowedUrls - URL Format and Scheme Validation

**Current Behavior:**
- Schema accepts any string as a URL
- `CopilotCliRunner.sanitizeUrl()` performs comprehensive runtime validation:
  - Validates URL format
  - Restricts to HTTP/HTTPS schemes only
  - Blocks shell metacharacters and command injection
  - Rejects embedded credentials
  - Supports wildcard domains (`*.example.com`)

**Security Risks:**

1. **Non-HTTP Schemes**: While runtime validation blocks them, schema validation allows dangerous schemes like `file://`, `javascript:`, `data:`, etc.

2. **Malformed URLs**: Schema accepts strings that aren't valid URLs, causing runtime errors and inconsistent behavior.

3. **Late Validation Feedback**: Users don't learn about invalid URLs until execution time, making debugging difficult.

**Example Attack Scenarios:**
```typescript
// Dangerous schemes (blocked at runtime but pass schema)
allowedUrls: ["file:///etc/passwd"]
allowedUrls: ["javascript:alert('xss')"] 
allowedUrls: ["data:text/html,<script>evil()</script>"]

// Malformed URLs (pass schema but fail at runtime)
allowedUrls: ["not-a-url-at-all"]
allowedUrls: ["http://"]
allowedUrls: ["://missing-scheme"]
```

## Current Runtime Protections

### Positive Security Controls

The `CopilotCliRunner` implementation provides several strong security controls:

1. **Path Security** (`buildCommand`, lines 411-425):
   - Requires absolute paths
   - Validates path existence 
   - Uses `path.resolve()` for normalization
   - Extensive security logging

2. **URL Security** (`sanitizeUrl`, lines 321-387):
   - Comprehensive input sanitization
   - Scheme restriction (HTTP/HTTPS only)
   - Command injection prevention
   - Credential rejection
   - Pattern matching support

3. **Principle of Least Privilege**:
   - Default network access: disabled
   - Default file access: worktree only
   - Explicit allowlisting required

## Recommended Solution: Post-Schema Validation

### Proposed Architecture

Implement dedicated validation functions that run after schema validation but before job execution:

```typescript
// src/mcp/validation/security.ts

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  sanitized?: any;
}

export function validateAllowedFolders(folders: string[]): ValidationResult;
export function validateAllowedUrls(urls: string[]): ValidationResult;
```

### Implementation Strategy

#### 1. Path Validation Function

```typescript
function validateAllowedFolders(folders: string[]): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const validated: string[] = [];

  for (const folder of folders) {
    // Must be absolute path
    if (!path.isAbsolute(folder)) {
      errors.push(`Path must be absolute: ${folder}`);
      continue;
    }

    // Check if path exists
    const resolved = path.resolve(folder);
    if (!fs.existsSync(resolved)) {
      warnings.push(`Path does not exist: ${folder} (resolved: ${resolved})`);
      continue;
    }

    // Verify it's actually a directory
    try {
      const stats = fs.statSync(resolved);
      if (!stats.isDirectory()) {
        errors.push(`Path is not a directory: ${folder}`);
        continue;
      }
    } catch (e) {
      errors.push(`Cannot access path: ${folder} (${e.message})`);
      continue;
    }

    // Additional security checks could go here
    // - Check if path is within allowed boundaries
    // - Verify directory permissions
    // - Scan for security-sensitive locations

    validated.push(resolved);
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
    sanitized: validated
  };
}
```

#### 2. URL Validation Function

```typescript
function validateAllowedUrls(urls: string[]): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const validated: string[] = [];

  for (const url of urls) {
    // Reuse existing sanitizeUrl logic
    const sanitized = sanitizeUrl(url);
    if (!sanitized) {
      errors.push(`Invalid or unsafe URL: ${url}`);
      continue;
    }

    // Additional checks for well-formedness
    try {
      const parsed = new URL(sanitized.startsWith('*.') ? `https://${sanitized.slice(2)}` : sanitized);
      
      // Verify supported schemes
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        errors.push(`Unsupported URL scheme: ${parsed.protocol}`);
        continue;
      }

      // Check for suspicious patterns
      if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
        warnings.push(`Local URL detected: ${url} - ensure this is intentional`);
      }

    } catch (e) {
      errors.push(`Malformed URL: ${url} (${e.message})`);
      continue;
    }

    validated.push(sanitized);
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
    sanitized: validated
  };
}
```

### Integration Points

1. **MCP Server Validation**: Add calls to validation functions in MCP tool implementations before job creation

2. **Plan Initialization**: Validate during plan creation to provide early feedback

3. **Job Retry/Modification**: Re-validate when work specifications are updated

4. **UI Feedback**: Surface validation errors and warnings in the VS Code interface

## Security Considerations

### Defense in Depth

The proposed validation adds an additional security layer while maintaining existing runtime protections:

- **Schema validation**: Basic type and length checking
- **Post-schema validation**: Security-focused content validation  
- **Runtime validation**: Final safety checks during execution

### Threat Model Coverage

**Mitigated Threats:**
- Typos in configuration leading to missing access
- Race conditions with non-existent paths
- Non-HTTP scheme injection attempts
- Malformed URL causing runtime errors
- Configuration errors discovered late in execution

**Remaining Risks:**
- Time-of-check vs time-of-use (TOCTOU) attacks on filesystem
- DNS spoofing of allowed domains
- Privilege escalation via allowed directories
- Network-based attacks through allowed URLs

### Performance Impact

**Path Validation:**
- `fs.existsSync()` and `fs.statSync()` are synchronous I/O operations
- Should be fast for small numbers of paths (typical: 1-5 paths)
- Consider async validation for large path lists

**URL Validation:**
- Primarily CPU-bound string processing
- No network requests (DNS resolution not performed)
- Minimal performance impact expected

## Implementation Recommendations

### Phase 1: Core Validation
1. Implement `validateAllowedFolders()` and `validateAllowedUrls()` functions
2. Add validation calls to `create_copilot_plan` and `create_copilot_job` handlers
3. Return validation errors as MCP tool errors for immediate user feedback

### Phase 2: Enhanced Integration
1. Add validation to plan retry/modification operations
2. Implement UI feedback for warnings (non-blocking validation issues)
3. Add optional strict mode for organizations requiring zero warnings

### Phase 3: Advanced Security
1. Add configurable path boundary checking (e.g., no access above repository root)
2. Implement DNS validation for allowed URLs (optional)
3. Add audit logging for security-relevant validation decisions

## Conclusion

While the current runtime validation in `CopilotCliRunner` provides strong security controls, the schema validation alone is insufficient for catching security and operational issues early in the workflow. Adding post-schema validation functions would:

1. **Improve User Experience**: Early feedback on configuration errors
2. **Reduce Security Risk**: Prevent dangerous configurations from reaching runtime
3. **Maintain Defense in Depth**: Complement existing runtime protections
4. **Enable Better Tooling**: Support IDE integration and configuration validation

The proposed validation functions leverage existing security logic while providing earlier detection of issues, making the system both more secure and more user-friendly.