# Trio

Four players, one groove. A browser band where one person plays a chord synth, one plays drums and one plays a mono bass. Everything is step-sequenced (16 steps) against a shared clock, so all three browsers stay in sync.

- Left column: polyphonic chord synth. Pick the notes of one chord on a two-octave keyboard, place its hits on 16 steps. LP/HP filter, resonance, filter envelope, ADSR, gate length and a tempo-synced dub echo.
- Middle: drum machine with tone, decay, snappy and level knobs per voice. The drummer sets the tempo.
- Right: mono bass synth with ADSR, gate, cutoff, peak (resonance), envelope amount, sub oscillator and glide.
- Far right: vocal sampler. Press REC, speak up to four seconds, and the sample is sent to everyone in the room. Place hits on 16 steps and shape it with pitch, start, length, reverse, filter, a tempo-synced echo, reverb and ducking.
- Every instrument has a Volume knob in its output section.
- The kick ducks the chords and the bass (sidechain). Each synth has a Duck knob, and patch cables from the drum machine's kick-out jack show the connection and flash on every kick.
- Follow Bass on the chord synth plugs a cable from the bass pitch out: the chord transposes so its root matches the latest bass note.
- Knob settings are part of the shared state, so everyone hears the same sound.
- Your own instrument is shown in colour; the others are black and white and read-only.
- Anyone can press Play / Stop. Only the drummer changes the tempo.
- The page opens straight into the room `jam`. Add `?room=name` to the URL for a different room. You are handed the first open instrument on arrival; type your name in the field in your panel. Extra visitors wait in line and automatically take the next instrument that opens up, longest wait first.

## Making your own default pattern

Open the page with `?all` in the URL (for example `http://localhost:5180/?room=mine&all`) and every panel becomes editable, so you can program all three instruments yourself. Play until the groove is right, press the "Copy pattern" button that appears in the top bar in this mode, and paste the clipboard contents over `src/default-pattern.json`. Every new room then starts from that pattern, including knob settings.

## How it works

- All sound is synthesized in the browser with the Web Audio API. Nothing is streamed.
- Realtime messaging and presence go through [Ably](https://ably.com) over WebSockets. Vercel's serverless platform cannot host a long-lived WebSocket server, and Ably's free tier is more than enough for a few jam rooms.
- Clock sync: each client measures its offset from Ably's server time. The transport is a shared `startAt` timestamp plus BPM, so every client computes the same step at the same moment.
- Without an Ably key the app still runs in solo mode so you can develop and play locally.

## Setup

1. Create a free Ably account and app, copy its API key.
2. `cp .env.example .env` and paste the key into `ABLY_API_KEY`.
3. `npm install` then `npm run dev`.

The key never ships to the browser. `api/token.js` issues short-lived Ably tokens, and the Vite dev server serves the same handler at `/api/token`.

## Deploy to Vercel

```
vercel
vercel env add ABLY_API_KEY
vercel --prod
```

Vercel detects the Vite project, builds `dist/` as static files and deploys `api/token.js` as a serverless function. Both fit the free tier.
