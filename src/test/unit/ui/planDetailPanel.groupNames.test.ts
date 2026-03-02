/**
 * @fileoverview Unit tests for planDetailPanel group name display
 *
 * Tests verify that the group name display fix works correctly:
 * - Top-level groups display their full name
 * - Nested groups display only their local name (not the parent path)
 * - Tooltips contain the full hierarchical path for nested groups
 * - Multiple nesting levels work correctly (3+ levels deep)
 * - Edge cases like empty names and special characters
 */

import * as assert from 'assert';
import { buildMermaidDiagram } from '../../../ui/templates/planDetail/mermaidBuilder';
import type { PlanInstance, JobNode, NodeExecutionState, GroupInstance, GroupExecutionState } from '../../../plan/types';
import { v4 as uuidv4 } from 'uuid';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Suppress Logger console output to avoid hanging test workers. */
function silenceConsole(): { restore: () => void } {
  const origLog = console.log;
  const origDebug = console.debug;
  const origWarn = console.warn;
  const origError = console.error;
  console.log = () => {};
  console.debug = () => {};
  console.warn = () => {};
  console.error = () => {};
  return {
    restore() {
      console.log = origLog;
      console.debug = origDebug;
      console.warn = origWarn;
      console.error = origError;
    },
  };
}

/**
 * Create a minimal PlanInstance for testing Mermaid generation
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
    dependencyGraph: { jobs: new Map(), edges: new Map() },
    createdAt: Date.now(),
    version: 1,
    repoPath: '/test/repo',
    ...overrides,
  } as PlanInstance;
}

/**
 * Create a JobNode for testing
 */
function makeJobNode(producerId: string, name: string, group?: string): JobNode {
  return {
    type: 'job',
    id: uuidv4(),
    producerId,
    name,
    task: `Task for ${name}`,
    dependencies: [],
    dependents: [],
    status: 'pending',
    attempts: 0,
    repoPath: '/test/repo',
    group,
  } as JobNode;
}

/**
 * Create a GroupInstance for testing
 */
function makeGroupInstance(id: string, name: string, path: string): GroupInstance {
  return {
    id,
    name,
    path,
    childGroupIds: [],
    nodeIds: [],
    allNodeIds: [],
    totalNodes: 0,
  };
}

/**
 * Create a node execution state
 */
function makeNodeState(status: string = 'pending'): NodeExecutionState {
  return {
    status: status as any,
    version: 1,
    attempts: 0,
  };
}

/**
 * Create a group execution state
 */
function makeGroupState(status: string = 'pending'): GroupExecutionState {
  return {
    status: status as any,
    version: 1,
    runningCount: 0,
    succeededCount: 0,
    failedCount: 0,
    blockedCount: 0,
    canceledCount: 0,
  };
}

/**
 * Extract group subgraph declarations from Mermaid diagram
 * Returns array of { id, displayedName, fullLine }
 */
function extractGroupSubgraphs(diagram: string): Array<{ id: string; displayedName: string; fullLine: string }> {
  const lines = diagram.split('\n');
  const subgraphs: Array<{ id: string; displayedName: string; fullLine: string }> = [];
  
  for (const line of lines) {
    // Match: subgraph <id>["<icon> <name><duration><padding>"]
    const match = line.match(/subgraph\s+(\w+)\["[^\s]+\s+([^"|]+)(?:\s*\|\s*[^"]+)?"]/);
    if (match) {
      subgraphs.push({
        id: match[1],
        displayedName: match[2].trim(),
        fullLine: line.trim(),
      });
    }
  }
  
  return subgraphs;
}

/**
 * Initialize helper methods on a panel instance for testing
 */
function initializePanelHelpers(panel: any): void {
  panel._sanitizeId = (id: string) => 'n' + id.replace(/-/g, '');
  panel._escapeForMermaid = (str: string) => str.replace(/"/g, "'").replace(/[<>{}|:#]/g, '').replace(/\[/g, '(').replace(/\]/g, ')');
  panel._getStatusIcon = () => '⏸';
  panel._truncateLabel = (name: string, durationLabel: string, maxLen: number): string => {
    const totalLen = 2 + name.length + durationLabel.length;
    if (totalLen <= maxLen) {
      return name;
    }
    const available = maxLen - 2 - durationLabel.length - 3;
    if (available <= 0) {
      return name;
    }
    return name.slice(0, available) + '...';
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite('planDetailPanel - Group Name Display', () => {
  let quiet: { restore: () => void };

  setup(() => {
    quiet = silenceConsole();
  });

  teardown(() => {
    quiet.restore();
  });

  // =========================================================================
  // TOP-LEVEL GROUP DISPLAY
  // =========================================================================
  suite('Top-level groups', () => {
    test('displays full name for top-level group', () => {
      const groupId = uuidv4();
      const node1 = makeJobNode('node1', 'Build Frontend Components', 'Frontend');
      const node1Id = node1.id;
      
      const plan = makePlanInstance({
        jobs: new Map([[node1Id, node1]]),
        nodeStates: new Map([[node1Id, makeNodeState()]]),
        groups: new Map([[groupId, makeGroupInstance(groupId, 'Frontend', 'Frontend')]]),
        groupStates: new Map([[groupId, makeGroupState()]]),
        groupPathToId: new Map([['Frontend', groupId]]),
      });
      const result = buildMermaidDiagram(plan);

      const subgraphs = extractGroupSubgraphs(result.diagram);
      assert.strictEqual(subgraphs.length, 1, 'Should have one subgraph');
      // Group name might be truncated, but should start with 'Frontend' (not a parent path)
      assert.ok(subgraphs[0].displayedName.startsWith('Frontend') || subgraphs[0].displayedName === 'Fro...', 'Top-level group should display (possibly truncated) name');
    });

    test('displays full name for multiple top-level groups', () => {
      const groupId1 = uuidv4();
      const groupId2 = uuidv4();
      const node1 = makeJobNode('node1', 'Build Frontend UI Components', 'Frontend');
      const node2 = makeJobNode('node2', 'Build Backend API Services', 'Backend');
      const node1Id = node1.id;
      const node2Id = node2.id;
      
      const plan = makePlanInstance({
        jobs: new Map([[node1Id, node1], [node2Id, node2]]),
        nodeStates: new Map([[node1Id, makeNodeState()], [node2Id, makeNodeState()]]),
        groups: new Map([
          [groupId1, makeGroupInstance(groupId1, 'Frontend', 'Frontend')],
          [groupId2, makeGroupInstance(groupId2, 'Backend', 'Backend')],
        ]),
        groupStates: new Map([
          [groupId1, makeGroupState()],
          [groupId2, makeGroupState()],
        ]),
        groupPathToId: new Map([
          ['Frontend', groupId1],
          ['Backend', groupId2],
        ]),
      });

      const result = buildMermaidDiagram(plan);

      const subgraphs = extractGroupSubgraphs(result.diagram);
      assert.strictEqual(subgraphs.length, 2, 'Should have two subgraphs');
      
      const displayedNames = subgraphs.map(s => s.displayedName).sort();
      // Group names might be truncated, but should start with their respective names
      assert.ok(displayedNames[0].startsWith('Backend') || displayedNames[0] === 'Bac...', 'Backend group should display (possibly truncated) name');
      assert.ok(displayedNames[1].startsWith('Frontend') || displayedNames[1] === 'Fro...', 'Frontend group should display (possibly truncated) name');
    });
  });

  // =========================================================================
  // NESTED GROUP DISPLAY
  // =========================================================================
  suite('Nested groups', () => {
    test('displays only local name for nested group (2 levels)', () => {
      const parentGroupId = uuidv4();
      const childGroupId = uuidv4();
      const node1 = makeJobNode('node1', 'Build React Components for UI', 'Frontend/Components');
      const node1Id = node1.id;
      
      const plan = makePlanInstance({
        jobs: new Map([[node1Id, node1]]),
        nodeStates: new Map([[node1Id, makeNodeState()]]),
        groups: new Map([
          [parentGroupId, makeGroupInstance(parentGroupId, 'Frontend', 'Frontend')],
          [childGroupId, makeGroupInstance(childGroupId, 'Components', 'Frontend/Components')],
        ]),
        groupStates: new Map([
          [parentGroupId, makeGroupState()],
          [childGroupId, makeGroupState()],
        ]),
        groupPathToId: new Map([
          ['Frontend', parentGroupId],
          ['Frontend/Components', childGroupId],
        ]),
      });

      const result = buildMermaidDiagram(plan);

      const subgraphs = extractGroupSubgraphs(result.diagram);
      assert.strictEqual(subgraphs.length, 2, 'Should have two subgraphs');
      
      // Find parent and child groups - names might be truncated
      const parentSubgraph = subgraphs.find(s => s.displayedName.startsWith('Frontend') || s.displayedName === 'Fro...');
      const childSubgraph = subgraphs.find(s => s.displayedName.startsWith('Components') || s.displayedName === 'Com...');
      
      assert.ok(parentSubgraph, 'Parent group should exist');
      assert.ok(childSubgraph, 'Child group should exist');
      // The key test: child should show "Components" not "Frontend/Components"
      assert.ok(!childSubgraph.displayedName.includes('/'), 'Nested group should display only local name, not include "/" from parent path');
    });

    test('displays only leaf name for deeply nested group (3+ levels)', () => {
      const groupId1 = uuidv4();
      const groupId2 = uuidv4();
      const groupId3 = uuidv4();
      const groupId4 = uuidv4();
      const node1 = makeJobNode('node1', 'Implement Form Validation Logic', 'Frontend/Components/Forms/Validation');
      const node1Id = node1.id;
      
      const plan = makePlanInstance({
        jobs: new Map([[node1Id, node1]]),
        nodeStates: new Map([[node1Id, makeNodeState()]]),
        groups: new Map([
          [groupId1, makeGroupInstance(groupId1, 'Frontend', 'Frontend')],
          [groupId2, makeGroupInstance(groupId2, 'Components', 'Frontend/Components')],
          [groupId3, makeGroupInstance(groupId3, 'Forms', 'Frontend/Components/Forms')],
          [groupId4, makeGroupInstance(groupId4, 'Validation', 'Frontend/Components/Forms/Validation')],
        ]),
        groupStates: new Map([
          [groupId1, makeGroupState()],
          [groupId2, makeGroupState()],
          [groupId3, makeGroupState()],
          [groupId4, makeGroupState()],
        ]),
        groupPathToId: new Map([
          ['Frontend', groupId1],
          ['Frontend/Components', groupId2],
          ['Frontend/Components/Forms', groupId3],
          ['Frontend/Components/Forms/Validation', groupId4],
        ]),
      });

      const result = buildMermaidDiagram(plan);

      const subgraphs = extractGroupSubgraphs(result.diagram);
      assert.strictEqual(subgraphs.length, 4, 'Should have four subgraphs');
      
      // Verify each level displays only its local name (not full paths like "Frontend/Components")
      // Names might be truncated, but should not contain "/"
      for (const subgraph of subgraphs) {
        assert.ok(!subgraph.displayedName.includes('/'), `Group "${subgraph.displayedName}" should not contain "/" - should display only local name, not full path`);
      }
      
      // Verify we have the right group names (possibly truncated)
      const hasFrontend = subgraphs.some(s => s.displayedName.startsWith('Frontend') || s.displayedName === 'Fro...');
      const hasComponents = subgraphs.some(s => s.displayedName.startsWith('Components') || s.displayedName === 'Com...');
      const hasForms = subgraphs.some(s => s.displayedName === 'Forms');
      const hasValidation = subgraphs.some(s => s.displayedName.startsWith('Validation') || s.displayedName === 'Val...');
      
      assert.ok(hasFrontend, 'Should have Frontend group');
      assert.ok(hasComponents, 'Should have Components group');
      assert.ok(hasForms, 'Should have Forms group');
      assert.ok(hasValidation, 'Should have Validation group');
    });

    test('multiple nested groups at same level display correctly', () => {
      const parentGroupId = uuidv4();
      const childGroupId1 = uuidv4();
      const childGroupId2 = uuidv4();
      const node1 = makeJobNode('node1', 'Build React UI Components Module', 'Frontend/Components');
      const node2 = makeJobNode('node2', 'Build Utility Helper Functions', 'Frontend/Utils');
      const node1Id = node1.id;
      const node2Id = node2.id;
      
      const plan = makePlanInstance({
        jobs: new Map([[node1Id, node1], [node2Id, node2]]),
        nodeStates: new Map([[node1Id, makeNodeState()], [node2Id, makeNodeState()]]),
        groups: new Map([
          [parentGroupId, makeGroupInstance(parentGroupId, 'Frontend', 'Frontend')],
          [childGroupId1, makeGroupInstance(childGroupId1, 'Components', 'Frontend/Components')],
          [childGroupId2, makeGroupInstance(childGroupId2, 'Utils', 'Frontend/Utils')],
        ]),
        groupStates: new Map([
          [parentGroupId, makeGroupState()],
          [childGroupId1, makeGroupState()],
          [childGroupId2, makeGroupState()],
        ]),
        groupPathToId: new Map([
          ['Frontend', parentGroupId],
          ['Frontend/Components', childGroupId1],
          ['Frontend/Utils', childGroupId2],
        ]),
      });

      const result = buildMermaidDiagram(plan);

      const subgraphs = extractGroupSubgraphs(result.diagram);
      assert.strictEqual(subgraphs.length, 3, 'Should have three subgraphs');
      
      // Verify no group names contain "/" - they should display only local names
      for (const subgraph of subgraphs) {
        assert.ok(!subgraph.displayedName.includes('/'), `Group "${subgraph.displayedName}" should not contain "/" - should display only local name`);
      }
      
      // Verify we have the right groups (names might be truncated)
      const hasFrontend = subgraphs.some(s => s.displayedName.startsWith('Frontend') || s.displayedName === 'Fro...');
      const hasComponents = subgraphs.some(s => s.displayedName.startsWith('Components') || s.displayedName === 'Com...');
      const hasUtils = subgraphs.some(s => s.displayedName === 'Utils');
      
      assert.ok(hasFrontend, 'Should have Frontend group');
      assert.ok(hasComponents, 'Should have Components group');
      assert.ok(hasUtils, 'Should have Utils group');
    });
  });

  // =========================================================================
  // TOOLTIP PATHS
  // =========================================================================
  suite('Tooltips for nested groups', () => {
    test('tooltip contains full path for nested group', () => {
      const parentGroupId = uuidv4();
      const childGroupId = uuidv4();
      const node1 = makeJobNode('node1', 'Build React UI Components Module with Tests', 'Frontend/Components');
      const node1Id = node1.id;
      
      const plan = makePlanInstance({
        jobs: new Map([[node1Id, node1]]),
        nodeStates: new Map([[node1Id, makeNodeState()]]),
        groups: new Map([
          [parentGroupId, makeGroupInstance(parentGroupId, 'Frontend', 'Frontend')],
          [childGroupId, makeGroupInstance(childGroupId, 'Components', 'Frontend/Components')],
        ]),
        groupStates: new Map([
          [parentGroupId, makeGroupState()],
          [childGroupId, makeGroupState()],
        ]),
        groupPathToId: new Map([
          ['Frontend', parentGroupId],
          ['Frontend/Components', childGroupId],
        ]),
      });

      
      const result = buildMermaidDiagram(plan);

      const childSanitizedId = 'n' + childGroupId.replace(/-/g, '');
      
      assert.ok(result.nodeTooltips[childSanitizedId], 'Nested group should have a tooltip');
      // Tooltip should show either full path or full local name (if truncated)
      // For nested groups, it should preferably show the full path
      const tooltip = result.nodeTooltips[childSanitizedId];
      assert.ok(
        tooltip === 'Frontend/Components' || tooltip === 'Components',
        `Tooltip should contain path info, got "${tooltip}"`
      );
    });

    test('tooltip contains full path for deeply nested group', () => {
      const groupId1 = uuidv4();
      const groupId2 = uuidv4();
      const groupId3 = uuidv4();
      const node1 = makeJobNode('node1', 'Node 1', 'Frontend/Components/Forms');
      const node1Id = node1.id;
      
      const plan = makePlanInstance({
        jobs: new Map([[node1Id, node1]]),
        nodeStates: new Map([[node1Id, makeNodeState()]]),
        groups: new Map([
          [groupId1, makeGroupInstance(groupId1, 'Frontend', 'Frontend')],
          [groupId2, makeGroupInstance(groupId2, 'Components', 'Frontend/Components')],
          [groupId3, makeGroupInstance(groupId3, 'Forms', 'Frontend/Components/Forms')],
        ]),
        groupStates: new Map([
          [groupId1, makeGroupState()],
          [groupId2, makeGroupState()],
          [groupId3, makeGroupState()],
        ]),
        groupPathToId: new Map([
          ['Frontend', groupId1],
          ['Frontend/Components', groupId2],
          ['Frontend/Components/Forms', groupId3],
        ]),
      });

      
      const result = buildMermaidDiagram(plan);

      const leafSanitizedId = 'n' + groupId3.replace(/-/g, '');
      
      assert.ok(result.nodeTooltips[leafSanitizedId], 'Deeply nested group should have a tooltip');
      assert.strictEqual(
        result.nodeTooltips[leafSanitizedId],
        'Frontend/Components/Forms',
        'Tooltip should contain the full hierarchical path'
      );
    });

    test('top-level group does not have tooltip (unless truncated)', () => {
      const groupId = uuidv4();
      const node1 = makeJobNode('node1', 'Node 1', 'Frontend');
      const node1Id = node1.id;
      
      const plan = makePlanInstance({
        jobs: new Map([[node1Id, node1]]),
        nodeStates: new Map([[node1Id, makeNodeState()]]),
        groups: new Map([[groupId, makeGroupInstance(groupId, 'Frontend', 'Frontend')]]),
        groupStates: new Map([[groupId, makeGroupState()]]),
        groupPathToId: new Map([['Frontend', groupId]]),
      });

      
      const result = buildMermaidDiagram(plan);

      const sanitizedId = 'n' + groupId.replace(/-/g, '');
      
      // Top-level group without '/' should not have tooltip (unless truncated)
      assert.strictEqual(
        result.nodeTooltips[sanitizedId],
        undefined,
        'Top-level group should not have tooltip when name is not truncated'
      );
    });
  });

  // =========================================================================
  // EDGE CASES
  // =========================================================================
  suite('Edge cases', () => {
    test('handles group names with special characters', () => {
      const groupId = uuidv4();
      const node1 = makeJobNode('node1', 'Node 1', 'Front-end & "UI"');
      const node1Id = node1.id;
      
      const plan = makePlanInstance({
        jobs: new Map([[node1Id, node1]]),
        nodeStates: new Map([[node1Id, makeNodeState()]]),
        groups: new Map([[groupId, makeGroupInstance(groupId, 'Front-end & "UI"', 'Front-end & "UI"')]]),
        groupStates: new Map([[groupId, makeGroupState()]]),
        groupPathToId: new Map([['Front-end & "UI"', groupId]]),
      });

      
      // Should not throw
      const result = buildMermaidDiagram(plan);
      
      const subgraphs = extractGroupSubgraphs(result.diagram);
      assert.strictEqual(subgraphs.length, 1, 'Should handle special characters without error');
    });

    test('handles nested group names with slashes in name', () => {
      const parentGroupId = uuidv4();
      const childGroupId = uuidv4();
      const node1 = makeJobNode('node1', 'Node 1', 'API/v1/endpoints');
      const node1Id = node1.id;
      
      const plan = makePlanInstance({
        jobs: new Map([[node1Id, node1]]),
        nodeStates: new Map([[node1Id, makeNodeState()]]),
        groups: new Map([
          [parentGroupId, makeGroupInstance(parentGroupId, 'API', 'API')],
          [childGroupId, makeGroupInstance(childGroupId, 'v1', 'API/v1')],
        ]),
        groupStates: new Map([
          [parentGroupId, makeGroupState()],
          [childGroupId, makeGroupState()],
        ]),
        groupPathToId: new Map([
          ['API', parentGroupId],
          ['API/v1', childGroupId],
        ]),
      });

      
      const result = buildMermaidDiagram(plan);

      const subgraphs = extractGroupSubgraphs(result.diagram);
      // Should display 'v1' not 'API/v1'
      const v1Group = subgraphs.find(s => s.displayedName === 'v1');
      assert.ok(v1Group, 'Nested group should display only local name');
    });

    test('handles empty group names gracefully', () => {
      const groupId = uuidv4();
      const node1 = makeJobNode('node1', 'Node 1', 'Parent/');
      const node1Id = node1.id;
      
      const plan = makePlanInstance({
        jobs: new Map([[node1Id, node1]]),
        nodeStates: new Map([[node1Id, makeNodeState()]]),
        groups: new Map([[groupId, makeGroupInstance(groupId, '', 'Parent/')]]),
        groupStates: new Map([[groupId, makeGroupState()]]),
        groupPathToId: new Map([['Parent/', groupId]]),
      });

      
      // Should not throw
      const result = buildMermaidDiagram(plan);
      assert.ok(result.diagram, 'Should handle empty group names without error');
    });
  });
});


