/**
 * ── THE PHOTO SLOTS ─────────────────────────────────────────────────────────
 *
 * Everything else on the landing page is drawn in code. These are the four things
 * code cannot fake: photographs of the hardware actually running in the ICTU
 * server room. They are what stops the page reading as a template.
 *
 * TO ADD A PHOTO — two steps, no other file changes:
 *   1. Drop the image in  frontend/public/landing/
 *   2. Fill in `src` below, e.g.  src: "/landing/esp32-installed.jpg"
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
  /** Shown only in the dev placeholder: what to actually shoot. */
  brief: string;
}

export const LANDING_PHOTOS: LandingPhoto[] = [
  {
    id: "esp32-installed",
    src: "",
    alt: "The ESP32 environment node mounted in the CSPC ICTU server room",
    caption: "The environment node, installed",
    brief:
      "ESP32 in its enclosure, mounted on the server room wall/rack, status LED lit. Get close — this is the hero of the section.",
  },
  {
    id: "sensor-board",
    src: "",
    alt: "DHT11, two MQ-2 gas sensors and the infrared transmitters on the ESP32 board",
    caption: "DHT11, two MQ-2 sensors, IR transmitters",
    brief:
      "Top-down on the board so the DHT11, BOTH MQ-2s and the two IR LEDs are individually visible. Fill the frame.",
  },
  {
    id: "rack",
    src: "",
    alt: "The CSPC ICTU server rack with indicator lights lit",
    caption: "The rack the agents report from",
    brief:
      "Server rack straight-on, door open if possible, indicator lights on. Room lights on, no flash.",
  },
  {
    id: "aircon-ir",
    src: "",
    alt: "An infrared transmitter aimed at the server room air conditioner",
    caption: "IR transmitter aimed at the aircon",
    brief:
      "Wide enough to show the IR LED AND the aircon it points at in one frame — that geometry is the automation loop.",
  },
];

/** Slots with an actual image behind them. The gallery renders only these. */
export const suppliedPhotos = (): LandingPhoto[] =>
  LANDING_PHOTOS.filter((p) => p.src.trim() !== "");
