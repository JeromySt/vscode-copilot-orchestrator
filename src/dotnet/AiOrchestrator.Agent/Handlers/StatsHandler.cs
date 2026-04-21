// <copyright file="StatsHandler.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Globalization;
using System.Text.RegularExpressions;
using AiOrchestrator.Abstractions.Time;

namespace AiOrchestrator.Agent.Handlers;

/// <summary>
/// Parses incremental token / cost statistics from runner output (INV-5). Always produces a non-null
/// <see cref="AgentStats"/> on partial parse: unknown fields are stored in <see cref="AgentStats.ProviderRaw"/>.
/// </summary>
internal sealed partial class StatsHandler : HandlerBase
{
    private readonly Dictionary<string, long> providerRaw = new(StringComparer.OrdinalIgnoreCase);
    private int inputTokens;
    private int outputTokens;
    private int turns;
    private decimal? estCost;

    /// <summary>Initializes a new instance of the <see cref="StatsHandler"/> class.</summary>
    /// <param name="clock">Clock.</param>
    public StatsHandler(IClock clock)
        : base(clock)
    {
    }

    /// <summary>Gets the latest aggregated stats (always non-null per INV-5).</summary>
    public AgentStats Current => new()
    {
        InputTokens = this.inputTokens,
        OutputTokens = this.outputTokens,
        Turns = this.turns,
        EstimatedCostUsd = this.estCost,
        ProviderRaw = this.providerRaw.ToImmutableDictionary(StringComparer.OrdinalIgnoreCase),
    };

    /// <inheritdoc/>
    public override bool TryHandle(LineEmitted line, AgentSpec spec)
    {
        ArgumentNullException.ThrowIfNull(line);
        ArgumentNullException.ThrowIfNull(spec);

        var consumed = false;

        foreach (Match m in InputTokensRegex().Matches(line.Line))
        {
            if (TryParseInt(m.Groups[1].Value, out var v))
            {
                this.inputTokens += v;
                consumed = true;
            }
        }

        foreach (Match m in OutputTokensRegex().Matches(line.Line))
        {
            if (TryParseInt(m.Groups[1].Value, out var v))
            {
                this.outputTokens += v;
                consumed = true;
            }
        }

        foreach (Match m in TurnsRegex().Matches(line.Line))
        {
            if (TryParseInt(m.Groups[1].Value, out var v))
            {
                this.turns = Math.Max(this.turns, v);
                consumed = true;
            }
        }

        foreach (Match m in CostRegex().Matches(line.Line))
        {
            if (decimal.TryParse(m.Groups[1].Value, NumberStyles.Float, CultureInfo.InvariantCulture, out var v))
            {
                this.estCost = (this.estCost ?? 0m) + v;
                consumed = true;
            }
        }

        foreach (Match m in ProviderRawRegex().Matches(line.Line))
        {
            var key = m.Groups[1].Value;
            if (long.TryParse(m.Groups[2].Value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var v))
            {
                this.providerRaw[key] = v;
                consumed = true;
            }
        }

        return consumed;
    }

    private static bool TryParseInt(string s, out int v)
        => int.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out v);

    [GeneratedRegex(@"input[_ ]tokens[=:]\s*(\d+)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex InputTokensRegex();

    [GeneratedRegex(@"output[_ ]tokens[=:]\s*(\d+)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex OutputTokensRegex();

    [GeneratedRegex(@"turns?[=:]\s*(\d+)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex TurnsRegex();

    [GeneratedRegex(@"cost[_ ]usd[=:]\s*([0-9]*\.?[0-9]+)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex CostRegex();

    [GeneratedRegex(@"raw\.([a-zA-Z_][a-zA-Z0-9_]*)[=:]\s*(\d+)", RegexOptions.CultureInvariant)]
    private static partial Regex ProviderRawRegex();
}
