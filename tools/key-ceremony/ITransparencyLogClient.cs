// <copyright file="ITransparencyLogClient.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Threading;
using System.Threading.Tasks;

namespace AiOrchestrator.Tools.KeyCeremony;

/// <summary>Submits a signed manifest payload to a Sigstore-style transparency log.</summary>
public interface ITransparencyLogClient
{
    /// <summary>Submits the payload and returns a Merkle inclusion receipt.</summary>
    /// <param name="payload">The bytes to record in the log.</param>
    /// <param name="logUrl">Optional log URL.</param>
    /// <param name="ct">Cancellation token.</param>
    /// <returns>A receipt string (opaque to callers).</returns>
    ValueTask<string> SubmitAsync(byte[] payload, string? logUrl, CancellationToken ct);
}

/// <summary>Stub <see cref="ITransparencyLogClient"/> for offline/test use; returns a deterministic receipt.</summary>
public sealed class StubTransparencyLogClient : ITransparencyLogClient
{
    private readonly string receipt;

    /// <summary>Initializes a new instance of the <see cref="StubTransparencyLogClient"/> class.</summary>
    public StubTransparencyLogClient()
        : this("MERKLE-RECEIPT-STUB")
    {
    }

    /// <summary>Initializes a new instance of the <see cref="StubTransparencyLogClient"/> class.</summary>
    /// <param name="fixedReceipt">The receipt string to return on every call.</param>
    public StubTransparencyLogClient(string fixedReceipt)
    {
        this.receipt = fixedReceipt;
    }

    /// <inheritdoc/>
    public ValueTask<string> SubmitAsync(byte[] payload, string? logUrl, CancellationToken ct)
        => ValueTask.FromResult(this.receipt);
}
