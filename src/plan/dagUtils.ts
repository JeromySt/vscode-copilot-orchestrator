/**
 * @fileoverview DAG Utilities
 *
 * Graph algorithms for dependency validation, cycle detection, and topology
 * computation. Operates on job specs with producerId-based dependencies.
 *
 * @module plan/dagUtils
 */

/**
 * Job structure for DAG operations (minimal interface).
 */
export interface DagJob {
  producerId: string;
  dependencies: string[];
}

/**
 * Detect cycles in the dependency graph using DFS.
 *
 * @param jobs - Array of jobs with producerId and dependencies.
 * @returns Human-readable error describing the cycle, or null if acyclic.
 */
export function detectCycles(jobs: DagJob[]): string | null {
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const path: string[] = [];
  const jobMap = new Map<string, DagJob>();

  for (const job of jobs) {
    jobMap.set(job.producerId, job);
  }

  function dfs(producerId: string): string | null {
    if (visiting.has(producerId)) {
      // Found a cycle - build the cycle path
      const cycleStart = path.indexOf(producerId);
      const cyclePath = path.slice(cycleStart);
      cyclePath.push(producerId);
      return `Circular dependency detected: ${cyclePath.join(' -> ')}`;
    }

    if (visited.has(producerId)) {
      return null;
    }

    visiting.add(producerId);
    path.push(producerId);

    const job = jobMap.get(producerId);
    if (job) {
      for (const depId of job.dependencies) {
        const error = dfs(depId);
        if (error) {
          return error;
        }
      }
    }

    visiting.delete(producerId);
    path.pop();
    visited.add(producerId);

    return null;
  }

  for (const job of jobs) {
    const error = dfs(job.producerId);
    if (error) {
      return error;
    }
  }

  return null;
}

/**
 * Compute root and leaf nodes by producerId.
 *
 * Roots have no dependencies, leaves have no dependents.
 *
 * @param jobs - Array of jobs with producerId and dependencies.
 * @returns Object with roots and leaves arrays (producerIds).
 */
export function computeRootsAndLeaves(jobs: DagJob[]): {
  roots: string[];
  leaves: string[];
} {
  const allProducerIds = new Set<string>();
  const referencedProducerIds = new Set<string>();

  for (const job of jobs) {
    allProducerIds.add(job.producerId);
  }

  for (const job of jobs) {
    for (const dep of job.dependencies) {
      referencedProducerIds.add(dep);
    }
  }

  const roots: string[] = [];
  const leaves: string[] = [];

  for (const job of jobs) {
    // Root: has no dependencies
    if (job.dependencies.length === 0) {
      roots.push(job.producerId);
    }

    // Leaf: no other job references it as a dependency
    if (!referencedProducerIds.has(job.producerId)) {
      leaves.push(job.producerId);
    }
  }

  return { roots, leaves };
}

/**
 * Validate that all dependency references point to existing producerIds.
 *
 * @param jobs - Array of jobs with producerId and dependencies.
 * @throws {Error} If any dependency references a non-existent producerId.
 */
export function validateAllDepsExist(jobs: DagJob[]): void {
  const existingIds = new Set<string>();
  for (const job of jobs) {
    existingIds.add(job.producerId);
  }

  const errors: string[] = [];
  for (const job of jobs) {
    for (const dep of job.dependencies) {
      if (!existingIds.has(dep)) {
        errors.push(`Job '${job.producerId}' references unknown dependency '${dep}'`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid dependencies:\n${errors.join('\n')}`);
  }
}

/**
 * Compute reverse edges (dependents map).
 *
 * Returns a map from producerId to array of producerIds that depend on it.
 *
 * @param jobs - Array of jobs with producerId and dependencies.
 * @returns Map from producerId to dependent producerIds.
 */
export function computeDependents(jobs: DagJob[]): Map<string, string[]> {
  const dependents = new Map<string, string[]>();

  // Initialize empty arrays for all producerIds
  for (const job of jobs) {
    dependents.set(job.producerId, []);
  }

  // Build reverse edges
  for (const job of jobs) {
    for (const dep of job.dependencies) {
      const depList = dependents.get(dep);
      if (depList) {
        depList.push(job.producerId);
      }
    }
  }

  return dependents;
}
