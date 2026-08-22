# Router & UPS Monitoring — Client's Returned Answers

**Returned by:** CSPC-ICTU · **Transcribed:** 2026-08-22
**Source:** photographs of the filled-in form, `router&ups_questionnaire_answers/` (4 JPGs)
**Form:** `router-ups-client-questionnaire.md`
**Answers to:** `router-ups-monitoring.md` §10

> This file is the **transcription**, not the original. Where the handwriting or a checkbox is
> genuinely unclear it says so rather than guessing — a wrong IP or community string registers a
> device that silently never polls, which looks identical to a broken poller.

---

## 1. The headline

**The form did not produce a working device list.** Every answer that decides *policy* came back
clean (v2c, no firewall, read-only community exists, named admin). Every answer that identifies
a *device* is missing or out of scope:

| | Listed | In scope for this feature | Has an IP we can poll |
|---|---|---|---|
| **UPS** | 3 | 3 (claimed) | **0** |
| **Routers/switches** | 4 | **1** (3 are MikroTik) | 1 (needs confirming) |

So the answer to "which devices do we register?" is currently **one router, maybe**, and it is the
one row the client left un-classified. See §5 for what to ask back.

---

## 2. Section 1 — UPS units

| # | Brand & model | Network / SNMP card? | IP | Location |
|---|---|---|---|---|
| 1 | KEDOS | ☑ **Yes** | *(blank)* | MAIN COMPUTER |
| 2 | NEW STAR INDUSTRIAL | ☑ **Yes** | *(blank)* | RACK |
| 3 | NEWSTAR INDUSTRIAL | ☑ **Yes** | *(blank)* | RACK |

⚠️ **Treat all three "Yes" answers as unconfirmed.** Three things point the other way:

1. **No IP address on any row.** A UPS with a live SNMP card has an address; the card is the only
   reason it would have one. Three "Yes" answers and three blank IP cells is the shape of a
   question that was read as *"does it have a port on the back?"* rather than *"is it on the
   network?"*
2. **Neither brand is one that ships SNMP.** KEDOS and NewStar Industrial are budget/local-market
   line-interactive units. SNMP management is a feature of the business-class ranges (APC
   Smart-UPS with an AP9631 card, Eaton 5P/9PX with a Network-M2, and so on). A slot for an
   optional card is not the same as a card being fitted.
3. **The printed question itself is damaged** — the header reads `Has a network/ SNMP card?` with
   *"Has a network"* struck through, so what the respondent actually read was closer to
   `/ SNMP card?`. That is not a well-formed question, and it undermines all three answers.
   ⚠️ **Fix this in the source `.docx` before the form is reused** — the strikethrough is in the
   printed document, not something the client drew on.

**Consequence under the SNMP-only scope (`router-ups-monitoring.md` §2/§3):** a UPS that is not on
the network **cannot be monitored** — no IP, nothing to poll, no partial mode to fall back on. If
these three turn out to be USB/serial units, **UPS monitoring has zero devices in this deployment**
until an SNMP card is fitted to at least one. That is a finding about the site, not a defect in
the feature, but it decides whether the UPS page ships with live data or an empty state.

**Resolve it by looking at the hardware, not by re-asking.** One photo of the back panel of each
unit settles it: an RJ45 jack (not the RJ11-looking serial port, and not the USB-B square) means a
card is fitted.

---

## 3. Section 2 — Routers & switches

The form asked for **non-MikroTik** gear. Three of the four rows are MikroTik.

| # | Label | Brand & model | Managed? | IP | Location |
|---|---|---|---|---|---|
| 1 | MAIN | Cloud Core Router (**MikroTik**) | ☑ Managed | `172.0.0.1/16` ⚠️ | MAIN ROUTER |
| 2 | BACKUP | Cloud Core Router (**MikroTik**) | ☑ Managed | *(blank)* | BACKUP ROUTER |
| 3 | BACKUP | Cloud Core Router (**MikroTik**) | *(none ticked)* | *(blank)* | " (ditto — backup router) |
| 4 | — | **PLDT DMZ** | *(none ticked)* | `10.233.200.18` ⚠️ | *(blank)* |

⚠️ **Two IP readings are not certain from the photograph:**
- Row 1 — `172.0.0.1/16`: the third octet could be `0` or `6` (`172.0.0.1` vs `172.0.6.1`).
  Note `172.0.0.0/16` is *not* RFC 1918 space — the private range is `172.16.0.0`–`172.31.255.255`
  — so this is either a deliberate use of public space on the LAN, or a mis-transcription of
  `172.16.x.x`. Confirm before relying on it.
- Row 4 — `10.233.200.18`: the third character reads `3` but could be `5` (`10.253.200.18`).

**Rows 1–3 are out of scope here.** MikroTik is data source **B**, already monitored over the
RouterOS API by `mikrotikPollerService` (`mikrotik-monitoring.md`) — a richer path than SNMP, and
the reason §2 of the design doc excludes it. Registering a CCR here as an SNMP router would
**double-count it**: two `devices` rows, two InfluxDB series, and both pages showing what is
physically one router. Do not add them.

> Worth noting for the manuscript rather than the code: the client listing their MikroTiks under
> "non-MikroTik" suggests the split between the two collectors is an internal distinction that
> doesn't survive contact with the people who own the gear. The dashboard should present one
> "Network" list regardless of which poller feeds it.

**Row 4, the PLDT DMZ router, is the only in-scope device on the whole form** — and its
Managed/Basic box is blank, which is precisely the fact that decides whether it is pollable:

- **Managed + SNMP enabled** → registers today, full IF-MIB traffic/link data.
- **Basic, or SNMP unavailable** → needs the **ICMP-ping fallback**, which is *not built*
  (§11). It is also an ISP-owned CPE, so ICTU may not be able to enable SNMP on it at all.

That single unticked checkbox is therefore the difference between "register one device and we're
done" and "build the ping-fallback module first."

---

## 4. Sections 3 & 4 — access, SNMP, logistics

| Q | Answer | Effect |
|---|---|---|
| 3.1 Firewall between backend and devices? | ☑ **Same network, no firewall in between** | ✅ §10 Q9 closed — no UDP 161 ACL work |
| 3.2 Management VLAN? | ☑ **Separate management VLAN** — *details blank* | ⚠️ Backend host must have an interface **on that VLAN**; contradicts "same network" unless the backend already sits there. Get the VLAN ID/subnet |
| 3.3 Read-only community string? | ☑ **Yes** — *value blank* | ⚠️ It exists but was not written down. Needed per device before registering. Deliberately not sent on paper — collect it from the admin directly |
| 3.4 SNMP version | ☑ **v2c** | ✅ §10 Q3 confirmed — matches the schema and the built `snmpClient`. No v3 migration needed |
| 3.5 Network admin | **"Sir Alex"** | ⚠️ First name only — no email/phone. He is the route to 3.2 and 3.3 |
| 4.1 Static or DHCP? | ☑ **DHCP — can reserve** | ⚠️ **Action required.** The poller keys on IP; an unreserved lease silently moves and the device goes Offline for a reason nothing in the UI explains. Reservations must be in place *before* registering |
| 4.2 Maintenance window | *(blank)* | Open |
| 4.3 Primary contact | *(blank)* | Open — "Sir Alex" is all we have |

---

## 5. What to ask back (short list, in priority order)

Keep it to what actually unblocks work — the form has already been round-tripped once.

1. **A photo of the back panel of each of the three UPS units.** Settles §2 without another form.
2. **Is the PLDT DMZ router (row 4) manageable — can SNMP be enabled on it?** It is the only
   in-scope device on the form. If it's ISP-locked, say so; that alone decides the next build task.
3. **The read-only community string**, from Sir Alex directly (not on paper), plus his email.
4. **DHCP reservations** for whatever survives 1–3, and the confirmed IPs (see the two ⚠️ readings
   in §3).
5. **The management VLAN's ID/subnet**, and confirmation the backend host has a leg on it.

---

## 6. Effect on `router-ups-monitoring.md` §10

| § | Question | Status after these answers |
|---|---|---|
| Q1 | Actual router models? | ⚠️ **Partial** — 3 MikroTik (out of scope) + 1 PLDT DMZ, class unknown |
| Q2 | Does each UPS have an SNMP card? | ⚠️ **Claimed yes, not credible** — no IPs, budget brands, damaged question. See §2 |
| Q3 | v2c or v3? | ✅ **Closed — v2c**, as already implemented |
| Q4 | Alerting model | ✅ Was already closed (configurable `alert_rules`) |
| Q9 | Firewall / UDP 161 | ✅ **Closed — no firewall.** VLAN reachability still to confirm |
