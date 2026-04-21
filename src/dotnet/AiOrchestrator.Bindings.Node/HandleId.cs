// <copyright file="HandleId.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Bindings.Node;

/// <summary>
/// Opaque identifier for a .NET object exposed to a Node caller via N-API.
/// The Node side never holds a direct reference to the underlying instance;
/// all access is mediated by the <see cref="NodeBindingsHost"/>.
/// </summary>
/// <param name="Value">The monotonically increasing numeric identifier.</param>
public readonly record struct HandleId(long Value);
