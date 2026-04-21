// <copyright file="IDiagnoseObserver.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using AiOrchestrator.Diagnose.Events;

namespace AiOrchestrator.Diagnose;

/// <summary>Observer hook allowing callers to receive <see cref="DiagnoseBundleProduced"/> events in-process.</summary>
public interface IDiagnoseObserver
{
    /// <summary>Invoked after the bundle has been written to disk but before <see cref="Diagnoser.ProduceBundleAsync"/> returns.</summary>
    /// <param name="produced">The event describing the bundle.</param>
    void OnBundleProduced(DiagnoseBundleProduced produced);
}
