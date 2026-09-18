# Data Flow Diagrams

Gane–Sarson DFDs for the Server Infrastructure Monitoring System (CSPC — ICTU), plus the
manuscript narrative that accompanies them.

| File | Figure | Content |
|------|--------|---------|
| `dfd-level0-clean.drawio` | Figure 3 | Context diagram — the whole system as **one** process, 9 external entities, 16 composite flows |
| `dfd-level1-clean.drawio` | Figure 4 | The same system decomposed into **6** processes, 10 data stores, 29 boundary flows |

---

## Manuscript narrative

### Figure 3 — Level 0 (context)

> Figure 3 presents the Level 0, or context, data flow diagram of the developed system,
> treating the system as a single process bounded by nine external entities. Two are human
> actors: Admin and IT Staff exchange sign-in, approvals, alert-rule configuration,
> gas-sensor setup, acknowledgements, and air-conditioner control requests for a session,
> role, and live dashboards, alerts, reports, and forecasts in return. Four are the monitored
> sources — the Server Room, Monitored Server, Router/MikroTik, and UPS Unit — each supplying
> its respective reading (temperature/humidity/gas, CPU/memory/disk, traffic and link state,
> or battery/load/runtime) in exchange for a query or an agent token. The Server Room
> additionally reports the pin map of its MQ-2 gas channels and receives in return the
> gas-sensor configuration that determines which of those channels are read and how each is
> labelled. The remaining two entities support authentication and notification: Google
> Workspace exchanges an authorisation code for a verified identity, and the Email Recipient
> receives alert and report e-mail. Figure 4 decomposes this single process into its
> constituent functions.

The Server Room sentence carries two flows that did not exist before the MQ-2 sensors became
managed data (`migrations/2026-09-17_gas_sensors.sql`): the room now **reports** which ADC pin
each gas channel sits on, and **receives** which channels are wired and what each is called.
It is the only monitored source whose return flow is a configuration rather than a poll, which
is why it gets a sentence of its own rather than being folded into the list.

### Figure 4 — Level 1

> Figure 4 decomposes the context process of Figure 3 into six processes and ten data stores.
> Process 1.0, Authenticate and Authorize, exchanges the Google authorization code and sign-in
> requests for a verified identity, session, and role, and records each account in D1 users and
> each enrollment key in D9 agent_install_keys. Process 2.0, Collect Monitoring Data, receives
> readings from all four monitored sources, writes each sample to D3 measurements and D7 backup
> files, and updates device status in D2 devices. It also holds the MQ-2 gas sensors as managed
> data: Admin supplies each channel's label and whether it is enabled, which Process 2.0 stores
> in D10 gas_sensors and reads back on every reading to decide which channels count and how each
> is named; the wiring is pushed to the Server Room as a gas channel configuration, the Server
> Room reports the pin map of those channels in return, and the change is logged to D6
> system_logs. Process 3.0, Evaluate Rules and Notify, checks each incoming sample against the
> thresholds held in D8 alert_rules, writes new alerts to D4 alerts, and returns alert
> notifications to IT Staff and alert e-mail to the Email Recipient; it also forwards a
> temperature-zone change to Process 4.0. Process 4.0, Control Air Conditioning, combines that
> zone change with manual on/off commands from IT Staff to issue an IR command to the Air
> Conditioner Unit and log the resulting unit state to D2 and D6 system_logs. Process 5.0,
> Generate Reports, draws period measurements and alerts from D3 and D4 to produce the CSV/PDF
> file recorded in D5 reports and e-mailed to the Email Recipient. Process 6.0, Analyse and
> Forecast, queries a history window from D3 to return forecasts, anomalies, and recommendations
> to IT Staff, and feeds a forecast alert back into Process 3.0. All rule changes,
> acknowledgements, and report actions are additionally logged to D6 system_logs.

The added Process 2.0 sentence carries all six gas-sensor flows at this level — Admin → 2.0,
2.0 → D10, D10 → 2.0, 2.0 → Server Room, Server Room → 2.0, and 2.0 → D6. The store count moved
from nine to ten because `D10 gas_sensors` is new; every other word is as originally written.

---

## Reading the diagrams

**Processes.** `1.0 Authenticate & Authorise`, `2.0 Collect Monitoring Data`,
`3.0 Evaluate Rules & Notify`, `4.0 Control Air Conditioning`, `5.0 Generate Reports`,
`6.0 Analyse & Forecast`.

**Data stores.** D1 `users` · D2 `devices` · D3 `measurements (InfluxDB)` · D4 `alerts` ·
D5 `reports` · D6 `system_logs` · D7 `backup files` · D8 `alert_rules` ·
D9 `agent_install_keys` · D10 `gas_sensors`.

**`*` means a duplicated symbol** — the same entity or store drawn more than once so that no
flow line has to cross another. There is still only one IT Staff (drawn 6×, once per process
it talks to), one Admin (3×), one `system_logs` (5×). The **D-number is the identity, not the
box**: every box labelled `D6` is the same table. Count entities by name, never by symbol, or
Level 1 appears to have 17 entities against Level 0's 9.

**Entities that appear exactly once** carry no asterisk: Server Room, Monitored Server,
Router/MikroTik, UPS Unit, Air Conditioner Unit, Google Workspace, and stores D1, D5, D7, D8,
D9, D10.

**Layout convention.** One horizontal band per process: external entities on the left, the
process in the centre, data stores on the right. Every flow has its own connection point and
its own straight line — no two flows share a segment. Three flows run process-to-process
(2.0→3.0 evaluated sample, 2.0→4.0 temperature zone change, 6.0→3.0 forecast alert); each is
routed in its own reserved corridor.

---

## Balance

The two levels are **balanced**: every flow crossing the system boundary at Level 1 rolls up
into exactly one Level 0 composite, and every Level 0 flow has at least one Level 1
counterpart.

```
Level 0 flows              : 16
Level 1 boundary flows     : 29   (1.0:8  2.0:11  3.0:4  4.0:2  5.0:3  6.0:1)
Level 1 store flows        : 23   internal — correctly absent from Level 0
Level 1 process-to-process :  3   internal — correctly absent from Level 0
External entities          :  9 vs 9, identical sets
```

Roll-up, by entity and direction:

| Flow | L1 | L0 | Level 1 detail |
|------|----|----|----------------|
| Admin → system | 5 | 1 | sign-in · approve/reject registration · issue/revoke install key · threshold rule edits · gas-sensor label & enable |
| system → Admin | 1 | 1 | session & role |
| IT Staff → system | 4 | 1 | sign-in · acknowledge/resolve · manual on/off · report request |
| system → IT Staff | 5 | 1 | session & role · live metrics, sensor readings & labels · alert notification · report file · forecast, anomaly & recommendation |
| Server Room → system | 2 | 1 | temperature, humidity, gas · gas channel pin map |
| system → Server Room | 1 | 1 | gas channel configuration |
| Monitored Server ↔ system | 1 / 1 | 1 / 1 | CPU/memory/disk sample · agent token |
| Router/MikroTik ↔ system | 1 / 1 | 1 / 1 | traffic & link state · SNMP/RouterOS query |
| UPS Unit ↔ system | 1 / 1 | 1 / 1 | battery, load & runtime · SNMP query |
| system → Air Conditioner | 1 | 1 | IR command |
| Google Workspace ↔ system | 1 / 1 | 1 / 1 | verified identity · authorisation code |
| system → Email Recipient | 2 | 1 | alert e-mail · report e-mail + PDF |

**Why the counts differ and it is still balanced.** Level 0 has one process, so four separate
IT Staff inputs would be four arrows into the same box, saying nothing a single arrow does not.
They are bundled into one composite arrow whose *label lists them* — which is why `f03` reads
"sign-in, acknowledgements, AC control & report requests". Level 1 splits the process into six,
so each item finally has a distinct process to land on. Data stores and process-to-process
flows never appear at Level 0 because they do not cross the system boundary.

**Maintaining it.** A feature that adds a flow crossing the system boundary changes *both*
files. A flow that only touches a data store changes Level 1 alone. The legend note inside each
`.drawio` states its own counts — update them, or the diagrams assert a balance they no longer
have.

---

## Exporting to PDF

`File → Export as → PDF`, then:

| Setting | Value | Why |
|---------|-------|-----|
| Zoom | `100%` | Vector output — zoom changes the nominal page size only, never quality |
| Border Width | `20` | The **only** margin you get; cropping discards the page margins in the file |
| Size | **`Diagram`** | Crops the page to the drawing's bounding box → one page, never tiled |
| Transparent Background | off | Transparent embeds into Word with a grey block behind it |
| Shadow / Grid | off | |
| Include a copy of my diagram | on | Embeds the `.drawio` XML so the PDF reopens as an editable diagram |

⚠️ **Do not choose a paper size or "Fit to Page" for Level 1.** Its content is 1840 × 2890 px
(≈ 19.2 × 30.1 in at 100%); against A4 draw.io tiles it across six sheets with flow lines cut
mid-span. `Size: Diagram` keeps it whole, and scaling it down at placement is lossless.

Printed sizes, for planning:

| | Content (px) | Aspect | Fits |
|---|---|---|---|
| Level 0 | 1420 × 949 | 1.50 : 1 landscape | Folio landscape (1.53 : 1) — labels ≈ 5.5 pt |
| Level 1 | 1840 × 2890 | 1 : 1.57 portrait | Folio portrait (1 : 1.53) — labels ≈ 4.5 pt |

Level 1's labels are legible on screen and marginal on paper. If it goes into the printed
manuscript, print that page on **A3** (labels rise to ≈ 6 pt) or treat it as a fold-out.
Splitting it into two half-diagrams would cost the single-page balance argument above.
