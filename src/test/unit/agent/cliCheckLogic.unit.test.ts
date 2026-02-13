/**
 * @fileoverview Unit tests for cliCheckLogic module.
 * 
 * Tests the pure business logic for Copilot CLI availability checking
 * and installation guidance without VS Code dependencies.
 */

import { suite, test } from 'mocha';
import * as assert from 'assert';
import {
  evaluateCliAvailability,
  getInstallInstructions,
  determineInstallMethod,
  type CliCheckDecision,
  type CliCheckConfig
} from '../../../agent/cliCheckLogic';

suite('cliCheckLogic', () => {
  
  suite('evaluateCliAvailability', () => {
    
    test('should return "not-required" when CLI is not required', () => {
      const config: CliCheckConfig = {
        required: false,
        preferredInstall: 'auto'
      };
      
      // Should return not-required regardless of availability
      assert.strictEqual(evaluateCliAvailability(config, true), 'not-required');
      assert.strictEqual(evaluateCliAvailability(config, false), 'not-required');
    });
    
    test('should return "available" when CLI is required and available', () => {
      const config: CliCheckConfig = {
        required: true,
        preferredInstall: 'auto'
      };
      
      const result = evaluateCliAvailability(config, true);
      assert.strictEqual(result, 'available');
    });
    
    test('should return "prompt-install" when CLI is required but not available', () => {
      const config: CliCheckConfig = {
        required: true,
        preferredInstall: 'auto'
      };
      
      const result = evaluateCliAvailability(config, false);
      assert.strictEqual(result, 'prompt-install');
    });
    
    test('should handle all preferredInstall options correctly', () => {
      const testCases: Array<{ preferredInstall: 'gh' | 'npm' | 'auto'; expected: CliCheckDecision }> = [
        { preferredInstall: 'gh', expected: 'prompt-install' },
        { preferredInstall: 'npm', expected: 'prompt-install' },
        { preferredInstall: 'auto', expected: 'prompt-install' }
      ];
      
      testCases.forEach(({ preferredInstall, expected }) => {
        const config: CliCheckConfig = {
          required: true,
          preferredInstall
        };
        
        const result = evaluateCliAvailability(config, false);
        assert.strictEqual(result, expected, `Failed for preferredInstall: ${preferredInstall}`);
      });
    });
  });
  
  suite('getInstallInstructions', () => {
    
    test('should return gh extension install instructions for "gh" method', () => {
      const result = getInstallInstructions('gh');
      
      assert.strictEqual(result.label, 'Install via gh');
      assert.strictEqual(result.commands.length, 2);
      assert.strictEqual(result.commands[0], 'gh extension install github/gh-copilot');
      assert.strictEqual(result.commands[1], '# When complete, run: gh copilot --help');
    });
    
    test('should return npm install instructions for "npm" method', () => {
      const result = getInstallInstructions('npm');
      
      assert.strictEqual(result.label, 'Install via npm');
      assert.strictEqual(result.commands.length, 2);
      assert.strictEqual(result.commands[0], 'npm i -g @githubnext/github-copilot-cli');
      assert.strictEqual(result.commands[1], '# When complete, run: copilot --help');
    });
    
    test('should return npm install instructions for unknown method', () => {
      const result = getInstallInstructions('unknown-method');
      
      assert.strictEqual(result.label, 'Install via npm');
      assert.strictEqual(result.commands.length, 2);
      assert.strictEqual(result.commands[0], 'npm i -g @githubnext/github-copilot-cli');
      assert.strictEqual(result.commands[1], '# When complete, run: copilot --help');
    });
    
    test('should return npm install instructions for empty string', () => {
      const result = getInstallInstructions('');
      
      assert.strictEqual(result.label, 'Install via npm');
      assert.strictEqual(result.commands.length, 2);
      assert.strictEqual(result.commands[0], 'npm i -g @githubnext/github-copilot-cli');
      assert.strictEqual(result.commands[1], '# When complete, run: copilot --help');
    });
    
    test('should return consistent structure for all methods', () => {
      const methods = ['gh', 'npm', 'auto', 'invalid', ''];
      
      methods.forEach(method => {
        const result = getInstallInstructions(method);
        
        // Should always have label and commands properties
        assert.ok(typeof result.label === 'string', `Label should be string for method: ${method}`);
        assert.ok(Array.isArray(result.commands), `Commands should be array for method: ${method}`);
        assert.ok(result.commands.length > 0, `Commands should not be empty for method: ${method}`);
        
        // All commands should be strings
        result.commands.forEach((cmd, index) => {
          assert.ok(typeof cmd === 'string', `Command ${index} should be string for method: ${method}`);
        });
      });
    });
  });
  
  suite('determineInstallMethod', () => {
    
    test('should return "gh" when preferredInstall is "gh"', () => {
      // Should prefer gh regardless of availability
      assert.strictEqual(determineInstallMethod('gh', true), 'gh');
      assert.strictEqual(determineInstallMethod('gh', false), 'gh');
    });
    
    test('should return "npm" when preferredInstall is "npm"', () => {
      // Should prefer npm regardless of gh availability
      assert.strictEqual(determineInstallMethod('npm', true), 'npm');
      assert.strictEqual(determineInstallMethod('npm', false), 'npm');
    });
    
    test('should return "gh" when preferredInstall is "auto" and gh is available', () => {
      const result = determineInstallMethod('auto', true);
      assert.strictEqual(result, 'gh');
    });
    
    test('should return "npm" when preferredInstall is "auto" and gh is not available', () => {
      const result = determineInstallMethod('auto', false);
      assert.strictEqual(result, 'npm');
    });
    
    test('should handle all combinations correctly', () => {
      const testCases = [
        { preferredInstall: 'gh' as const, hasGh: true, expected: 'gh' as const },
        { preferredInstall: 'gh' as const, hasGh: false, expected: 'gh' as const },
        { preferredInstall: 'npm' as const, hasGh: true, expected: 'npm' as const },
        { preferredInstall: 'npm' as const, hasGh: false, expected: 'npm' as const },
        { preferredInstall: 'auto' as const, hasGh: true, expected: 'gh' as const },
        { preferredInstall: 'auto' as const, hasGh: false, expected: 'npm' as const }
      ];
      
      testCases.forEach(({ preferredInstall, hasGh, expected }) => {
        const result = determineInstallMethod(preferredInstall, hasGh);
        assert.strictEqual(
          result, 
          expected, 
          `Failed for preferredInstall: ${preferredInstall}, hasGh: ${hasGh}`
        );
      });
    });
  });
  
  suite('integration scenarios', () => {
    
    test('should handle complete workflow when CLI is required but not available', () => {
      const config: CliCheckConfig = {
        required: true,
        preferredInstall: 'auto'
      };
      
      // Step 1: Evaluate availability
      const decision = evaluateCliAvailability(config, false);
      assert.strictEqual(decision, 'prompt-install');
      
      // Step 2: Determine install method (assume gh is available)
      const installMethod = determineInstallMethod(config.preferredInstall, true);
      assert.strictEqual(installMethod, 'gh');
      
      // Step 3: Get install instructions
      const instructions = getInstallInstructions(installMethod);
      assert.strictEqual(instructions.label, 'Install via gh');
      assert.ok(instructions.commands.length > 0);
    });
    
    test('should handle complete workflow when CLI is not required', () => {
      const config: CliCheckConfig = {
        required: false,
        preferredInstall: 'gh'
      };
      
      const decision = evaluateCliAvailability(config, false);
      assert.strictEqual(decision, 'not-required');
      
      // When not required, no further steps should be needed
    });
    
    test('should handle complete workflow when CLI is available', () => {
      const config: CliCheckConfig = {
        required: true,
        preferredInstall: 'npm'
      };
      
      const decision = evaluateCliAvailability(config, true);
      assert.strictEqual(decision, 'available');
      
      // When available, no further steps should be needed
    });
    
    test('should fallback to npm when gh is preferred but not available', () => {
      const config: CliCheckConfig = {
        required: true,
        preferredInstall: 'auto'
      };
      
      // CLI not available, need to install
      const decision = evaluateCliAvailability(config, false);
      assert.strictEqual(decision, 'prompt-install');
      
      // gh CLI not available, should fallback to npm
      const installMethod = determineInstallMethod(config.preferredInstall, false);
      assert.strictEqual(installMethod, 'npm');
      
      const instructions = getInstallInstructions(installMethod);
      assert.strictEqual(instructions.label, 'Install via npm');
    });
  });
});