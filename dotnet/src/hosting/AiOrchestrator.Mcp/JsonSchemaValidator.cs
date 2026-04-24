// <copyright file="JsonSchemaValidator.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace AiOrchestrator.Mcp;

/// <summary>
/// Minimal JSON-Schema validator supporting the subset used by tool input schemas:
/// <c>type</c> (object/string/integer/number/boolean/array), <c>required</c>, and
/// per-property <c>type</c> validation. Violations are reported as a single flat
/// list of messages; a non-empty list means the input is invalid.
/// </summary>
internal static class JsonSchemaValidator
{
    /// <summary>Validates a JSON element against the given JSON Schema and returns a list of violations.</summary>
    public static IReadOnlyList<string> Validate(JsonNode schema, JsonElement instance)
    {
        var errors = new List<string>();
        ValidateNode(schema, instance, "$", errors);
        return errors;
    }

    private static void ValidateNode(JsonNode? schema, JsonElement instance, string path, List<string> errors)
    {
        if (schema is not JsonObject so)
        {
            return;
        }

        string? type = so["type"]?.GetValue<string>();
        if (type is not null && !TypeMatches(type, instance))
        {
            errors.Add($"{path}: expected type '{type}', got '{instance.ValueKind}'");
            return;
        }

        if (type == "object" && instance.ValueKind == JsonValueKind.Object)
        {
            if (so["required"] is JsonArray req)
            {
                foreach (JsonNode? n in req)
                {
                    string? key = n?.GetValue<string>();
                    if (key is not null && !instance.TryGetProperty(key, out _))
                    {
                        errors.Add($"{path}: missing required property '{key}'");
                    }
                }
            }

            if (so["properties"] is JsonObject props)
            {
                foreach (KeyValuePair<string, JsonNode?> kv in props)
                {
                    if (instance.TryGetProperty(kv.Key, out JsonElement child))
                    {
                        ValidateNode(kv.Value, child, $"{path}.{kv.Key}", errors);
                    }
                }
            }
        }
        else if (type == "array" && instance.ValueKind == JsonValueKind.Array && so["items"] is JsonNode items)
        {
            int i = 0;
            foreach (JsonElement el in instance.EnumerateArray())
            {
                ValidateNode(items, el, $"{path}[{i++}]", errors);
            }
        }
    }

    private static bool TypeMatches(string type, JsonElement el) => type switch
    {
        "object" => el.ValueKind == JsonValueKind.Object,
        "array" => el.ValueKind == JsonValueKind.Array,
        "string" => el.ValueKind == JsonValueKind.String,
        "boolean" => el.ValueKind is JsonValueKind.True or JsonValueKind.False,
        "integer" => el.ValueKind == JsonValueKind.Number && el.TryGetInt64(out _),
        "number" => el.ValueKind == JsonValueKind.Number,
        "null" => el.ValueKind == JsonValueKind.Null,
        _ => true,
    };
}
