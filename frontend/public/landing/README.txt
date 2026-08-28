Landing/login page hardware photos.

===========================================================================
 SWAPPING A PHOTO — the common case
===========================================================================

If you are replacing a picture with a BETTER PICTURE OF THE SAME THING:

  1. Name the new file exactly like the old one and overwrite it here.
  2. Done. No code change at all.

     esp32-installed.jpg   sensor-board.jpg   rack.jpg   aircon-ir.jpg

The path in photos.ts is already "/landing/<filename>", so as long as the
filename matches, nothing else has to be touched. Hard-refresh the browser
(Ctrl+Shift+R) — the old image is cached under the same URL.

===========================================================================
 ADDING A PHOTO IN AN EMPTY SLOT
===========================================================================

  1. Drop the image here.
  2. Set `src` for the matching slot in
     frontend/src/components/landing/photos.ts, e.g.

       src: "/landing/esp32-installed.jpg"

The path is the filename with a leading /landing/ — /public is the web root,
so this folder is NOT part of the URL beyond that.

Slots (ids in photos.ts): esp32-installed, sensor-board, rack, aircon-ir

===========================================================================
 IF THE PHOTO SHOWS SOMETHING DIFFERENT
===========================================================================

Each slot in photos.ts carries FIVE pieces of text, not one. Clicking a photo
on the page opens a detail modal, so a picture swap that changes the subject
means the words have to follow it:

  alt      what the image shows, for screen readers and if it fails to load
  caption  the line under the photo in the strip (about five words)
  title    the heading inside the modal
  detail   the modal's paragraph — the substance
  meta     the small spec line, e.g. "ESP32 · Socket.IO push · ~3s"

  brief    NOT shown to visitors. It is the shot brief for whoever is taking
           the photo, and only appears in the dev placeholder.

⚠️ `detail` makes factual claims about the hardware — sampling intervals,
which sensor does what, how the IR is driven. It is the one place on the page
where a photograph is annotated with assertions, so a stale sentence there is
a wrong claim with a picture attached. Re-read it when the subject changes.

===========================================================================
 SHOOTING NOTES
===========================================================================

Landscape, 3:2 crop, min 2400px wide, room lights on, no flash.
(Flash blows out the rack LEDs and flattens the enclosure.)

The strip crops to 3:2; the modal shows the whole frame letterboxed, so a
shot that is not 3:2 will still look right in the modal.

===========================================================================
 BEFORE A REAL DEPLOYMENT
===========================================================================

Mock/stand-in images are fine during development. They are ordinary images to
the build, so anything left in `src` at `npm run build` time SHIPS. Blank the
src (back to "") for any slot still holding a stand-in — an empty slot is
dropped from the build entirely, and the whole section hides itself if every
slot is empty.

===========================================================================
 THE FOLD'S COVER PHOTOGRAPH  —  hero-cover.jpg
===========================================================================

The big picture behind the headline and the Sign in button.

  File:  frontend/public/landing/hero-cover.jpg
  Code:  HERO_COVER in src/pages/auth/Login.tsx

TO ADD OR REPLACE IT
  Drop the file here with that exact name. Nothing else to change.
  Hard-refresh (Ctrl+Shift+R) — the browser caches it under the same URL.

TO REMOVE IT
  Set  HERO_COVER = ""  in Login.tsx. The fold returns to the plain
  background it had before. Deleting the file alone also works: the layer
  paints nothing rather than showing a broken image, so the page never
  looks half-finished in front of anyone.

SHOOTING / CHOOSING THE SHOT
  - Landscape, minimum 2400px wide. JPG is fine.
  - Put the SUBJECT RIGHT OF CENTRE. The headline and button occupy the
    left half of the fold and a dark scrim is heaviest there, so anything
    important on the left will be deliberately obscured.
  - It is shown at very different shapes: about 100vh tall on a phone and
    66vh on a desktop, always centre-cropped. Check it does not lose its
    subject on a narrow window.
  - Busy is fine, and mid-tone is fine — the scrim handles both. What does
    NOT work is a bright area behind the left half, which fights the copy
    no matter how strong the scrim is.

WHAT STAYS ON TOP OF IT
  The drifting telemetry lines (HeroBackdrop) are drawn ABOVE the photo on
  purpose. They are the fold's one piece of motion and they survive any
  background change — if a picture ever hides them, the picture is wrong,
  not the animation.
