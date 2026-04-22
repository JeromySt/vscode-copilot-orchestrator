// <copyright file="ProtectedString.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

namespace AiOrchestrator.Abstractions.Credentials;

/// <summary>
/// A disposable wrapper around a secret byte sequence that zeroes its backing memory on dispose.
/// <see cref="ToString"/> always returns a redacted placeholder to defend against accidental
/// log emission (INV-10 / CRED-PWD-LOG). See <c>docs/SECURITY.md</c> for the same-uid threat model.
/// </summary>
public sealed class ProtectedString : IDisposable
{
    private readonly byte[] buffer;
    private bool disposed;

    /// <summary>Initializes a new instance of the <see cref="ProtectedString"/> class from a UTF-8 string.</summary>
    /// <param name="secret">
    /// The plaintext secret. The input <see cref="string"/> is intrinsically un-scrubbable in
    /// managed memory; callers that already hold the secret in a <see cref="string"/> have
    /// already accepted that risk.
    /// </param>
    public ProtectedString(string secret)
    {
        ArgumentNullException.ThrowIfNull(secret);
        this.buffer = System.Text.Encoding.UTF8.GetBytes(secret);
    }

    /// <summary>Initializes a new instance of the <see cref="ProtectedString"/> class directly from bytes. The buffer is copied.</summary>
    /// <param name="secret">Raw secret bytes. Copied into an internal buffer; the caller's bytes are not mutated.</param>
    public ProtectedString(ReadOnlySpan<byte> secret)
    {
        this.buffer = secret.ToArray();
    }

    /// <summary>Gets the length in bytes of the protected secret, or <c>0</c> after dispose.</summary>
    public int Length => this.disposed ? 0 : this.buffer.Length;

    /// <summary>Gets a value indicating whether the underlying buffer has been zeroed.</summary>
    public bool IsDisposed => this.disposed;

    /// <summary>Returns the secret material as a UTF-8 string.</summary>
    /// <returns>The plaintext secret.</returns>
    /// <exception cref="ObjectDisposedException">The secret has already been zeroed.</exception>
    public string Reveal()
    {
        if (this.disposed)
        {
            throw new ObjectDisposedException(nameof(ProtectedString));
        }

        return System.Text.Encoding.UTF8.GetString(this.buffer);
    }

    /// <summary>Copies the secret bytes into the provided span.</summary>
    /// <param name="destination">Destination buffer; must be at least <see cref="Length"/> bytes long.</param>
    /// <returns>Number of bytes written.</returns>
    /// <exception cref="ObjectDisposedException">The secret has already been zeroed.</exception>
    public int CopyTo(Span<byte> destination)
    {
        if (this.disposed)
        {
            throw new ObjectDisposedException(nameof(ProtectedString));
        }

        this.buffer.CopyTo(destination);
        return this.buffer.Length;
    }

    /// <summary>Zeroes the underlying buffer. After dispose, <see cref="Reveal"/> throws.</summary>
    public void Dispose()
    {
        if (this.disposed)
        {
            return;
        }

        Array.Clear(this.buffer, 0, this.buffer.Length);
        this.disposed = true;
        GC.SuppressFinalize(this);
    }

    /// <summary>Always returns <c>"***"</c>; never leaks the secret into logs.</summary>
    /// <returns>The string <c>"***"</c>.</returns>
    public override string ToString() => "***";
}
