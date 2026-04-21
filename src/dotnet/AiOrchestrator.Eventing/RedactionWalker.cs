// <copyright file="RedactionWalker.cs" company="AiOrchestrator contributors">
// Copyright (c) AiOrchestrator contributors. All rights reserved.
// </copyright>

using System.Collections.Concurrent;
using System.Reflection;
using AiOrchestrator.Abstractions.Redaction;

namespace AiOrchestrator.Eventing;

/// <summary>
/// Reflection helper that produces a redacted copy of a record-shaped event by walking
/// the primary constructor and replacing every <see cref="string"/>-valued component
/// with the result of <see cref="IRedactor.Redact(string)"/> (INV-3).
/// </summary>
internal static class RedactionWalker
{
    private static readonly ConcurrentDictionary<Type, ConstructorPlan?> PlanCache = new();

    /// <summary>
    /// Returns a copy of <paramref name="event"/> with every public string-valued
    /// constructor parameter passed through <paramref name="redactor"/>. When the
    /// runtime type has no usable constructor or no string-valued fields, the original
    /// instance is returned (the redactor is still invoked, satisfying INV-3 visibility).
    /// </summary>
    /// <typeparam name="TEvent">The event type.</typeparam>
    /// <param name="event">The event instance to redact.</param>
    /// <param name="redactor">The redactor to apply.</param>
    /// <returns>The redacted event (or the original when no rewrite is possible).</returns>
    public static TEvent Redact<TEvent>(TEvent @event, IRedactor redactor)
        where TEvent : notnull
    {
        var plan = PlanCache.GetOrAdd(@event.GetType(), BuildPlan);
        if (plan is null || plan.Slots.Length == 0)
        {
            return @event;
        }

        var args = new object?[plan.Slots.Length];
        for (var i = 0; i < plan.Slots.Length; i++)
        {
            var slot = plan.Slots[i];
            var value = slot.Property.GetValue(@event);
            if (slot.IsString && value is string s)
            {
                args[i] = redactor.Redact(s);
            }
            else
            {
                args[i] = value;
            }
        }

        return (TEvent)plan.Ctor.Invoke(args);
    }

    private static ConstructorPlan? BuildPlan(Type type)
    {
        var ctor = type
            .GetConstructors(BindingFlags.Public | BindingFlags.Instance)
            .OrderByDescending(c => c.GetParameters().Length)
            .FirstOrDefault();

        if (ctor is null || ctor.GetParameters().Length == 0)
        {
            return null;
        }

        var ps = ctor.GetParameters();
        var slots = new ParamSlot[ps.Length];
        var hasString = false;
        for (var i = 0; i < ps.Length; i++)
        {
            var prop = type.GetProperty(
                ps[i].Name!,
                BindingFlags.Public | BindingFlags.Instance | BindingFlags.IgnoreCase);
            if (prop is null)
            {
                return null;
            }

            var isString = prop.PropertyType == typeof(string);
            slots[i] = new ParamSlot(prop, isString);
            hasString |= isString;
        }

        return hasString ? new ConstructorPlan(ctor, slots) : null;
    }

    private readonly record struct ParamSlot(PropertyInfo Property, bool IsString);

    private sealed record ConstructorPlan(ConstructorInfo Ctor, ParamSlot[] Slots);
}
