# EventVersioning fixtures

This directory holds captured wire-format payloads consumed by the
`EventVersionAcceptanceTests.g.cs` source emitted by `AiOrchestrator.Eventing.Generators`
(rule **EV-GEN-3**).

Layout:

```
tests/dotnet/EventVersioning.Fixtures/
└── <EventTypeName>/
    ├── v1.json
    ├── v2.json
    └── ...
```

For every `[EventV(name, version)]` type discovered in a compilation, the
generator emits a case at `<EventTypeName>/v<N>.json`. Tests in the consuming
project iterate `EventVersionAcceptanceCases.All` and assert each captured
payload deserializes and migrates through to the latest version with no data
loss.

The wire-format bytes themselves are owned by job 13 (event-store wire format).
