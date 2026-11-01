using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;

namespace EthernalCosmos.Client.Tests;

/// <summary>A real hub process (<c>node server/dist/index.js</c>) with test games and generous limits, like server/test/helpers/hub.ts.</summary>
public sealed class HubProcess : IAsyncDisposable
{
    private static readonly string[] LimitedEvents =
    [
        "createLobby", "joinLobby", "joinLobbyByCode", "kickPlayer", "transferHost", "lockLobby", "unlockLobby", "requestJoinLobby",
        "requestJoinLobbyByCode", "cancelJoinRequest", "respondJoinRequest", "listLobbies", "getLobbyInfo", "presenceList", "getUserData",
        "getPlayerData", "gameAction", "registerGame", "sessionState", "setUserData", "bulkSetUserData", "deleteUserData", "leaveLobby",
        "friendRequestByName", "friendRequest", "friendAction", "socialRead", "socialSettings", "notificationWrite", "dmSend", "dmTyping",
        "lobbyInvite", "lobbyInviteAction", "authRefresh", "setLobbyState",
    ];

    private readonly Process _process;
    private readonly string _dataDir;
    private readonly StringBuilder _log = new();

    public string Url { get; }

    private HubProcess(Process process, string dataDir, string url)
    {
        _process = process;
        _dataDir = dataDir;
        Url = url;
    }

    public static string FindRepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            if (File.Exists(Path.Combine(dir.FullName, "package.json")) && Directory.Exists(Path.Combine(dir.FullName, "server")))
                return dir.FullName;
            dir = dir.Parent;
        }
        throw new InvalidOperationException("Repo root (package.json + server/) not found above " + AppContext.BaseDirectory);
    }

    private static int FreePort()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        return port;
    }

    public static async Task<HubProcess> StartAsync(Dictionary<string, string>? env = null, Dictionary<string, object>? limitOverrides = null)
    {
        var root = FindRepoRoot();
        var hubJs = Path.Combine(root, "server", "dist", "index.js");
        if (!File.Exists(hubJs)) throw new FileNotFoundException("Hub not built — run `npm run build` first.", hubJs);

        var dataDir = Path.Combine(AppContext.BaseDirectory, "hub-data-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(dataDir);
        var gamesPath = Path.Combine(dataDir, "games.json");
        var limitsPath = Path.Combine(dataDir, "limits.json");

        object[] games =
        [
            new { id = "echo", name = "Echo", maxPlayers = 3, entryScript = Path.Combine(root, "csharp-sdk", "EthernalCosmos.Client.Tests", "fixtures", "echo-game.js"), reconnectGraceMs = 1500, serverKeys = new[] { "rank\\..*" }, publicSettingKeys = new[] { "mode" } },
            new { id = "relay", name = "Relay", maxPlayers = 2, reconnectGraceMs = 1500 },
            new { id = "other", name = "Other", maxPlayers = 4, reconnectGraceMs = 1500 },
            new { id = "gs-opt", name = "GS optional", maxPlayers = 4, reconnectGraceMs = 1500, serverSupport = "optional", regions = new[] { "eu", "us" } },
            new { id = "gs-req", name = "GS required", maxPlayers = 4, reconnectGraceMs = 1500, serverSupport = "required", regions = new[] { "eu", "us" } },
        ];
        await File.WriteAllTextAsync(gamesPath, JsonSerializer.Serialize(games));

        var big = new { refillPerSecond = 1000, burst = 100000 };
        var authBig = new { windowMs = 60000, max = 10000, message = "x" };
        var limits = new Dictionary<string, object>
        {
            ["authRateLimits"] = new { login = authBig, register = authBig, refresh = authBig },
            ["socketLimits"] = LimitedEvents.ToDictionary(k => k, _ => (object)big),
        };
        foreach (var (k, v) in limitOverrides ?? []) limits[k] = v;
        await File.WriteAllTextAsync(limitsPath, JsonSerializer.Serialize(limits));

        var port = FreePort();
        var psi = new ProcessStartInfo("node") { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true, WorkingDirectory = root };
        psi.ArgumentList.Add(hubJs);
        var vars = new Dictionary<string, string>
        {
            ["NODE_ENV"] = "test", ["PORT"] = port.ToString(), ["HOST"] = "127.0.0.1", ["DATA_DIR"] = dataDir,
            ["GAMES_CONFIG_PATH"] = gamesPath, ["LIMITS_CONFIG_PATH"] = limitsPath, ["BCRYPT_ROUNDS"] = "4",
            ["JWT_SECRET"] = "test-secret", ["ADMIN_TOKEN"] = "admin-test",
            ["SERVER_RESUME_GRACE_MS"] = "1500", ["SERVER_ASSIGN_TIMEOUT_MS"] = "800",
        };
        foreach (var (k, v) in env ?? []) vars[k] = v;
        foreach (var (k, v) in vars) psi.Environment[k] = v;

        var process = new Process { StartInfo = psi };
        var hub = new HubProcess(process, dataDir, $"http://127.0.0.1:{port}");
        process.OutputDataReceived += (_, e) => { lock (hub._log) hub._log.AppendLine(e.Data); };
        process.ErrorDataReceived += (_, e) => { lock (hub._log) hub._log.AppendLine(e.Data); };
        process.Start();
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();

        using var http = new HttpClient();
        var deadline = DateTime.UtcNow.AddSeconds(20);
        while (true)
        {
            try
            {
                if ((await http.GetAsync(hub.Url + "/health")).IsSuccessStatusCode) break;
            }
            catch (HttpRequestException) { /* not ready yet */ }
            if (process.HasExited) throw new InvalidOperationException("Hub exited: " + hub._log);
            if (DateTime.UtcNow > deadline)
            {
                await hub.DisposeAsync();
                throw new TimeoutException("Hub start timeout: " + hub._log);
            }
            await Task.Delay(100);
        }
        return hub;
    }

    public async ValueTask DisposeAsync()
    {
        try
        {
            if (!_process.HasExited)
            {
                _process.Kill(entireProcessTree: true);
                await _process.WaitForExitAsync();
            }
        }
        catch (InvalidOperationException) { /* already gone */ }
        _process.Dispose();
        try { Directory.Delete(_dataDir, recursive: true); } catch (IOException) { /* best-effort cleanup */ }
    }
}
