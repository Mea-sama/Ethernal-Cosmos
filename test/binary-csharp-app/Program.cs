using System.Text.Json;
using EthernalCosmos.Client;
using EthernalCosmos.Client.Models;

const string defaultServer = "https://mea-sama.duckdns.org:12346";
const string userA = "rararara";
const string userB = "tatatata";
const int typeLobby = 2001;
const int typeDirect = 2002;

string server = args.Length > 0 ? args[0] : defaultServer;

static bool EqualBytes(byte[] a, byte[] b)
{
    if (a.Length != b.Length) return false;
    for (int i = 0; i < a.Length; i++)
    {
        if (a[i] != b[i]) return false;
    }
    return true;
}

static string Hex(byte[] data)
{
    return BitConverter.ToString(data);
}

static async Task<T> WithTimeout<T>(Task<T> task, TimeSpan timeout, string label)
{
    using var cts = new CancellationTokenSource();
    var delay = Task.Delay(timeout, cts.Token);
    var done = await Task.WhenAny(task, delay);
    if (done == delay)
    {
        throw new TimeoutException($"Timeout: {label}");
    }
    cts.Cancel();
    return await task;
}

static async Task<string> ResolveGameIdAsync(string serverUrl)
{
    using var http = new HttpClient();
    using var res = await http.GetAsync($"{serverUrl}/api/games");
    res.EnsureSuccessStatusCode();

    using var stream = await res.Content.ReadAsStreamAsync();
    using var doc = await JsonDocument.ParseAsync(stream);

    if (doc.RootElement.ValueKind != JsonValueKind.Array || doc.RootElement.GetArrayLength() == 0)
    {
        throw new InvalidOperationException("No games registered on server");
    }

    var first = doc.RootElement[0];
    return first.GetProperty("id").GetString() ?? throw new InvalidOperationException("Game id missing");
}

Console.WriteLine($"Binary C#↔C# test against {server}");

await using var alice = new EthernalClient(new EthernalClientOptions { ServerUrl = server });
await using var bob = new EthernalClient(new EthernalClientOptions { ServerUrl = server });

alice.ServerError += msg => Console.WriteLine($"[alice][serverError] {msg}");
bob.ServerError += msg => Console.WriteLine($"[bob][serverError] {msg}");

try
{
    var gameId = await ResolveGameIdAsync(server);
    var aliceAuth = await alice.LoginAsync(userA, userA);
    var bobAuth = await bob.LoginAsync(userB, userB);

    Console.WriteLine($"Logged in as {aliceAuth.User.Username} and {bobAuth.User.Username}");
    Console.WriteLine($"Using gameId: {gameId}");

    var lobby = await alice.CreateLobbyAsync(
        gameId: gameId,
        name: $"binary-csharp-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}",
        isPrivate: true,
        settings: new Dictionary<string, object?> { ["mode"] = "binary-test" }
    );

    await bob.JoinLobbyAsync(lobby.Id);
    await Task.Delay(200);

    var lobbyInfo = await alice.GetLobbyInfoAsync();
    var aliceUserId = lobbyInfo.Players.FirstOrDefault(p => p.Username == userA)?.UserId ?? lobbyInfo.HostId;
    var bobUserId = lobbyInfo.Players.FirstOrDefault(p => p.Username == userB)?.UserId ?? "";

    if (string.IsNullOrWhiteSpace(aliceUserId) || string.IsNullOrWhiteSpace(bobUserId))
    {
        throw new Exception("Could not resolve lobby player IDs for validation");
    }

    var payloadLobby = new byte[] { 10, 20, 30, 40, 50, 60 };
    var payloadDirect = new byte[] { 99, 88, 77, 66, 55, 44, 33 };

    var bobRecvTcs = new TaskCompletionSource<RelayBinaryMessage>(TaskCreationOptions.RunContinuationsAsynchronously);
    void BobHandler(RelayBinaryMessage msg) => bobRecvTcs.TrySetResult(msg);
    bob.MessageBinary += BobHandler;

    try
    {
        await alice.SendToLobbyBinaryAsync(typeLobby, payloadLobby);
        var bobMsg = await WithTimeout(bobRecvTcs.Task, TimeSpan.FromSeconds(4), "bob lobby binary receive");

        if (bobMsg.From != aliceUserId || bobMsg.TypeCode != typeLobby || !EqualBytes(bobMsg.Payload, payloadLobby))
        {
            Console.WriteLine("DEBUG lobby mismatch:");
            Console.WriteLine($"  expected from={aliceUserId}, got={bobMsg.From}");
            Console.WriteLine($"  expected typeCode={typeLobby}, got={bobMsg.TypeCode}");
            Console.WriteLine($"  expected payload({payloadLobby.Length})={Hex(payloadLobby)}");
            Console.WriteLine($"  got payload({bobMsg.Payload.Length})={Hex(bobMsg.Payload)}");
            throw new Exception("Lobby binary relay validation failed");
        }
        Console.WriteLine("PASS: Lobby binary relay");
    }
    finally
    {
        bob.MessageBinary -= BobHandler;
    }

    var aliceRecvTcs = new TaskCompletionSource<RelayBinaryMessage>(TaskCreationOptions.RunContinuationsAsynchronously);
    void AliceHandler(RelayBinaryMessage msg) => aliceRecvTcs.TrySetResult(msg);
    alice.MessageBinary += AliceHandler;

    try
    {
        await bob.SendToPlayerBinaryAsync(aliceUserId, typeDirect, payloadDirect);
        var aliceMsg = await WithTimeout(aliceRecvTcs.Task, TimeSpan.FromSeconds(4), "alice direct binary receive");

        if (aliceMsg.From != bobUserId || aliceMsg.TypeCode != typeDirect || !EqualBytes(aliceMsg.Payload, payloadDirect))
        {
            Console.WriteLine("DEBUG direct mismatch:");
            Console.WriteLine($"  expected from={bobUserId}, got={aliceMsg.From}");
            Console.WriteLine($"  expected typeCode={typeDirect}, got={aliceMsg.TypeCode}");
            Console.WriteLine($"  expected payload({payloadDirect.Length})={Hex(payloadDirect)}");
            Console.WriteLine($"  got payload({aliceMsg.Payload.Length})={Hex(aliceMsg.Payload)}");
            throw new Exception("Direct binary relay validation failed");
        }
        Console.WriteLine("PASS: Direct binary relay");
    }
    finally
    {
        alice.MessageBinary -= AliceHandler;
    }

    Console.WriteLine("SUCCESS: C# binary relay test completed");
}
finally
{
    await Task.WhenAll(
        alice.LogoutAsync().ContinueWith(_ => { }),
        bob.LogoutAsync().ContinueWith(_ => { })
    );
}
