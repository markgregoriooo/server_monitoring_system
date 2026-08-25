Landing/login page hardware photos.

Drop image files here, then set `src` for the matching slot in
frontend/src/components/landing/photos.ts, e.g.

  src: "/landing/esp32-installed.jpg"

The path is the filename with a leading /landing/ — /public is the web root,
so this folder is NOT part of the URL beyond that.

Slots (ids in photos.ts): esp32-installed, sensor-board, rack, aircon-ir

Mock/stand-in images are fine during development. They are ordinary images to
the build, so anything left in `src` at `npm run build` time SHIPS. Blank the
src (back to "") before a real deployment if the photo is still a stand-in.

Shooting notes: landscape, 3:2 crop, min 2400px wide, room lights on, no flash.
