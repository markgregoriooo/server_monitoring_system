/**
 * ── THE PHOTO SLOTS ─────────────────────────────────────────────────────────
 *
 * Everything else on the landing page is drawn in code. These are the four things
 * code cannot fake: photographs of the hardware actually running in the ICTU
 * server room. They are what stops the page reading as a template.
 *
 * TO SWAP A PHOTO for a better shot of the SAME thing: overwrite the file in
 * frontend/public/landing/ keeping its filename. No change here at all.
 *
 * TO FILL AN EMPTY SLOT — two steps, no other file changes:
 *   1. Drop the image in  frontend/public/landing/
 *   2. Fill in `src` below, e.g.  src: "/landing/esp32-installed.jpg"
 *
 * ⚠️ If the new photo shows something DIFFERENT, the words have to follow it:
 * `alt`, `caption`, `title`, `detail` and `meta` all describe the subject, and
 * `detail` makes factual claims about the hardware that a swap can invalidate.
 * See public/landing/README.txt.
 *
 * Until `src` is filled in:
 *   - `npm run dev`  shows a labelled placeholder with the shot brief, so the
 *     slot is impossible to forget.
 *   - `npm run build` omits the slot entirely, and the gallery hides itself if
 *     every slot is empty. A half-built photo strip must never reach the public
 *     page — an empty frame reads as a broken image, which is worse than no
 *     section at all.
 *
 * Shooting notes: landscape, minimum 2400px wide, room lights ON, no phone
 * flash (it blows out rack LEDs and flattens the enclosure). JPG is fine.
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
  /** Body copy inside the lightbox. Two or three sentences, and they have to be TRUE:
   *  this is the only place on the page where a photograph is annotated with claims
   *  about what it is doing, so a stale number here is a lie with a picture attached. */
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
    src: "/landing/aircon-ir.jpg",
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
