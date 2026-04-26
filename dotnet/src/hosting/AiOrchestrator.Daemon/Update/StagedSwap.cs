// <copyright file="StagedSwap.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using AiOrchestrator.Abstractions.Io;
using AiOrchestrator.Abstractions.Time;
using AiOrchestrator.Models.Paths;
using Microsoft.Extensions.Logging;

namespace AiOrchestrator.Daemon.Update;

/// <summary>Atomically swaps a staged install directory into the live install root, with rollback support.</summary>
internal sealed class StagedSwap
{
    private readonly IFileSystem fs;
    private readonly IClock clock;
    private readonly ILogger<StagedSwap> logger;

    public StagedSwap(IFileSystem fs, IClock clock, ILogger<StagedSwap> logger)
    {
        ArgumentNullException.ThrowIfNull(fs);
        ArgumentNullException.ThrowIfNull(clock);
        ArgumentNullException.ThrowIfNull(logger);
        this.fs = fs;
        this.clock = clock;
        this.logger = logger;
    }

    public async ValueTask<AbsolutePath> SwapAsync(AbsolutePath installRoot, AbsolutePath stagingRoot, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        var ts = this.clock.UtcNow.ToUnixTimeMilliseconds();
        var backup = new AbsolutePath(installRoot.Value + ".bak-" + ts.ToString(System.Globalization.CultureInfo.InvariantCulture));

        if (await this.fs.DirectoryExistsAsync(installRoot, ct).ConfigureAwait(false))
        {
            this.logger.LogInformation("Backing up {Install} -> {Backup}", installRoot.Value, backup.Value);
            await this.fs.MoveAtomicAsync(installRoot, backup, ct).ConfigureAwait(false);
        }

        try
        {
            this.logger.LogInformation("Promoting {Staging} -> {Install}", stagingRoot.Value, installRoot.Value);
            await this.fs.MoveAtomicAsync(stagingRoot, installRoot, ct).ConfigureAwait(false);
        }
        catch
        {
            if (await this.fs.DirectoryExistsAsync(backup, ct).ConfigureAwait(false) &&
                !await this.fs.DirectoryExistsAsync(installRoot, ct).ConfigureAwait(false))
            {
                await this.fs.MoveAtomicAsync(backup, installRoot, ct).ConfigureAwait(false);
            }

            throw;
        }

        return backup;
    }

    public async ValueTask RollbackAsync(AbsolutePath installRoot, AbsolutePath previousBackupRoot, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        try
        {
            if (await this.fs.DirectoryExistsAsync(installRoot, ct).ConfigureAwait(false))
            {
                await this.fs.DeleteDirectoryAsync(installRoot, recursive: true, ct).ConfigureAwait(false);
            }

            if (await this.fs.DirectoryExistsAsync(previousBackupRoot, ct).ConfigureAwait(false))
            {
                await this.fs.MoveAtomicAsync(previousBackupRoot, installRoot, ct).ConfigureAwait(false);
            }

            this.logger.LogWarning("Rolled back to {Backup}", previousBackupRoot.Value);
        }
        catch (IOException ex)
        {
            this.logger.LogError(ex, "Rollback failed");
            throw;
        }
    }
}
