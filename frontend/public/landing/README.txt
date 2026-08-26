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
