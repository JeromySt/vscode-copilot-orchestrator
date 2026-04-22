// <copyright file="Credential.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Abstractions.Credentials;

/// <summary>
/// Holds a credential (username + secret) retrieved from <see cref="ICredentialBroker"/>.
/// The secret is wrapped in <see cref="ProtectedString"/> so it can be zeroed in memory
/// on <see cref="Dispose"/>. Secrets MUST never be written to logs (INV-10 / CRED-PWD-LOG).
/// </summary>
public sealed record Credential : IDisposable
{
    private bool disposed;

    /// <summary>Gets the username associated with this credential.</summary>
    public required string Username { get; init; }

    /// <summary>Gets the secret token or password. Zeroed on <see cref="Dispose"/>.</summary>
    public required ProtectedString Password { get; init; }

    /// <summary>Gets the UTC time at which this credential was retrieved from the OS keychain.</summary>
    public required DateTimeOffset RetrievedAt { get; init; }

    /// <summary>Gets the protocol this credential is bound to (<c>https</c>, <c>ssh</c>, or <c>basic</c>).</summary>
    public required string SourceProtocol { get; init; }

    /// <summary>Releases the credential and zeroes the underlying secret buffer.</summary>
    public void Dispose()
    {
        if (this.disposed)
        {
            return;
        }

        this.Password.Dispose();
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
