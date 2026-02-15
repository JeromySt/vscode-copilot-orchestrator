/**
 * @fileoverview Dependency injection container for service registration and resolution.
 * 
 * Provides a typed, Symbol-based dependency injection container that supports
 * singleton registration, lazy initialization, and scoped containers.
 * 
 * @module core/container
 */

/** Factory function type for creating service instances. */
export type ServiceFactory<T> = (container: ServiceContainer) => T;

/** Service registration information. */
interface ServiceRegistration<T> {
  factory: ServiceFactory<T>;
  isSingleton: boolean;
  instance?: T;
}

/**
 * Dependency injection container with Symbol-based type safety.
 * 
 * Supports service registration, lazy initialization, singleton pattern,
 * and scoped containers that inherit from parent containers.
 */
export class ServiceContainer {
  private readonly services = new Map<symbol, ServiceRegistration<any>>();
  private readonly parent?: ServiceContainer;

  constructor(parent?: ServiceContainer) {
    this.parent = parent;
  }

  /**
   * Register a service factory. Creates a new instance on each resolve() call.
   */
  register<T>(token: symbol, factory: ServiceFactory<T>): void {
    this.services.set(token, { factory, isSingleton: false });
  }

  /**
   * Register a singleton service factory. Creates only one instance, cached after first resolve().
   */
  registerSingleton<T>(token: symbol, factory: ServiceFactory<T>): void {
    this.services.set(token, { factory, isSingleton: true });
  }

  /**
   * Resolve a service instance.
   * 
   * For regular services, creates a new instance each time.
   * For singletons, returns the cached instance or creates it on first call.
   */
  resolve<T>(token: symbol): T {
    const registration = this.services.get(token);
    if (registration) {
      return this.createInstance(registration);
    }

    if (this.parent) {
      return this.parent.resolve<T>(token);
    }

    throw new Error(`Service not registered: ${token.toString()}`);
  }

  /**
   * Create a scoped child container.
   * 
   * The child inherits all parent registrations and can override them.
   * Singleton instances are shared between parent and child unless overridden.
   */
  createScope(): ServiceContainer {
    return new ServiceContainer(this);
  }

  /**
   * Check if a service is registered in this container or its parents.
   */
  isRegistered(token: symbol): boolean {
    return this.services.has(token) || (this.parent?.isRegistered(token) ?? false);
  }

  /** Create an instance from a service registration. */
  private createInstance<T>(registration: ServiceRegistration<T>): T {
    if (registration.isSingleton && registration.instance) {
      return registration.instance;
    }

    const instance = registration.factory(this);

    if (registration.isSingleton) {
      registration.instance = instance;
    }

    return instance;
  }
}