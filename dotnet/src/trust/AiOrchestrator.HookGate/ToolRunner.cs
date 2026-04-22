// <copyright file="ToolRunner.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Text;
using AiOrchestrator.Abstractions.Process;
using AiOrchestrator.Models;

namespace AiOrchestrator.HookGate;

/// <summary>
/// Internal helper that invokes short-lived OS tools via <see cref="IProcessSpawner"/> and
/// collects their exit code + captured stdout. Used by the immutability probe and redirection
/// managers so they never reach <c>System.Diagnostics.Process</c> directly (banned API).
/// </summary>
internal static class ToolRunner
{
    public static async ValueTask<(int ExitCode, string Stdout)> RunAsync(
        IProcessSpawner spawner,
        string executable,
        string[] args,
        TimeSpan timeout,
        CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(spawner);
        ArgumentNullException.ThrowIfNull(executable);
        ArgumentNullException.ThrowIfNull(args);

        var spec = new ProcessSpec
        {
            Producer = "hookgate",
            Description = $"invoke {executable}",
            Executable = executable,
            Arguments = args.ToImmutableArray(),
            Environment = null,
        };

        IProcessHandle? handle = null;
        try
        {
            handle = await spawner.SpawnAsync(spec, ct).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException or FileNotFoundException or IOException)
        {
            return (-1, string.Empty);
        }

        try
        {
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct);
            linked.CancelAfter(timeout);

            var stdoutTask = ReadAllAsync(handle.StandardOut, linked.Token);
            int code;
            try
            {
                code = await handle.WaitForExitAsync(linked.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return (-1, string.Empty);
            }

            string so;
            try
            {
                so = await stdoutTask.ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                so = string.Empty;
            }

            return (code, so);
        }
        finally
        {
            if (handle is not null)
            {
                await handle.DisposeAsync().ConfigureAwait(false);
            }
        }
    }

    private static async Task<string> ReadAllAsync(System.IO.Pipelines.PipeReader reader, CancellationToken ct)
    {
        var sb = new StringBuilder();
        while (!ct.IsCancellationRequested)
        {
            System.IO.Pipelines.ReadResult rr;
            try
            {
                rr = await reader.ReadAsync(ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return sb.ToString();
            }

            foreach (var seg in rr.Buffer)
            {
                _ = sb.Append(Encoding.UTF8.GetString(seg.Span));
            }

            reader.AdvanceTo(rr.Buffer.End);
            if (rr.IsCompleted)
            {
                break;
            }
        }

        return sb.ToString();
    }
}
