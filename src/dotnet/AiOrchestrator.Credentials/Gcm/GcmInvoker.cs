// <copyright file="GcmInvoker.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.IO.Pipelines;
using System.Text;
using AiOrchestrator.Abstractions.Credentials;
using AiOrchestrator.Abstractions.Process;
using AiOrchestrator.Models;
using Microsoft.Extensions.Options;

namespace AiOrchestrator.Credentials.Gcm;

/// <summary>
/// Invokes the Git Credential Manager binary to run <c>get</c> / <c>store</c> / <c>erase</c> verbs
/// (INV-5 / CRED-VERB-1). Uses <see cref="IProcessSpawner"/> exclusively per DI constraints —
/// no direct <c>Process.Start</c>. Enforces a per-invocation timeout (INV-6 / CRED-TIMEOUT-1).
/// </summary>
public sealed class GcmInvoker
{
    private readonly IProcessSpawner spawner;
    private readonly IOptionsMonitor<CredentialOptions> opts;

    /// <summary>Initializes a new <see cref="GcmInvoker"/>.</summary>
    /// <param name="spawner">Process spawner (DI-banned direct Process.Start).</param>
    /// <param name="opts">Options monitor (GCM executable name and timeout).</param>
    public GcmInvoker(IProcessSpawner spawner, IOptionsMonitor<CredentialOptions> opts)
    {
        this.spawner = spawner ?? throw new ArgumentNullException(nameof(spawner));
        this.opts = opts ?? throw new ArgumentNullException(nameof(opts));
    }

    /// <summary>Invokes <c>git credential fill</c> (verb=<c>get</c>) and parses the key=value response.</summary>
    /// <param name="repoUrl">The repository URL.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>The parsed <see cref="Credential"/>.</returns>
    /// <exception cref="GcmInvocationException">GCM exited non-zero or timed out (INV-6).</exception>
    public async ValueTask<Credential> GetAsync(Uri repoUrl, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(repoUrl);
        var stdout = await this.InvokeAsync("get", repoUrl, credential: null, ct).ConfigureAwait(false);
        var dict = ParseKeyValueResponse(stdout);

        string username = dict.TryGetValue("username", out var u) ? u : string.Empty;
        string password = dict.TryGetValue("password", out var p) ? p : string.Empty;
        string protocol = dict.TryGetValue("protocol", out var proto) ? proto : "https";

        return new Credential
        {
            Username = username,
            Password = new ProtectedString(password),
            RetrievedAt = DateTimeOffset.UtcNow,
            SourceProtocol = protocol,
        };
    }

    /// <summary>Invokes <c>git credential approve</c> (verb=<c>store</c>).</summary>
    /// <param name="repoUrl">The URL.</param>
    /// <param name="cred">Credential that was successfully used.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A task that completes when the verb finishes.</returns>
    public async ValueTask StoreAsync(Uri repoUrl, Credential cred, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(repoUrl);
        ArgumentNullException.ThrowIfNull(cred);
        _ = await this.InvokeAsync("store", repoUrl, cred, ct).ConfigureAwait(false);
    }

    /// <summary>Invokes <c>git credential reject</c> (verb=<c>erase</c>).</summary>
    /// <param name="repoUrl">The URL.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A task that completes when the verb finishes.</returns>
    public async ValueTask EraseAsync(Uri repoUrl, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(repoUrl);
        _ = await this.InvokeAsync("erase", repoUrl, credential: null, ct).ConfigureAwait(false);
    }

    private async Task<string> InvokeAsync(string verb, Uri repoUrl, Credential? credential, CancellationToken ct)
    {
        var options = this.opts.CurrentValue;
        var spec = new ProcessSpec
        {
            Producer = "credential-broker",
            Description = $"git-credential {verb}",
            Executable = options.GcmExecutableName,
            Arguments = ImmutableArray.Create(verb),
        };

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(options.GcmTimeout);

        var handle = await this.spawner.SpawnAsync(spec, timeout.Token).ConfigureAwait(false);
        try
        {
            // Write stdin: git credential input format (key=value\n\n to terminate).
            var sb = new StringBuilder();
            sb.Append("protocol=").Append(repoUrl.Scheme).Append('\n');
            sb.Append("host=").Append(repoUrl.Host).Append('\n');
            if (!string.IsNullOrEmpty(repoUrl.AbsolutePath) && repoUrl.AbsolutePath != "/")
            {
                sb.Append("path=").Append(repoUrl.AbsolutePath.TrimStart('/')).Append('\n');
            }

            if (credential is not null)
            {
                sb.Append("username=").Append(credential.Username).Append('\n');
                sb.Append("password=").Append(credential.Password.Reveal()).Append('\n');
            }

            sb.Append('\n');

            var bytes = Encoding.UTF8.GetBytes(sb.ToString());
            await handle.StandardIn.WriteAsync(bytes, timeout.Token).ConfigureAwait(false);
            await handle.StandardIn.CompleteAsync().ConfigureAwait(false);

            var stdout = await ReadAllAsync(handle.StandardOut, timeout.Token).ConfigureAwait(false);

            int exitCode;
            try
            {
                exitCode = await handle.WaitForExitAsync(timeout.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                throw;
            }
            catch (OperationCanceledException)
            {
                // INV-6: the invocation exceeded the GCM timeout; surface clearly.
                throw new GcmInvocationException(verb, $"GCM '{verb}' timed out after {options.GcmTimeout}.");
            }

            if (exitCode != 0)
            {
                throw new GcmInvocationException(verb, $"GCM '{verb}' exited with code {exitCode}.");
            }

            return stdout;
        }
        finally
        {
            await handle.DisposeAsync().ConfigureAwait(false);
        }
    }

    private static async Task<string> ReadAllAsync(PipeReader reader, CancellationToken ct)
    {
        var buffer = new StringBuilder();
        while (true)
        {
            var result = await reader.ReadAsync(ct).ConfigureAwait(false);
            foreach (var mem in result.Buffer)
            {
                buffer.Append(Encoding.UTF8.GetString(mem.Span));
            }

            reader.AdvanceTo(result.Buffer.End);
            if (result.IsCompleted)
            {
                break;
            }
        }

        return buffer.ToString();
    }

    internal static Dictionary<string, string> ParseKeyValueResponse(string stdout)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var rawLine in stdout.Split('\n'))
        {
            var line = rawLine.TrimEnd('\r');
            if (line.Length == 0)
            {
                continue;
            }

            var idx = line.IndexOf('=');
            if (idx <= 0)
            {
                continue;
            }

            var key = line[..idx];
            var value = line[(idx + 1)..];
            result[key] = value;
        }

        return result;
    }
}

/// <summary>Thrown when a GCM invocation fails, times out, or returns a non-zero exit code.</summary>
public sealed class GcmInvocationException : Exception
{
    /// <summary>Initializes a new <see cref="GcmInvocationException"/>.</summary>
    /// <param name="verb">The GCM verb (<c>get</c>, <c>store</c>, <c>erase</c>).</param>
    /// <param name="message">Detail message.</param>
    public GcmInvocationException(string verb, string message)
        : base(message)
    {
        this.Verb = verb;
    }

    /// <summary>Gets the GCM verb that failed.</summary>
    public string Verb { get; }
}
