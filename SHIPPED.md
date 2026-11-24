# Shipped

**Live:** https://bop-wustep.vercel.app
**Repo:** https://github.com/wustep/bop

## The instrument

bop is a tray of sixteen dimples and three rubber balls. A ball crosses the tray at a steady speed, bouncing as it goes, and every landing plays the dimple it lands in; it keeps travelling in the direction it was last sent and reflects off the walls, so a straight line folds into a loop. Because the ball's speed is constant, a long stride is a slow note and a short stride is a fast one: the direction of a throw sets the melody and the rhythm together.

## How to play

- Tap a dimple. It sounds straight away, the listening ball flies there, then carries on the same way.
- Tap again to re-aim it. A yellow dot marks where it is headed.
- `lo` `mid` `hi` choose which ball listens. Tapping the lit one calls it home.
- Any ball can be taken in the hand: one in the air is caught the moment it is touched, one sitting still is picked up with a drag. A flick throws it; a still hand sets it down, and it dribbles on the spot.
- The key serves all three balls, or calls them all back. Once you have set a ball going yourself, it serves them again as they were.
- Four knobs: `tempo` (ball speed), `bounce` (how much each hop keeps; at the top they never stop, below it they speed up and rattle to rest), `tone` (soft to glassy), `scale` (six tunings). The `scale` knob is also a button: push it and the root steps up a semitone.
- `link` copies an address that holds what is playing. The address bar holds the same thing all the time, so a reload keeps the loop and the browser's own share sheet sends it.
- Keyboard: `1234 / QWER / ASDF / ZXCV` for the dimples, `J K L` for the balls, `space` for the key.

Other names considered were `pips`, `dimple` and `pogo`. Other concepts considered were a tilt-table marble run (pretty, but more toy than instrument) and balls bouncing in place with drop height as period (clean, but a top-down view can't show height well).

## Font and colour

- **Martian Mono**, one family, self-hosted. It is wide and sturdy at 8px, which is what silk-screened hardware labels need, and note names, tempo and scale read as measurements. Nothing on the banned list.
- **Paper** `#efede8` slab on a warm grey `#c9c7c2` table, after the reference.
- **Black** `#1b1b1d` is used for the balls and nothing else on the surface. The first pass had black knobs and a black key; they competed with the balls, so every control is now the same pale material as the body and reads through its shadow.
- **Yellow** `#ffc400` is the one signal colour and always means state: the pips that tell the balls apart, the tonic dimples, the lit ball, and the dot showing where a ball is going.
- One light, upper left. Every dimple, knob and shadow agrees with it.

## What was checked, and how

- `pnpm test`: 400 random sessions of taps, recalls, pick-ups and throws. No ball passes a wall, no position goes non-finite, and balls in flight together always share one sixteenth-note grid.
- Sound is measured, not heard. `tools/render.html` plays scripted sessions through the real engine and the real sound in an offline context and meters each one (BS.1770 loudness, peak, band shares, onsets); the meter is itself tested against signals with known readings. The play key at 96 bpm renders at -12.3 LUFS, peaking at -1.9 dBFS, with 0.003% of samples deep in the soft clipper.
- Under 4x CPU throttling at 390x844 @3x in Chrome, three balls playing held 60fps (worst frame 18.6 ms, script under 1% of the frame).
- `docs/bop-v2.mp4` is a frame-exact capture of production after the three passes: the real app driven by a stepped clock, with its audio rendered from the same clock, so picture and sound line up (a landing that sounds at 2.012 s is seated in its well on frame 121 of 60). `docs/bop.mp4` is the same thing from the first ship.

## Known rough spots

- **Nobody has listened to it.** I can't hear, so the voices were designed from synthesis knowledge and checked by measurement. Balance, the echo level and the top of the `tone` range want a pair of ears.
- **Not run on a real phone.** The iOS unlock path (resume on touchend, `audioSession = "playback"` for the silent switch, the same nudge after an interruption) is written to the platform rules and checked in desktop WebKit, but untested on a device.
- On a touch screen the very first note sounds as the finger lifts, not as it lands. That is the browser's rule, not a choice: `touchstart` and `pointerdown` do not count as the gesture that lets audio start, `touchend` does. Every note after that first lift sounds on the way down. The audio graph is now built at load, so the first touch only has to start it (about 85 ms of work moved out of that touch, measured in Chrome).
- A tap still sounds twice, but no longer as two equal notes: the finger is a quiet touch (about 9 dB down, duller, half as long, no echo) and the ball that arrives plays the note. Whether 9 dB is the right distance is a guess until someone listens.
- A tap that lands squarely on a flying ball catches it instead of playing the pad under it. That is the rule (touch a ball and you have it), but in a busy pattern it will sometimes happen by accident. A touch that is only near a ball, and nearer the middle of a well, is left as a tap.
- Two balls in one dimple nestle side by side, but in the air they pass through each other.
- The echo catches up with a new tempo about a fifth of a second after the knob comes to rest, not while it is turning.
- `tone` now reaches much further than it did (57–82% in spectral centroid, from 11–15%). The top of it was set by numbers, so it may be brighter than is pleasant.
- Pushing the `scale` knob to move the root is not marked on the slab. It is in the README, and the label answers `root D` when you find it, but nothing invites the first push.
- A link holds each ball's course, not the moment: open one made with `bounce` turned down and the balls are thrown again and rattle to rest again, rather than resuming mid-rattle.
- The root only steps upward, so going from D back to C is ten pushes.

## Suggested next steps

1. Play it on an iPhone with headphones and with the speaker, and retune levels by ear.
2. Let balls knock into each other, with a clack.
3. Web MIDI out, one channel per ball.
4. A way to step the root down as well as up, and a mark on the `scale` knob that says it can be pushed.

## Passes since the first ship

1. **Touch.** A ball can be caught out of the air, by either hand at once. The audio graph is built before the first touch. On a tall phone the slab grows into the spare height; on its side the controls run in two columns that line up with the tray's rows. CI runs the tests and the build on every pull request.
2. **Sound.** Judged by offline renders, before against after. The echo no longer bends pitch when the tempo moves (it was sliding over an octave). The note under a finger is a quiet touch instead of a second full note. `tone` reaches five times further. The low ball keeps a second and third harmonic so a phone speaker can play it (its loudness through a phone-shaped filter went from 7.8 LU under the mid ball to 5.1). A tenth of the output power was below 30 Hz, where nothing can hear it; that is gone. Landings are heard when they are seen instead of 6 ms later, and what a hand does skips the leveller's lookahead.
3. **Link.** The address always says what is playing: the knobs, the root and the course each ball is on, in about thirty characters. A `link` key copies it (or opens the share sheet on a phone). Opening one sets the knobs and leaves the balls in their nests for the key to serve. The key now serves your own loop again after calling it back. The root can be moved by pushing the `scale` knob.
