using EthernalCosmos.Client.Models;
using Xunit;

namespace EthernalCosmos.Client.Tests;

[Collection("Hub")]
public class ErrorTests(HubFixture hub)
{
    [Fact]
    public void Known_code_maps_to_ErrorCode()
    {
        var ex = new EthernalException("LOBBY_FULL", "full", 250);
        Assert.Equal(ErrorCode.LobbyFull, ex.Error);
        Assert.Equal("LOBBY_FULL", ex.Code);
        Assert.Equal(250, ex.RetryAfterMs);
    }

    [Fact]
    public void Unknown_code_maps_to_Unknown_but_keeps_the_string()
    {
        var ex = new EthernalException("SOMETHING_NEW", "x");
        Assert.Equal(ErrorCode.Unknown, ex.Error);
        Assert.Equal("SOMETHING_NEW", ex.Code);
    }

    [Fact]
    public async Task Hub_errors_surface_as_typed_EthernalException()
    {
        await using var u = await hub.NewUserAsync();
        var ex = await Assert.ThrowsAsync<EthernalException>(() => u.Client.JoinLobbyAsync("does-not-exist"));
        Assert.Equal(ex.Code, ex.Code.ToUpperInvariant());
        Assert.NotEqual(ErrorCode.Unknown, ex.Error);
    }

    [Fact]
    public async Task Rest_errors_are_EthernalException_with_hub_code()
    {
        await using var c = hub.NewClient();
        var ex = await Assert.ThrowsAsync<EthernalException>(() => c.LoginAsync(HubFixture.UniqueName("nobody"), "password123"));
        Assert.False(string.IsNullOrEmpty(ex.Code));
        Assert.NotEqual(ErrorCode.Unknown, ex.Error);
    }
}
