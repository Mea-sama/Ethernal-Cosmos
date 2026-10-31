using System.Text.Json;
using EthernalCosmos.Client.Models;
using Xunit;

namespace EthernalCosmos.Client.Tests;

public class WireEnumTests
{
    private sealed class Holder
    {
        public LobbyStatus Status { get; init; }
        public LobbyChangeReason? Reason { get; init; }
    }

    [Fact]
    public void Round_trips_through_JSON()
    {
        var json = JsonSerializer.Serialize(new Holder { Status = LobbyStatus.InProgress, Reason = LobbyChangeReason.ServerRebound });
        Assert.Contains("\"in_progress\"", json);
        Assert.Contains("\"server_rebound\"", json);
        var back = JsonSerializer.Deserialize<Holder>(json)!;
        Assert.Equal(LobbyStatus.InProgress, back.Status);
        Assert.Equal(LobbyChangeReason.ServerRebound, back.Reason);
    }

    [Fact]
    public void Unknown_string_null_and_non_string_become_Unknown()
    {
        var h = JsonSerializer.Deserialize<Holder>("{\"Status\":\"brand_new\",\"Reason\":5}")!;
        Assert.Equal(LobbyStatus.Unknown, h.Status);
        Assert.Equal(LobbyChangeReason.Unknown, h.Reason);
        Assert.Equal(LobbyStatus.Unknown, JsonSerializer.Deserialize<Holder>("{\"Status\":null}")!.Status);
    }

    [Fact]
    public void Parse_and_Wire_helpers()
    {
        Assert.Equal(LobbyStatus.Full, WireEnumConverter<LobbyStatus>.Parse("full"));
        Assert.Equal(LobbyStatus.Unknown, WireEnumConverter<LobbyStatus>.Parse("nope"));
        Assert.Equal(LobbyStatus.Unknown, WireEnumConverter<LobbyStatus>.Parse(null));
        Assert.Equal("in_progress", LobbyStatus.InProgress.Wire());
    }
}
