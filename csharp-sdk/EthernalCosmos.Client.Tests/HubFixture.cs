using EthernalCosmos.Client.Models;
using Xunit;

namespace EthernalCosmos.Client.Tests;

/// <summary>One shared hub process for all integration tests.</summary>
public sealed class HubFixture : IAsyncLifetime
{
    private static int _counter;
    private HubProcess _hub = null!;

    public string Url => _hub.Url;

    public async Task InitializeAsync() => _hub = await HubProcess.StartAsync();

    public async Task DisposeAsync() => await _hub.DisposeAsync();

    public static string UniqueName(string prefix = "u") =>
        $"{prefix}{DateTime.UtcNow.Ticks % 100000000:x}{Interlocked.Increment(ref _counter)}";

    public EthernalClient NewClient(string? url = null, TimeSpan? timeout = null) =>
        new(new EthernalClientOptions { ServerUrl = url ?? Url, RequestTimeout = timeout ?? TimeSpan.FromSeconds(8) });

    /// <summary>Registers a fresh user (connects the socket) and optionally registers a game.</summary>
    public async Task<TestUser> NewUserAsync(string? game = "relay", string prefix = "u")
    {
        var name = UniqueName(prefix);
        var client = NewClient();
        var auth = await client.RegisterAsync(name, "password123");
        var user = new TestUser(client, name, auth.User.UserId, auth);
        if (game is not null) await client.RegisterGameAsync(game);
        return user;
    }
}

[CollectionDefinition(Name)]
public sealed class HubCollection : ICollectionFixture<HubFixture>
{
    public const string Name = "Hub";
}

public sealed class TestUser : IAsyncDisposable
{
    public EthernalClient Client { get; }
    public string Username { get; }
    public string UserId { get; }
    public AuthResult Auth { get; }

    public TestUser(EthernalClient client, string username, string userId, AuthResult auth)
    {
        Client = client;
        Username = username;
        UserId = userId;
        Auth = auth;
    }

    public ValueTask DisposeAsync() => Client.DisposeAsync();
}
