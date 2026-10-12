# TeamMatch frontend

## Requirements

- Node.js `^20.19.0` or `>=22.12.0` (the supported Vite runtime versions).
- npm, included with Node.js.
- The TeamMatch backend running on `http://localhost:8080`; follow its
  [setup guide](../backend/README.md) to configure MySQL and apply migrations.

## Install, validate, and run

From PowerShell in the `frontend` directory:

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run lint
npm.cmd run build
npm.cmd run dev
```

Open the Vite URL printed in the terminal (normally
`http://localhost:5173`). Keep the backend running in a separate terminal.
Vite proxies `/api` requests to `http://localhost:8080`; no database credentials
belong in frontend configuration.

The production bundle is written to `dist/`. `npm.cmd run preview` serves that
bundle locally after a successful build.
