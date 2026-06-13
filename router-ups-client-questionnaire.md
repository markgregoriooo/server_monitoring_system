# Router & UPS Monitoring — Information Request

**To:** CSPC-ICTU (server-room / network team)
**From:** Monitoring System team
**Re:** Information needed to add live **router/switch** and **UPS** monitoring to the dashboard

---

## Why we're asking

We're extending the monitoring dashboard to show the **health of your server-room network
equipment (routers/switches)** and **UPS battery backups** — live traffic, link up/down,
battery level, runtime remaining, and on-battery alerts.

To set this up we read health data from each device over the network using **SNMP**, a standard,
**read-only** method that almost all professional network gear and UPS units support. We do **not**
install anything on the devices and we never change their settings — we only *read* status.

Please fill in what you know below. **"Not sure" is a perfectly fine answer** — for anything
unclear we'll run a quick test together to find out. A short glossary is at the bottom.

> 🔑 **The single most useful thing:** for **one** router and **one** UPS, the device's **IP
> address** + permission to enable SNMP. With those we can run one test that confirms most of the
> rest of this form automatically.

---

## Section 1 — UPS units (battery backups)

> **Why:** only a UPS with a **network port / SNMP card** can be monitored. A UPS that connects
> **only by USB or serial cable** cannot be monitored over the network (it would need an add-on
> SNMP card first).

For **each** UPS in the server room:

| # | Brand & model | Has a network/Ethernet port or SNMP card? | IP address (if networked) | Location (rack/room) |
|---|---|---|---|---|
| 1 | | ☐ Yes ☐ No ☐ Not sure | | |
| 2 | | ☐ Yes ☐ No ☐ Not sure | | |
| 3 | | ☐ Yes ☐ No ☐ Not sure | | |
| 4 | | ☐ Yes ☐ No ☐ Not sure | | |

---

## Section 2 — Routers & switches

> **Why:** **managed** devices (the kind you can log into and configure) give full stats —
> traffic per port, link up/down, uptime. **Basic / plug-and-play** devices can only be checked
> for "is it up or down." We're **not** covering the MikroTik gear here (handled separately).

For **each** non-MikroTik router/switch in the server room:

| # | Brand & model | Managed or basic? | IP address | Location / what it connects |
|---|---|---|---|---|
| 1 | | ☐ Managed ☐ Basic ☐ Not sure | | |
| 2 | | ☐ Managed ☐ Basic ☐ Not sure | | |
| 3 | | ☐ Managed ☐ Basic ☐ Not sure | | |
| 4 | | ☐ Managed ☐ Basic ☐ Not sure | | |

---

## Section 3 — Network access & SNMP

1. **Can our monitoring server reach these devices over the network, or is there a firewall
   between them?** (We need it to allow our read-only traffic on **UDP port 161**.)
   - ☐ Same network, no firewall in between  ☐ Firewall in between  ☐ Not sure

2. **Is there a separate "management" network or VLAN** for infrastructure (where switches/UPS
   are reached), or is everything on one network?
   - ☐ Separate management VLAN (details: ____________________)  ☐ One network  ☐ Not sure

3. **Do you already use a read-only SNMP "community string"** (a shared password for reading
   stats)? If yes, what is it? If no, **may we set a read-only one** on each device?
   - ☐ Yes, it is: ____________________  ☐ No — please set one  ☐ Not sure

4. **Which SNMP version is enabled / preferred?** (We support **v2c**. v3 adds encryption but
   needs extra setup.)
   - ☐ v2c  ☐ v3  ☐ Not sure / whatever is easiest

5. **Who is the network admin** we coordinate with to enable SNMP and open the firewall, if needed?
   - Name / contact: ____________________

---

## Section 4 — Logistics

1. **Are the device IP addresses fixed (static), or could they change (DHCP)?** Monitoring needs
   addresses that don't change — can we get **static or reserved** IPs for these devices?
   - ☐ Static  ☐ DHCP — can reserve  ☐ Not sure

2. **Preferred maintenance window** to briefly enable SNMP on each device (no downtime expected,
   but good to schedule):
   - ____________________

3. **Primary contact** for this rollout:
   - Name / email / phone: ____________________

---

## What happens after you return this

1. We confirm reachability with a one-line read-only test (`snmpwalk`) to **one** device.
2. We (or your admin) enable **read-only SNMP** on each device and open the firewall if needed.
3. We register the devices and they appear **live on the dashboard** — traffic, link status,
   battery level, runtime, and on-battery alerts.

Nothing here changes how your devices operate; we only read status.

---

## Plain-language glossary

- **SNMP** — a standard, read-only way to ask a network device "how are you doing?" (traffic,
  uptime, battery, etc.). Supported by virtually all managed switches/routers and networked UPS.
- **Managed switch/router** — one you can log into (web page or console) to configure. The
  opposite is a **basic / unmanaged / plug-and-play** unit with no login.
- **SNMP card / network port (on a UPS)** — lets a UPS talk on the network. Without it, a UPS can
  only be reached by a USB/serial cable to one nearby computer, which we can't monitor centrally.
- **Community string** — a shared, read-only "password" SNMP uses. We only ever need a
  **read-only** one (it cannot change any settings).
- **UDP port 161** — the network "door" SNMP uses; a firewall between us and the device must allow it.
- **Static IP** — a fixed address that doesn't change, so monitoring always finds the device.
