// <copyright file="VsCodeWindowId.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.VsCode.Transport;

/// <summary>
/// Identifies a single VS Code window. Each window owns its own
/// <see cref="TransportSession"/> and, transitively, its own
/// <see cref="AiOrchestrator.Bindings.Node.HandleScope"/> (see INV-2).
/// </summary>
/// <param name="Value">The opaque window identifier supplied by the extension host.</param>
public readonly record struct VsCodeWindowId(string Value);
