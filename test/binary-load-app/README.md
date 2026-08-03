# Binary Load Test App

Runs throughput and latency measurements for binary relay using common payload sizes up to 500 bytes at a target send rate.

## Default

- Endpoint: https://mea-sama.duckdns.org:12346
- Rate: 120 Hz
- Duration per size: 10 seconds
- Sizes: 64, 128, 256, 500 bytes

## Run

```powershell
npx ts-node --project test/tsconfig.json test/binary-load-app/app.ts
```

Optional arguments:

```powershell
npx ts-node --project test/tsconfig.json test/binary-load-app/app.ts <serverUrl> <hz> <durationSec>
```

Example local run:

```powershell
npx ts-node --project test/tsconfig.json test/binary-load-app/app.ts http://127.0.0.1:12348 120 10
```

## Output

- Console summary for each size
- JSON result file in test/results/binary-load-*.json
