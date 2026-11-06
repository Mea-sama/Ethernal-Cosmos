using System.Numerics;
using System.Text.Json;
using EthernalCosmos.Client;
using EthernalCosmos.Client.Models;
using EthernalCosmos.ScoreRush.Shared;
using Raylib_cs;

var app = new ScoreRushClientApp();
await app.RunAsync();

internal sealed class ScoreRushClientApp
{
    private static readonly string EventLogPath = Path.Combine(AppContext.BaseDirectory, "score-rush-client-events.log");
    private readonly object _sync = new();
    private readonly JsonSerializerOptions _json = new() { PropertyNameCaseInsensitive = true };

    private EthernalClient? _client;
    private Lobby? _lobby;
    private ScoreRushSnapshot? _snapshot;
    private ScoreRushRoundResult? _roundResult;
    private LeaderboardResult? _leaderboard;

    private string _status = "Not connected";
    private string _serverUrl = "http://127.0.0.1:12346";
    private string _username = "";
    private string _password = "password123";
    private string _joinCode = "";
    private string _roundSecondsText = ScoreRushGame.DefaultRoundSeconds.ToString();
    private string _spawnRateText = ScoreRushGame.SpawnPerSecond.ToString("0.0");
    private string _initialPickupsText = ScoreRushGame.StartPickups.ToString();
    private int _roundSeconds = ScoreRushGame.DefaultRoundSeconds;
    private float _spawnRate = ScoreRushGame.SpawnPerSecond;
    private int _initialPickups = ScoreRushGame.StartPickups;
    private string _lobbyChangeReason = "none";

    private string _selfUserId = "";
    private string _selfUsername = "";

    private bool _busy;
    private bool _inputSendInFlight;
    private DateTimeOffset _lastInputSent = DateTimeOffset.MinValue;
    private readonly Queue<DateTimeOffset> _inputSendTimestamps = new();

    private readonly List<JoinRequestInfo> _incomingJoinRequests = [];
    private readonly List<string> _logs = [];

    private TextField _activeField = TextField.None;

    public async Task RunAsync()
    {
        InitializeLogFile();
        AppendLog($"Score Rush client started. Server URL: {_serverUrl}");

        Raylib.SetConfigFlags(ConfigFlags.FLAG_WINDOW_RESIZABLE);
        Raylib.InitWindow(1320, 820, "Ethernal Cosmos - Score Rush (Raylib C#)");
        Raylib.SetTargetFPS(60);

        while (!Raylib.WindowShouldClose())
        {
            HandleTextInput();
            HandleGameInput();
            Draw();
        }

        if (_client is not null)
        {
            await _client.DisposeAsync();
        }

        Raylib.CloseWindow();
    }

    private void HandleTextInput()
    {
        if (_activeField == TextField.None) return;

        var entered = Raylib.GetCharPressed();
        while (entered > 0)
        {
            if (entered is >= 32 and <= 126)
            {
                AppendToActive(((char)entered).ToString());
            }

            entered = Raylib.GetCharPressed();
        }

        if (Raylib.IsKeyPressed(KeyboardKey.KEY_BACKSPACE))
        {
            BackspaceActive();
        }
    }

    private void HandleGameInput()
    {
        EthernalClient? client;
        Lobby? lobby;
        lock (_sync)
        {
            client = _client;
            lobby = _lobby;
        }

        if (client is null || lobby is null || _busy) return;

        var now = DateTimeOffset.UtcNow;
        if ((now - _lastInputSent).TotalMilliseconds < 50) return;
        if (_inputSendInFlight) return;

        var x = 0f;
        var y = 0f;
        if (Raylib.IsKeyDown(KeyboardKey.KEY_A) || Raylib.IsKeyDown(KeyboardKey.KEY_LEFT)) x -= 1f;
        if (Raylib.IsKeyDown(KeyboardKey.KEY_D) || Raylib.IsKeyDown(KeyboardKey.KEY_RIGHT)) x += 1f;
        if (Raylib.IsKeyDown(KeyboardKey.KEY_W) || Raylib.IsKeyDown(KeyboardKey.KEY_UP)) y -= 1f;
        if (Raylib.IsKeyDown(KeyboardKey.KEY_S) || Raylib.IsKeyDown(KeyboardKey.KEY_DOWN)) y += 1f;

        if (Math.Abs(x) < 0.0001f && Math.Abs(y) < 0.0001f) return;

        var vec = new Vector2(x, y);
        if (vec.LengthSquared() > 1f)
        {
            vec = Vector2.Normalize(vec);
        }

        RecordInputAttempt();
        _lastInputSent = now;
        _inputSendInFlight = true;
        _ = Task.Run(async () =>
        {
            try
            {
                await client.SendGameActionAsync(ScoreRushGame.InputActionType, new PlayerInputMessage { X = vec.X, Y = vec.Y });
            }
            catch (Exception ex)
            {
                SetStatus($"Input send failed: {ex.Message}");
            }
            finally
            {
                _inputSendInFlight = false;
            }
        });
    }

    private void Draw()
    {
        Raylib.BeginDrawing();
        Raylib.ClearBackground(new Color(20, 22, 26, 255));

        DrawConnectionPanel();
        DrawActionPanel();
        DrawMapPanel();
        DrawLeaderboardPanel();
        DrawLogPanel();

        Raylib.EndDrawing();
    }

    private void DrawConnectionPanel()
    {
        Raylib.DrawRectangle(12, 12, 1296, 120, new Color(31, 36, 43, 255));
        Raylib.DrawText("Score Rush Client", 24, 22, 28, Color.RAYWHITE);
        Raylib.DrawText(_status, 24, 56, 18, new Color(186, 201, 219, 255));

        DrawTextField("Server URL", new Rectangle(430, 18, 300, 32), _serverUrl, TextField.ServerUrl);
        DrawTextField("Username", new Rectangle(740, 18, 180, 32), _username, TextField.Username);
        DrawTextField("Password", new Rectangle(930, 18, 180, 32), Mask(_password), TextField.Password);

        if (Button(new Rectangle(1120, 18, 176, 32), "Login/Register", new Color(66, 120, 80, 255)))
        {
            _ = RunTaskAsync(LoginOrRegisterAsync);
        }

        if (Button(new Rectangle(1120, 58, 176, 32), "Disconnect", new Color(131, 82, 78, 255)))
        {
            _ = RunTaskAsync(DisconnectAsync);
        }
    }

    private void DrawActionPanel()
    {
        Raylib.DrawRectangle(12, 142, 360, 448, new Color(31, 36, 43, 255));
        Raylib.DrawText("Lobby / Resilience Actions", 24, 154, 20, Color.RAYWHITE);

        DrawTextField("Join Code", new Rectangle(24, 186, 180, 30), _joinCode, TextField.JoinCode);

        if (Button(new Rectangle(214, 186, 148, 30), "Join by code", new Color(70, 97, 133, 255)))
        {
            _ = RunTaskAsync(JoinByCodeAsync);
        }

        if (Button(new Rectangle(24, 224, 168, 30), "Create lobby", new Color(63, 113, 86, 255)))
        {
            _ = RunTaskAsync(CreateLobbyAsync);
        }

        if (Button(new Rectangle(198, 224, 164, 30), "Leave lobby", new Color(122, 78, 78, 255)))
        {
            _ = RunTaskAsync(LeaveLobbyAsync);
        }

        if (Button(new Rectangle(24, 262, 168, 30), "Lock lobby", new Color(96, 86, 130, 255)))
        {
            _ = RunTaskAsync(() => WithClient(c => c.LockLobbyAsync()));
        }

        if (Button(new Rectangle(198, 262, 164, 30), "Unlock lobby", new Color(96, 86, 130, 255)))
        {
            _ = RunTaskAsync(() => WithClient(c => c.UnlockLobbyAsync()));
        }

        if (Button(new Rectangle(24, 300, 168, 30), "Request by code", new Color(80, 101, 130, 255)))
        {
            _ = RunTaskAsync(RequestJoinByCodeAsync);
        }

        if (Button(new Rectangle(198, 300, 164, 30), "Pull requests", new Color(80, 101, 130, 255)))
        {
            _ = RunTaskAsync(PullJoinRequestsAsync);
        }

        if (Button(new Rectangle(24, 338, 168, 30), "Accept first req", new Color(75, 122, 79, 255)))
        {
            _ = RunTaskAsync(() => RespondFirstJoinRequestAsync(true));
        }

        if (Button(new Rectangle(198, 338, 164, 30), "Reject first req", new Color(135, 93, 67, 255)))
        {
            _ = RunTaskAsync(() => RespondFirstJoinRequestAsync(false));
        }

        if (Button(new Rectangle(24, 376, 168, 30), "Transfer host", new Color(110, 93, 55, 255)))
        {
            _ = RunTaskAsync(TransferHostAsync);
        }

        if (Button(new Rectangle(198, 376, 164, 30), "Kick other", new Color(125, 70, 70, 255)))
        {
            _ = RunTaskAsync(KickOtherAsync);
        }

        if (Button(new Rectangle(24, 414, 168, 30), "Unkick other", new Color(75, 100, 115, 255)))
        {
            _ = RunTaskAsync(UnkickOtherAsync);
        }

        if (Button(new Rectangle(198, 414, 164, 30), "Sim disconnect", new Color(98, 70, 110, 255)))
        {
            _ = RunTaskAsync(SimulateDisconnectAsync);
        }

        Raylib.DrawText("Round Settings", 24, 460, 18, Color.RAYWHITE);
        DrawTextField("Secs", new Rectangle(24, 482, 88, 28), _roundSecondsText, TextField.RoundSeconds);
        DrawTextField("Spawn/s", new Rectangle(122, 482, 96, 28), _spawnRateText, TextField.SpawnRate);
        DrawTextField("Start", new Rectangle(228, 482, 103, 28), _initialPickupsText, TextField.InitialPickups);

        if (Button(new Rectangle(24, 520, 307, 30), "Use settings on next lobby", new Color(78, 118, 97, 255)))
        {
            if (_lobby is null)
            {
                SetStatus("Settings are saved locally and used when the next lobby is created.");
            }
            else
            {
                SetStatus("Current lobby settings are already in sync from the lobby snapshot.");
            }
        }

        lock (_sync)
        {
            if (_lobby is not null)
            {
                Raylib.DrawText($"Lobby: {_lobby.Name}", 24, 560, 18, Color.RAYWHITE);
                Raylib.DrawText($"Invite: {_lobby.InviteCode}", 24, 584, 18, new Color(186, 201, 219, 255));
                Raylib.DrawText($"Status: {_lobby.Status} / server={_lobby.ServerStatus}", 24, 606, 17, new Color(186, 201, 219, 255));
            }
        }
    }

    private void DrawMapPanel()
    {
        Raylib.DrawRectangle(384, 142, 924, 520, new Color(31, 36, 43, 255));
        Raylib.DrawText("Arena", 396, 154, 20, Color.RAYWHITE);

        var arena = new Rectangle(404, 186, 884, 456);
        Raylib.DrawRectangleRec(arena, new Color(11, 19, 30, 255));
        Raylib.DrawRectangleLinesEx(arena, 3f, new Color(207, 209, 215, 255));

        ScoreRushSnapshot? snapshot;
        string selfId;
        lock (_sync)
        {
            snapshot = _snapshot;
            selfId = _selfUserId;
        }

        if (snapshot is not null)
        {
            var diagnosticsRect = new Rectangle(arena.X + arena.Width - 260f, arena.Y + 12f, 248f, 104f);
            Raylib.DrawRectangleRec(diagnosticsRect, new Color(0, 0, 0, 170));
            Raylib.DrawRectangleLinesEx(diagnosticsRect, 1.5f, new Color(116, 133, 157, 180));
            Raylib.DrawText("Diagnostics", (int)diagnosticsRect.X + 12, (int)diagnosticsRect.Y + 10, 16, Color.RAYWHITE);

            var nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var ageMs = Math.Max(0L, nowMs - snapshot.ServerTimeMs);
            var inputRate = GetInputRatePerSecond();
            var serverLabel = GetServerStatusLabel();

            Raylib.DrawText($"Server: {serverLabel}", (int)diagnosticsRect.X + 12, (int)diagnosticsRect.Y + 30, 15, new Color(195, 210, 227, 255));
            Raylib.DrawText($"Lobby reason: {_lobbyChangeReason}", (int)diagnosticsRect.X + 12, (int)diagnosticsRect.Y + 48, 15, new Color(195, 210, 227, 255));
            Raylib.DrawText($"Input rate: {inputRate:0.0}/s", (int)diagnosticsRect.X + 12, (int)diagnosticsRect.Y + 66, 15, new Color(195, 210, 227, 255));
            Raylib.DrawText($"Snapshot age: {ageMs} ms", (int)diagnosticsRect.X + 12, (int)diagnosticsRect.Y + 84, 15, new Color(195, 210, 227, 255));
        }

        if (snapshot is null)
        {
            Raylib.DrawText("No game snapshot yet. Create/join a lobby and move with WASD.", 420, 400, 20, new Color(165, 176, 190, 255));
            return;
        }

        var scale = MathF.Min(arena.Width / snapshot.ArenaWidth, arena.Height / snapshot.ArenaHeight);
        var ox = arena.X + (arena.Width - snapshot.ArenaWidth * scale) * 0.5f;
        var oy = arena.Y + (arena.Height - snapshot.ArenaHeight * scale) * 0.5f;

        foreach (var pickup in snapshot.Pickups)
        {
            var px = ox + pickup.X * scale;
            var py = oy + pickup.Y * scale;
            Raylib.DrawCircleV(new Vector2(px, py), ScoreRushGame.PickupRadius * scale, new Color(248, 197, 64, 255));
        }

        foreach (var player in snapshot.Players)
        {
            var px = ox + player.X * scale;
            var py = oy + player.Y * scale;
            var color = player.UserId == selfId ? new Color(84, 220, 155, 255) : new Color(85, 162, 241, 255);
            if (!player.Connected)
            {
                color = new Color(125, 130, 140, 255);
            }

            Raylib.DrawCircleV(new Vector2(px, py), ScoreRushGame.PlayerRadius * scale, color);
            Raylib.DrawText($"{player.Username} ({player.Score})", (int)px - 30, (int)py - 34, 14, Color.RAYWHITE);
        }

        Raylib.DrawText($"Phase: {snapshot.Phase}", 410, 650, 18, Color.RAYWHITE);
        Raylib.DrawText($"Time Left: {snapshot.TimeLeftSec:0.0}s", 560, 650, 18, Color.RAYWHITE);
        if (!string.IsNullOrWhiteSpace(snapshot.Status))
        {
            Raylib.DrawText(snapshot.Status, 760, 650, 18, new Color(186, 201, 219, 255));
        }

        ScoreRushRoundResult? result;
        lock (_sync)
        {
            result = _roundResult;
        }

        if (result is not null)
        {
            Raylib.DrawRectangle(520, 250, 460, 220, new Color(0, 0, 0, 180));
            Raylib.DrawText("Round Finished", 560, 274, 32, Color.RAYWHITE);
            Raylib.DrawText($"Reason: {result.Reason}", 560, 312, 22, new Color(212, 216, 224, 255));
            var winner = string.IsNullOrWhiteSpace(result.WinnerUsername) ? "Draw" : result.WinnerUsername;
            Raylib.DrawText($"Winner: {winner}", 560, 342, 24, new Color(247, 211, 92, 255));

            var y = 376;
            foreach (var p in result.Scores)
            {
                Raylib.DrawText($"{p.Username}: {p.Score}", 560, y, 20, new Color(212, 216, 224, 255));
                y += 24;
            }
        }
    }

    private void DrawLeaderboardPanel()
    {
        Raylib.DrawRectangle(12, 522, 360, 140, new Color(31, 36, 43, 255));
        Raylib.DrawText("Leaderboard (best round)", 24, 534, 20, Color.RAYWHITE);

        if (Button(new Rectangle(24, 562, 120, 28), "Refresh", new Color(72, 104, 120, 255)))
        {
            _ = RunTaskAsync(RefreshLeaderboardAsync);
        }

        LeaderboardResult? board;
        lock (_sync)
        {
            board = _leaderboard;
        }

        if (board is null)
        {
            Raylib.DrawText("No leaderboard data yet.", 24, 596, 18, new Color(182, 195, 210, 255));
            return;
        }

        var rowY = 596;
        foreach (var entry in board.Entries.Take(3))
        {
            var score = ReadInt(entry.Value);
            Raylib.DrawText($"#{entry.Rank} {entry.Username} - {score}", 24, rowY, 18, Color.RAYWHITE);
            rowY += 22;
        }

        if (board.Me is not null)
        {
            Raylib.DrawText($"Me: #{board.Me.Rank} ({ReadInt(board.Me.Value)})", 180, 562, 18, new Color(247, 211, 92, 255));
        }
    }

    private void DrawLogPanel()
    {
        Raylib.DrawRectangle(384, 672, 924, 136, new Color(31, 36, 43, 255));
        Raylib.DrawText("Event Log", 396, 684, 20, Color.RAYWHITE);

        string[] lines;
        lock (_sync)
        {
            lines = _logs.TakeLast(5).ToArray();
        }

        var y = 712;
        foreach (var line in lines)
        {
            Raylib.DrawText(line, 396, y, 17, new Color(186, 201, 219, 255));
            y += 20;
        }
    }

    private void DrawTextField(string label, Rectangle rect, string value, TextField field)
    {
        Raylib.DrawText(label, (int)rect.X, (int)rect.Y - 16, 14, new Color(180, 193, 206, 255));
        var active = _activeField == field;
        var fill = active ? new Color(54, 62, 75, 255) : new Color(42, 49, 60, 255);
        Raylib.DrawRectangleRec(rect, fill);
        Raylib.DrawRectangleLinesEx(rect, 2f, active ? new Color(130, 169, 230, 255) : new Color(88, 99, 116, 255));
        Raylib.DrawText(value, (int)rect.X + 8, (int)rect.Y + 7, 16, Color.RAYWHITE);

        if (Raylib.IsMouseButtonPressed(MouseButton.MOUSE_BUTTON_LEFT) && Raylib.CheckCollisionPointRec(Raylib.GetMousePosition(), rect))
        {
            _activeField = field;
        }
    }

    private static bool Button(Rectangle rect, string text, Color fill)
    {
        var mouse = Raylib.GetMousePosition();
        var hover = Raylib.CheckCollisionPointRec(mouse, rect);
        var drawFill = hover ? Shift(fill, 22) : fill;
        Raylib.DrawRectangleRec(rect, drawFill);
        Raylib.DrawRectangleLinesEx(rect, 2f, new Color(36, 40, 46, 255));
        Raylib.DrawText(text, (int)rect.X + 10, (int)rect.Y + 7, 16, Color.RAYWHITE);
        return hover && Raylib.IsMouseButtonPressed(MouseButton.MOUSE_BUTTON_LEFT);
    }

    private static Color Shift(Color c, int delta)
    {
        int Clip(int v) => Math.Clamp(v, 0, 255);
        return new Color((byte)Clip(c.R + delta), (byte)Clip(c.G + delta), (byte)Clip(c.B + delta), c.A);
    }

    private async Task RunTaskAsync(Func<Task> task)
    {
        if (_busy) return;
        _busy = true;
        try
        {
            await task();
        }
        catch (Exception ex)
        {
            SetStatus($"Action failed: {ex.Message}");
        }
        finally
        {
            _busy = false;
        }
    }

    private async Task LoginOrRegisterAsync()
    {
        await DisposeClientIfAnyAsync();
        AppendLog($"Attempting auth against {_serverUrl} as '{_username}'");

        var client = new EthernalClient(new EthernalClientOptions
        {
            ServerUrl = _serverUrl,
            ClientType = ClientType.Game,
        });

        WireClientEvents(client);

        AuthResult auth;
        try
        {
            auth = await client.RegisterAsync(_username, _password);
            SetStatus($"Registered and connected as {_username}");
        }
        catch (EthernalException ex) when (ex.Error == ErrorCode.UsernameTaken)
        {
            AppendLog($"Username already exists; trying login. Error={ex.Error} Message={ex.Message}");
            auth = await client.LoginAsync(_username, _password);
            SetStatus($"Logged in as {_username}");
        }
        catch (Exception ex)
        {
            AppendLog($"Auth failed before login/register. Message={ex.Message}");
            throw;
        }

        AppendLog($"Registering game '{ScoreRushGame.GameId}' with client version 0.1.0");
        try
        {
            await client.RegisterGameAsync(ScoreRushGame.GameId, clientVersion: "0.1.0", platform: "raylib-csharp");
        }
        catch (Exception ex)
        {
            AppendLog($"Game registration failed. GameId={ScoreRushGame.GameId} Message={ex.Message}");
            throw;
        }

        lock (_sync)
        {
            _client = client;
            _selfUserId = auth.User.UserId;
            _selfUsername = auth.User.Username;
            _roundResult = null;
        }

        AppendLog($"Game registered for '{ScoreRushGame.GameId}'");
    }

    private async Task DisconnectAsync()
    {
        EthernalClient? client;
        lock (_sync)
        {
            client = _client;
        }

        if (client is null) return;
        await client.DisconnectAsync();
        SetStatus("Disconnected socket. Login/Register to reconnect.");
    }

    private async Task SimulateDisconnectAsync()
    {
        EthernalClient? client;
        lock (_sync)
        {
            client = _client;
        }

        if (client is null) return;
        await client.DisconnectAsync();
        SetStatus("Simulated disconnect sent.");
    }

    private async Task DisposeClientIfAnyAsync()
    {
        EthernalClient? old;
        lock (_sync)
        {
            old = _client;
            _client = null;
            _lobby = null;
            _snapshot = null;
            _incomingJoinRequests.Clear();
        }

        if (old is not null)
        {
            await old.DisposeAsync();
        }
    }

    private async Task CreateLobbyAsync()
    {
        await WithClient(async client =>
        {
            var settings = BuildLobbySettings();
            var lobby = await client.CreateLobbyAsync(
                "Score Rush Lobby",
                isPrivate: false,
                settings: settings,
                serverMode: ServerMode.Any);

            lock (_sync)
            {
                _lobby = lobby;
                _roundResult = null;
                _lobbyChangeReason = "lobby created";
            }

            SyncSettingsFromLobby(lobby);
            AppendLog($"Lobby created id={lobby.Id} code={lobby.InviteCode} settings={settings.Count}");
        });
    }

    private async Task JoinByCodeAsync()
    {
        await WithClient(async client =>
        {
            var lobby = await client.JoinLobbyByCodeAsync(_joinCode.Trim());
            lock (_sync)
            {
                _lobby = lobby;
                _roundResult = null;
                _lobbyChangeReason = "joined by code";
            }

            SyncSettingsFromLobby(lobby);
            AppendLog($"Joined lobby {lobby.Name}");
        });
    }

    private async Task RequestJoinByCodeAsync()
    {
        await WithClient(async client =>
        {
            var lobby = await client.RequestJoinLobbyByCodeAsync(_joinCode.Trim());
            lock (_sync)
            {
                _lobby = lobby;
            }

            AppendLog("Join request accepted.");
        });
    }

    private async Task PullJoinRequestsAsync()
    {
        await WithClient(async client =>
        {
            var req = await client.GetJoinRequestsAsync();
            lock (_sync)
            {
                _incomingJoinRequests.Clear();
                _incomingJoinRequests.AddRange(req.Incoming);
            }

            AppendLog($"Join requests incoming={req.Incoming.Length}");
        });
    }

    private async Task RespondFirstJoinRequestAsync(bool accept)
    {
        JoinRequestInfo? info;
        lock (_sync)
        {
            info = _incomingJoinRequests.FirstOrDefault();
        }

        if (info is null)
        {
            SetStatus("No pending join request");
            return;
        }

        await WithClient(client => client.RespondJoinRequestAsync(info.RequesterId, accept));
        await PullJoinRequestsAsync();
    }

    private async Task LeaveLobbyAsync()
    {
        await WithClient(async client =>
        {
            await client.LeaveLobbyAsync();
            lock (_sync)
            {
                _lobby = null;
                _snapshot = null;
                _roundResult = null;
            }

            AppendLog("Left lobby");
        });
    }

    private async Task TransferHostAsync()
    {
        await WithClient(async client =>
        {
            var target = GetOtherPlayerId();
            if (target is null)
            {
                SetStatus("No other player to transfer host to.");
                return;
            }

            await client.TransferHostAsync(target);
            AppendLog($"Transferred host to {target}");
        });
    }

    private async Task KickOtherAsync()
    {
        await WithClient(async client =>
        {
            var target = GetOtherPlayerId();
            if (target is null)
            {
                SetStatus("No other player to kick.");
                return;
            }

            await client.KickPlayerAsync(target, "Demo kick");
            AppendLog($"Kicked {target}");
        });
    }

    private async Task UnkickOtherAsync()
    {
        await WithClient(async client =>
        {
            var target = GetOtherPlayerId();
            if (target is null)
            {
                SetStatus("No other player to unkick.");
                return;
            }

            await client.UnkickPlayerAsync(target);
            AppendLog($"Unkicked {target}");
        });
    }

    private async Task RefreshLeaderboardAsync()
    {
        await WithClient(async client =>
        {
            var board = await client.GetLeaderboardWithMeAsync(ScoreRushGame.GameId, ScoreRushGame.LeaderboardKey, order: "desc", limit: 10);
            lock (_sync)
            {
                _leaderboard = board;
            }

            AppendLog($"Leaderboard total={board.Total}");
        });
    }

    private string? GetOtherPlayerId()
    {
        lock (_sync)
        {
            if (_lobby is null) return null;
            return _lobby.Players.FirstOrDefault(p => !string.Equals(p.UserId, _selfUserId, StringComparison.Ordinal))?.UserId;
        }
    }

    private async Task WithClient(Func<EthernalClient, Task> action)
    {
        EthernalClient? client;
        lock (_sync)
        {
            client = _client;
        }

        if (client is null) throw new InvalidOperationException("Not connected.");
        await action(client);
    }

    private void WireClientEvents(EthernalClient client)
    {
        client.Connected += () => SetStatus("Socket connected");
        client.Disconnected += reason => SetStatus($"Disconnected: {reason}");
        client.AuthError += reason => SetStatus($"Auth error: {reason}");
        client.ServerError += error => SetStatus($"Server error: {error}");

        client.SessionResumed += data =>
        {
            lock (_sync)
            {
                _lobby = data.Lobby;
                _lobbyChangeReason = "session resumed";
            }

            SyncSettingsFromLobby(data.Lobby);
            AppendLog("Session resumed");
        };

        client.LobbyCreated += lobby =>
        {
            lock (_sync)
            {
                _lobby = lobby;
                _lobbyChangeReason = "lobby created";
            }

            SyncSettingsFromLobby(lobby);
            AppendLog("Lobby created event received");
        };

        client.LobbyUpdated += lobby =>
        {
            lock (_sync)
            {
                _lobby = lobby;
            }

            SyncSettingsFromLobby(lobby);
        };

        client.LobbyChanged += (lobby, reason) =>
        {
            lock (_sync)
            {
                _lobby = lobby;
                _lobbyChangeReason = reason is null ? "unknown" : reason.Value.ToString();
            }

            SyncSettingsFromLobby(lobby);
            if (reason is not null)
            {
                AppendLog($"Lobby changed: {reason.Value}");
            }
        };

        client.GameState += state =>
        {
            try
            {
                var snapshot = state.Deserialize<ScoreRushSnapshot>(_json);
                if (snapshot is null) return;
                lock (_sync)
                {
                    _snapshot = snapshot;
                }
            }
            catch (JsonException)
            {
                AppendLog("Failed to parse game snapshot");
            }
        };

        client.GameEvent += evt =>
        {
            AppendLog($"Game event: {evt}");
        };

        client.GameOver += over =>
        {
            try
            {
                var result = over.Deserialize<ScoreRushRoundResult>(_json);
                if (result is null) return;
                lock (_sync)
                {
                    _roundResult = result;
                }

                AppendLog("Round finished");
            }
            catch (JsonException)
            {
                AppendLog("Failed to parse game over payload");
            }
        };

        client.JoinRequestReceived += data =>
        {
            lock (_sync)
            {
                _incomingJoinRequests.RemoveAll(r => string.Equals(r.RequesterId, data.RequesterId, StringComparison.Ordinal));
                _incomingJoinRequests.Add(new JoinRequestInfo
                {
                    LobbyId = data.LobbyId,
                    RequesterId = data.RequesterId,
                    Username = data.Username,
                    ExpiresAt = data.ExpiresAt,
                });
            }

            AppendLog($"Join request from {data.Username}");
        };

        client.JoinRequestWithdrawn += data =>
        {
            lock (_sync)
            {
                _incomingJoinRequests.RemoveAll(r => string.Equals(r.RequesterId, data.RequesterId, StringComparison.Ordinal));
            }

            AppendLog($"Join request withdrawn: {data.RequesterId}");
        };

        client.JoinRequestAccepted += _ => AppendLog("Join request accepted");
        client.JoinRequestRejected += data => AppendLog($"Join request rejected: {data.Reason}");

        client.PlayerKicked += kicked =>
        {
            AppendLog($"You were kicked from lobby {kicked.LobbyId}. Reason={kicked.Reason}");
        };
    }

    private void AppendToActive(string text)
    {
        switch (_activeField)
        {
            case TextField.ServerUrl:
                _serverUrl += text;
                break;
            case TextField.Username:
                _username += text;
                break;
            case TextField.Password:
                _password += text;
                break;
            case TextField.JoinCode:
                _joinCode += text.ToUpperInvariant();
                break;
            case TextField.RoundSeconds:
                _roundSecondsText += text;
                _roundSeconds = ParseIntText(_roundSecondsText, ScoreRushGame.DefaultRoundSeconds);
                break;
            case TextField.SpawnRate:
                _spawnRateText += text;
                _spawnRate = ParseFloatText(_spawnRateText, ScoreRushGame.SpawnPerSecond);
                break;
            case TextField.InitialPickups:
                _initialPickupsText += text;
                _initialPickups = ParseIntText(_initialPickupsText, ScoreRushGame.StartPickups);
                break;
        }
    }

    private void BackspaceActive()
    {
        switch (_activeField)
        {
            case TextField.ServerUrl:
                _serverUrl = Backspace(_serverUrl);
                break;
            case TextField.Username:
                _username = Backspace(_username);
                break;
            case TextField.Password:
                _password = Backspace(_password);
                break;
            case TextField.JoinCode:
                _joinCode = Backspace(_joinCode);
                break;
            case TextField.RoundSeconds:
                _roundSecondsText = Backspace(_roundSecondsText);
                _roundSeconds = ParseIntText(_roundSecondsText, ScoreRushGame.DefaultRoundSeconds);
                break;
            case TextField.SpawnRate:
                _spawnRateText = Backspace(_spawnRateText);
                _spawnRate = ParseFloatText(_spawnRateText, ScoreRushGame.SpawnPerSecond);
                break;
            case TextField.InitialPickups:
                _initialPickupsText = Backspace(_initialPickupsText);
                _initialPickups = ParseIntText(_initialPickupsText, ScoreRushGame.StartPickups);
                break;
        }
    }

    private static string Backspace(string input) => input.Length > 0 ? input[..^1] : input;

    private void SetStatus(string status)
    {
        lock (_sync)
        {
            _status = status;
        }

        AppendLog(status);
    }

    private static void InitializeLogFile()
    {
        try
        {
            if (!File.Exists(EventLogPath))
            {
                File.WriteAllText(EventLogPath, $"[{DateTime.Now:O}] Score Rush client log initialized{Environment.NewLine}");
            }
        }
        catch
        {
            // Ignore file logging failures; the UI log still works.
        }
    }

    private void AppendLog(string log)
    {
        var entry = $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}] {log}{Environment.NewLine}";

        lock (_sync)
        {
            _logs.Add(entry.TrimEnd());
            if (_logs.Count > 100)
            {
                _logs.RemoveRange(0, _logs.Count - 100);
            }
        }

        try
        {
            File.AppendAllText(EventLogPath, entry);
        }
        catch
        {
            // Ignore file logging failures; the UI log still works.
        }
    }

    private static string Mask(string password) => new('*', password.Length);

    private static int ReadInt(object? value, int fallback = 0)
    {
        return value switch
        {
            int i => i,
            long l => (int)l,
            double d => (int)d,
            float f => (int)f,
            JsonElement je when je.ValueKind == JsonValueKind.Number && je.TryGetInt32(out var i) => i,
            JsonElement je when je.ValueKind == JsonValueKind.Number => (int)je.GetDouble(),
            _ => fallback,
        };
    }

    private static float ReadFloat(object? value, float fallback = 0f)
    {
        return value switch
        {
            float f => f,
            int i => i,
            long l => l,
            double d => (float)d,
            JsonElement je when je.ValueKind == JsonValueKind.Number && je.TryGetDouble(out var d) => (float)d,
            _ => fallback,
        };
    }

    private static int ParseIntText(string? value, int fallback)
    {
        if (string.IsNullOrWhiteSpace(value)) return fallback;
        return int.TryParse(value, out var parsed) ? parsed : fallback;
    }

    private static float ParseFloatText(string? value, float fallback)
    {
        if (string.IsNullOrWhiteSpace(value)) return fallback;
        return float.TryParse(value, out var parsed) ? parsed : fallback;
    }

    private Dictionary<string, object?> BuildLobbySettings()
    {
        _roundSeconds = ParseIntText(_roundSecondsText, ScoreRushGame.DefaultRoundSeconds);
        _spawnRate = ParseFloatText(_spawnRateText, ScoreRushGame.SpawnPerSecond);
        _initialPickups = ParseIntText(_initialPickupsText, ScoreRushGame.StartPickups);

        _roundSeconds = Math.Clamp(_roundSeconds, 10, 600);
        _spawnRate = MathF.Max(0.1f, _spawnRate);
        _initialPickups = Math.Clamp(_initialPickups, 0, 100);

        _roundSecondsText = _roundSeconds.ToString();
        _spawnRateText = _spawnRate.ToString("0.0");
        _initialPickupsText = _initialPickups.ToString();

        return new Dictionary<string, object?>
        {
            [ScoreRushGame.RoundSecondsSettingKey] = _roundSeconds,
            [ScoreRushGame.SpawnRateSettingKey] = _spawnRate,
            [ScoreRushGame.InitialPickupsSettingKey] = _initialPickups,
        };
    }

    private void SyncSettingsFromLobby(Lobby? lobby)
    {
        if (lobby is null) return;

        _roundSeconds = ReadInt(lobby.Settings.GetValueOrDefault(ScoreRushGame.RoundSecondsSettingKey), ScoreRushGame.DefaultRoundSeconds);
        _spawnRate = ReadFloat(lobby.Settings.GetValueOrDefault(ScoreRushGame.SpawnRateSettingKey), ScoreRushGame.SpawnPerSecond);
        _initialPickups = ReadInt(lobby.Settings.GetValueOrDefault(ScoreRushGame.InitialPickupsSettingKey), ScoreRushGame.StartPickups);

        if (_roundSeconds < 10) _roundSeconds = ScoreRushGame.DefaultRoundSeconds;
        if (_spawnRate <= 0f) _spawnRate = ScoreRushGame.SpawnPerSecond;
        if (_initialPickups < 0) _initialPickups = ScoreRushGame.StartPickups;

        _roundSecondsText = _roundSeconds.ToString();
        _spawnRateText = _spawnRate.ToString("0.0");
        _initialPickupsText = _initialPickups.ToString();
    }

    private string GetServerStatusLabel()
    {
        lock (_sync)
        {
            if (_client is null) return "offline";
            if (_lobby is not null && _lobby.ServerStatus is not null)
            {
                return _lobby.ServerStatus.Value.ToString();
            }

            return "connected";
        }
    }

    private float GetInputRatePerSecond()
    {
        lock (_sync)
        {
            var now = DateTimeOffset.UtcNow;
            while (_inputSendTimestamps.Count > 0 && (now - _inputSendTimestamps.Peek()).TotalSeconds > 5.0)
            {
                _inputSendTimestamps.Dequeue();
            }

            if (_inputSendTimestamps.Count == 0) return 0f;

            var begin = _inputSendTimestamps.Peek();
            var elapsed = Math.Max((now - begin).TotalSeconds, 0.1);
            return (float)(_inputSendTimestamps.Count / elapsed);
        }
    }

    private void RecordInputAttempt()
    {
        lock (_sync)
        {
            var now = DateTimeOffset.UtcNow;
            _inputSendTimestamps.Enqueue(now);
            while (_inputSendTimestamps.Count > 0 && (now - _inputSendTimestamps.Peek()).TotalSeconds > 5.0)
            {
                _inputSendTimestamps.Dequeue();
            }
        }
    }

    private enum TextField
    {
        None,
        ServerUrl,
        Username,
        Password,
        JoinCode,
        RoundSeconds,
        SpawnRate,
        InitialPickups,
    }
}
