# RouterFarm Dashboard v2.0.0

RouterFarm is a native Windows 11 dashboard for a router-controlled Android farm. It evolved from the PhoneFarm codebase and is now a separate project focused on router-managed IP rotation and session control.

This release is **v2.0.0** — a major step forward in security, input validation, and maintainability.

## Designed For

- 15 GL.iNet Opal routers
- Up to 4 permanently assigned phones per router
- Only 1 phone active per router at a time
- Only 1 active phone across the whole dashboard at a time
- Remote router actions, phone-to-router connect actions, and uplink IP reset workflows

## What's New in v2.0.0

- **Input validation layer** — All API parameters (serials, router IDs, actions, usernames) are strictly validated. Invalid inputs are rejected with HTTP 400 before reaching scripts or the file system.
- **Path traversal protection** — Malicious path segments (`..`, absolute paths, drive prefixes) are blocked.
- **Security hardening** — Session cookie renamed to `routerfarm_session`, Electron IPC channels renamed to `routerfarm:*`, and the `AUTH_DISABLED` initialization order bug is fixed.
- **Modular utilities** — New `lib/validation.js`, `lib/security.js`, and `lib/process-runner.js` libraries for cleaner, reusable code.
- **CI/CD** — GitHub Actions workflow for automated testing and desktop builds.

## Folder Layout

- `server.js` — Main HTTP server and API dispatcher
- `lib/` — Shared JavaScript utilities (routing, validation, security, process runners)
- `config/settings.json` — Runtime configuration
- `config/devices.json` — Device records
- `config/routers.json` — Router records
- `scripts/` — PowerShell automation scripts
- `web/` — Vanilla HTML/JS/CSS frontend
- `electron/` — Desktop shell wrapper

## Config Model

### Routers

`config/routers.json` defines the Opal layer:

```json
{
  "routers": [
    {
      "id": "opal-01",
      "label": "Opal 01",
      "host": "192.168.8.11",
      "adminUsername": "root",
      "sshPort": 22,
      "sshKeyPath": "",
      "lanSubnet": "192.168.11.0/24",
      "ssid": "OPAL-01",
      "wifiPassword": "",
      "maxAssignedDevices": 4,
      "maxConcurrentDevices": 1,
      "mobileUplinkId": "uplink-01",
      "enabled": true
    }
  ]
}
```

### Devices

Each phone can be pinned to a router slot:

```json
{
  "serial": "DEVICE_SERIAL",
  "nickname": "Phone 01",
  "role": "opal-client",
  "routerId": "opal-01",
  "routerSlot": 1
}
```

## Control Model

### Session gating

- A phone cannot start a session until it is assigned to an Opal router.
- If any other phone is already active, the next phone is blocked.
- If another phone on the same router is active, the next phone is blocked.

### Router actions

The backend exposes:

- `POST /api/routers/:routerId/router-health`
- `POST /api/routers/:routerId/wan-reconnect`
- `POST /api/routers/:routerId/restart-wifi`
- `POST /api/routers/:routerId/cycle-uplink`

Current transport assumption:

- SSH into the Opal router
- Execute OpenWrt/GL.iNet compatible commands such as `ubus call system board`, `wifi reload`, `ifup wan`, and `reboot`

### Phone actions

The backend exposes:

- `POST /api/devices/:serial/connect-router`
- `POST /api/devices/:serial/reset-uplink-ip`

`connect-router` currently attempts Android shell Wi-Fi connection commands first and falls back to opening Wi-Fi settings if direct connect is not supported on that ROM.

## Important hardware assumptions

This fork assumes each Opal can be managed remotely either by:

- SSH with a key already deployed to the router
- Or another non-interactive admin path you will wire in later

For IP reset by power cycling the mobile USB router, this fork currently stops at the orchestration layer. You still need one real controllable power primitive per uplink, for example:

- USB relay
- Managed smart plug
- Programmable PDU
- Another host-side commandable switch path

`cycle-mobile-uplink.ps1` is intentionally a placeholder until that hardware path is defined.

## Start

```powershell
npm start
```

Desktop shell:

```powershell
npm run start:desktop
```

Seed router assignments automatically:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\seed-routerfarm-assignments.ps1
```

## Testing

```powershell
npm run test:unit
```

## Building

```powershell
npm run dist:desktop
```

## Next implementation priorities

1. Provision Opal SSH keys and confirm non-interactive router control on all 15.
2. Replace best-effort Android Wi-Fi join with a reliable on-device automation path.
3. Add a real uplink power controller implementation.
4. Add router polling and WAN/IP telemetry to the dashboard.
5. Add assignment editing in the UI for router slots.
6. Extract shared PowerShell module to eliminate script duplication.
7. Migrate backend to TypeScript.
