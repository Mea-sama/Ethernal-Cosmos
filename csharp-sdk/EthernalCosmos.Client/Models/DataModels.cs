using System.Text.Json.Serialization;

namespace EthernalCosmos.Client.Models;

/// <summary>New value and version of a key after an atomic write (<c>IncrementUserDataAsync</c>, <c>SetUserDataIfAsync</c>).</summary>
public sealed class UserDataWriteResult
{
    /// <summary>Data key.</summary>
    [JsonPropertyName("key")]     public string  Key     { get; init; } = "";
    /// <summary>The value after the write (JSON).</summary>
    [JsonPropertyName("value")]   public object? Value   { get; init; }
    /// <summary>The version after the write (starts at 1, +1 per write).</summary>
    [JsonPropertyName("version")] public int     Version { get; init; }
}

/// <summary>Result of one operation of a transaction; for <see cref="UserDataOp.Delete"/> the version is 0 and the value is null.</summary>
public sealed class UserDataOpResult
{
    /// <summary>Data key.</summary>
    [JsonPropertyName("key")]     public string  Key     { get; init; } = "";
    /// <summary>The value after the operation (JSON); null for a delete.</summary>
    [JsonPropertyName("value")]   public object? Value   { get; init; }
    /// <summary>The version after the operation; 0 for a delete.</summary>
    [JsonPropertyName("version")] public int     Version { get; init; }
}

/// <summary>Stored state of a key at the time of a <c>VERSION_CONFLICT</c>.</summary>
public sealed class VersionConflictState
{
    /// <summary>Current value (JSON).</summary>
    [JsonPropertyName("value")]   public object? Value   { get; init; }
    /// <summary>Current version; pass it as <c>expectedVersion</c> to retry.</summary>
    [JsonPropertyName("version")] public int     Version { get; init; }
}

/// <summary>Payload of a <c>VERSION_CONFLICT</c> error (<see cref="EthernalException.Conflict"/>).</summary>
public sealed class VersionConflict
{
    /// <summary>The current stored state, or null when the key does not exist (retry with <c>expectedVersion: 0</c>).</summary>
    [JsonPropertyName("current")] public VersionConflictState? Current { get; init; }
}

/// <summary>
/// One operation of an all-or-nothing transaction (<see cref="EthernalClient.TransactUserDataAsync"/>, <see cref="GameServerClient.TransactDataAsync"/>).
/// Create it with <see cref="Set"/>, <see cref="Increment"/>, <see cref="SetIf"/> or <see cref="Delete"/>.
/// </summary>
public sealed class UserDataOp
{
    private UserDataOp() { }

    /// <summary>Operation name on the wire: <c>set</c>, <c>increment</c>, <c>setIf</c> or <c>delete</c>.</summary>
    [JsonPropertyName("op")]              public string  Op              { get; private init; } = "";
    /// <summary>Data key.</summary>
    [JsonPropertyName("key")]             public string  Key             { get; private init; } = "";
    /// <summary>New value (<c>set</c>, <c>setIf</c>).</summary>
    [JsonPropertyName("value")]           public object? Value           { get; private init; }
    /// <summary>Amount to add (<c>increment</c>).</summary>
    [JsonPropertyName("by")]              public double? By              { get; private init; }
    /// <summary>Required current version (<c>setIf</c>); 0 = the key must not exist.</summary>
    [JsonPropertyName("expectedVersion")] public int?    ExpectedVersion { get; private init; }
    /// <summary>Visibility wire value to set; null keeps the existing one (new keys: private).</summary>
    [JsonPropertyName("visibility")]      public string? Visibility      { get; private init; }

    /// <summary>Write <paramref name="value"/> to <paramref name="key"/>.</summary>
    public static UserDataOp Set(string key, object? value, DataVisibility? visibility = null) =>
        new() { Op = "set", Key = key, Value = value, Visibility = visibility?.Wire() };

    /// <summary>Add <paramref name="by"/> to a numeric key (a missing key counts as 0).</summary>
    public static UserDataOp Increment(string key, double by, DataVisibility? visibility = null) =>
        new() { Op = "increment", Key = key, By = by, Visibility = visibility?.Wire() };

    /// <summary>Write only if the key is at <paramref name="expectedVersion"/> (0 = does not exist), otherwise the transaction fails with <c>VERSION_CONFLICT</c>.</summary>
    public static UserDataOp SetIf(string key, object? value, int expectedVersion, DataVisibility? visibility = null) =>
        new() { Op = "setIf", Key = key, Value = value, ExpectedVersion = expectedVersion, Visibility = visibility?.Wire() };

    /// <summary>Delete the key.</summary>
    public static UserDataOp Delete(string key) => new() { Op = "delete", Key = key };
}
