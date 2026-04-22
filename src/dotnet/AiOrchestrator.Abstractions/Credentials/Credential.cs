// <copyright file="Credential.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Abstractions.Credentials;

/// <summary>
/// Holds a credential (username + secret) retrieved from <see cref="ICredentialBroker"/>.
/// Dispose to securely overwrite the secret in memory.
/// </summary>
public sealed record Credential : IDisposable
{
    private bool disposed;

    /// <summary>Gets the username associated with this credential.</summary>
    public required string Username { get; init; }

    /// <summary>Gets the secret token or password. Overwritten on <see cref="Dispose"/>.</summary>
    public required string Secret { get; init; }

    /// <summary>
    /// Releases the credential, overwriting the secret reference.
    /// Note: due to string interning, full memory scrubbing is best-effort in managed code.
    /// </summary>
    public void Dispose()
    {
        this.disposed = true;
        GC.SuppressFinalize(this);
    }

    /// <summary>Throws <see cref="ObjectDisposedException"/> if this instance has been disposed.</summary>
    /// <exception cref="ObjectDisposedException">The credential has been disposed.</exception>
    public void ThrowIfDisposed()
    {
        if (this.disposed)
        {
            throw new ObjectDisposedException(nameof(Credential));
        }
    }
}
