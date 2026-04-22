// <copyright file="StagedSwap.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Models.Paths;
using Microsoft.Extensions.Logging;

namespace AiOrchestrator.Daemon.Update;

/// <summary>Atomically swaps a staged install directory into the live install root, with rollback support.</summary>
internal sealed class StagedSwap
{
    private readonly IClock clock;
    private readonly ILogger<StagedSwap> logger;

    public StagedSwap(IClock clock, ILogger<StagedSwap> logger)
    {
        ArgumentNullException.ThrowIfNull(clock);
        ArgumentNullException.ThrowIfNull(logger);
        this.clock = clock;
        this.logger = logger;
    }

    public ValueTask<AbsolutePath> SwapAsync(AbsolutePath installRoot, AbsolutePath stagingRoot, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        var ts = this.clock.UtcNow.ToUnixTimeMilliseconds();
        var backup = new AbsolutePath(installRoot.Value + ".bak-" + ts.ToString(System.Globalization.CultureInfo.InvariantCulture));

        if (Directory.Exists(installRoot.Value))
        {
            this.logger.LogInformation("Backing up {Install} -> {Backup}", installRoot.Value, backup.Value);
            Directory.Move(installRoot.Value, backup.Value);
        }

        try
        {
            this.logger.LogInformation("Promoting {Staging} -> {Install}", stagingRoot.Value, installRoot.Value);
            Directory.Move(stagingRoot.Value, installRoot.Value);
        }
        catch
        {
            if (Directory.Exists(backup.Value) && !Directory.Exists(installRoot.Value))
            {
                Directory.Move(backup.Value, installRoot.Value);
            }

            throw;
        }

        return ValueTask.FromResult(backup);
    }

    public ValueTask RollbackAsync(AbsolutePath installRoot, AbsolutePath previousBackupRoot, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        try
        {
            if (Directory.Exists(installRoot.Value))
            {
                Directory.Delete(installRoot.Value, recursive: true);
            }

            if (Directory.Exists(previousBackupRoot.Value))
            {
                Directory.Move(previousBackupRoot.Value, installRoot.Value);
            }

            this.logger.LogWarning("Rolled back to {Backup}", previousBackupRoot.Value);
        }
        catch (IOException ex)
        {
            this.logger.LogError(ex, "Rollback failed");
            throw;
        }

        return ValueTask.CompletedTask;
    }
}
