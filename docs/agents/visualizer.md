# Visualizer troubleshooting

The external visualizer consumes its player's queue buffers. Audio routed around
that queue can play without animating the canvas. Verify the current renderer
version and playback path before diagnosing the lighting/capture pipeline.
The live-audio page renders from this server's live input instead: diagnose it
from its `data-party-wait` reason (also the helper's log and `display.wait`)
and the live input's status before the capture pipeline.
A hidden or covered browser window can stop painting; use a foreground capture
window when testing. Keep source-application names and private deployment details
out of this public repository.
