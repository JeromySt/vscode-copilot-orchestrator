// <copyright file="KeyCeremonyToolingStub.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.SkewManifest.Tools;

/// <summary>
/// Marker type referenced by the offline key-ceremony binary (job 043).
/// The daemon (this assembly) never calls into this type; analyzer OE0043 enforces that.
/// See docs/SECURITY.md § "Key ceremony" for the ceremony policy.
/// </summary>
public sealed class KeyCeremonyToolingStub
{
    private KeyCeremonyToolingStub()
    {
        // Intentionally empty: M-of-N signing tooling lives in tools/key-ceremony.
    }
}
