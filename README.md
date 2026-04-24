# RouterFarm Dashboard

RouterFarm is a native Windows 11 dashboard for a router-controlled Android farm. It starts from the working PhoneFarm codebase, but operates as a separate project focused on router-managed IP rotation and session control.

This fork is designed for:

- 15 GL.iNet Opal routers
- up to 4 permanently assigned phones per router
- only 1 phone active per router at a time
- only 1 active phone across the whole dashboard at a time
- remote router actions, phone-to-router connect actions, and uplink IP reset workflows

## Current Fork Status

This branch is the first Opal-focused foundation, not the finished production build yet.

Implemented in this fork:

- renamed desktop/package identity to `RouterFarm`
- new `config/routers.json` with 15 Opal router records
- device model extended with `routerId` and `routerSlot`
- router-aware `/api/status` payload with router summaries
- backend enforcement for single active device globally
- backend enforcement for router assignment before session activation
- router API endpoints for:
  - `router-health`
  - `wan-reconnect`
  - `restart-wifi`
  - `cycle-uplink`
- phone action endpoints for:
  - `connect-router`
  - `reset-uplink-ip`
- new PowerShell scripts for router SSH actions and phone-to-router Wi-Fi connect attempts
- UI section for Opal routers and new device actions

Still intentionally incomplete:

- production-grade GL.iNet authentication and provisioning
- confirmed SSH key rollout to every router
- fully reliable Android Wi-Fi join flow on every device/ROM
- real power relay or smart outlet integration for uplink power cycling
- router health polling beyond on-demand actions

## Setup

1. Copy config templates:
   ```powershell
   copy config\settings.template.json config\settings.json
   copy config\devices.template.json config\devices.json
   copy config\routers.template.json config\routers.json
   copy config\users.template.json config\users.json
   ```
2. Edit `config\settings.json` with your local `adb.exe` and `scrcpy.exe` paths.
3. Run deployment:
   ```powershell
   .\deploy-routerfarm.ps1
   ```

## Folder Layout

- `config/settings.json`
- `config/devices.json`
- `config/routers.json`
- `config/state.json`
- `scripts/invoke-routerfarm-router-action.ps1`
- `scripts/connect-phone-to-router.ps1`
- `scripts/cycle-mobile-uplink.ps1`
- `web/`
- `electron/`

## Config Model

### Routers

`config/routers.json` now defines the Opal layer:

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

Each phone can now be pinned to a router slot:

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

The backend now exposes:

- `POST /api/routers/:routerId/router-health`
- `POST /api/routers/:routerId/wan-reconnect`
- `POST /api/routers/:routerId/restart-wifi`
- `POST /api/routers/:routerId/cycle-uplink`

Current transport assumption:

- SSH into the Opal router
- execute OpenWrt/GL.iNet compatible commands such as `ubus call system board`, `wifi reload`, `ifup wan`, and `reboot`

### Phone actions

The backend now exposes:

- `POST /api/devices/:serial/connect-router`
- `POST /api/devices/:serial/reset-uplink-ip`

`connect-router` currently attempts Android shell Wi-Fi connection commands first and falls back to opening Wi-Fi settings if direct connect is not supported on that ROM.

## Important hardware assumptions

This fork assumes each Opal can be managed remotely either by:

- SSH with a key already deployed to the router
- or another non-interactive admin path you will wire in later

For IP reset by power cycling the mobile USB router, this fork currently stops at the orchestration layer. You still need one real controllable power primitive per uplink, for example:

- USB relay
- managed smart plug
- programmable PDU
- another host-side commandable switch path

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

## Next implementation priorities

1. Provision Opal SSH keys and confirm non-interactive router control on all 15.
2. Replace best-effort Android Wi-Fi join with a reliable on-device automation path.
3. Add a real uplink power controller implementation.
4. Add router polling and WAN/IP telemetry to the dashboard.
5. Add assignment editing in the UI for router slots.
