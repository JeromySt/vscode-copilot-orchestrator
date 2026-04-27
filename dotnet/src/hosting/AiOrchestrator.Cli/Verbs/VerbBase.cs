// <copyright file="VerbBase.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.CommandLine;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Paths;
using AiOrchestrator.Models.Paths;

namespace AiOrchestrator.Cli.Verbs;

/// <summary>
/// Shared plumbing for verb handlers: builds the common <c>--json</c>,
/// <c>--no-color</c>, and <c>--help</c> options and wires the action.
/// </summary>
internal abstract class VerbBase : ICliVerbHandler
{
    protected VerbBase(IServiceProvider services)
    {
        this.Services = services ?? throw new ArgumentNullException(nameof(services));
    }

    /// <summary>Gets the CLI verb path (e.g. "plan create").</summary>
    public abstract string VerbPath { get; }

    /// <summary>Gets the short one-line description shown in help output.</summary>
    protected abstract string Description { get; }

    /// <summary>Gets optional verb-specific option lines rendered in help output.</summary>
    protected virtual IReadOnlyList<string> ExtraOptionHelp { get; } = Array.Empty<string>();

    protected IServiceProvider Services { get; }

    protected Option<bool> JsonOption { get; } = new("--json")
    {
        Description = "Emit machine-readable JSON output.",
    };

    protected Option<bool> NoColorOption { get; } = new("--no-color")
    {
        Description = "Disable ANSI color output (also respects NO_COLOR env var).",
    };

    /// <summary>Builds the <see cref="Command"/> for this verb.</summary>
    /// <returns>A fully-populated command.</returns>
    public virtual Command Build()
    {
        string name = this.LeafName();
        var command = new Command(name, this.Description);
        command.Options.Add(this.JsonOption);
        command.Options.Add(this.NoColorOption);
        this.ConfigureOptions(command);

        command.SetAction((parseResult, token) => this.InvokeAsync(parseResult, token));
        return command;
    }

    /// <summary>Entry point invoked by the command action.</summary>
    /// <param name="result">The parse result for the verb.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>The CLI exit code.</returns>
    public async Task<int> InvokeAsync(ParseResult result, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(result);

        try
        {
            return await this.RunAsync(result, ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            return CliExitCodes.PlanCanceled;
        }
        catch (UnauthorizedAccessException)
        {
            return CliExitCodes.PermissionDenied;
        }
        catch (IOException)
        {
            return CliExitCodes.IoError;
        }
#pragma warning disable CA1031 // top-level CLI boundary
        catch (Exception ex)
        {
            Console.Error.WriteLine($"FATAL: {ex}");
            return CliExitCodes.InternalError;
        }
#pragma warning restore CA1031
    }

    /// <summary>Renders deterministic help text used for snapshot tests (INV-3).</summary>
    /// <returns>The help text.</returns>
    public string RenderHelp()
    {
        var sb = new StringBuilder();
        _ = sb.Append("aio ").AppendLine(this.VerbPath);
        _ = sb.AppendLine();
        _ = sb.AppendLine(this.Description);
        _ = sb.AppendLine();
        _ = sb.Append("Usage: aio ").Append(this.VerbPath).AppendLine(" [options]");
        _ = sb.AppendLine();
        _ = sb.AppendLine("Options:");
        _ = sb.AppendLine("  --json        Emit machine-readable JSON output.");
        _ = sb.AppendLine("  --no-color    Disable ANSI color output (also respects NO_COLOR env var).");
        _ = sb.AppendLine("  --help        Show this help.");
        foreach (string extra in this.ExtraOptionHelp)
        {
            _ = sb.Append("  ").AppendLine(extra);
        }

        _ = sb.AppendLine();
        _ = sb.AppendLine("Exit codes:");
        _ = sb.AppendLine("  0   OK");
        _ = sb.AppendLine("  64  Usage error");
        _ = sb.AppendLine("  65  Config error");
        _ = sb.AppendLine("  74  I/O error");
        _ = sb.AppendLine("  77  Permission denied");
        _ = sb.AppendLine("  80  Plan failed");
        _ = sb.AppendLine("  81  Plan canceled");
        _ = sb.AppendLine("  82  Plan partial");
        _ = sb.AppendLine("  90  Daemon unavailable");
        _ = sb.AppendLine("  99  Internal error");
        return sb.ToString();
    }

    /// <summary>Derives the leaf command name from <see cref="VerbPath"/>.</summary>
    /// <returns>The leaf name (last space-separated token).</returns>
    protected string LeafName()
    {
        int idx = this.VerbPath.LastIndexOf(' ');
        return idx < 0 ? this.VerbPath : this.VerbPath[(idx + 1)..];
    }

    /// <summary>Lets subclasses add verb-specific options before <c>Build()</c> wires the action.</summary>
    /// <param name="command">The command being built.</param>
    protected virtual void ConfigureOptions(Command command)
    {
    }

    /// <summary>Verb-specific execution.</summary>
    /// <param name="result">The parse result.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>The CLI exit code.</returns>
    protected abstract Task<int> RunAsync(ParseResult result, CancellationToken ct);

    /// <summary>Validates a path argument using <see cref="IPathValidator"/> (INV-8).</summary>
    /// <param name="candidate">The path string to validate (may be <see langword="null"/>).</param>
    /// <param name="allowedRoot">The allowed containment root.</param>
    /// <returns><see langword="true"/> if the path validates (or is null); <see langword="false"/> on a violation.</returns>
    protected bool ValidateOptionalPath(string? candidate, AbsolutePath allowedRoot)
    {
        if (string.IsNullOrEmpty(candidate))
        {
            return true;
        }

        var validator = (IPathValidator?)this.Services.GetService(typeof(IPathValidator));
        if (validator is null)
        {
            return true;
        }

        try
        {
            validator.AssertSafe(new AbsolutePath(Path.GetFullPath(candidate)), allowedRoot);
            return true;
        }
        catch (UnauthorizedAccessException)
        {
            return false;
        }
    }

    /// <summary>Writes a result payload either as JSON or human text.</summary>
    /// <param name="result">The parse result (used to read <c>--json</c>/<c>--no-color</c>).</param>
    /// <param name="payload">The result object.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A completed task.</returns>
    protected async Task WriteVerbResultAsync(ParseResult result, VerbResult payload, CancellationToken ct)
    {
        bool json = result.GetValue(this.JsonOption);
        bool noColor = result.GetValue(this.NoColorOption);
        TextWriter writer = Console.Out;

        if (json)
        {
            var jw = new JsonOutputWriter();
            await jw.WriteAsync(payload, writer, CliJsonContext.Default.VerbResult, ct).ConfigureAwait(false);
        }
        else
        {
            string? env = Environment.GetEnvironmentVariable("NO_COLOR");
            var hw = new HumanOutputWriter(noColor, env);
            await hw.WriteAsync(payload, writer, ct).ConfigureAwait(false);
        }
    }
}
