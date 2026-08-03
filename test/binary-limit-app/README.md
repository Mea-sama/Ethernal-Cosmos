# Binary Limit Test App

Runs three focused limit checks after load tests:

1. Oversize payload rejection (> 640 bytes)
	- Default limit is 1000 bytes (configurable in `server/config/limits.json`)
2. Invalid typeCode rejection
3. Rate-limit frequency sweep around and above the configured socket limit (120, 180, 220, 260, 320, 380 Hz)

## Default

- Endpoint: https://mea-sama.duckdns.org:12346

## Run

```powershell
npx ts-node --project test/tsconfig.json test/binary-limit-app/app.ts
```

Optional endpoint:

```powershell
npx ts-node --project test/tsconfig.json test/binary-limit-app/app.ts <serverUrl>
```

## Output

- PASS/FAIL lines in console
- JSON result file in test/results/binary-limit-*.json
