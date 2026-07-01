# FrameClip Progress Handoff

Date: 2026-06-25

## Architecture (current — read this first)

FrameClip captures a region of a PDF page as a PNG and inserts it into a note.
The flow is **render the page natively, then crop in React** — NOT the old
native-overlay-on-live-PDF approach (that is abandoned; see bottom).

1. Plugin opens from a PDF (`PluginCommAPI.getCurrentFilePath` / `getCurrentPageNum`).
2. The page is rendered to a PNG. `renderPage()` in `App.tsx` tries renderers in order:
   - **DOC** (`PluginDocAPI.generateDocImage`) — the correct path for PDFs. This is
     what works on-device ("rendered via DOC").
   - **NOTE** (`PluginFileAPI.generateNotePng`) — if the file is actually a note.
   - **pdfium** (`FrameClipNative.renderPdfPage`, Android `PdfRenderer`) — fallback;
     geometry is right but content can be wrong for some PDFs.
3. React displays the rendered page. User draws a crop box (drag) or nudges it with
   buttons.
4. `FrameClipNative.cropImage(src, left, top, w, h)` crops the rendered PNG (crop
   coords are SOURCE pixels) and saves to `/sdcard/MyStyle/FrameClip/frameclip_*.png`.
5. From a note, **Insert Last Clip** / **Insert Here** drops the newest clip via
   `PluginNoteAPI.insertImage`.

A diagnostic panel at the bottom of the crop screen prints the render log, including
`fileCheck darkPct=..% avgEdge=..` (from `readImageInfo` content stats) so a
blank/smeared render is distinguishable from a real one on-device.

## Latest Build

- Package: `/Users/ctreatherford/supernote-plugins/sn-frameclip/build/outputs/FrameClip.snplg`
- `package.json`: `0.1.20-beta`
- `PluginConfig.json`: `versionName` `0.1.20-beta`, `versionCode` `21`
- Packaged config verified: `nativeCodePackage: "/app.npk"`, `reactPackages` present.

## Fixed in 0.1.18-beta — EPUB Screenshot Picker Missing From Notes

User report: EPUB screenshot flow previously worked by taking a Supernote
screenshot, opening a note, launching FrameClip, and choosing that screenshot.
The screenshot file existed in the device `SCREENSHOT` folder but no longer
appeared in FrameClip.

Root causes:

- Note context only loaded saved clips via `FrameClipNative.listClips()`. It no
  longer loaded recent screenshots, so the EPUB screenshot picker was hidden
  exactly where the user needed it.
- Screenshot listing in JS depended on `FileUtils.listFiles` for one hardcoded
  directory. Native direct filesystem listing is more reliable for this device
  class.

Fix:

- Added native `FrameClipNative.listScreenshots()` in
  `android/app/src/main/java/com/snframeclip/FrameClipNativeModule.java`.
- Native screenshot lookup now searches uppercase and common folders:
  `/sdcard/SCREENSHOT`, `/sdcard/Screenshot`, `/sdcard/Screenshots`,
  `/sdcard/PICTURES/SCREENSHOT`, `/sdcard/Pictures/Screenshot`,
  `/sdcard/Pictures/Screenshots`, `/sdcard/DCIM/SCREENSHOT`,
  `/sdcard/DCIM/Screenshots`.
- `App.tsx` now uses native `listScreenshots()` first, with old `FileUtils`
  listing as a fallback.
- In `.note` context, FrameClip now loads both recent screenshots and saved
  clips. The note gallery shows a `Screenshots` section for cropping EPUB/page
  screenshots and a `Saved Clips` section for inserting existing clips.

## Fixed in 0.1.19-beta — Duplicate Screenshot Thumbnails

User report: screenshots appeared duplicated or triplicated after 0.1.18-beta.

Likely cause: Android/Supernote exposes the same storage through multiple path
aliases. Searching every screenshot folder up front can discover the same physical
image more than once.

Fix:

- Native screenshot scan now prefers the confirmed `/sdcard/SCREENSHOT` folder.
- Fallback screenshot folders are scanned only if the primary folder is empty.
- The list also dedupes by image traits (`filename + size + modified timestamp
  bucket`) instead of relying only on canonical path, since aliases may still
  report different canonical paths on-device.

Scope decision: do **not** add note-page capture/clipboard behavior yet. In
`.note` files, FrameClip remains for choosing EPUB/page screenshots to crop and
for inserting/managing saved clips. Native Supernote lasso/clipboard already
handles editable note content better.

## Added in 0.1.20-beta — Manual Source Screenshot Deletion

User request: after clipping from an EPUB/page screenshot, allow deleting the
original screenshot from inside FrameClip instead of requiring the user to open
the device `SCREENSHOT` folder separately.

Implementation:

- Added native `deleteScreenshot(path)` in `FrameClipNativeModule.java`.
- Deletion is validated: only image files inside recognized screenshot folders
  can be removed.
- No automatic deletion. After a screenshot crop is saved, the saved screen shows
  `Delete Source Screenshot`.
- Deletion requires two taps:
  1. `Delete Source Screenshot`
  2. `Confirm Delete Screenshot`
- After deletion, screenshot gallery state is refreshed and the saved clip remains.

UX decision: screenshot deletion is tied to the source screenshot used for the
current crop. The screenshot gallery still keeps the simple tap-to-crop behavior.

## Device

The user tests on the **Supernote Nomad (A6 X2, ≈1404×1872)**, NOT the Manta
(≈1920×2560). Keep layout device-aware via `useWindowDimensions` (no hardcoded
model dimensions). `App.tsx` uses `compact = window.width < 1500` to shrink chrome
on the smaller Nomad screen.

## Changed in 0.1.11-beta

- **Move vs. draw:** drag inside the box moves it, the corner resizes, empty space
  draws a new box. Previously every drag drew a new box (you could not reposition).
  Implemented with a `moveArea` capture View (zIndex 1) + existing resize handle
  (zIndex 3) + background `drawResponder`.
- **Bigger preview / device-aware:** diagnostics panel is now collapsed behind a
  `▸ diagnostics` toggle (default hidden) to reclaim vertical space, biggest win on
  the Nomad. Chrome (margins, spacing, hint) shrinks when `compact`.
- **Reopen staleness:** `onStop` and Close now call `resetTransient()` (clears
  page/crop/saved so a reopen is never stale), plus an `AppState change→active`
  reload as a backup to `onStart`. NEEDS ON-DEVICE VERIFICATION — if the Nomad
  delivers none of onStart/onStop/AppState on reopen, a native hook is required.

## What Works On Device

- DOC render produces a real page image (e.g. page 4 of 7, 1922×2560,
  `darkPct=2% avgEdge=11`, "rendered via DOC").
- The crop screen, "Crop Again", capture/save, and the saved preview all work.

## Fixed in 0.1.10-beta — first-pass preview was collapsing

Symptom: on first open the page looked blank/tiny and a drawn crop came back
"greatly zoomed in", but **Crop Again** displayed the page correctly.

Root cause: `display` scale depends on `previewBox`, which is only set when the
preview area's `onLayout` fires. On the first frame `onLayout` had not delivered a
real size, so `display` fell back to `{1,1, scale:1}`:
- image wrapper sized 1×1 → blank/tiny page;
- drawing at `scale 1` (App.tsx draw responder divides display px by scale) mapped
  the gesture to a tiny slice of the 1922px-wide source → zoomed-in capture.
Crop Again remounted the preview after layout settled, so it worked.

Fix: `display` now seeds its bounds from `useWindowDimensions` (`window.width - 12`,
`window.height * 0.66`) until `onLayout` reports the real preview size, so the first
frame already has a correct scale. Also trimmed control chrome (smaller margins,
buttons, paddings) to give the portrait page more vertical room.

Note: the page is portrait and **height-limited** in the preview area (big gray side
margins are expected). The only way to enlarge it further is to reclaim vertical
space from the controls or allow scroll/zoom — width cannot be used for a portrait
page.

## Key Files

- React UI / crop logic: `App.tsx`
- Native module (render + crop + image stats): `android/app/src/main/java/com/snframeclip/FrameClipNativeModule.java`
- Plugin manifest: `PluginConfig.json`

## Next Candidates

1. Confirm 0.1.10-beta first-open preview now matches Crop Again on-device.
2. If still not large enough, add pinch-zoom or a scrollable preview (mind the
   pan-vs-draw gesture conflict).
3. Optional cleanup: the unused native overlay code (`launchSelectionOverlay`,
   `SelectionOverlayView`, `saveSelection`) can be removed once the render path is
   fully trusted.

## Build Reminder

Before rebuilding, remove stale generated outputs:

```sh
rm -rf build/generated build/outputs
./buildPlugin.sh
```

Stale Metro/build artifacts have repeatedly made code changes look like they did not
apply. If Metro hits `EMFILE: too many open files, watch`, see:

- `/Users/ctreatherford/supernote-plugins/AGENTS.md`
- `/Users/ctreatherford/supernote-plugins/references/setup-and-build.md`

## Abandoned Approach (do not resurrect without reason)

Earlier versions (≤0.1.3-beta) drew a native `WindowManager` overlay on top of the
live PDF to capture a lasso/rectangle. It proved an overlay can sit above the PDF,
but the selection gesture also inked the PDF underneath, and mapping overlay coords
to screenshot pixels was unsolved. Replaced by the render-then-crop flow above. The
overlay code still exists in the native module but is no longer called from JS.
