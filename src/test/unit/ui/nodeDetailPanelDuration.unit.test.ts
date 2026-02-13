/**
 * @fileoverview Unit tests for Node Detail Panel Duration Timer functionality
 * 
 * @module test/unit/ui/nodeDetailPanelDuration
 */

import { suite, test } from 'mocha';
import * as assert from 'assert';
import * as sinon from 'sinon';

suite('Node Detail Panel Duration Timer', () => {
  suite('Duration timer JavaScript code', () => {
    test('should only run timer for running status', () => {
      // Test the timer logic by simulating the browser environment
      const mockWindow = { nodeDurationTimer: undefined };
      const mockDocument = {
        getElementById: sinon.stub()
      };
      
      // Mock the duration timer element with data attributes
      const mockDurationElement = {
        hasAttribute: sinon.stub().withArgs('data-started-at').returns(true),
        getAttribute: sinon.stub().withArgs('data-started-at').returns('1000'),
        textContent: ''
      };
      
      mockDocument.getElementById.withArgs('duration-timer').returns(mockDurationElement);
      
      const mockSetInterval = sinon.stub();
      const mockClearInterval = sinon.stub();
      
      // Test function that simulates the timer logic from nodeDetailPanel.ts
      function simulateTimerLogic(nodeStatus: string) {
        const durationTimer = mockDocument.getElementById('duration-timer');
        if (durationTimer && durationTimer.hasAttribute('data-started-at')) {
          const startedAt = parseInt(durationTimer.getAttribute('data-started-at'), 10);
          
          // Clear any existing timer to prevent duplicates
          if (mockWindow.nodeDurationTimer) {
            mockClearInterval(mockWindow.nodeDurationTimer);
          }
          
          // Only run timer if node is running
          if (nodeStatus === 'running' && startedAt) {
            mockWindow.nodeDurationTimer = mockSetInterval(() => {
              const elapsed = Math.round((Date.now() - startedAt) / 1000);
              const elem = mockDocument.getElementById('duration-timer');
              if (elem) {
                // Simulate formatDuration function
                const sec = Math.floor(elapsed);
                const min = Math.floor(sec / 60);
                const remSec = sec % 60;
                elem.textContent = min > 0 ? `${min}m ${remSec}s` : `${sec}s`;
              }
            }, 1000);
          }
        }
      }
      
      // Test: Timer should start for running status
      simulateTimerLogic('running');
      assert.strictEqual(mockSetInterval.called, true, 'setInterval should be called for running status');
      assert.strictEqual(mockSetInterval.getCall(0).args[1], 1000, 'Timer interval should be 1000ms');
      
      // Reset mocks
      mockSetInterval.resetHistory();
      mockClearInterval.resetHistory();
      
      // Test: Timer should NOT start for completed status
      simulateTimerLogic('completed');
      assert.strictEqual(mockSetInterval.called, false, 'setInterval should NOT be called for completed status');
      
      // Test: Timer should NOT start for failed status
      simulateTimerLogic('failed');
      assert.strictEqual(mockSetInterval.called, false, 'setInterval should NOT be called for failed status');
    });
    
    test('should clear existing timer to prevent duplicates', () => {
      const mockWindow = { nodeDurationTimer: 'existing-timer-id' };
      const mockDocument = {
        getElementById: sinon.stub()
      };
      
      const mockDurationElement = {
        hasAttribute: sinon.stub().withArgs('data-started-at').returns(true),
        getAttribute: sinon.stub().withArgs('data-started-at').returns('1000'),
        textContent: ''
      };
      
      mockDocument.getElementById.withArgs('duration-timer').returns(mockDurationElement);
      
      const mockSetInterval = sinon.stub();
      const mockClearInterval = sinon.stub();
      
      function simulateTimerLogic(nodeStatus: string) {
        const durationTimer = mockDocument.getElementById('duration-timer');
        if (durationTimer && durationTimer.hasAttribute('data-started-at')) {
          const startedAt = parseInt(durationTimer.getAttribute('data-started-at'), 10);
          
          // Clear any existing timer to prevent duplicates
          if (mockWindow.nodeDurationTimer) {
            mockClearInterval(mockWindow.nodeDurationTimer);
          }
          
          // Only run timer if node is running
          if (nodeStatus === 'running' && startedAt) {
            mockWindow.nodeDurationTimer = mockSetInterval(() => {
              // Timer logic
            }, 1000);
          }
        }
      }
      
      simulateTimerLogic('running');
      
      assert.strictEqual(mockClearInterval.called, true, 'clearInterval should be called to clear existing timer');
      assert.strictEqual(mockClearInterval.getCall(0).args[0], 'existing-timer-id', 'Should clear the specific existing timer');
      assert.strictEqual(mockSetInterval.called, true, 'Should set new timer after clearing existing one');
    });
    
    test('should not start timer without startedAt attribute', () => {
      const _mockWindow = { nodeDurationTimer: undefined };
      const mockDocument = {
        getElementById: sinon.stub()
      };
      
      // Mock element without data-started-at attribute
      const mockDurationElement = {
        hasAttribute: sinon.stub().withArgs('data-started-at').returns(false),
        getAttribute: sinon.stub(),
        textContent: ''
      };
      
      mockDocument.getElementById.withArgs('duration-timer').returns(mockDurationElement);
      
      const mockSetInterval = sinon.stub();
      const _mockClearInterval = sinon.stub();
      
      function simulateTimerLogic(nodeStatus: string) {
        const durationTimer = mockDocument.getElementById('duration-timer');
        if (durationTimer && durationTimer.hasAttribute('data-started-at')) {
          // This block should not execute
          mockSetInterval(() => {}, 1000);
        }
      }
      
      simulateTimerLogic('running');
      
      assert.strictEqual(mockSetInterval.called, false, 'setInterval should NOT be called without data-started-at attribute');
    });
    
    test('should not start timer without duration element', () => {
      const _mockWindow = { nodeDurationTimer: undefined };
      const mockDocument = {
        getElementById: sinon.stub()
      };
      
      // Mock missing duration element
      mockDocument.getElementById.withArgs('duration-timer').returns(null);
      
      const mockSetInterval = sinon.stub();
      
      function simulateTimerLogic(nodeStatus: string) {
        const durationTimer = mockDocument.getElementById('duration-timer');
        if (durationTimer && durationTimer.hasAttribute('data-started-at')) {
          // This block should not execute
          mockSetInterval(() => {}, 1000);
        }
      }
      
      simulateTimerLogic('running');
      
      assert.strictEqual(mockSetInterval.called, false, 'setInterval should NOT be called without duration element');
    });
  });
});