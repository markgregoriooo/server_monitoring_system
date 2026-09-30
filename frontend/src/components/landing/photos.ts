/**
 * ── Photo slots ─────────────────────────────────────────────────────────
 * Photos of the actual hardware in the ICTU server room.
 *
 * To replace a photo with a better shot of the same thing: overwrite the file in
 * frontend/public/landing/, keeping its name.
 *
 * To fill an empty slot:
 *   1. Put the image in  frontend/public/landing/
 *   2. Set `src` below, e.g.  src: "/landing/esp32-installed.jpg"
 *
 * If the new photo shows something different, update `alt`, `caption`, `title`,
 * `detail` and `meta` too. See public/landing/README.txt.
 *
 * Until `src` is set:
 *   - `npm run dev`  shows a labelled placeholder with the shot brief.
 *   - `npm run build` leaves the slot out, and hides the gallery if all are empty.
 *
 * Shooting notes: landscape, at least 2400px wide, room lights on, no phone flash.
 * JPG is fine.
 */
export interface LandingPhoto {
  id: string;
  /** Path under /public. EMPTY = not supplied yet. */
  src: string;
  /** Real alt text — these are content images, not decoration. */
  alt: string;
  /** Shown under the photo on the page. */
  caption: string;
  /** Headline inside the lightbox — names the thing rather than describing the shot. */
  title: string;
  /** Text shown in the lightbox. Two or three sentences, and they must be accurate. */
  detail: string;
  /** Short spec line under the detail — the same shape as COVERAGE's `meta`. */
  meta: string;
  /** Shown only in the dev placeholder: what to actually shoot. */
  brief: string;
}

export const LANDING_PHOTOS: LandingPhoto[] = [
  {
    id: "esp32-installed",
    src: "/landing/esp32-installed.jpg",
    alt: "The ESP32 environment node mounted in the CSPC ICTU server room",
    caption: "The environment node, installed",
    title: "The environment node",
    detail:
      "An ESP32 carrying a DHT22, two MQ-2 gas sensors, an infrared transmitter array, a " +
      "WS2812B status strip and a piezo buzzer. It pushes a reading every three seconds over an " +
      "authenticated Socket.IO connection — every one of them evaluated against the alert " +
      "rules, though only about one in ten is stored, because a server room does not move " +
      "measurably in three seconds and the rest is sensor noise. A DS3231 clock and a micro SD card " +
      "let it keep recording when the backend is unreachable and replay the gap on reconnect.",
    meta: "ESP32 · Socket.IO push · ~3s",
    brief:
      "ESP32 in its enclosure, mounted on the server room wall/rack, status LED lit. Get close — this is the hero of the section.",
  },
  {
    id: "sensor-board",
    src: "/landing/sensor-board.jpg",
    alt: "DHT22, two MQ-2 gas sensors and the infrared transmitters on the ESP32 board",
    caption: "DHT22, two MQ-2 sensors, IR transmitters",
    title: "The sensors, close up",
    detail:
      "The DHT22 reports temperature and humidity at 0.1 °C and 0.1 %RH resolution. The two MQ-2 " +
      "gas sensors are deliberately judged separately rather than averaged — one rising while " +
      "the other does not is the entire reason there are two of them, and it is what tells a " +
      "real event from a drifting sensor. Their clean-air baseline is measured once per " +
      "location and stored in flash, not re-measured at boot: a restart during a gas event " +
      "would record polluted air as clean.",
    meta: "DHT22 + 2x MQ-2 + IR TX on GPIO 25/33",
    brief:
      "Top-down on the board so the DHT22, BOTH MQ-2s and the two IR LEDs are individually visible. Fill the frame.",
  },
  {
    id: "rack",
    src: "/landing/rack.jpg",
    alt: "The CSPC ICTU server rack with indicator lights lit",
    caption: "The rack the agents report from",
    title: "The rack the agents report from",
    detail:
      "Each host here runs a small Go agent that posts CPU, memory, uptime and every mounted " +
      "fixed volume roughly every ten seconds. Disk alerting follows the WORST volume rather " +
      "than the root filesystem — a full /var will take an application down while / still reads " +
      "comfortable. If the backend goes away the agent holds about forty minutes of readings " +
      "and backfills them, so an outage leaves a gap in the live view but not in the stored " +
      "history.",
    meta: "Go agent · HTTP push · ~10s",
    brief:
      "Server rack straight-on, door open if possible, indicator lights on. Room lights on, no flash.",
  },
  {
    id: "aircon-ir",
    src: "/landing/aircon-ir.png",
    alt: "An infrared transmitter aimed at the server room air conditioner",
    caption: "IR transmitter aimed at the aircon",
    title: "The automation loop, in one frame",
    detail:
      "The transmitter and the unit it points at are the whole control loop. As the room warms " +
      "it crosses configurable temperature zones, and each zone replays a raw infrared code " +
      "captured from the physical remote — the protocol decodes as UNKNOWN, so there is no " +
      "library to generate one. It fires only when the zone CHANGES, not on every reading, and " +
      "it never switches a unit on or off: power stays a human decision.",
    meta: "Captured raw IR · 38 kHz · zone-change driven",
    brief:
      "Wide enough to show the IR LED AND the aircon it points at in one frame — that geometry is the automation loop.",
  },
];

/** Slots with an actual image behind them. The gallery renders only these. */
export const suppliedPhotos = (): LandingPhoto[] =>
  LANDING_PHOTOS.filter((p) => p.src.trim() !== "");
