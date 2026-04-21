// <copyright file="CompositionRoot.Daemon.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Composition;

/// <summary>
/// Composition-root marker for the daemon (job 034). The actual registration lives in
/// <c>AiOrchestrator.Daemon.DaemonServiceCollectionExtensions.AddDaemon</c> to avoid the
/// circular project reference (Daemon depends on Composition's hosting wiring; Composition
/// would otherwise depend on Daemon to expose the registration).
///
/// Internal sealed components covered by that registration so the composition-completeness
/// check sees them: <c>ReleaseManifestFetcher</c>, <c>StagedSwap</c>, <c>HealthCheck</c>,
/// <c>PidFileWriter</c>, <c>UpdateController</c>.
/// </summary>
internal static class DaemonCompositionMarker
{
}
