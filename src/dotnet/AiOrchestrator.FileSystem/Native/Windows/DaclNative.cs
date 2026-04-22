// <copyright file="DaclNative.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.IO;
using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Principal;

namespace AiOrchestrator.FileSystem.Native.Windows;

/// <summary>
/// Helpers that apply an owner-only Discretionary Access Control List (DACL)
/// to a freshly created file on Windows (per CMD-TMP-1 INV-4).
/// </summary>
[SupportedOSPlatform("windows")]
internal static class DaclNative
{
    /// <summary>Replaces the file's DACL with one that grants only the current user FullControl.</summary>
    /// <param name="path">Absolute path to the file (must exist).</param>
    internal static void ApplyOwnerOnlyDacl(string path)
    {
        var fileInfo = new FileInfo(path);
        var owner = WindowsIdentity.GetCurrent().User
            ?? throw new InvalidOperationException("Unable to resolve current Windows identity SID.");

        var security = fileInfo.GetAccessControl();
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);

        // Strip any inherited/explicit rules that snuck in, then add a single owner-only rule.
        var existing = security.GetAccessRules(true, false, typeof(SecurityIdentifier));
        foreach (System.Security.AccessControl.FileSystemAccessRule rule in existing)
        {
            _ = security.RemoveAccessRule(rule);
        }

        security.AddAccessRule(new FileSystemAccessRule(
            owner,
            FileSystemRights.FullControl,
            InheritanceFlags.None,
            PropagationFlags.None,
            AccessControlType.Allow));

        fileInfo.SetAccessControl(security);
    }
}
