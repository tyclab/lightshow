# Visualizer troubleshooting

The external visualizer consumes its player's queue buffers. Audio routed around
that queue can play without animating the canvas. Verify the current renderer
version and playback path before diagnosing the lighting/capture pipeline.
The live-audio page renders from this server's live input instead: diagnose it
from its `data-party-wait` reason (also the helper's log and `display.wait`)
and the live input's status before the capture pipeline.
A dark room under the Visualizer source is the server saying the picture is missing:
read `picture.unmet` in `/api/state/live` first (`no-sender`, `no-frame`,
`bad-frame` with its refusal, `rig-changed`, `disarmed`, `unacknowledged`) and the
`picture` log lines (claims, releases and expiries with their reasons). The server
sees only what reaches it: a helper that cannot capture releases its lease and shows
as `no-sender`, its own reason on its status page and in its log.
A hidden or covered browser window can stop painting; use a foreground capture
window when testing. Keep source-application names and private deployment details
out of this public repository.
