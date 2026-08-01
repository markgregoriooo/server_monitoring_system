# MikroTik Network Monitoring — Information Request

**To:** CSPC-ICTU network team **From:** Monitoring System team
**Re:** Information needed to add live **campus network monitoring** (through your MikroTik) to the dashboard

---

## Why we're asking

We're adding live campus-network monitoring to the dashboard — the traffic going to **each
building**, whether each building's link is up or down, how busy the MikroTik is, and (optionally)
latency and per-device usage. We read this from your **one MikroTik** over its **read-only**
RouterOS API. Nothing is installed on the router and **no settings are changed** — we only read.

Please fill in what you can. **"Not sure" is a perfectly fine answer** — for anything unclear we'll
run a quick test together. A short glossary is at the bottom.

> **Most useful:** the MikroTik's **IP address**, permission for a **read-only login**, and **which
> port goes to which building**. With those we can confirm most of the rest automatically.

---

## Section 1 — The MikroTik router

| Question | Answer |
|---|---|
| Make & model (e.g. "RB4011", "CCR2004", "hAP ax3") | |
| RouterOS version (Winbox/WebFig top bar shows it) | ☐ v6   ☐ v7   ☐ Not sure |
| Management IP address | |
| Is that IP fixed (it won't change)? | ☐ Yes (static)   ☐ Not sure |
| Number of ports in use (buildings + uplink) | |
| Is this the **only** MikroTik for the whole campus? | ☐ Yes   ☐ No (please describe): __________ |

---

## Section 2 — Which port serves which building  *(the most important section)*

> Each building shows on the dashboard as the **port it's plugged into**. Tell us the port name and
> the building it feeds, which port is the **internet uplink**, and the port speed (for % usage).

| Port (etherN / sfpN) | Building it serves | Internet uplink? | Port speed (100M / 1G / 10G) |
|---|---|---|---|
| | | ☐ Yes ☐ No | |
| | | ☐ Yes ☐ No | |
| | | ☐ Yes ☐ No | |
| | | ☐ Yes ☐ No | |
| | | ☐ Yes ☐ No | |

*Don't know the exact port names? Leave them blank — we can read the live list once connected.*

---

## Section 3 — How the buildings' networks are arranged

> This decides whether we can break **connected-device counts** (and per-device usage) down per
> building, or only show campus totals. Traffic and link up/down are **always** per building.

1. **Is each building on its own subnet / VLAN / DHCP range?**
   - ☐ Yes — each building separate   ☐ No — one shared network   ☐ Not sure
2. **If separate, the IP range per building** (e.g. Engineering = 192.168.10.0/24):
   - ____________________________________________________________________
3. **Roughly how many devices connect** — Total: ________  Per building: ________________________
4. **Does the MikroTik hand out the IP addresses (DHCP)?** (lets us see who's connected)
   - ☐ Yes, the MikroTik runs DHCP   ☐ No, something else does   ☐ Not sure

---

## Section 4 — Access for our monitoring server (read-only)

> Our server reaches the MikroTik's **API** with a **read-only** login. It cannot change settings.

1. **May we enable the RouterOS API service?** (API on **8728**, or secure API-SSL on **8729**.)
   - ☐ Yes   ☐ Already enabled   ☐ Need approval first   ☐ Not sure
2. **May we create a dedicated read-only login** for monitoring?
   - ☐ Yes   ☐ You'll create it and send it to us   ☐ Not sure
3. **Is there a firewall between our server and the MikroTik?** (Must allow our server → API port.)
   - ☐ No, same network   ☐ Firewall in between   ☐ Not sure
   - Our monitoring server's IP (we'll confirm): ____________________
4. **Prefer the secure (TLS / 8729) connection?**
   - ☐ Yes, use TLS   ☐ Plain is fine on our network   ☐ Not sure
5. **If RouterOS v7**, prefer the built-in **REST API** (HTTPS) over the classic API? (Either works.)
   - ☐ REST/HTTPS   ☐ Classic API   ☐ Not sure
6. **Is SNMP already enabled** on the MikroTik? (A read-only fallback we can use.)
   - ☐ Yes   ☐ No   ☐ Not sure

---

## Section 5 — Latency & packet-loss  *(optional add-on)*

> Measured by having the MikroTik send small test pings to a target on each building's network.

1. **Do you want per-building latency / packet-loss monitoring?**
   - ☐ Yes   ☐ No   ☐ Maybe later
2. **If yes, an "always-on" address to ping for each building** (its switch/gateway IP):

| Building | Ping target IP |
|---|---|
| | |
| | |
| | |

3. **OK for the MikroTik to send these small test pings** (a few packets per cycle)?
   - ☐ Yes   ☐ No   ☐ Not sure

---

## Section 6 — Per-client / per-device bandwidth  *(optional add-on)*

> Per-**building** (per-port) usage is always available. Per-**device** usage needs an extra
> feature turned on in the MikroTik.

1. **Do you need usage per individual device/IP, or is per-building enough?**
   - ☐ Per-building is enough   ☐ I want per-device too   ☐ Not sure
2. **If per-device:** may we enable **IP Accounting** (read-only per-device counters)? Or do you
   already shape clients with **Simple Queues** (which we could read)?
   - ☐ Enable IP Accounting   ☐ We already use per-client Queues   ☐ Not sure
3. **Live "who's using the most right now" snapshot, or full history per device?**
   *(Full history for thousands of devices is heavy — a live top-list is usually the better fit.)*
   - ☐ Live snapshot is fine   ☐ I want full history   ☐ Not sure

---

## Section 7 — Logistics & contacts

1. **How often should we refresh the data?** (Default ~30 seconds.)
   - ☐ ~30s is fine   ☐ Other: ____________
2. **Preferred maintenance window** to enable the API / accounting (no downtime expected):
   - ____________________
3. **Network admin** to coordinate with (enables API / firewall / creates the login):
   - Name / contact: ____________________
4. **Primary contact** for this rollout:
   - Name / email / phone: ____________________
5. **How will the read-only login be shared securely?** (Please **don't** write the password in
   this form — send it separately.)
   - ____________________

---

## What happens after you return this

1. We confirm we can reach the MikroTik's API with the **read-only** login (one quick test).
2. We register the **one** MikroTik and label each port with its building.
3. The campus network appears **live on the dashboard** — per-building traffic, link up/down,
   router CPU/memory, and link-down alerts.
4. If you asked for them, we add **latency/packet-loss** and **per-device usage** as a second step.

Nothing here changes how your network operates; we only read status.

---

## Plain-language glossary

- **RouterOS API** — a standard, read-only way to ask the router for its status (traffic, CPU, link
  state). We connect to it; nothing is installed on the router.
- **Read-only login** — a username/password that can only read status, never change settings.
- **Port / interface** — a physical socket on the router (e.g. `ether1`); each building plugs into one.
- **Uplink** — the port that goes out to the internet (the ISP).
- **Subnet / VLAN** — a way to separate networks. If each building has its own, we can report
  per-building device counts; if not, only totals.
- **DHCP** — the service that hands out IP addresses. If the MikroTik runs it, we can see who's connected.
- **IP Accounting** — a built-in MikroTik feature that counts traffic per device/IP (read-only);
  needed only for per-device bandwidth.
- **API port 8728 / 8729** — the "door" the API uses; 8729 is the encrypted (TLS) version. A
  firewall between us and the router must allow it.
- **Static IP** — a fixed address that doesn't change, so monitoring always finds the router.
