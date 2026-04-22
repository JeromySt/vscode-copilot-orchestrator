// <copyright file="ContextPressureHandler.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Globalization;
using System.Text.RegularExpressions;
using AiOrchestrator.Abstractions.Time;

namespace AiOrchestrator.Agent.Handlers;

/// <summary>
/// Tracks rolling context-window pressure (INV-7). Thresholds:
/// Rising 0.60, High 0.80, Critical 0.92. Emits at most one level-transition per session.
/// </summary>
internal sealed partial class ContextPressureHandler : HandlerBase
{
    /// <summary>Rising threshold (60% of window).</summary>
    public const double RisingThreshold = 0.60;

    /// <summary>High threshold (80% of window).</summary>
    public const double HighThreshold = 0.80;

    /// <summary>Critical threshold (92% of window).</summary>
    public const double CriticalThreshold = 0.92;

    private ContextPressureLevel currentLevel = ContextPressureLevel.None;
    private double currentFraction;
    private bool pending;

    /// <summary>Initializes a new instance of the <see cref="ContextPressureHandler"/> class.</summary>
    /// <param name="clock">Clock.</param>
    public ContextPressureHandler(IClock clock)
        : base(clock)
    {
    }

    /// <summary>Gets the most recently observed pressure level.</summary>
    public ContextPressureLevel Level => this.currentLevel;

    /// <summary>Gets the current fraction of the window used (0..1).</summary>
    public double Fraction => this.currentFraction;

    /// <summary>Gets a value indicating whether an unfired transition is pending emission by the runner.</summary>
    public bool PendingTransition => this.pending;

    /// <summary>Clears the pending-transition flag after the runner has emitted the event.</summary>
    public void ClearPending() => this.pending = false;

    /// <inheritdoc/>
    public override bool TryHandle(LineEmitted line, AgentSpec spec)
    {
        ArgumentNullException.ThrowIfNull(line);
        ArgumentNullException.ThrowIfNull(spec);

        var match = ContextPctRegex().Match(line.Line);
        if (!match.Success)
        {
            return false;
        }

        if (!double.TryParse(match.Groups[1].Value, NumberStyles.Float, CultureInfo.InvariantCulture, out var pct))
        {
            return false;
        }

        // Accept 0-100 or 0.0-1.0
        var fraction = pct > 1.0 ? pct / 100.0 : pct;
        if (fraction < 0 || fraction > 2.0)
        {
            return false;
        }

        this.currentFraction = fraction;
        var newLevel = ClassifyLevel(fraction);
        if (newLevel > this.currentLevel)
        {
            this.currentLevel = newLevel;
            this.pending = true;
        }

        return true;
    }

    private static ContextPressureLevel ClassifyLevel(double fraction) => fraction switch
    {
        >= CriticalThreshold => ContextPressureLevel.Critical,
        >= HighThreshold => ContextPressureLevel.High,
        >= RisingThreshold => ContextPressureLevel.Rising,
        _ => ContextPressureLevel.None,
    };

    [GeneratedRegex(@"context[_ ](?:usage|pct|pressure)[=:]\s*([0-9]*\.?[0-9]+)%?", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex ContextPctRegex();
}
