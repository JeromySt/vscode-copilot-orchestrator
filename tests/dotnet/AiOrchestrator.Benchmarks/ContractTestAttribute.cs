// <copyright file="ContractTestAttribute.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;

namespace AiOrchestrator.Benchmarks;

/// <summary>Marks a test method as a contract test verifying a specific acceptance criterion.</summary>
[AttributeUsage(AttributeTargets.Method, AllowMultiple = false)]
internal sealed class ContractTestAttribute : Attribute
{
    /// <summary>Initializes a new instance of the <see cref="ContractTestAttribute"/> class.</summary>
    /// <param name="id">The contract identifier (e.g., "SLO-ENV-1").</param>
    public ContractTestAttribute(string id) => this.Id = id;

    /// <summary>Gets the contract identifier.</summary>
    public string Id { get; }
}
