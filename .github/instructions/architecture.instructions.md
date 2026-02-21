---
applyTo: "src/interfaces/**,src/composition.ts,src/core/tokens.ts,src/core/container.ts,src/plan/dagUtils.ts,src/plan/svNodeBuilder.ts,src/plan/repository/**,docs/ARCHITECTURE.md"
---

# Architecture Requirements

When creating, modifying, or reviewing files in the interfaces, composition root,
DI container, DAG utilities, or repository layers, follow the architecture and
DI patterns defined in `software-architect.instructions.md` and `di-refactor.instructions.md`.

Key areas covered:
- Component communication diagrams (Mermaid sequence diagrams)
- Composition over creation mandate
- Adapter pattern for external dependencies
- Single responsibility boundaries
- Three-layer storage architecture
- Phase pipeline contract
- DI wiring patterns

## Mandatory for new components

When adding a NEW interface, service, or subsystem:
1. Review the architecture instructions FIRST
2. Verify the new component fits the existing sequence diagram
3. If it introduces a new communication path, update the diagram in `software-architect.instructions.md`
4. Follow the interface → token → implementation → composition root pipeline
5. Ensure the component is testable with mocked dependencies
