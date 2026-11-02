# TycStation Lightshow

Controls the [TycStation Lightshow](https://github.com/tyclab/lightshow) server — a beat-synced light show for DMX fixtures, LED bars, WLED strips and panels and Philips Hue lamps — from a Stream Deck or any Companion surface. Built for busking: palettes, patterns and pixel effects a press away, effects that last as long as a button is held, cues, tempo and the auto show.

## Configuration

| Setting      | Description                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------- |
| Host         | Hostname or IP of the machine running the Lightshow server                                  |
| Port         | Port of the Lightshow server (default `3000`)                                               |
| Access token | The server's access token, when it has one (it must whenever it is reachable from the network) |

The connection shows **OK** once connected and reconnects on its own. It follows the server by its changes alone (protocol 2), so a big rig — a WLED panel of thousands of pixels — costs Companion nothing between changes.

The patterns, colours, palettes, energy effects, fixtures and cues offered in actions, feedbacks and presets are the server's own, read when it connects: a pattern or a cue added on the server shows up here without a new module.

## Busking

The **Busk** preset page has what a set played by hand needs:

- **Looks** — previous, next and random patterns or effects, plus the current look. Patterns are every look the server lists except the bars' pictures and the energy looks, by the tags the server sends (the gentle Fire and Ice included); effects are the energy holds and strobe voices. Retired ids are in neither list. Rapid effects enter a browse list after the server's photosensitivity acknowledgement.
- **Palettes** — toggle a palette over the whole running show, clear the override, or choose a random palette or four random colour slots. Override buttons light while selected.
- **Pads** — the server's two banks, following each pad's launch mode.
- **Hits** — a strobe burst and held blackout alongside the pads.
- **Tempo** — tap, the BPM, double and halve, beat divisions, and automatic tempo matching on/off.
- **Show** — auto-show start/stop, current track and stop all live effects. Programme Start/Stop and picture Freeze/Resume are in Looks; output arming is on the Transport page.
- **Master** — the master level (±10 % and a display) and blackout.
- **Cues** — one button for each cue saved on the server.

The separate **Auto Show** page has start/stop, intensity (±10 and a display), sync nudges (±20 ms) and the current track. Button variables use this connection's label, including when it has been renamed.

**Energy → Held** has each energy effect (white strobe, colour strobe, blinder, UV wash, kill, glow) and blackout, **on only while held**. The server expires a hold if Companion stops renewing it. Rapid effects require the server's photosensitivity acknowledgement; refusals appear in the module's log.

## Actions

| Action                            | Description                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------ |
| Set Pattern                       | Switch the running pattern, optionally crossfading over some milliseconds            |
| Browse / Random Look              | Previous, next or random eligible pattern/effect; random palettes and colours are also available |
| Palette Override / Off            | Apply or toggle a palette over every effect, or clear the override                    |
| Stop Every Effect                 | Stop the live voices; the base look and sequence retain their own transport controls  |
| Tempo Mode                        | Automatic matching on/off/toggle                                                     |
| Set Bars Pattern                  | The LED bars' own picture (a pixel effect) while the pars run the pattern; or none   |
| Set Panels Pattern                | The panels' own picture (a WLED matrix: bars, fire, rain…); or none, as the bars     |
| Set Pixel Map                     | Lay pixel effects across the stage, along each bar, or mirrored                      |
| Set Palette                       | A server palette with 1–8 colour slots and authored gradients; classic variants use 2, 3 or 4 colours |
| Set Colour A / B / C / D          | Change one colour slot (C/D feed 3/4-colour patterns)                                |
| Set BPM / Adjust BPM              | Set exact BPM or nudge it by ± amount                                                |
| Double / Halve BPM                | ×2 or ÷2                                                                             |
| Tap Tempo                         | Register a tap                                                                       |
| Set / Adjust Master Dimmer        | 0-255, or by ± amount                                                                |
| Master Blackout                   | On / Off / Toggle — On on a button's down and Off on its up makes a blackout hold    |
| Programme Start / Stop            | Start, Stop or Toggle the selected programme; Start never arms, restores Blackout or releases Freeze |
| Picture Freeze / Resume           | Hold or resume the complete composition independently of programme transport |
| Outputs Armed / Disarmed          | Arm / Disarm / Toggle whether anything leaves the machine: disarmed, no Art-Net, sACN or DDP frame goes out and the Hue bridges are handed back. The server starts disarmed; disarming does not freeze or stop the programme |
| Set Beat Division                 | 1/1, 1/2, 1/4, 1/8                                                                   |
| Energy Hold                       | Press on a button's down, Release on its up: the effect lasts while it is held      |
| Energy Override / Off             | Latch an energy effect on, or clear it                                               |
| Set Strobe Function / Speed       | Choose the strobe program and its speed                                              |
| Recall Cue                        | Put a saved cue on stage                                                             |
| Start Auto / Stop programme       | Start selects Auto explicitly; Stop stops the selected programme |
| Sequence transport               | Start/resume the loaded sequence, pause its timeline (clips continue), or Stop programme |
| Auto Show Intensity               | Set it, or adjust it by ± amount                                                     |
| Auto Show Source                  | What the auto show follows: auto-detect, Spotify, PRO DJ LINK, the live input, …     |
| Nudge Auto Show Sync              | Run the lights earlier (+) or later (−) against the music                             |
| Fixture Blackout                  | Per fixture, toggle/on/off                                                           |
| Fixture Override (RGBWAUV)        | Set colour + dimmer on one fixture                                                   |
| Clear Fixture Override            | Remove override on one or all fixtures                                               |

Global commands use the server session and revision last received for the displayed controls. A stale command is refused once: the module does not fetch fresh state and silently retry it. Wait for the updated feedback and press the intended action again. Reconnection or a missing state patch invalidates global controls until a complete snapshot arrives.

An older server without this contract leaves global commands unavailable; its old `running` flag cannot represent whole-picture Freeze. The retained `play_stop` action ID now means **Programme Start/Stop**. Review existing button labels, and use the new **Picture Freeze/Resume** action for a held picture. Existing custom button text is not rewritten automatically.

## Feedbacks

| Feedback                       | Button highlights when…                                    |
| ------------------------------ | ---------------------------------------------------------- |
| Pattern is active              | Selected pattern is running                                |
| Bars pattern is active         | The bars are running that picture (or none)                |
| Panels pattern is active       | The panels are running that picture (or none)              |
| Pixel map is active            | Pixel effects are laid out that way                        |
| Palette is active              | That palette is the look's                                 |
| Palette override is active     | The selected palette is overriding the show                |
| Automatic tempo matching       | Tempo mode is automatic                                    |
| Colour A/B/C/D selected        | That colour slot matches                                   |
| Master blackout active         | Blackout is on                                             |
| Programme is playing           | The selected programme is running and its timeline is not paused |
| Whole picture is frozen         | The server confirms the complete composition is held |
| Explicit controls available     | The server provides the current global control contract |
| Sequence transport state       | The loaded sequence is playing, paused or stopped          |
| Outputs are armed              | Frames are going out to the rig                            |
| Auto show is running           | The auto show is on                                        |
| Auto show follows this source  | The auto show is following that source now                 |
| Energy override active         | An (or a specific) effect is on, latched or held           |
| Fixture blackout / override    | That fixture is blacked out, or has an override            |

## Variables

`bpm` (to a tenth), `clock_source` (Auto, CDJ, Track or Tap), `beat_division`, `playing`, `programme`, `picture_frozen`, `controls_available`, `outputs_armed`, `pattern`, `pattern_id`, `pixel_pattern`, `panel_pattern`, `pixel_map`, `palette`, `palette_override` (the overriding palette or "off"), `color_a` … `color_d`, `master_dimmer`, `master_dimmer_pct`, `master_blackout`, `strobe_function`, `strobe_speed`, `energy_override`, `auto_show`, `auto_source`, `auto_intensity`, `sync_offset`, `track` (Artist — Title), `cue_count`

## Presets

Besides **Busk**: every pattern (the whole-rig ones and the pixel effects apart), the bars' and the panels' own pictures and the pixel map; all four colour slots; transport (outputs, programme Start/Stop, picture Freeze/Resume, blackout, tap tempo, BPM, beat divisions); **Sequence** transport and tempo; a blackout for each fixture in the patch; and latched energy effects.

Load or edit the sequence in Lightshow's Sequence page first. **Sequence: Start** starts after a stop and resumes a paused timeline. Pause holds timeline progression while clips continue; it does not freeze the composition. Stop uses global programme Stop. The combined legacy sequence stop-with-black action now refuses; configure separate explicit Stop and Blackout actions. These controls never arm outputs or release Freeze/Blackout. Server refusals, including no loaded sequence or a missing photosensitivity acknowledgement, appear in the connection log.

The Sequence presets reuse the existing BPM display and ±5 actions. Set BPM and Adjust BPM change the shared tempo and end sequence tempo automation; later authored tempo commands can change it again. Pausing and resuming preserves the sequence position and does not reapply its initial tempo.

TycStation Lightshow builds on [LightD31’s ArtNet Lightshow](https://github.com/LightD31/artnet-lightshow) under the MIT license. The module ID is `tycstation-lightshow`; the variable prefix is `lightshow`.
