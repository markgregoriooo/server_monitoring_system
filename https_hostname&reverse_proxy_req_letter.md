# Request to ICTU — HTTPS hostname + reverse proxy

A ready-to-send request for the one thing the deployment depends on and that we cannot do
ourselves: publishing the dashboard at `monitoring.cspc.edu.ph` over HTTPS.

**How to use this:** fill the bracketed values, delete this header block, send. The technical
background is in `deployment-guide.md` §6.1; this file is just the message.

> **Fill in first**
>
> | Placeholder | Value |
> |---|---|
> | `[LAN-IP]` | the campus server's static LAN address |
> | `[Your name]` | |
> | `[Program / capstone group]` | |
> | `[Contact number]` / `[Email]` | |
>
> If the server hasn't been assigned yet, **ask question 4 first** — its answer supplies
> `[LAN-IP]`, and questions 4 and 5 gate everything else.

---

**Subject:** HTTPS hostname + reverse proxy for the ICTU server-monitoring dashboard

Good day,

We're deploying the **server infrastructure monitoring system** for ICTU — a dashboard that
tracks server-room temperature, humidity and gas levels, server CPU/memory/disk usage, network
devices, and UPS status, with alerting. It runs on a campus server and needs to be reachable by
ICTU staff over HTTPS.

## What we're requesting

Please publish `monitoring.cspc.edu.ph` as an HTTPS endpoint and reverse-proxy it to our campus
server:

```
Public hostname:  monitoring.cspc.edu.ph
Forward to:       http://[LAN-IP]:80          (plain HTTP is fine over the LAN)
Forward:          ALL paths, unchanged — no prefix stripping or rewriting

Required headers:
  Host                 monitoring.cspc.edu.ph    (preserve; please don't rewrite to the IP)
  X-Forwarded-For      client IP (append)
  X-Forwarded-Proto    https

WebSocket:        must allow HTTP/1.1 Upgrade on /socket.io/
                  (long-lived connections; read timeout above ~25 s)
Max body size:    at least 2 MB (profile photo uploads)
```

## Two requirements worth highlighting

1. **WebSocket upgrades on `/socket.io/`.** The dashboard's live data depends on this. If the
   upgrade is dropped, the page loads normally but never updates — with no visible error — so
   it's much easier to configure now than to diagnose later.
2. **Preserve `X-Forwarded-For`.** We use the client IP for sign-in rate limiting and for the
   audit log. Without it, every request appears to originate from the proxy.

## One security request

If possible, please restrict `/api/agents/` and `/api/servers/metrics` to campus LAN sources.
Those endpoints are only ever called by monitoring agents inside the network, never from the
internet.

## Questions we need answered

| # | Question | Why we're asking |
|---|---|---|
| 1 | Can you host this endpoint (DNS + TLS + reverse proxy)? | if not, we'll arrange our own domain |
| 2 | Will it be reachable **off-campus**? | staff want to check server status outside working hours |
| 3 | If public access isn't acceptable, is **VPN** an option? | fallback for remote access |
| 4 | Which **server** are we deploying on, and what **OS**? | our setup steps assume Ubuntu/Debian Linux |
| 5 | Can that server have a **static LAN IP**? | monitoring agents and the ESP32 cache the address |
| 6 | Who should be the **long-term technical contact**? | for handover of the Google Cloud project and the system |
| 7 | Expected **timeline**? | so we can plan the deployment date |

## What we provide on our side

The campus server running the dashboard, its API, the databases, and an nginx instance
listening on port 80 — a single target for your proxy. We don't need any inbound ports opened
on the server itself, and no certificate is needed on our end, since TLS terminates at your
edge.

Thank you,

[Your name] · [Program / capstone group] · [Contact number] · [Email]

---

*Technical background: `deployment-guide.md` §5 (our nginx) and §6 (the endpoint).*
