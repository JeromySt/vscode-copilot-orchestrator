// <copyright file="ContractTestAttribute.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;

namespace AiOrchestrator.Acceptance;

/// <summary>Marks a test as a contract test verifying a specific acceptance criterion.</summary>
[AttributeUsage(AttributeTargets.Method, AllowMultiple = false)]
public sealed class ContractTestAttribute : Attribute
{
    /// <summary>Initializes a new instance of the <see cref="ContractTestAttribute"/> class.</summary>
    /// <param name="id">The acceptance test identifier (e.g. "ACCEPT-COVERAGE").</param>
    public ContractTestAttribute(string id) => this.Id = id;

    /// <summary>Gets the acceptance test identifier.</summary>
    public string Id { get; }
}
