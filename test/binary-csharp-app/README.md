# Binary C# Test App

Runs a local C#-to-C# binary relay validation against the Hub.

## Run

```powershell
dotnet run --project test/binary-csharp-app/BinaryCsharpApp.csproj -- http://127.0.0.1:12348
```

If URL is omitted, defaults to `https://mea-sama.duckdns.org:12346`.
Use `http://127.0.0.1:12348` explicitly for local-only runs.

Accounts used:
- `rararara` (password `rararara`)
- `tatatata` (password `tatatata`)
