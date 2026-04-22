// <copyright file="VersionHandler.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.CommandLine;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;

namespace AiOrchestrator.Cli.Verbs;

/// <summary>Handler for <c>aio version</c>.</summary>
internal sealed class VersionHandler : VerbBase
{
    public VersionHandler(IServiceProvider services)
        : base(services)
    {
    }

    public override string VerbPath => "version";

    protected override string Description => "Print product, assembly, and runtime version information.";

    protected override async Task<int> RunAsync(ParseResult result, CancellationToken ct)
    {
        Assembly asm = typeof(Program).Assembly;
        string version = asm.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
            ?? asm.GetName().Version?.ToString()
            ?? "0.0.0";
        var info = new VersionInfo("aio", version, RuntimeInformation.FrameworkDescription);

        bool json = result.GetValue(this.JsonOption);
        TextWriter writer = Console.Out;
        if (json)
        {
            await new JsonOutputWriter().WriteAsync(info, writer, CliJsonContext.Default.VersionInfo, ct).ConfigureAwait(false);
        }
        else
        {
            string? env = Environment.GetEnvironmentVariable("NO_COLOR");
            await new HumanOutputWriter(result.GetValue(this.NoColorOption), env).WriteAsync(info, writer, ct).ConfigureAwait(false);
        }

        return CliExitCodes.Ok;
    }
}
