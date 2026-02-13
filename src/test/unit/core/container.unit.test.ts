/**
 * @fileoverview Unit tests for ServiceContainer
 */

import * as assert from 'assert';
import { ServiceContainer, ServiceFactory } from '../../../core/container';

// Test interfaces and tokens
const TestTokenA = Symbol('TestTokenA');
const TestTokenB = Symbol('TestTokenB');
const TestTokenSingleton = Symbol('TestTokenSingleton');
const TestTokenNotRegistered = Symbol('TestTokenNotRegistered');

interface TestServiceA {
  name: string;
  getValue(): string;
}

interface TestServiceB {
  name: string;
  dependency: TestServiceA;
}

interface TestSingletonService {
  id: number;
}

class MockTestServiceA implements TestServiceA {
  name = 'ServiceA';
  getValue(): string {
    return 'test-value-a';
  }
}

class MockTestServiceB implements TestServiceB {
  name = 'ServiceB';
  constructor(public dependency: TestServiceA) {}
}

class MockSingletonService implements TestSingletonService {
  private static instanceCount = 0;
  public readonly id: number;

  constructor() {
    MockSingletonService.instanceCount++;
    this.id = MockSingletonService.instanceCount;
  }

  static getInstanceCount(): number {
    return this.instanceCount;
  }

  static resetCounter(): void {
    this.instanceCount = 0;
  }
}

suite('ServiceContainer', () => {
  let container: ServiceContainer;

  setup(() => {
    container = new ServiceContainer();
    MockSingletonService.resetCounter();
  });

  suite('register and resolve', () => {
    test('should register and resolve a simple service', () => {
      // Arrange
      const factory: ServiceFactory<TestServiceA> = () => new MockTestServiceA();
      
      // Act
      container.register(TestTokenA, factory);
      const service = container.resolve<TestServiceA>(TestTokenA);
      
      // Assert
      assert.ok(service instanceof MockTestServiceA);
      assert.strictEqual(service.name, 'ServiceA');
      assert.strictEqual(service.getValue(), 'test-value-a');
    });

    test('should create new instances for each resolve call', () => {
      // Arrange
      container.register(TestTokenA, () => new MockTestServiceA());
      
      // Act
      const service1 = container.resolve<TestServiceA>(TestTokenA);
      const service2 = container.resolve<TestServiceA>(TestTokenA);
      
      // Assert
      assert.notStrictEqual(service1, service2, 'Should be different instances');
      assert.strictEqual(service1.name, service2.name);
    });

    test('should resolve service with dependencies', () => {
      // Arrange
      container.register(TestTokenA, () => new MockTestServiceA());
      container.register(TestTokenB, (c) => new MockTestServiceB(c.resolve<TestServiceA>(TestTokenA)));
      
      // Act
      const serviceB = container.resolve<TestServiceB>(TestTokenB);
      
      // Assert
      assert.strictEqual(serviceB.name, 'ServiceB');
      assert.ok(serviceB.dependency instanceof MockTestServiceA);
      assert.strictEqual(serviceB.dependency.name, 'ServiceA');
    });

    test('should throw error for unregistered service', () => {
      // Act & Assert
      assert.throws(
        () => container.resolve(TestTokenNotRegistered),
        /Service not registered: Symbol\(TestTokenNotRegistered\)/
      );
    });
  });

  suite('singleton behavior', () => {
    test('should register and resolve singleton service', () => {
      // Arrange
      container.registerSingleton(TestTokenSingleton, () => new MockSingletonService());
      
      // Act
      const service = container.resolve<TestSingletonService>(TestTokenSingleton);
      
      // Assert
      assert.strictEqual(service.id, 1);
      assert.strictEqual(MockSingletonService.getInstanceCount(), 1);
    });

    test('should return same instance for multiple singleton resolves', () => {
      // Arrange
      container.registerSingleton(TestTokenSingleton, () => new MockSingletonService());
      
      // Act
      const service1 = container.resolve<TestSingletonService>(TestTokenSingleton);
      const service2 = container.resolve<TestSingletonService>(TestTokenSingleton);
      
      // Assert
      assert.strictEqual(service1, service2, 'Should be same instance');
      assert.strictEqual(service1.id, 1);
      assert.strictEqual(MockSingletonService.getInstanceCount(), 1);
    });

    test('should create different instances for regular vs singleton registration', () => {
      // Arrange
      container.register(TestTokenA, () => new MockSingletonService());
      container.registerSingleton(TestTokenSingleton, () => new MockSingletonService());
      
      // Act
      const regular1 = container.resolve(TestTokenA);
      const regular2 = container.resolve(TestTokenA);
      const singleton1 = container.resolve(TestTokenSingleton);
      const singleton2 = container.resolve(TestTokenSingleton);
      
      // Assert
      assert.notStrictEqual(regular1, regular2, 'Regular services should be different');
      assert.strictEqual(singleton1, singleton2, 'Singleton should be same');
      assert.strictEqual(MockSingletonService.getInstanceCount(), 3);
    });
  });

  suite('lazy initialization', () => {
    test('should not call factory until first resolve', () => {
      // Arrange
      let factoryCalled = false;
      const factory = () => {
        factoryCalled = true;
        return new MockTestServiceA();
      };
      
      // Act
      container.register(TestTokenA, factory);
      
      // Assert
      assert.strictEqual(factoryCalled, false, 'Factory should not be called on register');
      
      // Act
      container.resolve(TestTokenA);
      
      // Assert
      assert.strictEqual(factoryCalled, true, 'Factory should be called on first resolve');
    });

    test('should call singleton factory only once', () => {
      // Arrange
      let factoryCallCount = 0;
      const factory = () => {
        factoryCallCount++;
        return new MockSingletonService();
      };
      
      // Act
      container.registerSingleton(TestTokenSingleton, factory);
      container.resolve(TestTokenSingleton);
      container.resolve(TestTokenSingleton);
      container.resolve(TestTokenSingleton);
      
      // Assert
      assert.strictEqual(factoryCallCount, 1, 'Singleton factory should be called only once');
    });
  });

  suite('scoped containers', () => {
    test('should create child container', () => {
      // Act
      const child = container.createScope();
      
      // Assert
      assert.ok(child instanceof ServiceContainer);
      assert.notStrictEqual(child, container);
    });

    test('should inherit parent registrations', () => {
      // Arrange
      container.register(TestTokenA, () => new MockTestServiceA());
      const child = container.createScope();
      
      // Act
      const service = child.resolve<TestServiceA>(TestTokenA);
      
      // Assert
      assert.ok(service instanceof MockTestServiceA);
      assert.strictEqual(service.name, 'ServiceA');
    });

    test('should allow child to override parent registrations', () => {
      // Arrange
      container.register(TestTokenA, () => {
        const service = new MockTestServiceA();
        service.name = 'ParentService';
        return service;
      });
      
      const child = container.createScope();
      child.register(TestTokenA, () => {
        const service = new MockTestServiceA();
        service.name = 'ChildService';
        return service;
      });
      
      // Act
      const parentService = container.resolve<TestServiceA>(TestTokenA);
      const childService = child.resolve<TestServiceA>(TestTokenA);
      
      // Assert
      assert.strictEqual(parentService.name, 'ParentService');
      assert.strictEqual(childService.name, 'ChildService');
    });

    test('should share singleton instances between parent and child', () => {
      // Arrange
      container.registerSingleton(TestTokenSingleton, () => new MockSingletonService());
      const child = container.createScope();
      
      // Act
      const parentService = container.resolve<TestSingletonService>(TestTokenSingleton);
      const childService = child.resolve<TestSingletonService>(TestTokenSingleton);
      
      // Assert
      assert.strictEqual(parentService, childService, 'Should share singleton instance');
      assert.strictEqual(parentService.id, 1);
      assert.strictEqual(MockSingletonService.getInstanceCount(), 1);
    });

    test('should allow child to override singleton with new singleton', () => {
      // Arrange
      container.registerSingleton(TestTokenSingleton, () => new MockSingletonService());
      const child = container.createScope();
      child.registerSingleton(TestTokenSingleton, () => new MockSingletonService());
      
      // Act
      const parentService = container.resolve<TestSingletonService>(TestTokenSingleton);
      const childService = child.resolve<TestSingletonService>(TestTokenSingleton);
      
      // Assert
      assert.notStrictEqual(parentService, childService, 'Should be different instances');
      assert.strictEqual(parentService.id, 1);
      assert.strictEqual(childService.id, 2);
    });

    test('should support nested scopes', () => {
      // Arrange
      container.register(TestTokenA, () => {
        const service = new MockTestServiceA();
        service.name = 'Root';
        return service;
      });
      
      const child = container.createScope();
      const grandchild = child.createScope();
      grandchild.register(TestTokenA, () => {
        const service = new MockTestServiceA();
        service.name = 'Grandchild';
        return service;
      });
      
      // Act
      const rootService = container.resolve<TestServiceA>(TestTokenA);
      const childService = child.resolve<TestServiceA>(TestTokenA);
      const grandchildService = grandchild.resolve<TestServiceA>(TestTokenA);
      
      // Assert
      assert.strictEqual(rootService.name, 'Root');
      assert.strictEqual(childService.name, 'Root'); // Inherited from parent
      assert.strictEqual(grandchildService.name, 'Grandchild');
    });
  });

  suite('isRegistered', () => {
    test('should return true for registered service', () => {
      // Arrange
      container.register(TestTokenA, () => new MockTestServiceA());
      
      // Act & Assert
      assert.strictEqual(container.isRegistered(TestTokenA), true);
    });

    test('should return false for unregistered service', () => {
      // Act & Assert
      assert.strictEqual(container.isRegistered(TestTokenNotRegistered), false);
    });

    test('should return true for service registered in parent', () => {
      // Arrange
      container.register(TestTokenA, () => new MockTestServiceA());
      const child = container.createScope();
      
      // Act & Assert
      assert.strictEqual(child.isRegistered(TestTokenA), true);
    });

    test('should return false for service not in parent chain', () => {
      // Arrange
      const child = container.createScope();
      
      // Act & Assert
      assert.strictEqual(child.isRegistered(TestTokenNotRegistered), false);
    });
  });

  suite('error cases', () => {
    test('should handle factory throwing error', () => {
      // Arrange
      const factory = () => {
        throw new Error('Factory error');
      };
      container.register(TestTokenA, factory);
      
      // Act & Assert
      assert.throws(
        () => container.resolve(TestTokenA),
        /Factory error/
      );
    });

    test('should handle circular dependencies gracefully', () => {
      // Note: This test demonstrates the behavior but doesn't prevent infinite recursion
      // Real implementation might want to detect and prevent circular dependencies
      const TokenCircularA = Symbol('CircularA');
      const TokenCircularB = Symbol('CircularB');
      
      container.register(TokenCircularA, (c) => ({ 
        name: 'A', 
        dep: c.resolve(TokenCircularB) 
      }));
      container.register(TokenCircularB, (c) => ({ 
        name: 'B', 
        dep: c.resolve(TokenCircularA) 
      }));
      
      // This will cause a stack overflow, which is expected behavior
      // In a real implementation, you might want to add circular dependency detection
      assert.throws(() => container.resolve(TokenCircularA));
    });
  });
});