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
- The key serves all three balls, or calls them all back.
- Four knobs: `tempo` (ball speed), `bounce` (how much each hop keeps; at the top they never stop, below it they speed up and rattle to rest), `tone` (soft to glassy), `scale` (six tunings).
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
- Sound was measured, not heard. An offline render of a scripted session peaks at -2.2 dBFS with no flat-topped samples, at about -13 LUFS.
- Under 4x CPU throttling at 390x844 @3x in Chrome, three balls playing held 60fps (worst frame 18.6 ms, script under 1% of the frame).
- `docs/bop.mp4` is a frame-exact capture: the real app driven by a fake clock, with its audio rendered from the same clock, so picture and sound line up.

## Known rough spots

- **Nobody has listened to it.** I can't hear, so the voices were designed from synthesis knowledge and checked by measurement. Balance, the echo level and the top of the `tone` range want a pair of ears.
- **Not run on a real phone.** The iOS unlock path (resume on touchend, `audioSession = "playback"` for the silent switch, the same nudge after an interruption) is written to the platform rules and checked in desktop WebKit, but untested on a device.
- On a touch screen the very first note sounds as the finger lifts, not as it lands. That is the browser's rule, not a choice: `touchstart` and `pointerdown` do not count as the gesture that lets audio start, `touchend` does. Every note after that first lift sounds on the way down. The audio graph is now built at load, so the first touch only has to start it (about 85 ms of work moved out of that touch, measured in Chrome).
- A tap sounds twice: once under the finger, once when the ball arrives. That is deliberate (the ball answers you) but it may feel busy at fast tempos.
- A tap that lands squarely on a flying ball catches it instead of playing the pad under it. That is the rule (touch a ball and you have it), but in a busy pattern it will sometimes happen by accident. A touch that is only near a ball, and nearer the middle of a well, is left as a tap.
- Two balls in one dimple nestle side by side, but in the air they pass through each other.
- Echo time follows `tempo`, so turning the knob bends the pitch of echoes already ringing.
- The compressor adds about 6 ms of lookahead to every note.
- The root is fixed at C.

## Suggested next steps

1. Play it on an iPhone with headphones and with the speaker, and retune levels by ear.
2. Let balls knock into each other, with a clack.
3. A share link that encodes the three throws and the knob positions.
4. A root-note control, perhaps as a second function of the `scale` knob.
5. Web MIDI out, one channel per ball.

## Passes since the first ship

1. **Touch.** A ball can be caught out of the air, by either hand at once. The audio graph is built before the first touch. On a tall phone the slab grows into the spare height; on its side the controls run in two columns that line up with the tray's rows. CI runs the tests and the build on every pull request.
