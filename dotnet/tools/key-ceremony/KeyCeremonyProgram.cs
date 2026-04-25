// <copyright file="KeyCeremonyProgram.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Diagnostics.CodeAnalysis;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Models.Paths;
using AiOrchestrator.SkewManifest.Tools;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace AiOrchestrator.Tools.KeyCeremony;

/// <summary>Entry point for the offline M-of-N HSM key ceremony binary.</summary>
[ExcludeFromCodeCoverage]
public sealed class KeyCeremonyProgram
{
    // J43-PC-6: reference KeyCeremonyToolingStub from AiOrchestrator.SkewManifest so the OE0043 allowlist closes the loop.
    private static readonly Type _stubMarker = typeof(KeyCeremonyToolingStub);

    /// <summary>Program entry point.</summary>
    /// <param name="args">CLI arguments.</param>
    /// <returns>Process exit code (0 success, non-zero failure).</returns>
    public static async Task<int> Main(string[] args)
    {
        try
        {
            var parsed = ParseArgs(args ?? Array.Empty<string>());

            // Resolve dependencies (defaults are wired here so this binary is self-contained).
            var fs = new MinimalFileSystem();
            var clock = new SystemClock();
            var hsm = new Hsm.Pkcs11HsmClient();
            var probe = new DefaultNetworkProbe();
            ITransparencyLogClient tl = parsed.NoTransparencyLog
                ? new StubTransparencyLogClient("(disabled)")
                : new StubTransparencyLogClient();

            var orchestrator = new CeremonyOrchestrator(
                hsm,
                fs,
                clock,
                NullLogger<CeremonyOrchestrator>.Instance,
                probe,
                tl);

            var request = new CeremonyRequest
            {
                UnsignedManifestPath = new AbsolutePath(Path.GetFullPath(parsed.Unsigned!)),
                OutputSignedPath = new AbsolutePath(Path.GetFullPath(parsed.Out!)),
                RequiredSigners = parsed.Signers.Select(s => new HsmOperatorId(s)).ToImmutableArray(),
                CeremonyTranscriptPath = Path.GetFullPath(parsed.Transcript!),
                SubmitToTransparencyLog = !parsed.NoTransparencyLog,
                TransparencyLogUrl = parsed.TransparencyLogUrl,
                AllowNetwork = parsed.AllowNetwork,
            };

            var result = await orchestrator.RunAsync(request, CancellationToken.None).ConfigureAwait(false);
            Console.WriteLine($"Ceremony complete. Signed manifest: {result.SignedManifestPath.Value}");
            Console.WriteLine($"Transcript: {result.TranscriptPath.Value}");
            if (result.TransparencyLogReceipt is not null)
            {
                Console.WriteLine($"Transparency log receipt: {result.TransparencyLogReceipt}");
            }

            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"Ceremony failed: {ex.Message}");
            return 1;
        }
    }

    private static ParsedArgs ParseArgs(string[] args)
    {
        var p = new ParsedArgs();
        for (int i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--unsigned": p.Unsigned = args[++i]; break;
                case "--out": p.Out = args[++i]; break;
                case "--transcript": p.Transcript = args[++i]; break;
                case "--signers": p.Signers = args[++i].Split(',', StringSplitOptions.RemoveEmptyEntries); break;
                case "--allow-network": p.AllowNetwork = true; break;
                case "--transparency-log": p.TransparencyLogUrl = args[++i]; break;
                case "--no-transparency-log": p.NoTransparencyLog = true; break;
                case "--batch":
                    throw new BatchSigningException("Batch mode is forbidden.");
                default:
                    Console.Error.WriteLine($"Unknown argument: {args[i]}");
                    break;
            }
        }

        if (string.IsNullOrEmpty(p.Unsigned) || string.IsNullOrEmpty(p.Out) || string.IsNullOrEmpty(p.Transcript))
        {
            throw new ArgumentException("--unsigned, --out, and --transcript are required.");
        }

        if (p.Signers.Length == 0)
        {
            throw new ArgumentException("--signers a,b,c is required.");
        }

        return p;
    }

    private sealed class ParsedArgs
    {
        public string? Unsigned { get; set; }

        public string? Out { get; set; }

        public string? Transcript { get; set; }

        public string[] Signers { get; set; } = Array.Empty<string>();

        public bool AllowNetwork { get; set; }

        public string? TransparencyLogUrl { get; set; }

        public bool NoTransparencyLog { get; set; }
    }

    private sealed class SystemClock : IClock
    {
        public DateTimeOffset UtcNow => DateTimeOffset.UtcNow;

        public long MonotonicMilliseconds => Environment.TickCount64;
    }

    /// <summary>Minimal IFileSystem impl backed by System.IO for the offline binary.</summary>
    private sealed class MinimalFileSystem : IFileSystem
    {
        public ValueTask<bool> ExistsAsync(AbsolutePath path, CancellationToken ct)
            => ValueTask.FromResult(File.Exists(path.Value) || Directory.Exists(path.Value));

        public async ValueTask<string> ReadAllTextAsync(AbsolutePath path, CancellationToken ct)
            => await File.ReadAllTextAsync(path.Value, ct).ConfigureAwait(false);

        public async ValueTask WriteAllTextAsync(AbsolutePath path, string contents, CancellationToken ct)
        {
            var dir = Path.GetDirectoryName(path.Value);
            if (!string.IsNullOrEmpty(dir))
            {
                Directory.CreateDirectory(dir);
            }

            await File.WriteAllTextAsync(path.Value, contents, ct).ConfigureAwait(false);
        }

        public ValueTask<Stream> OpenReadAsync(AbsolutePath path, CancellationToken ct)
            => ValueTask.FromResult<Stream>(File.OpenRead(path.Value));

        public ValueTask<Stream> OpenWriteExclusiveAsync(AbsolutePath path, FilePermissions perms, CancellationToken ct)
            => ValueTask.FromResult<Stream>(new FileStream(path.Value, FileMode.CreateNew, FileAccess.Write, FileShare.None));

        public ValueTask MoveAtomicAsync(AbsolutePath source, AbsolutePath destination, CancellationToken ct)
        {
            File.Move(source.Value, destination.Value, overwrite: true);
            return ValueTask.CompletedTask;
        }

        public ValueTask DeleteAsync(AbsolutePath path, CancellationToken ct)
        {
            if (File.Exists(path.Value))
            {
                File.Delete(path.Value);
            }
            else if (Directory.Exists(path.Value))
            {
                Directory.Delete(path.Value, recursive: false);
            }

            return ValueTask.CompletedTask;
        }

        public ValueTask<MountKind> GetMountKindAsync(AbsolutePath path, CancellationToken ct)
            => ValueTask.FromResult(MountKind.Local);

        public ValueTask<bool> FileExistsAsync(AbsolutePath path, CancellationToken ct)
            => ValueTask.FromResult(File.Exists(path.Value));

        public ValueTask<bool> DirectoryExistsAsync(AbsolutePath path, CancellationToken ct)
            => ValueTask.FromResult(Directory.Exists(path.Value));

        public ValueTask CreateDirectoryAsync(AbsolutePath path, CancellationToken ct)
        {
            Directory.CreateDirectory(path.Value);
            return ValueTask.CompletedTask;
        }

        public ValueTask DeleteDirectoryAsync(AbsolutePath path, bool recursive, CancellationToken ct)
        {
            Directory.Delete(path.Value, recursive);
            return ValueTask.CompletedTask;
        }

        public async ValueTask<byte[]> ReadAllBytesAsync(AbsolutePath path, CancellationToken ct)
            => await File.ReadAllBytesAsync(path.Value, ct).ConfigureAwait(false);

        public async ValueTask WriteAllBytesAsync(AbsolutePath path, byte[] contents, CancellationToken ct)
            => await File.WriteAllBytesAsync(path.Value, contents, ct).ConfigureAwait(false);

        public ValueTask CopyAsync(AbsolutePath source, AbsolutePath destination, bool overwrite, CancellationToken ct)
        {
            File.Copy(source.Value, destination.Value, overwrite);
            return ValueTask.CompletedTask;
        }

        public async IAsyncEnumerable<AbsolutePath> EnumerateFilesAsync(AbsolutePath directory, string searchPattern, [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct)
        {
            await Task.CompletedTask;
            foreach (var f in Directory.EnumerateFiles(directory.Value, searchPattern))
            {
                ct.ThrowIfCancellationRequested();
                yield return new AbsolutePath(f);
            }
        }

        public async IAsyncEnumerable<AbsolutePath> EnumerateDirectoriesAsync(AbsolutePath directory, [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct)
        {
            await Task.CompletedTask;
            foreach (var d in Directory.EnumerateDirectories(directory.Value))
            {
                ct.ThrowIfCancellationRequested();
                yield return new AbsolutePath(d);
            }
        }

        public ValueTask<Stream> OpenWriteAsync(AbsolutePath path, CancellationToken ct)
            => ValueTask.FromResult<Stream>(new FileStream(path.Value, FileMode.Create, FileAccess.Write));

        public ValueTask<Stream> OpenAppendAsync(AbsolutePath path, CancellationToken ct)
            => ValueTask.FromResult<Stream>(new FileStream(path.Value, FileMode.Append, FileAccess.Write));
    }
}
