// <copyright file="UserConcurrencyOptions.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Concurrency.User;

/// <summary>Configuration options for the per-user concurrency limiter.</summary>
public sealed class UserConcurrencyOptions
{
    /// <summary>Gets or sets the maximum number of concurrent jobs allowed per user. Default is 4.</summary>
    public int MaxConcurrentPerUser { get; set; } = 4;

    /// <summary>Gets or sets the maximum depth of the FIFO wait queue per user. Default is 1024.</summary>
    public int FifoQueueDepth { get; set; } = 1024;
}
