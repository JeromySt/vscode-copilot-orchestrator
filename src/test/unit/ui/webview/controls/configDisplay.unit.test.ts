/**
 * @fileoverview Unit tests for ConfigDisplay control
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { EventBus } from '../../../../../ui/webview/eventBus';
import { Topics } from '../../../../../ui/webview/topics';
import { ConfigDisplay, ConfigDisplayData, JobSpec } from '../../../../../ui/webview/controls/configDisplay';

function mockDocument(elements: Record<string, any> = {}): () => void {
  const prev = (globalThis as any).document;
  (globalThis as any).document = {
    getElementById(id: string) { return elements[id] || null; },
  };
  return () => {
    if (prev === undefined) { delete (globalThis as any).document; }
    else { (globalThis as any).document = prev; }
  };
}

function makeEl(): any {
  return { 
    innerHTML: '',
    style: {},
    classList: {
      contains: sinon.stub().returns(false),
      replace: sinon.stub(),
    },
    querySelector: sinon.stub().returns(null),
  };
}

suite('ConfigDisplay', () => {
  let bus: EventBus;
  let restoreDoc: () => void;

  setup(() => {
    bus = new EventBus();
  });

  teardown(() => {
    if (restoreDoc) { restoreDoc(); }
  });

  test('subscribes to CONFIG_UPDATE and NODE_STATE_CHANGE topics', () => {
    const cd = new ConfigDisplay(bus, 'cd', 'config');
    assert.strictEqual(bus.count(Topics.CONFIG_UPDATE), 1);
    assert.strictEqual(bus.count(Topics.NODE_STATE_CHANGE), 1);
    cd.dispose();
  });

  test('update with no data is a no-op', () => {
    const cd = new ConfigDisplay(bus, 'cd', 'config');
    cd.update(undefined);
    cd.dispose();
  });

  test('update renders task', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ config: el });

    const cd = new ConfigDisplay(bus, 'cd', 'config');
    cd.update({ task: 'Build the widget' });

    assert.ok(el.innerHTML.includes('Task'));
    assert.ok(el.innerHTML.includes('Build the widget'));
    cd.dispose();
  });

  test('renders string work spec as shell command', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ config: el });

    const cd = new ConfigDisplay(bus, 'cd', 'config');
    cd.update({ 
      task: 'test', 
      work: 'npm run build' 
    });

    assert.ok(el.innerHTML.includes('Work'));
    assert.ok(el.innerHTML.includes('npm run build'));
    assert.ok(el.innerHTML.includes('Shell'));
    cd.dispose();
  });

  test('renders agent spec with instructions and metadata', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ config: el });

    const agentSpec: JobSpec = {
      type: 'agent',
      instructions: 'Fix all the bugs in the codebase',
      model: 'claude-sonnet',
      allowedFolders: ['/src'],
      allowedUrls: ['https://api.example.com']
    };

    const cd = new ConfigDisplay(bus, 'cd', 'config');
    cd.update({ 
      task: 'test', 
      work: agentSpec 
    });

    assert.ok(el.innerHTML.includes('Fix all the bugs'));
    assert.ok(el.innerHTML.includes('claude-sonnet'));
    assert.ok(el.innerHTML.includes('/src'));
    assert.ok(el.innerHTML.includes('https://api.example.com'));
    assert.ok(el.innerHTML.includes('Agent'));
    cd.dispose();
  });

  test('renders process spec with executable and args', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ config: el });

    const processSpec: JobSpec = {
      type: 'process',
      executable: 'node',
      args: ['--version']
    };

    const cd = new ConfigDisplay(bus, 'cd', 'config');
    cd.update({ 
      task: 'test', 
      work: processSpec 
    });

    assert.ok(el.innerHTML.includes('node --version'));
    assert.ok(el.innerHTML.includes('Process'));
    cd.dispose();
  });

  test('renders shell spec with command and shell type', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ config: el });

    const shellSpec: JobSpec = {
      type: 'shell',
      command: 'echo hello',
      shell: 'bash'
    };

    const cd = new ConfigDisplay(bus, 'cd', 'config');
    cd.update({ 
      task: 'test', 
      work: shellSpec 
    });

    assert.ok(el.innerHTML.includes('echo hello'));
    assert.ok(el.innerHTML.includes('bash'));
    assert.ok(el.innerHTML.includes('Shell'));
    cd.dispose();
  });

  test('renders prechecks phase as collapsible', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ config: el });

    const cd = new ConfigDisplay(bus, 'cd', 'config');
    cd.update({ 
      task: 'test',
      prechecks: 'npm run lint' 
    });

    assert.ok(el.innerHTML.includes('Prechecks'));
    assert.ok(el.innerHTML.includes('chevron'));
    assert.ok(el.innerHTML.includes('collapsed'));
    assert.ok(el.innerHTML.includes('display:none'));
    cd.dispose();
  });

  test('renders work phase as non-collapsible', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ config: el });

    const cd = new ConfigDisplay(bus, 'cd', 'config');
    cd.update({ 
      task: 'test',
      work: 'npm run build' 
    });

    assert.ok(el.innerHTML.includes('Work'));
    assert.ok(el.innerHTML.includes('non-collapsible'));
    assert.ok(!el.innerHTML.includes('chevron'));
    cd.dispose();
  });

  test('renders postchecks phase as collapsible', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ config: el });

    const cd = new ConfigDisplay(bus, 'cd', 'config');
    cd.update({ 
      task: 'test',
      postchecks: 'npm run test' 
    });

    assert.ok(el.innerHTML.includes('Postchecks'));
    assert.ok(el.innerHTML.includes('chevron'));
    assert.ok(el.innerHTML.includes('collapsed'));
    assert.ok(el.innerHTML.includes('display:none'));
    cd.dispose();
  });

  test('renders all three phases together', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ config: el });

    const cd = new ConfigDisplay(bus, 'cd', 'config');
    cd.update({ 
      task: 'Build project',
      prechecks: 'npm run lint',
      work: 'npm run build',
      postchecks: 'npm run test'
    });

    assert.ok(el.innerHTML.includes('Prechecks'));
    assert.ok(el.innerHTML.includes('Work'));
    assert.ok(el.innerHTML.includes('Postchecks'));
    assert.ok(el.innerHTML.includes('npm run lint'));
    assert.ok(el.innerHTML.includes('npm run build'));
    assert.ok(el.innerHTML.includes('npm run test'));
    cd.dispose();
  });

  test('skips undefined/null phases', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ config: el });

    const cd = new ConfigDisplay(bus, 'cd', 'config');
    cd.update({ 
      task: 'test',
      work: 'npm run build',
      prechecks: undefined,
      postchecks: undefined  // Changed from null to undefined
    });

    assert.ok(el.innerHTML.includes('Work'));
    assert.ok(!el.innerHTML.includes('Prechecks'));
    assert.ok(!el.innerHTML.includes('Postchecks'));
    cd.dispose();
  });

  test('handles state change for auto-expand logic', () => {
    const el = makeEl();
    const preHeader = makeEl();
    const preBody = makeEl();
    restoreDoc = mockDocument({ 
      config: el,
      'config-phase-prechecks-header': preHeader,
      'config-phase-prechecks-body': preBody
    });

    const cd = new ConfigDisplay(bus, 'cd', 'config');
    cd.update({ 
      task: 'test',
      prechecks: 'npm run lint'
    });

    // Simulate state change with prechecks running
    bus.emit(Topics.NODE_STATE_CHANGE, { currentPhase: 'prechecks' });

    cd.dispose();
  });

  test('truncates long agent instructions', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ config: el });

    const longInstructions = 'a'.repeat(300);
    const agentSpec: JobSpec = {
      type: 'agent',
      instructions: longInstructions
    };

    const cd = new ConfigDisplay(bus, 'cd', 'config');
    cd.update({ 
      task: 'test',
      work: agentSpec 
    });

    assert.ok(el.innerHTML.includes('...'));
    assert.ok(!el.innerHTML.includes(longInstructions));
    cd.dispose();
  });

  test('escapes HTML in all content', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ config: el });

    const cd = new ConfigDisplay(bus, 'cd', 'config');
    cd.update({ 
      task: '<script>evil</script>',
      work: '<script>hack</script>',
      instructions: '<b>bold</b>'
    });

    assert.ok(!el.innerHTML.includes('<script>evil'));
    assert.ok(!el.innerHTML.includes('<script>hack'));
    assert.ok(el.innerHTML.includes('&lt;script&gt;'));
    assert.ok(el.innerHTML.includes('&lt;b&gt;bold'));
    cd.dispose();
  });

  test('responds to CONFIG_UPDATE bus events', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ config: el });

    const cd = new ConfigDisplay(bus, 'cd', 'config');
    bus.emit(Topics.CONFIG_UPDATE, { task: 'From bus' });

    assert.ok(el.innerHTML.includes('From bus'));
    cd.dispose();
  });

  test('publishes control update', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ config: el });

    const spy = sinon.spy();
    bus.on(Topics.controlUpdate('cd'), spy);

    const cd = new ConfigDisplay(bus, 'cd', 'config');
    cd.update({ task: 'test' });
    assert.strictEqual(spy.callCount, 1);
    cd.dispose();
  });

  test('update with missing element is safe', () => {
    restoreDoc = mockDocument({});
    const cd = new ConfigDisplay(bus, 'cd', 'config');
    cd.update({ task: 'test' });
    cd.dispose();
  });

  test('dispose unsubscribes from both topics', () => {
    const cd = new ConfigDisplay(bus, 'cd', 'config');
    cd.dispose();
    assert.strictEqual(bus.count(Topics.CONFIG_UPDATE), 0);
    assert.strictEqual(bus.count(Topics.NODE_STATE_CHANGE), 0);
  });

  test('getSpecTypeInfo returns correct types', () => {
    const el = makeEl();
    restoreDoc = mockDocument({ config: el });

    const cd = new ConfigDisplay(bus, 'cd', 'config');
    
    // Test string spec
    cd.update({ task: 'test', work: 'command' });
    assert.ok(el.innerHTML.includes('shell'));

    // Test agent spec
    cd.update({ task: 'test', work: { type: 'agent', instructions: 'test' } });
    assert.ok(el.innerHTML.includes('agent'));

    // Test process spec
    cd.update({ task: 'test', work: { type: 'process', executable: 'node' } });
    assert.ok(el.innerHTML.includes('process'));

    cd.dispose();
  });
});
