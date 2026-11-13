# PUBG-stats
Сбор информации с PUBG API по последним играм и вывод некоторой статистики, полученной с апишки

## Запуск в Docker

Создайте `.env` на основе `.env.example` и укажите действительный `PUBG_API_KEY`, затем выполните:


https://developer.pubg.com/apps?locale=en

```bash
docker compose up --build
```

Приложение будет доступно по адресу `http://localhost:5000`.


## Map telemetry

All ten Battle Royale maps and Camp Jackal are bundled locally in `static/maps`.
Images and weapon names come from https://github.com/pubg/api-assets (PUBG Developer Terms apply).
Raw telemetry map identifiers are normalized before selecting image and coordinate extent.
Combat markers, labels, dashes and routes use CSS-pixel sizes converted through the SVG screen matrix and zoom.
Landed airdrops come exclusively from `LogCarePackageLand`, deduplicated by package ID.
The map shows the whole match, including all recorded landings, rather than a live timeline.


## Distance calculator

The separate Mortar Calculator tab works without loading match telemetry or calling the API.
Choose a map, click A (mortar), then B (target). A third click starts a new measurement.
Drag to pan; use the wheel or buttons to zoom. Distances use each map's telemetry extent.
Terrain elevations are fetched automatically from `/api/terrain-height` after each click.
Nine maps use community heightmaps from https://github.com/MingDMeng/mortarkiller
with its 2.08 m per red-channel level calibration. Bundled gzip rasters have a
2048 x 2048 sampling grid (about 4 m on 8 km maps), with bilinear interpolation.
Displayed elevations are model-relative estimates, not surveyed sea-level values.
Data can differ from current terrain; buildings, roofs and bridges are not modeled.
Haven and Camp Jackal have no data and explicitly show unavailable heights.
This computes straight-line 3D distance, not a ballistic mortar range setting.
Source metadata is in `terrain/sources.json`; no external service or PUBG API key
is needed for elevation lookups.


## Map rendering performance

`static/map-renderer.js` batches camera updates with requestAnimationFrame and caches
SVG viewport geometry. Maps use a separate composited raster layer; combat markers,
airdrops and mortar geometry reuse existing SVG nodes. Panning does not rebuild
labels or measure SVG text. Label widths are measured once through Canvas and label
collision checks use a spatial grid on zoom. Coordinates and pixel-sized markers
retain their original calibration.


### Distance calculation checks

The panel and fullscreen overlay share a single result:
`horizontal = hypot(dx, dy) / 100`, `delta = heightB - heightA`,
`distance = hypot(horizontal, delta)`. Heights are in meters; XY is centimeters.
This is straight-line geometry, not a ballistic mortar aiming setting.
Missing, null or invalid elevations never become zero or planar fallback values.
Run `node test_mortar_math.cjs` for analytical tests, including the 3-4-5 horizontal
triangle plus 12 m elevation giving exactly 13 m, ascent/descent, zero elevations
and invalid values. Point placement uses taps/clicks or marker dragging.

## Screenshot distance

In the Mortar Calculator, choose the matching map and squad color, then paste a
screenshot or select a PNG, JPEG or WebP file (up to 12 MiB). The server registers
visible map features against its bundled map; colored point suggestions are
provisional and must be checked. Users can pick A and B directly on the screenshot,
pan and zoom the original screenshot with mouse or touch, drag the vector markers,
open it fullscreen, or align it manually using two distant landmarks on both maps.
The server does not persist uploaded images. HTTPS deployment should install both
`deploy/nginx-pubg.conf` and `deploy/pubg-screenshot-limit.conf` (the latter in
`/etc/nginx/conf.d/`) so nginx accepts 12 MiB, streams the body to the app rather
than buffering it to disk, and limits recognition request rates. Terrain coverage
and straight-line accuracy limitations are the same as the regular calculator.

Telemetry zones use one unfilled target circle per recorded phase. If older telemetry
has no phase identifiers, only stable circles can be shown without inventing phases.

## VPS security

Docker publishes the application to loopback only. The container runs as a
non-root user with a read-only root filesystem, no Linux capabilities, and
`no-new-privileges`; `/tmp` is a small writable tmpfs. Nginx terminates HTTPS
and rate-limits screenshot recognition and the public player/match endpoints.
The application is still public and does not require a login.

The deployed Debian host uses UFW for TCP 22, 80 and 443, Fail2ban for SSH,
SSH key authentication with direct root login disabled, and unattended Debian
security updates. Kernel updates require a planned restart. Docker-published
ports may bypass UFW: keep the application bound to `127.0.0.1` and review any
new container port mappings and Cloud.ru security-group rules.


## Sharing an HTTPS host

On the shared VPS the physics page stays at `/`, DocumentVault keeps its routes,
and this app is served at `/pubg/`. Include `deploy/nginx-pubg-shared.conf` in
the existing HTTPS server block and `deploy/pubg-screenshot-limit.conf` in the
Nginx HTTP context; do not replace the existing server configuration. Nginx
sets `X-Forwarded-Prefix` and proxies to the app on loopback. Link directly to
`/pubg/#mortar` to open the calculator. Do not expose the backend port publicly.

## Mortar aiming estimate

The aiming setting uses the community desktop model and sight-angle table from
https://github.com/Ashimdude/mortarkiller_desktop. It models the descending
arc with gravity 32.16, launch speed 151 and empirical height adjustment -17.8,
then refines the best discrete setting by 0.1-degree interpolation. This is an
estimate, not official game physics, and must be verified by test shots. Terrain
heights omit roofs and bridges. The range ring is nominal, not a firing envelope.
Run `node test_mortar_ballistics.cjs` and `node test_mortar_math.cjs`.

## Windows clipboard helper

`clipboard-helper/pubg_clipboard.py` watches the Windows clipboard for new
images. With Pillow installed, run `python clipboard-helper/pubg_clipboard.py`,
then select **Открыть калькулятор**. It opens the site through
`http://127.0.0.1:18741/pubg/#mortar`; the screenshot and recognition request
are sent to the configured VPS, while the latest image is held only in memory
until the clipboard changes or the helper closes. Only the local helper origin
can access its clipboard stream. Select the game map and verify the detected
points before using the aiming estimate.

For a standalone Windows executable, install PyInstaller and run
`pyinstaller --onefile --windowed --name PUBG-Clipboard clipboard-helper/pubg_clipboard.py`.
The generated executable is a build artifact and is not included in the repo.
