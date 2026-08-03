# Binary Node Test App

Runs a local Node-to-Node binary relay validation against the Hub.

## Run

```powershell
npx ts-node --project test/tsconfig.json test/binary-node-app/app.ts http://127.0.0.1:12348
```

If URL is omitted, defaults to `https://mea-sama.duckdns.org:12346`.
Use `http://127.0.0.1:12348` explicitly for local-only runs.

Accounts used:
- `rararara` (password `rararara`)
- `tatatata` (password `tatatata`)
