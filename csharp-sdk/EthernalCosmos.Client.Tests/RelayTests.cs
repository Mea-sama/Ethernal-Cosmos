using EthernalCosmos.Client.Models;
using Xunit;

namespace EthernalCosmos.Client.Tests;

[Collection(HubCollection.Name)]
public class RelayTests(HubFixture hub)
{
    private sealed record Move(int X, int Y);

    private async Task<(TestUser Host, TestUser Guest, Lobby Lobby)> PairAsync()
    {
        var host = await hub.NewUserAsync();
        var guest = await hub.NewUserAsync();
        var lobby = await host.Client.CreateLobbyAsync("relay-lobby");
        await guest.Client.JoinLobbyAsync(lobby.Id);
        return (host, guest, lobby);
    }

    [Fact]
    public async Task SendToLobbyAsync_broadcasts_to_others_only()
    {
        var (host, guest, _) = await PairAsync();
        await using var _h = host;
        await using var _g = guest;
        var received = Wait.For<RelayMessage>(h => guest.Client.Message += h, h => guest.Client.Message -= h);
        var echoed = new List<RelayMessage>();
        host.Client.Message += echoed.Add;

        await host.Client.SendToLobbyAsync("move", new Move(3, 4));

        var msg = await received;
        Assert.Equal(host.UserId, msg.From);
        Assert.Equal("move", msg.Type);
        Assert.NotNull(msg.Seq);
        Assert.Equal(new Move(3, 4), msg.PayloadAs<Move>());
        Assert.True(msg.TryPayloadAs<Move>(out var parsed));
        Assert.Equal(3, parsed!.X);
        Assert.False(msg.TryPayloadAs<int[]>(out _));
        await Task.Delay(200);
        Assert.Empty(echoed);
    }

    [Fact]
    public async Task SendToLobbyAsync_without_payload_delivers_null_payload()
    {
        var (host, guest, _) = await PairAsync();
        await using var _h = host;
        await using var _g = guest;
        var received = Wait.For<RelayMessage>(h => guest.Client.Message += h, h => guest.Client.Message -= h);
        await host.Client.SendToLobbyAsync("ping");
        var msg = await received;
        Assert.Equal("ping", msg.Type);
        Assert.Null(msg.PayloadAs<Move>());
    }

    [Fact]
    public async Task SendToPlayerAsync_targets_one_player()
    {
        var (host, guest, _) = await PairAsync();
        await using var _h = host;
        await using var _g = guest;
        var received = Wait.For<RelayMessage>(h => guest.Client.Message += h, h => guest.Client.Message -= h);
        await host.Client.SendToPlayerAsync(guest.UserId, "whisper", new { text = "hi" });
        var msg = await received;
        Assert.Equal("whisper", msg.Type);
        Assert.Equal("hi", msg.PayloadAs<Dictionary<string, string>>()!["text"]);

        var self = await Assert.ThrowsAsync<EthernalException>(() => host.Client.SendToPlayerAsync(host.UserId, "x"));
        Assert.Equal(ErrorCode.CannotTargetSelf, self.Error);
    }

    [Fact]
    public async Task SendToLobbyBinaryAsync_round_trips_bytes()
    {
        var (host, guest, _) = await PairAsync();
        await using var _h = host;
        await using var _g = guest;
        var received = Wait.For<RelayBinaryMessage>(h => guest.Client.MessageBinary += h, h => guest.Client.MessageBinary -= h);
        byte[] bytes = [0, 1, 2, 250, 255];
        await host.Client.SendToLobbyBinaryAsync(7, bytes);
        var msg = await received;
        Assert.Equal(host.UserId, msg.From);
        Assert.Equal(7, msg.TypeCode);
        Assert.Equal(bytes, msg.Payload);
        Assert.NotNull(msg.Seq);
    }

    [Fact]
    public async Task SendToPlayerBinaryAsync_round_trips_bytes()
    {
        var (host, guest, _) = await PairAsync();
        await using var _h = host;
        await using var _g = guest;
        var received = Wait.For<RelayBinaryMessage>(h => host.Client.MessageBinary += h, h => host.Client.MessageBinary -= h);
        byte[] bytes = Enumerable.Range(0, 200).Select(i => (byte)i).ToArray();
        await guest.Client.SendToPlayerBinaryAsync(host.UserId, 65535, bytes);
        var msg = await received;
        Assert.Equal(65535, msg.TypeCode);
        Assert.Equal(bytes, msg.Payload);
    }

    [Fact]
    public async Task Relay_validation_errors()
    {
        var (host, guest, _) = await PairAsync();
        await using var _h = host;
        await using var _g = guest;
        Assert.Equal(ErrorCode.InvalidMessageType, (await Assert.ThrowsAsync<EthernalException>(() => host.Client.SendToLobbyAsync("bad type!"))).Error);
        Assert.Equal(ErrorCode.InvalidBinaryTypecode, (await Assert.ThrowsAsync<EthernalException>(() => host.Client.SendToLobbyBinaryAsync(70000, [1]))).Error);
        Assert.Equal(ErrorCode.PayloadTooLarge, (await Assert.ThrowsAsync<EthernalException>(() => host.Client.SendToLobbyAsync("big", new string('x', 200_000)))).Error);
        await Assert.ThrowsAsync<ArgumentNullException>(() => host.Client.SendToLobbyBinaryAsync(1, null!));
        await Assert.ThrowsAsync<ArgumentNullException>(() => host.Client.SendToPlayerBinaryAsync(guest.UserId, 1, null!));

        await using var loner = await hub.NewUserAsync();
        Assert.Equal(ErrorCode.NotInLobby, (await Assert.ThrowsAsync<EthernalException>(() => loner.Client.SendToLobbyAsync("x"))).Error);
    }
}
