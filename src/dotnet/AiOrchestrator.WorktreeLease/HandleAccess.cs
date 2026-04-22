// <copyright file="HandleAccess.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Reflection;

namespace AiOrchestrator.WorktreeLease;

/// <summary>
/// Internal helper that updates the mutable-via-reflection fields of a <see cref="LeaseHandle"/>
/// during renewal. <see cref="LeaseHandle"/> exposes <c>init</c>-only properties so its initial
/// construction is via an object initializer; renewals need to mutate the same instance to
/// preserve reference-equality semantics for callers.
/// </summary>
internal static class HandleAccess
{
    private static readonly PropertyInfo TokenProp = typeof(LeaseHandle).GetProperty(nameof(LeaseHandle.Token))!;
    private static readonly PropertyInfo ExpiresProp = typeof(LeaseHandle).GetProperty(nameof(LeaseHandle.ExpiresAt))!;

    public static void Update(LeaseHandle handle, FencingToken token, DateTimeOffset expiresAt)
    {
        TokenProp.SetValue(handle, token);
        ExpiresProp.SetValue(handle, expiresAt);
    }
}
