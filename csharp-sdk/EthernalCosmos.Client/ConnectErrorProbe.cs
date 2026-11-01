using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

namespace EthernalCosmos.Client;

/// <summary>
/// SocketIOClient 3.x only reports <c>connect_error.message</c>; the structured <c>data</c> (<c>{code, message, retryAfterMs}</c> of RATE_LIMITED) is dropped.
/// After a refused connection this repeats the handshake once over a raw Engine.IO WebSocket purely to read that packet.
/// </summary>
internal static class ConnectErrorProbe
{
    /// <summary>Returns the connect_error JSON (<c>{"message":..,"data":{..}}</c>) or null when the probe could not read one.</summary>
    public static async Task<string?> RunAsync(string httpUrl, string ns, object auth, TimeSpan timeout)
    {
        try
        {
            var uri = new UriBuilder(httpUrl.TrimEnd('/') + "/socket.io/") { Query = "EIO=4&transport=websocket" };
            uri.Scheme = uri.Scheme == "https" ? "wss" : "ws";
            using var cts = new CancellationTokenSource(timeout);
            using var ws = new ClientWebSocket();
            await ws.ConnectAsync(uri.Uri, cts.Token);

            var nsPart = ns == "/" ? "" : ns + ",";
            var sent = false;
            while (!cts.IsCancellationRequested)
            {
                var text = await ReceiveAsync(ws, cts.Token);
                if (text is null) return null;
                if (text.StartsWith('0') && !sent)
                {
                    sent = true;
                    await SendAsync(ws, "40" + nsPart + JsonSerializer.Serialize(auth), cts.Token);
                }
                else if (text == "2") await SendAsync(ws, "3", cts.Token);
                else if (text.StartsWith("44" + nsPart)) return text[(2 + nsPart.Length)..];
                else if (text.StartsWith("40")) return null; // connected after all
            }
        }
        catch (Exception) { /* best effort */ }
        return null;
    }

    private static Task SendAsync(ClientWebSocket ws, string text, CancellationToken ct) =>
        ws.SendAsync(Encoding.UTF8.GetBytes(text), WebSocketMessageType.Text, true, ct);

    private static async Task<string?> ReceiveAsync(ClientWebSocket ws, CancellationToken ct)
    {
        var buffer = new byte[8192];
        using var ms = new MemoryStream();
        WebSocketReceiveResult result;
        do
        {
            result = await ws.ReceiveAsync(buffer, ct);
            if (result.MessageType == WebSocketMessageType.Close) return null;
            ms.Write(buffer, 0, result.Count);
        } while (!result.EndOfMessage);
        return Encoding.UTF8.GetString(ms.ToArray());
    }
}
