// <copyright file="NonceManager.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Security.Cryptography;
using AiOrchestrator.Abstractions.Time;
using Microsoft.Extensions.Options;

namespace AiOrchestrator.HookGate.Nonce;

/// <summary>
/// Default <see cref="INonceManager"/>. Lazily rotates the nonce whenever the clock has
/// advanced past <see cref="Nonce.RotatesAt"/>. Keeps one previous nonce available for
/// an overlap window equal to <see cref="HookGateOptions.NonceRotation"/> (INV-5).
/// </summary>
public sealed class NonceManager : INonceManager
{
    private readonly IClock clock;
    private readonly IOptionsMonitor<HookGateOptions> opts;
    private readonly object gate = new();
    private Nonce current;
    private Nonce? previous;

    /// <summary>Initializes a new <see cref="NonceManager"/>.</summary>
    /// <param name="clock">Clock used to stamp nonces and evaluate rotation time.</param>
    /// <param name="opts">Options monitor providing the rotation interval.</param>
    public NonceManager(IClock clock, IOptionsMonitor<HookGateOptions> opts)
    {
        this.clock = clock ?? throw new ArgumentNullException(nameof(clock));
        this.opts = opts ?? throw new ArgumentNullException(nameof(opts));
        this.current = this.Issue();
    }

    /// <inheritdoc/>
    public event EventHandler<NonceRotated>? Rotated;

    /// <inheritdoc/>
    public Nonce Current
    {
        get
        {
            this.MaybeRotate();
            lock (this.gate)
            {
                return this.current;
            }
        }
    }

    /// <inheritdoc/>
    public Nonce? Previous
    {
        get
        {
            this.MaybeRotate();
            lock (this.gate)
            {
                return this.previous;
            }
        }
    }

    /// <summary>Forces a rotation regardless of the clock (test hook / admin op).</summary>
    public void ForceRotate()
    {
        Nonce retired;
        Nonce issued;
        lock (this.gate)
        {
            retired = this.current;
            issued = this.Issue();
            this.previous = retired;
            this.current = issued;
        }

        this.Rotated?.Invoke(this, new NonceRotated(retired, issued));
    }

    private void MaybeRotate()
    {
        Nonce? retired = null;
        Nonce? issued = null;
        lock (this.gate)
        {
            var now = this.clock.UtcNow;
            if (now < this.current.RotatesAt)
            {
                return;
            }

            retired = this.current;
            issued = this.Issue();

            // Keep the retired nonce as "previous" for one rotation period (overlap window).
            var rotation = this.opts.CurrentValue.NonceRotation;
            if ((now - retired.IssuedAt) <= (rotation + rotation))
            {
                this.previous = retired;
            }
            else
            {
                this.previous = null;
            }

            this.current = issued;
        }

        this.Rotated?.Invoke(this, new NonceRotated(retired, issued!));
    }

    private Nonce Issue()
    {
        var raw = RandomNumberGenerator.GetBytes(32);
        var now = this.clock.UtcNow;
        var rotation = this.opts.CurrentValue.NonceRotation;
        return new Nonce
        {
            Value = Convert.ToBase64String(raw),
            IssuedAt = now,
            RotatesAt = now + rotation,
        };
    }
}
