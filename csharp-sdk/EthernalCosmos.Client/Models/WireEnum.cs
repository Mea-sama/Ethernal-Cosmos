using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace EthernalCosmos.Client.Models;

/// <summary>Maps an enum member to its exact string on the wire (e.g. <c>in_progress</c>).</summary>
[AttributeUsage(AttributeTargets.Field)]
public sealed class WireValueAttribute(string value) : Attribute
{
    /// <summary>The exact wire string.</summary>
    public string Value { get; } = value;
}

/// <summary>
/// JSON converter for the wire enums in <c>Enums.cs</c>. Unknown strings become <c>default</c> (<c>Unknown</c>)
/// instead of throwing, so older SDKs keep working when the hub adds values.
/// </summary>
public sealed class WireEnumConverter<T> : JsonConverter<T> where T : struct, Enum
{
    private static readonly Dictionary<string, T> FromWire = [];
    private static readonly Dictionary<T, string> ToWire = [];

    static WireEnumConverter()
    {
        foreach (var field in typeof(T).GetFields(BindingFlags.Public | BindingFlags.Static))
        {
            var wire = field.GetCustomAttribute<WireValueAttribute>()?.Value;
            if (wire is null) continue;
            var value = (T)field.GetValue(null)!;
            FromWire[wire] = value;
            ToWire[value] = wire;
        }
    }

    /// <summary>Parses a wire string; unknown or null values give <c>default</c> (<c>Unknown</c>).</summary>
    public static T Parse(string? wire) => wire is not null && FromWire.TryGetValue(wire, out var v) ? v : default;

    /// <inheritdoc />
    public override T Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
        reader.TokenType == JsonTokenType.String && FromWire.TryGetValue(reader.GetString()!, out var v) ? v : default;

    /// <inheritdoc />
    public override void Write(Utf8JsonWriter writer, T value, JsonSerializerOptions options)
    {
        if (ToWire.TryGetValue(value, out var wire)) writer.WriteStringValue(wire);
        else writer.WriteNullValue();
    }
}

/// <summary>Helpers for wire enums.</summary>
public static class WireEnumExtensions
{
    /// <summary>The exact string of this value on the wire (e.g. <c>in_progress</c>).</summary>
    public static string? Wire<T>(this T value) where T : struct, Enum =>
        typeof(T).GetField(value.ToString())?.GetCustomAttribute<WireValueAttribute>()?.Value;
}
