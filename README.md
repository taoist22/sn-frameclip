

https://github.com/user-attachments/assets/b0c25294-76b5-46cd-a46e-44a928650e26

# FrameClip for Supernote

FrameClip captures a region of a **PDF page** as a PNG and inserts it into a note.
It renders the page natively, lets you draw and fine-tune a crop, optionally
darkens it for faint scans, and keeps a gallery of clips you can drop into any note.

> Status: **beta**, tested on the Supernote Nomad (A6 X2) and Manta. Layout is
> device-aware, so it adapts to each screen size.

## What it does

- **Render-then-crop:** opens the current PDF page, renders it to an image, and
  lets you crop from that — no screenshots required.
- **Crop from a screenshot:** EPUBs can't be render-cropped (they reflow, so there
  is no fixed page to rasterize). To pull an image out of an EPUB, take a Supernote
  screenshot of the page, then launch FrameClip — it lists your recent screenshots;
  tap one to crop it just like a PDF page.
- **Draw-first cropping:** drag anywhere on the page to draw the crop box, drag the
  corner to resize, and use the on-screen buttons to nudge/resize precisely.
- **Page navigation:** ‹ Prev / Next › step through a multi-page PDF without leaving
  the plugin, so you can grab several regions in one session.
- **Tone adjustment** (great for light scans): a row of boxes —
  `Auto · Off · 1 · 2 · 3 · 4 · B/W`. Contrast is pivoted at white, so the
  background stays clean while faint text darkens. **Auto** picks a gentle level for
  you; **B/W** produces crisp 1-bit black/white (best for plain text).
- **Multi-clip gallery:** every capture is saved. In a note, FrameClip shows a
  thumbnail grid — pick one and insert it, or delete clips you no longer need.
- **Screenshot cleanup:** after clipping from an EPUB/page screenshot, you can
  manually delete the source screenshot from FrameClip with a two-tap confirmation.

## Workflow

1. Open a PDF and launch FrameClip from the plugin toolbar.
2. Draw a box around the region you want; fine-tune with the buttons or corner handle.
3. (Optional) Use Prev/Next to capture from other pages.
4. Tap **Capture Clip**. On the saved screen, adjust the **Tone** if needed.
5. Tap **Capture Another** to grab more, or **Done** to exit.
6. Open the destination note and launch FrameClip there.
7. Pick a clip from the gallery and tap **Insert Selected**. Resize it in the note
   as usual.

### From an EPUB (via screenshot)

1. In the EPUB, navigate to the page with the image and take a Supernote screenshot.
2. Open the destination note and launch FrameClip. It shows your recent screenshots
   from `/storage/emulated/0/SCREENSHOT` above the saved-clip gallery.
3. Tap the screenshot, draw a box around just the image (excluding the page chrome),
   and tap **Capture Clip**. From here it behaves exactly like a PDF crop.
4. Optional: on the saved screen, tap **Delete Source Screenshot**, then
   **Confirm Delete Screenshot**, to remove the original full-page screenshot while
   keeping the saved clip.

In `.note` files, FrameClip is for choosing screenshots to crop and for inserting
saved clips. It does not replace Supernote's native lasso/clipboard tools for
editable note content.

Saved clips live in `/storage/emulated/0/MyStyle/FrameClip/`.

## Install

Side-load the plugin package onto your device:

1. Download `FrameClip.snplg` from the latest [release](../../releases).
2. Copy it to your Supernote and install it via the plugin manager.

## Build from source

Requires Node 18+ and a working React Native / Android toolchain.

```sh
npm install
# Always clear stale generated output first, or changes may appear not to apply:
rm -rf build/generated build/outputs
./buildPlugin.sh
```

The packaged plugin is written to `build/outputs/FrameClip.snplg`.

## Project layout

- `App.tsx` — React UI and crop/tone/gallery logic.
- `android/app/src/main/java/com/snframeclip/FrameClipNativeModule.java` — native
  page render, crop, contrast/threshold, and clip management.
- `PluginConfig.json` — Supernote plugin manifest.

## Credits

Icon: [Crop icons created by Fajrul Fitrianto - Flaticon](https://www.flaticon.com/free-icons/crop)

## License

[MIT](LICENSE) © CT Reatherford
