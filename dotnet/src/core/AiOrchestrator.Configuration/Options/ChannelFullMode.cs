// <copyright file="ChannelFullMode.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Configuration.Options;

/// <summary>Specifies how a bounded channel behaves when it reaches capacity.</summary>
public enum ChannelFullMode
{
    /// <summary>Wait until space is available.</summary>
    Wait,

    /// <summary>Drop the oldest item to make room.</summary>
    DropOldest,

    /// <summary>Drop the newest (incoming) item.</summary>
    DropNewest,

    /// <summary>Throw an exception.</summary>
    Throw,
}
