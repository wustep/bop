# bop

A bouncing-ball instrument. Three rubber balls hop across a tray of sixteen dimples, and every landing plays that dimple's note. A ball keeps travelling in whatever direction you last sent it, bouncing off the walls, so a single tap turns into a loop — the melody and the rhythm both come from the geometry.

**Play it: https://bop-wustep.vercel.app**

![bop](docs/desktop.png)

## How to play

- **Tap a dimple.** It sounds, the ball flies there, and then it keeps going. Far taps make long, slow hops; near taps make quick ones.
- **Tap again** to send it somewhere else. The yellow dot shows where it's headed.
- **lo / mid / hi** pick which ball listens to you. Tap the lit one to call it home.
- **▶** serves all three. **■** calls them all back.
- **tempo** is how fast the balls travel. **bounce** is how much each hop keeps: all the way up they never stop, lower and they rattle to rest like a dropped ball. **tone** goes from soft to glassy. **scale** retunes the tray.

Keyboard: `1234 / QWER / ASDF / ZXCV` are the dimples, `J K L` pick a ball, `space` is play/stop.

## Develop

```bash
pnpm install
pnpm dev
pnpm build
```

Vite + TypeScript, no framework. Sound is Web Audio FM synthesis, no samples. The design reference is in `docs/inspo.jpg`.

MIT
