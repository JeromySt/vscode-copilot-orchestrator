/**
 * @fileoverview Unit tests for mermaidBuilder
 *
 * Tests verify that the Mermaid diagram builder correctly generates flowchart
 * syntax from PlanInstance data including:
 * - Flowchart header
 * - Node ID sanitization
 * - Edge generation between dependencies
 * - Group rendering as nested subgraphs
 * - Branch nodes
 */

import { suite, test } from 'mocha';
import * as assert from 'assert';
import { buildMermaidDiagram } from '../../../../ui/templates/planDetail/mermaidBuilder';
import type { PlanInstance, JobNode } from '../../../../plan/types';
import { v4 as uuidv4 } from 'uuid';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a minimal PlanInstance for testing
 */
function makePlanInstance(overrides?: Partial<PlanInstance>): PlanInstance {
  return {
    id: uuidv4(),
    name: 'Test Plan',
    spec: { jobs: [] },
    status: 'running',
    jobs: new Map(),
    nodeStates: new Map(),
    groups: new Map(),
    groupStates: new Map(),
    groupPathToId: new Map(),
    producerIdToNodeId: new Map(),
    dependencyGraph: { jobs: new Map(), edges: new Map() },
    createdAt: Date.now(),
    version: 1,
    repoPath: '/test/repo',
    baseBranch: 'main',
    targetBranch: 'main',
    ...overrides,
  } as PlanInstance;
}

/**
 * Create a JobNode for testing
 */
function makeJobNode(producerId: string, name: string, dependencies: string[] = []): JobNode {
  return {
    type: 'job',
    id: uuidv4(),
    producerId,
    name,
    task: `Task for ${name}`,
    dependencies,
    dependents: [],
    status: 'pending',
    attempts: 0,
    repoPath: '/test/repo',
  } as JobNode;
}

/**
 * Create a minimal NodeExecutionState for testing
 */
function makeNodeState(status: string = 'pending', overrides: any = {}): any {
  return {
    status,
    version: 1,
    attempts: 0,
    ...overrides,
  };
}

/**
 * Create a minimal GroupExecutionState for testing
 */
function makeGroupState(status: string = 'pending'): any {
  return {
    status,
    version: 1,
    runningCount: 0,
    succeededCount: 0,
    failedCount: 0,
    blockedCount: 0,
    canceledCount: 0,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite('buildMermaidDiagram', () => {
  test('should generate flowchart LR header', () => {
    const plan = makePlanInstance();
    const result = buildMermaidDiagram(plan);
    
    assert.ok(result.diagram.startsWith('flowchart LR'), 'Diagram should start with "flowchart LR"');
  });

  test('should sanitize node IDs (remove hyphens, prefix with n)', () => {
    const nodeId = '12345678-1234-1234-1234-123456789abc';
    const job = makeJobNode('job1', 'Test Job');
    job.id = nodeId;
    
    const plan = makePlanInstance({
      jobs: new Map([[nodeId, job]]),
      nodeStates: new Map([[nodeId, makeNodeState('pending')]]),
    });
    
    const result = buildMermaidDiagram(plan);
    const sanitizedId = 'n' + nodeId.replace(/-/g, '');
    
    assert.ok(result.diagram.includes(sanitizedId), `Diagram should contain sanitized ID ${sanitizedId}`);
    assert.ok(!result.diagram.includes(nodeId), 'Diagram should not contain raw UUID with hyphens');
  });

  test('should create edges between dependent nodes', () => {
    const node1Id = uuidv4();
    const node2Id = uuidv4();
    const job1 = makeJobNode('job1', 'Job 1');
    const job2 = makeJobNode('job2', 'Job 2', [node1Id]);
    job1.id = node1Id;
    job2.id = node2Id;
    
    const plan = makePlanInstance({
      jobs: new Map([
        [node1Id, job1],
        [node2Id, job2],
      ]),
      nodeStates: new Map([
        [node1Id, makeNodeState('pending')],
        [node2Id, makeNodeState('pending')],
      ]),
    });
    
    const result = buildMermaidDiagram(plan);
    const sanitizedId1 = 'n' + node1Id.replace(/-/g, '');
    const sanitizedId2 = 'n' + node2Id.replace(/-/g, '');
    
    // Should have edge from node1 to node2
    const edgePattern = new RegExp(`${sanitizedId1}\\s+(-\\.->|-->)\\s+${sanitizedId2}`);
    assert.ok(edgePattern.test(result.diagram), 'Diagram should contain edge from job1 to job2');
  });

  test('should include edge data for client-side coloring', () => {
    const node1Id = uuidv4();
    const node2Id = uuidv4();
    const job1 = makeJobNode('job1', 'Job 1');
    const job2 = makeJobNode('job2', 'Job 2', [node1Id]);
    job1.id = node1Id;
    job2.id = node2Id;
    
    const plan = makePlanInstance({
      jobs: new Map([
        [node1Id, job1],
        [node2Id, job2],
      ]),
      nodeStates: new Map([
        [node1Id, makeNodeState('succeeded')],
        [node2Id, makeNodeState('pending')],
      ]),
    });
    
    const result = buildMermaidDiagram(plan);
    
    assert.ok(Array.isArray(result.edgeData), 'Should return edgeData array');
    assert.ok(result.edgeData.length > 0, 'Should have at least one edge');
    
    // Each edge should have index, from, to
    for (const edge of result.edgeData) {
      assert.ok(typeof edge.index === 'number', 'Edge should have numeric index');
      assert.ok(typeof edge.from === 'string', 'Edge should have from ID');
      assert.ok(typeof edge.to === 'string', 'Edge should have to ID');
    }
  });

  test('should render groups as nested subgraphs', () => {
    const groupId = uuidv4();
    const nodeId = uuidv4();
    const job = makeJobNode('job1', 'Grouped Job');
    job.id = nodeId;
    job.group = 'frontend';
    
    const plan = makePlanInstance({
      jobs: new Map([[nodeId, job]]),
      nodeStates: new Map([[nodeId, makeNodeState('pending')]]),
      groups: new Map([[groupId, { id: groupId, name: 'frontend', path: 'frontend', childGroupIds: [], nodeIds: [nodeId], allNodeIds: [nodeId], totalNodes: 1 }]]),
      groupStates: new Map([[groupId, makeGroupState('pending')]]),
      groupPathToId: new Map([['frontend', groupId]]),
    });
    
    const result = buildMermaidDiagram(plan);
    
    // Should contain subgraph syntax
    assert.ok(result.diagram.includes('subgraph'), 'Diagram should contain subgraph for group');
    assert.ok(result.diagram.includes('end'), 'Diagram should close subgraph with end');
    
    // Group name should appear in diagram
    assert.ok(result.diagram.includes('frontend'), 'Diagram should include group name');
  });

  test('should include tooltips for truncated node names', () => {
    const nodeId = uuidv4();
    const longName = 'This is a very long job name that will definitely exceed the maximum label character limit for node labels';
    const job = makeJobNode('job1', longName);
    job.id = nodeId;
    
    const plan = makePlanInstance({
      jobs: new Map([[nodeId, job]]),
      nodeStates: new Map([[nodeId, makeNodeState('pending')]]),
    });
    
    const result = buildMermaidDiagram(plan);
    const sanitizedId = 'n' + nodeId.replace(/-/g, '');
    
    // Should have tooltip for long name
    assert.ok(result.nodeTooltips[sanitizedId], 'Should have tooltip for truncated node');
    assert.strictEqual(result.nodeTooltips[sanitizedId], longName, 'Tooltip should contain full node name');
  });

  test('should render branch nodes when base and target differ', () => {
    const plan = makePlanInstance({
      baseBranch: 'main',
      targetBranch: 'feature/test',
    });
    
    const result = buildMermaidDiagram(plan);
    
    // Should contain BASE_BRANCH and TARGET_SOURCE nodes
    assert.ok(result.diagram.includes('BASE_BRANCH'), 'Diagram should contain BASE_BRANCH node');
    assert.ok(result.diagram.includes('TARGET_SOURCE'), 'Diagram should contain TARGET_SOURCE node');
    assert.ok(result.diagram.includes('TARGET_DEST'), 'Diagram should contain TARGET_DEST node');
  });

  test('should handle plans with no jobs', () => {
    const plan = makePlanInstance();
    
    const result = buildMermaidDiagram(plan);
    
    assert.ok(result.diagram.includes('flowchart LR'), 'Should still generate valid flowchart');
    assert.strictEqual(Object.keys(result.nodeTooltips).length, 0, 'Should have no node tooltips');
  });

  test('should apply status-based styling', () => {
    const nodeId = uuidv4();
    const job = makeJobNode('job1', 'Test Job');
    job.id = nodeId;
    
    const plan = makePlanInstance({
      jobs: new Map([[nodeId, job]]),
      nodeStates: new Map([[nodeId, makeNodeState('succeeded')]]),
    });
    
    const result = buildMermaidDiagram(plan);
    
    // Should contain status class definitions
    assert.ok(result.diagram.includes('classDef pending'), 'Should define pending style');
    assert.ok(result.diagram.includes('classDef succeeded'), 'Should define succeeded style');
    assert.ok(result.diagram.includes('classDef failed'), 'Should define failed style');
    assert.ok(result.diagram.includes('classDef running'), 'Should define running style');
  });

  test('should handle nested groups (multi-level)', () => {
    const group1Id = uuidv4();
    const group2Id = uuidv4();
    const nodeId = uuidv4();
    const job = makeJobNode('job1', 'Nested Job');
    job.id = nodeId;
    job.group = 'frontend/components';
    
    const plan = makePlanInstance({
      jobs: new Map([[nodeId, job]]),
      nodeStates: new Map([[nodeId, makeNodeState('pending')]]),
      groups: new Map([
        [group1Id, { id: group1Id, name: 'frontend', path: 'frontend', childGroupIds: [group2Id], nodeIds: [], allNodeIds: [nodeId], totalNodes: 1 }],
        [group2Id, { id: group2Id, name: 'components', path: 'frontend/components', childGroupIds: [], nodeIds: [nodeId], allNodeIds: [nodeId], totalNodes: 1 }],
      ]),
      groupStates: new Map([
        [group1Id, makeGroupState('pending')],
        [group2Id, makeGroupState('pending')],
      ]),
      groupPathToId: new Map([
        ['frontend', group1Id],
        ['frontend/components', group2Id],
      ]),
    });
    
    const result = buildMermaidDiagram(plan);
    
    // Should have multiple subgraph declarations
    const subgraphCount = (result.diagram.match(/subgraph/g) || []).length;
    assert.ok(subgraphCount >= 2, 'Should have at least 2 nested subgraphs');
  });
});
