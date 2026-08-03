# Binary Cross Interop Test (Node <-> C#)

Validates cross-SDK binary interop in both directions:
- Node host broadcasts binary to lobby
- C# guest receives and responds with direct binary
- Node host validates direct response

## Default endpoint

Both apps default to:
- `https://mea-sama.duckdns.org:12346`

You can pass a local endpoint explicitly, e.g. `http://127.0.0.1:12348`.

## Accounts

- Host: `rararara` / `rararara`
- Guest: `tatatata` / `tatatata`

## Run manually

Use the same `runId` for both commands.

1. Start C# guest first (it polls for the host lobby):

```powershell
dotnet run --project test/binary-cross-app/csharp-guest/BinaryCrossGuest.csproj -- https://mea-sama.duckdns.org:12346 123456
```

2. Start Node host:

```powershell
npx ts-node --project test/tsconfig.json test/binary-cross-app/host-node.ts https://mea-sama.duckdns.org:12346 123456
```

Success is reached when both commands print a `SUCCESS:` line.
