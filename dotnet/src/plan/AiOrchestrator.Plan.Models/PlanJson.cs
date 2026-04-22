// <copyright file="PlanJson.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.Json.Serialization.Metadata;

namespace AiOrchestrator.Plan.Models;

/// <summary>
/// Provides canonical, byte-stable JSON serialization for <see cref="Plan"/> objects.
/// Properties are emitted in alphabetical order; dictionaries are key-sorted; timestamps are UTC ISO-8601.
/// </summary>
public static class PlanJson
{
    private static readonly JsonSerializerOptions Options = BuildOptions();

    /// <summary>Deserializes a <see cref="Plan"/> from its JSON representation.</summary>
    /// <param name="json">The JSON string produced by <see cref="Serialize"/>.</param>
    /// <returns>The deserialized <see cref="Plan"/>, or <see langword="null"/> if <paramref name="json"/> is empty.</returns>
    public static Plan? Deserialize(string json) =>
        JsonSerializer.Deserialize<Plan>(json, Options);

    /// <summary>Serializes a <see cref="Plan"/> to its canonical, byte-stable JSON representation.</summary>
    /// <param name="plan">The plan to serialize.</param>
    /// <returns>An indented JSON string with alphabetically-ordered properties and key-sorted dictionaries.</returns>
    public static string Serialize(Plan plan) =>
        JsonSerializer.Serialize(plan, Options);

    private static JsonSerializerOptions BuildOptions()
    {
        var opts = new JsonSerializerOptions
        {
            WriteIndented = true,
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            Converters =
            {
                new JsonStringEnumConverter(JsonNamingPolicy.CamelCase),
                new UtcDateTimeOffsetConverter(),
                new SortedDictionaryConverter(),
            },
        };

        opts.TypeInfoResolver = new DefaultJsonTypeInfoResolver
        {
            Modifiers = { SortPropertiesAlphabetically },
        };

        return opts;
    }

    private static void SortPropertiesAlphabetically(JsonTypeInfo typeInfo)
    {
        if (typeInfo.Kind != JsonTypeInfoKind.Object)
        {
            return;
        }

        var sorted = typeInfo.Properties
            .OrderBy(static p => p.Name, StringComparer.Ordinal)
            .ToArray();

        typeInfo.Properties.Clear();

        foreach (var prop in sorted)
        {
            typeInfo.Properties.Add(prop);
        }
    }

    /// <summary>Ensures <see cref="DateTimeOffset"/> values are always serialized as UTC (+00:00).</summary>
    private sealed class UtcDateTimeOffsetConverter : JsonConverter<DateTimeOffset>
    {
        public override DateTimeOffset Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
        {
            var raw = reader.GetString() ?? throw new JsonException("Expected DateTimeOffset string.");
            return DateTimeOffset.Parse(raw, null, System.Globalization.DateTimeStyles.RoundtripKind);
        }

        public override void Write(Utf8JsonWriter writer, DateTimeOffset value, JsonSerializerOptions options) =>
            writer.WriteStringValue(value.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffffffZ", System.Globalization.CultureInfo.InvariantCulture));
    }

    /// <summary>
    /// Intercepts <see cref="IReadOnlyDictionary{TKey,TValue}"/> serialization to emit keys in sorted order.
    /// </summary>
    private sealed class SortedDictionaryConverter : JsonConverterFactory
    {
        public override bool CanConvert(Type typeToConvert) =>
            typeToConvert.IsGenericType &&
            typeToConvert.GetGenericTypeDefinition() == typeof(IReadOnlyDictionary<,>) &&
            typeToConvert.GetGenericArguments()[0] == typeof(string);

        public override JsonConverter? CreateConverter(Type typeToConvert, JsonSerializerOptions options)
        {
            var valueType = typeToConvert.GetGenericArguments()[1];
            var converterType = typeof(SortedDictionaryConverter<>).MakeGenericType(valueType);
            return (JsonConverter?)Activator.CreateInstance(converterType);
        }
    }

#pragma warning disable CA1812 // SortedDictionaryConverter is instantiated via reflection by SortedDictionaryConverterFactory
    private sealed class SortedDictionaryConverter<TValue> : JsonConverter<IReadOnlyDictionary<string, TValue>>
    {
        public override IReadOnlyDictionary<string, TValue>? Read(
            ref Utf8JsonReader reader,
            Type typeToConvert,
            JsonSerializerOptions options)
        {
            var dict = JsonSerializer.Deserialize<Dictionary<string, TValue>>(ref reader, options);
            return dict;
        }

        public override void Write(
            Utf8JsonWriter writer,
            IReadOnlyDictionary<string, TValue> value,
            JsonSerializerOptions options)
        {
            writer.WriteStartObject();

            foreach (var kvp in value.OrderBy(static k => k.Key, StringComparer.Ordinal))
            {
                writer.WritePropertyName(kvp.Key);
                JsonSerializer.Serialize(writer, kvp.Value, options);
            }

            writer.WriteEndObject();
        }
    }
}
