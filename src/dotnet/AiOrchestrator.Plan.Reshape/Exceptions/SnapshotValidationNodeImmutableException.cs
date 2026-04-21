// <copyright file="SnapshotValidationNodeImmutableException.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;

namespace AiOrchestrator.Plan.Reshape;

/// <summary>
/// Raised when a reshape operation targets the auto-managed snapshot-validation node
/// (<c>producerId = __snapshot-validation__</c>). This node is immutable per INV-8 / RS-SV.
/// </summary>
#pragma warning disable CA1032 // Exception parameterless ctor
public sealed class SnapshotValidationNodeImmutableException : Exception
#pragma warning restore CA1032
{
    /// <summary>Sentinel node id recognised as the snapshot-validation node.</summary>
    public const string NodeId = "__snapshot-validation__";
}
