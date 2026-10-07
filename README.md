# Sound Sculpt

A browser instrument where the sound is a sphere. Pull and push its surface to shape the sound in real time — every knob owns a spot on the sphere, so sculpting turns knobs and turning knobs sculpts.

Plain HTML, CSS and JavaScript. No build step, no dependencies to install — Three.js (r128) loads from cdnjs, and all built-in sounds are synthesised in the browser with the Web Audio API.

## Run it

Open `index.html` in a browser, or serve the folder:

```
npx serve .
# or
python3 -m http.server
```

To publish with GitHub Pages: push this folder to a repo, then Settings → Pages → deploy from the `main` branch, root folder.

## Using it

- **Drag the sphere** up to pull the surface out, down to push it in. Pulling at a knob's spot raises it, pushing lowers it. Broad or hard strokes reach several spots.
- **Drag around the sphere** to rotate it any way. `⇧` + scroll or pinch to zoom.
- **BRUSH** sets stroke size: `[` `]`, scroll, or its knob.
- **Knobs**: drag vertically, `⇧` for fine, double-click to reset. Grey = waiting on its partner. Red **OVER** = a spot pushed past its range.
- **Hover a knob** to see its spot; `A` shows all spots.
- **Sound name** (next to play) opens the sound list — 38 synthesised sounds, or load your own wav / mp3 / ogg (or drop a file on the sphere).
- **Download**: `1×` renders one pass (or one note) to WAV; `4×` renders a seamless loop with reverb/echo tails wrapped to the start.
- `SPACE` play/pause · `R` reset sphere · `⌘/Ctrl Z` undo · `⇧ ⌘/Ctrl Z` redo · `ESC` close overlays.

## Files

- `index.html` — markup
- `style.css` — styles
- `app.js` — geometry, audio engine, sound synthesis, UI
