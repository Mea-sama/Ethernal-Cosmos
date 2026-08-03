using System.Text.Json;
using EthernalCosmos.Client;
using EthernalCosmos.Client.Models;

const string defaultServer = "https://mea-sama.duckdns.org:12346";
const string user = "tatatata";
const string hostUser = "rararara";
const int typeHostToGuest = 3001;
const int typeGuestToHost = 3002;

var expectedHostPayload = new byte[] { 1, 2, 3, 4, 250, 251 };
var responsePayload = new byte[] { 9, 8, 7, 6, 42, 24 };

var server = args.Length > 0 ? args[0] : defaultServer;
var runId = args.Length > 1 ? args[1] : throw new ArgumentException("runId argument required");
var directLobbyId = args.Length > 2 ? args[2] : null;

static bool EqualBytes(byte[] a, byte[] b)
{
    if (a.Length != b.Length) return false;
    for (var i = 0; i < a.Length; i++)
    {
        if (a[i] != b[i]) return false;
    }
    return true;
}

static async Task<T> WithTimeout<T>(Task<T> task, TimeSpan timeout, string label)
{
    using var cts = new CancellationTokenSource();
    var delay = Task.Delay(timeout, cts.Token);
    var done = await Task.WhenAny(task, delay);
    if (done == delay) throw new TimeoutException($"Timeout: {label}");
    cts.Cancel();
    return await task;
}

static async Task<string[]> ResolveGameIdsAsync(string serverUrl)
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

    var ids = new List<string>();
    foreach (var game in doc.RootElement.EnumerateArray())
    {
        var id = game.GetProperty("id").GetString();
        if (!string.IsNullOrWhiteSpace(id)) ids.Add(id);
    }
    if (ids.Count == 0) throw new InvalidOperationException("No valid game ids found");
    return ids.ToArray();
}

static async Task<Lobby> WaitForLobbyAsync(EthernalClient client, string[] gameIds, string lobbyName, TimeSpan timeout)
{
    var started = DateTime.UtcNow;
    var attempts = 0;
    while (DateTime.UtcNow - started < timeout)
    {
        attempts++;
        foreach (var gameId in gameIds)
        {
            var list = await client.ListLobbiesAsync(gameId);
            var lobby = list.FirstOrDefault(l => l.Name == lobbyName);
            if (lobby is not null) return lobby;
        }
        if (attempts % 10 == 0)
        {
            Console.WriteLine($"GUEST_WAITING_FOR_LOBBY name={lobbyName} attempts={attempts}");
        }
        await Task.Delay(150);
    }

    throw new TimeoutException($"Lobby not found: {lobbyName}");
}

Console.WriteLine($"Cross interop guest (C#) against {server}, run={runId}");

await using var guest = new EthernalClient(new EthernalClientOptions { ServerUrl = server });
guest.ServerError += msg => Console.WriteLine($"[guest][serverError] {msg}");

try
{
    var auth = await guest.LoginAsync(user, user);
    Console.WriteLine($"GUEST_LOGGED_IN username={auth.User.Username}");

    string lobbyId;
    if (!string.IsNullOrWhiteSpace(directLobbyId))
    {
        lobbyId = directLobbyId;
        Console.WriteLine($"GUEST_USING_DIRECT_LOBBY id={lobbyId}");
    }
    else
    {
        var gameIds = await ResolveGameIdsAsync(server);
        Console.WriteLine($"GUEST_GAME_IDS count={gameIds.Length}");
        var lobbyName = $"cross-{runId}";
        var lobby = await WaitForLobbyAsync(guest, gameIds, lobbyName, TimeSpan.FromSeconds(25));
        lobbyId = lobby.Id;
        Console.WriteLine($"GUEST_FOUND_LOBBY id={lobbyId}");
    }

    await guest.JoinLobbyAsync(lobbyId);
    Console.WriteLine("GUEST_JOINED_LOBBY");

    var info = await guest.GetLobbyInfoAsync();
    var hostId = info.Players.FirstOrDefault(p => p.Username == hostUser)?.UserId ?? info.HostId;
    if (string.IsNullOrWhiteSpace(hostId))
    {
        throw new Exception("Could not resolve host user id");
    }

    var recvTcs = new TaskCompletionSource<RelayBinaryMessage>(TaskCreationOptions.RunContinuationsAsynchronously);
    void Handler(RelayBinaryMessage msg) => recvTcs.TrySetResult(msg);
    guest.MessageBinary += Handler;

    try
    {
        var msg = await WithTimeout(recvTcs.Task, TimeSpan.FromSeconds(8), "guest receive host lobby binary");

        if (msg.From != hostId || msg.TypeCode != typeHostToGuest || !EqualBytes(msg.Payload, expectedHostPayload))
        {
            throw new Exception("Guest received invalid host lobby binary packet");
        }

        await guest.SendToPlayerBinaryAsync(hostId, typeGuestToHost, responsePayload);
        Console.WriteLine("PASS: C# guest received host binary and sent direct response");
        Console.WriteLine("SUCCESS: Cross interop guest flow complete");
    }
    finally
    {
        guest.MessageBinary -= Handler;
    }
}
finally
{
    await guest.LogoutAsync().ContinueWith(_ => { });
}
