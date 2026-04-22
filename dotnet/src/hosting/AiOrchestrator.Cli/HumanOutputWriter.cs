// <copyright file="HumanOutputWriter.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Globalization;
using System.IO;
using System.Threading;
using System.Threading.Tasks;

namespace AiOrchestrator.Cli;

/// <summary>
/// Writes human-readable, optionally color-aware tabular output. Respects
/// <c>NO_COLOR</c> (env var) and <c>--no-color</c> (flag) per INV-5.
/// </summary>
internal sealed class HumanOutputWriter
{
    private readonly bool colorEnabled;

    /// <summary>Initializes a new instance of the <see cref="HumanOutputWriter"/> class.</summary>
    /// <param name="noColorRequested">Whether <c>--no-color</c> was specified.</param>
    /// <param name="envNoColor">The value of the <c>NO_COLOR</c> environment variable (or <see langword="null"/>).</param>
    public HumanOutputWriter(bool noColorRequested, string? envNoColor)
    {
        bool envSaysNo = !string.IsNullOrEmpty(envNoColor);
        this.colorEnabled = !(noColorRequested || envSaysNo);
    }

    /// <summary>Gets a value indicating whether color output is enabled.</summary>
    public bool ColorEnabled => this.colorEnabled;

    /// <summary>Writes <paramref name="value"/> to <paramref name="writer"/>.</summary>
    /// <param name="value">The value to render.</param>
    /// <param name="writer">The destination.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A completed <see cref="ValueTask"/>.</returns>
    public async ValueTask WriteAsync(object value, TextWriter writer, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(writer);
        ArgumentNullException.ThrowIfNull(value);

        string text = Render(value);
        if (this.colorEnabled)
        {
            text = "\u001b[0m" + text;
        }

        await writer.WriteLineAsync(text.AsMemory(), ct).ConfigureAwait(false);
    }

    private static string Render(object value)
    {
        return value switch
        {
            VerbResult r => string.Format(
                CultureInfo.InvariantCulture,
                "{0,-24} {1,-4} (exit {2}) {3}",
                r.Verb,
                r.Ok ? "OK" : "FAIL",
                r.ExitCode,
                r.Message),
            VersionInfo v => string.Format(
                CultureInfo.InvariantCulture,
                "{0} {1} on {2}",
                v.Product,
                v.Version,
                v.Runtime),
            PlanStatusDto p => string.Format(
                CultureInfo.InvariantCulture,
                "plan {0}: {1} ({2}/{3} jobs complete)",
                p.PlanId,
                p.State,
                p.Completed,
                p.Jobs),
            DaemonStatusDto d => string.Format(
                CultureInfo.InvariantCulture,
                "daemon: {0} pid={1} endpoint={2}",
                d.Running ? "running" : "stopped",
                d.Pid,
                d.Endpoint),
            _ => value.ToString() ?? string.Empty,
        };
    }
}
