// <copyright file="LinkValidator.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Diagnostics.CodeAnalysis;
using System.Runtime.InteropServices;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.HookGate.Validation;

/// <summary>
/// Validates that a hook file has not been tampered with prior to approval (HK-GATE-LINK-3 v1.4).
/// POSIX: stats the file and rejects if <c>st_nlink &gt; 1</c> (multiple hardlinks indicate
/// tamper) or if the resolved canonical path is outside the worktree. Windows: rejects any
/// reparse point whose resolved target leaves the worktree.
/// </summary>
internal sealed partial class LinkValidator
{
    private readonly IFileSystem fs;

    public LinkValidator(IFileSystem fs)
    {
        this.fs = fs ?? throw new ArgumentNullException(nameof(fs));
    }

    public async ValueTask<LinkValidationResult> ValidateAsync(AbsolutePath hookFile, AbsolutePath worktreeRoot, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        if (!await this.fs.FileExistsAsync(hookFile, ct).ConfigureAwait(false))
        {
            return new LinkValidationResult { Ok = false, FailureReason = "hook file does not exist" };
        }

        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return ValidateWindows(hookFile, worktreeRoot);
        }

        return ValidatePosix(hookFile, worktreeRoot);
    }

    // ---- POSIX -----------------------------------------------------------

    [ExcludeFromCodeCoverage(Justification = "POSIX-only struct layout for libc interop.")]
    [StructLayout(LayoutKind.Sequential)]
    private struct LinuxStat64
    {
        public ulong st_dev;
        public ulong st_ino;
        public ulong st_nlink;
        public uint st_mode;
        public uint st_uid;
        public uint st_gid;
        public uint __pad0;
        public ulong st_rdev;
        public long st_size;
        public long st_blksize;
        public long st_blocks;
        public long st_atime;
        public long st_atime_nsec;
        public long st_mtime;
        public long st_mtime_nsec;
        public long st_ctime;
        public long st_ctime_nsec;
        public long __unused_1;
        public long __unused_2;
        public long __unused_3;
    }

    [LibraryImport("libc", SetLastError = true, EntryPoint = "__xstat64", StringMarshalling = StringMarshalling.Utf8)]
    private static partial int XStat64(int ver, string path, out LinuxStat64 buf);

    [LibraryImport("libc", SetLastError = true, EntryPoint = "stat", StringMarshalling = StringMarshalling.Utf8)]
    private static partial int StatFallback(string path, out LinuxStat64 buf);

    [ExcludeFromCodeCoverage(Justification = "POSIX-only path; covered by Linux CI only.")]
    private static LinkValidationResult ValidatePosix(AbsolutePath hookFile, AbsolutePath worktreeRoot)
    {
        // st_nlink check (Linux only — on macOS we approximate via FileInfo resolved target).
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Linux))
        {
            LinuxStat64 st = default;
            var rc = -1;
            try
            {
                rc = XStat64(1, hookFile.Value, out st);
            }
            catch (DllNotFoundException)
            {
                rc = -1;
            }
            catch (EntryPointNotFoundException)
            {
                rc = -1;
            }

            if (rc != 0)
            {
                try
                {
                    rc = StatFallback(hookFile.Value, out st);
                }
                catch (DllNotFoundException)
                {
                    // libc unavailable — treat as unable-to-check (fail-closed).
                    return new LinkValidationResult { Ok = false, FailureReason = "stat() unavailable" };
                }
                catch (EntryPointNotFoundException)
                {
                    return new LinkValidationResult { Ok = false, FailureReason = "stat() entry point missing" };
                }
            }

            if (rc != 0)
            {
                return new LinkValidationResult { Ok = false, FailureReason = "stat() returned non-zero" };
            }

            if (st.st_nlink > 1)
            {
                return new LinkValidationResult { Ok = false, FailureReason = $"st_nlink={st.st_nlink}" };
            }
        }

        // Canonical path must remain inside the worktree.
        string canonical;
        try
        {
            canonical = Path.GetFullPath(hookFile.Value);
            var target = new FileInfo(canonical).LinkTarget;
            if (target is not null)
            {
                canonical = Path.GetFullPath(Path.IsPathRooted(target) ? target : Path.Combine(Path.GetDirectoryName(canonical) ?? string.Empty, target));
            }
        }
        catch (IOException)
        {
            return new LinkValidationResult { Ok = false, FailureReason = "path canonicalization failed" };
        }

        if (!canonical.StartsWith(Path.GetFullPath(worktreeRoot.Value), StringComparison.Ordinal))
        {
            return new LinkValidationResult { Ok = false, FailureReason = "resolved path outside worktree" };
        }

        return new LinkValidationResult { Ok = true, FailureReason = null };
    }

    // ---- Windows ---------------------------------------------------------

    private static LinkValidationResult ValidateWindows(AbsolutePath hookFile, AbsolutePath worktreeRoot)
    {
        try
        {
            var info = new FileInfo(hookFile.Value);
            var attrs = info.Attributes;
            if ((attrs & FileAttributes.ReparsePoint) != 0)
            {
                var target = info.LinkTarget ?? string.Empty;
                var resolved = Path.IsPathRooted(target)
                    ? target
                    : Path.Combine(info.DirectoryName ?? string.Empty, target);
                resolved = Path.GetFullPath(resolved);
                if (!resolved.StartsWith(Path.GetFullPath(worktreeRoot.Value), StringComparison.OrdinalIgnoreCase))
                {
                    return new LinkValidationResult { Ok = false, FailureReason = "reparse-point target outside worktree" };
                }
            }

            return new LinkValidationResult { Ok = true, FailureReason = null };
        }
        catch (IOException ex)
        {
            return new LinkValidationResult { Ok = false, FailureReason = ex.GetType().Name };
        }
    }
}
