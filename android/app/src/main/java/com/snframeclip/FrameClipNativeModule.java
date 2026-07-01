package com.snframeclip;

import android.app.Activity;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.ColorMatrix;
import android.graphics.ColorMatrixColorFilter;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.graphics.pdf.PdfRenderer;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.ParcelFileDescriptor;
import android.provider.Settings;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.Toast;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableArray;
import com.facebook.react.bridge.WritableMap;

import java.io.File;
import java.io.FileOutputStream;
import java.io.FileWriter;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

public class FrameClipNativeModule extends ReactContextBaseJavaModule {
    private static final int MAX_SCAN_FILES_PER_DIR = 800;
    private SelectionOverlayView activeOverlay;
    private final ReactApplicationContext reactContext;

    FrameClipNativeModule(ReactApplicationContext context) {
        super(context);
        reactContext = context;
    }

    @Override
    public String getName() {
        return "FrameClipNative";
    }

    @ReactMethod
    public void getLatestScreenshot(Promise promise) {
        try {
            File latest = findLatestScreenshot();
            if (latest == null) {
                promise.resolve(null);
                return;
            }
            promise.resolve(imageInfo(latest));
        } catch (Exception error) {
            promise.reject("FRAMECLIP_FIND_FAILED", error);
        }
    }

    @ReactMethod
    public void listScreenshots(Promise promise) {
        try {
            ArrayList<File> files = new ArrayList<>();
            Set<String> seen = new HashSet<>();
            collectImages(primaryScreenshotDir(), files, seen);
            if (files.isEmpty()) {
                for (File dir : fallbackScreenshotDirs()) {
                    collectImages(dir, files, seen);
                }
            }

            ArrayList<File> unique = new ArrayList<>();
            Set<String> traits = new HashSet<>();
            for (File file : files) {
                if (traits.add(imageTraitKey(file))) {
                    unique.add(file);
                }
            }
            files = unique;
            files.sort(Comparator.comparingLong(File::lastModified).reversed());

            WritableArray shots = Arguments.createArray();
            int limit = Math.min(files.size(), 40);
            for (int i = 0; i < limit; i++) {
                try {
                    shots.pushMap(imageInfo(files.get(i)));
                } catch (Exception ignored) {
                }
            }
            promise.resolve(shots);
        } catch (Exception error) {
            promise.reject("FRAMECLIP_LIST_SCREENSHOTS_FAILED", error);
        }
    }

    @ReactMethod
    public void deleteScreenshot(String path, Promise promise) {
        try {
            File target = screenshotTarget(path);
            if (target == null) {
                promise.reject("FRAMECLIP_DELETE_SCREENSHOT_INVALID", "Not a screenshot path: " + path);
                return;
            }
            boolean ok = !target.exists() || target.delete();
            promise.resolve(ok);
        } catch (Exception error) {
            promise.reject("FRAMECLIP_DELETE_SCREENSHOT_FAILED", error);
        }
    }

    @ReactMethod
    public void getLatestClip(Promise promise) {
        try {
            File latest = newestImageIn(getOutputDir());
            if (latest == null) {
                promise.resolve(null);
                return;
            }
            promise.resolve(imageInfo(latest));
        } catch (Exception error) {
            promise.reject("FRAMECLIP_FIND_CLIP_FAILED", error);
        }
    }

    // All saved clips, newest first, for the in-note gallery picker. Excludes the
    // scratch page renders so only real captures are listed. Capped so a huge
    // directory can't blow up memory when every thumbnail is decoded on-device.
    @ReactMethod
    public void listClips(Promise promise) {
        try {
            File dir = getOutputDir();
            WritableArray clips = Arguments.createArray();
            if (dir.exists() && dir.isDirectory()) {
                File[] files = dir.listFiles((d, name) -> {
                    String lower = name.toLowerCase(Locale.US);
                    return lower.startsWith("frameclip_")
                            && !lower.startsWith("frameclip_page_")
                            && lower.endsWith(".png");
                });
                if (files != null) {
                    Arrays.sort(files, Comparator.comparingLong(File::lastModified).reversed());
                    int limit = Math.min(files.length, 30);
                    for (int i = 0; i < limit; i++) {
                        try {
                            clips.pushMap(imageInfo(files[i]));
                        } catch (Exception ignored) {
                        }
                    }
                }
            }
            promise.resolve(clips);
        } catch (Exception error) {
            promise.reject("FRAMECLIP_LIST_FAILED", error);
        }
    }

    // Delete a single clip from the gallery. Validated through reuseTarget so
    // only a real clip inside our own output dir can ever be removed.
    @ReactMethod
    public void deleteClip(String path, Promise promise) {
        try {
            File target = reuseTarget(path, getOutputDir());
            if (target == null) {
                promise.reject("FRAMECLIP_DELETE_INVALID", "Not a deletable clip: " + path);
                return;
            }
            boolean ok = !target.exists() || target.delete();
            promise.resolve(ok);
        } catch (Exception error) {
            promise.reject("FRAMECLIP_DELETE_FAILED", error);
        }
    }

    @ReactMethod
    public void launchSelectionOverlay(Promise promise) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(reactContext)) {
                promise.reject(
                        "FRAMECLIP_OVERLAY_PERMISSION",
                        "FrameClip needs overlay permission before it can draw on top of the PDF."
                );
                return;
            }

            reactContext.runOnUiQueueThread(() -> {
                try {
                    showSelectionOverlay();
                    WritableMap result = Arguments.createMap();
                    result.putBoolean("armed", true);
                    result.putString("message", "Selection overlay armed");
                    promise.resolve(result);
                } catch (Exception error) {
                    promise.reject("FRAMECLIP_OVERLAY_FAILED", error);
                }
            });
        } catch (Exception error) {
            promise.reject("FRAMECLIP_OVERLAY_FAILED", error);
        }
    }

    // Crops the source (a pristine page render) and optionally darkens it.
    // `contrast` is a multiplier (1.0 = untouched); because the source is never
    // modified, re-cropping the same region at a different contrast does NOT
    // compound. When `reusePath` names an existing clip in our output dir, the
    // result overwrites it in place (used by the contrast stepper) instead of
    // creating a new file, so adjusting contrast never litters orphan clips.
    @ReactMethod
    public void cropImage(String sourcePath, double left, double top, double width, double height,
                          double contrast, double threshold, String reusePath, Promise promise) {
        Bitmap source = null;
        Bitmap cropped = null;
        Bitmap adjusted = null;
        try {
            source = BitmapFactory.decodeFile(sourcePath);
            if (source == null) {
                promise.reject("FRAMECLIP_DECODE_FAILED", "Could not decode source image");
                return;
            }

            int srcW = source.getWidth();
            int srcH = source.getHeight();
            int x = clamp((int) Math.round(left), 0, Math.max(0, srcW - 1));
            int y = clamp((int) Math.round(top), 0, Math.max(0, srcH - 1));
            int w = clamp((int) Math.round(width), 1, srcW - x);
            int h = clamp((int) Math.round(height), 1, srcH - y);

            cropped = Bitmap.createBitmap(source, x, y, w, h);

            // Tone adjustment, applied to the freshly cropped (pristine) pixels:
            //   threshold != 0 → 1-bit black/white (threshold < 0 = auto cutoff)
            //   else contrast   → darken curve (contrast < 0 = auto level)
            Bitmap toSave = cropped;
            if (threshold != 0) {
                double thr = threshold < 0 ? autoThreshold(cropped) : threshold;
                adjusted = applyThreshold(cropped, thr);
                toSave = adjusted;
            } else {
                double c = contrast < 0 ? autoContrast(cropped) : contrast;
                if (c > 1.0001) {
                    adjusted = applyContrast(cropped, c);
                    toSave = adjusted;
                }
            }

            File outDir = getOutputDir();
            if (!outDir.exists() && !outDir.mkdirs()) {
                promise.reject("FRAMECLIP_OUTPUT_DIR_FAILED", "Could not create " + outDir.getAbsolutePath());
                return;
            }

            File out = reuseTarget(reusePath, outDir);
            if (out == null) {
                out = new File(outDir, "frameclip_" + System.currentTimeMillis() + ".png");
            }
            FileOutputStream stream = new FileOutputStream(out);
            try {
                toSave.compress(Bitmap.CompressFormat.PNG, 100, stream);
                stream.flush();
            } finally {
                stream.close();
            }

            WritableMap result = Arguments.createMap();
            result.putString("path", out.getAbsolutePath());
            result.putString("uri", "file://" + out.getAbsolutePath());
            result.putInt("width", w);
            result.putInt("height", h);
            promise.resolve(result);
        } catch (Exception error) {
            promise.reject("FRAMECLIP_CROP_FAILED", error);
        } finally {
            if (adjusted != null && adjusted != cropped) adjusted.recycle();
            if (cropped != null && cropped != source) cropped.recycle();
            if (source != null) source.recycle();
        }
    }

    // Darken faint scans without graying the background: a contrast curve pivoted
    // at white (255). White stays white (255 → 255) while light-gray text is
    // pushed darker (out = c·in + 255·(1−c), values below 0 clamp to black).
    private Bitmap applyContrast(Bitmap src, double contrast) {
        int w = src.getWidth();
        int h = src.getHeight();
        Bitmap out = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        float c = (float) contrast;
        float t = 255f * (1f - c);
        ColorMatrix cm = new ColorMatrix(new float[]{
                c, 0, 0, 0, t,
                0, c, 0, 0, t,
                0, 0, c, 0, t,
                0, 0, 0, 1, 0,
        });
        Paint paint = new Paint(Paint.FILTER_BITMAP_FLAG);
        paint.setColorFilter(new ColorMatrixColorFilter(cm));
        Canvas canvas = new Canvas(out);
        canvas.drawBitmap(src, 0, 0, paint);
        return out;
    }

    // Convert to crisp 1-bit black/white at a luminance cutoff. Best for text:
    // tiny files and sharp edges on e-ink. Pixels darker than the cutoff go pure
    // black, the rest pure white.
    private Bitmap applyThreshold(Bitmap src, double cutoff) {
        int w = src.getWidth();
        int h = src.getHeight();
        int[] px = new int[w * h];
        src.getPixels(px, 0, w, 0, 0, w, h);
        int t = clamp((int) Math.round(cutoff), 1, 254);
        for (int i = 0; i < px.length; i++) {
            int p = px[i];
            int lum = (int) (0.299 * ((p >> 16) & 0xff)
                    + 0.587 * ((p >> 8) & 0xff)
                    + 0.114 * (p & 0xff));
            px[i] = lum < t ? 0xFF000000 : 0xFFFFFFFF;
        }
        Bitmap out = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        out.setPixels(px, 0, w, 0, 0, w, h);
        return out;
    }

    // Mean luminance over a sub-sampled grid (cheap; full-res scan is wasteful).
    private double meanLuminance(Bitmap b) {
        int w = b.getWidth();
        int h = b.getHeight();
        int stepX = Math.max(1, w / 200);
        int stepY = Math.max(1, h / 200);
        long sum = 0;
        int n = 0;
        for (int y = 0; y < h; y += stepY) {
            for (int x = 0; x < w; x += stepX) {
                int p = b.getPixel(x, y);
                sum += (int) (0.299 * ((p >> 16) & 0xff)
                        + 0.587 * ((p >> 8) & 0xff)
                        + 0.114 * (p & 0xff));
                n++;
            }
        }
        return n > 0 ? (double) sum / n : 255;
    }

    // Pick a GENTLE darken multiplier from how light the crop is. Auto should be
    // a subtle lift, not max darkness — the curve pivots at white, so even small
    // multipliers pull the whole midrange down and a large one grays the page.
    private double autoContrast(Bitmap b) {
        double mean = meanLuminance(b);
        if (mean > 235) return 1.5;
        if (mean > 215) return 1.35;
        if (mean > 190) return 1.25;
        if (mean > 160) return 1.15;
        return 1.0;
    }

    // B/W cutoff just below the mean, so light-gray text still falls on the dark
    // side instead of vanishing into white. Clamped to a sane range.
    private double autoThreshold(Bitmap b) {
        double t = meanLuminance(b) * 0.9;
        if (t < 120) t = 120;
        if (t > 225) t = 225;
        return t;
    }

    // Only allow overwriting a real clip inside our own output dir, never a page
    // render or anything outside FrameClip's folder.
    private File reuseTarget(String reusePath, File outDir) {
        if (reusePath == null || reusePath.isEmpty()) return null;
        File candidate = new File(reusePath);
        File parent = candidate.getParentFile();
        String name = candidate.getName().toLowerCase(Locale.US);
        if (parent != null && parent.equals(outDir)
                && name.startsWith("frameclip_")
                && !name.startsWith("frameclip_page_")
                && name.endsWith(".png")) {
            return candidate;
        }
        return null;
    }

    @ReactMethod
    public void renderPdfPage(String filePath, int pageNum, Promise promise) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) {
            promise.reject("FRAMECLIP_PDF_UNSUPPORTED", "PdfRenderer requires Android 5.0+");
            return;
        }
        ParcelFileDescriptor pfd = null;
        PdfRenderer renderer = null;
        PdfRenderer.Page page = null;
        Bitmap bitmap = null;
        try {
            File pdfFile = new File(filePath);
            if (!pdfFile.exists()) {
                promise.reject("FRAMECLIP_PDF_NOT_FOUND", "PDF not found: " + filePath);
                return;
            }

            pfd = ParcelFileDescriptor.open(pdfFile, ParcelFileDescriptor.MODE_READ_ONLY);
            renderer = new PdfRenderer(pfd);
            int count = renderer.getPageCount();
            if (count <= 0) {
                promise.reject("FRAMECLIP_PDF_EMPTY", "PDF has no pages");
                return;
            }

            int index = clamp(pageNum, 0, count - 1);
            page = renderer.openPage(index);

            // PdfRenderer reports page size in points (1/72"). Upscale so crops stay crisp,
            // capping the long edge. Never downscale below the native point size.
            int targetLongEdge = 2200;
            float scale = (float) targetLongEdge / Math.max(page.getWidth(), page.getHeight());
            if (scale < 1f) scale = 1f;
            int outW = Math.max(1, Math.round(page.getWidth() * scale));
            int outH = Math.max(1, Math.round(page.getHeight() * scale));

            bitmap = Bitmap.createBitmap(outW, outH, Bitmap.Config.ARGB_8888);
            bitmap.eraseColor(Color.WHITE); // transparent PDF areas should read white, not black
            page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);

            // Page renders are scratch images; keep them in cache (not the clips dir, so
            // getLatestClip never mistakes a full page for a saved crop).
            File cacheDir = reactContext.getCacheDir();
            clearOldPageRenders(cacheDir);
            File out = new File(cacheDir, "frameclip_page_" + System.currentTimeMillis() + ".png");
            FileOutputStream stream = new FileOutputStream(out);
            try {
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream);
                stream.flush();
            } finally {
                stream.close();
            }

            WritableMap result = Arguments.createMap();
            result.putString("path", out.getAbsolutePath());
            result.putString("uri", "file://" + out.getAbsolutePath());
            result.putString("name", pdfFile.getName());
            result.putInt("width", outW);
            result.putInt("height", outH);
            result.putInt("pageIndex", index);
            result.putInt("pageCount", count);
            promise.resolve(result);
        } catch (Exception error) {
            promise.reject("FRAMECLIP_PDF_RENDER_FAILED", error);
        } finally {
            if (bitmap != null) bitmap.recycle();
            if (page != null) page.close();
            if (renderer != null) renderer.close();
            if (pfd != null) {
                try {
                    pfd.close();
                } catch (Exception ignored) {
                }
            }
        }
    }

    @ReactMethod
    public void newRenderTarget(Promise promise) {
        try {
            // External storage: SDK render APIs reject internal app-cache paths.
            File outDir = getOutputDir();
            if (!outDir.exists() && !outDir.mkdirs()) {
                promise.reject("FRAMECLIP_TARGET_FAILED", "Could not create " + outDir.getAbsolutePath());
                return;
            }
            clearOldPageRenders(outDir);
            File out = new File(outDir, "frameclip_page_" + System.currentTimeMillis() + ".png");
            promise.resolve(out.getAbsolutePath());
        } catch (Exception error) {
            promise.reject("FRAMECLIP_TARGET_FAILED", error);
        }
    }

    @ReactMethod
    public void readImageInfo(String path, Promise promise) {
        try {
            File file = new File(path);
            if (!file.exists()) {
                promise.reject("FRAMECLIP_IMAGE_NOT_FOUND", "Image not found: " + path);
                return;
            }
            WritableMap info = imageInfo(file);
            addContentStats(file, info);
            promise.resolve(info);
        } catch (Exception error) {
            promise.reject("FRAMECLIP_IMAGE_INFO_FAILED", error);
        }
    }

    // Inspects the actual PNG bytes so we can tell a real render (text = sharp
    // edges) from a smeared gradient (near-zero edges), independent of display.
    private void addContentStats(File file, WritableMap into) {
        try {
            BitmapFactory.Options opts = new BitmapFactory.Options();
            opts.inSampleSize = 8;
            Bitmap bmp = BitmapFactory.decodeFile(file.getAbsolutePath(), opts);
            if (bmp == null) return;
            int w = bmp.getWidth();
            int h = bmp.getHeight();
            int dark = 0;
            int total = 0;
            long edgeSum = 0;
            int prev = -1;
            for (int y = 0; y < h; y += 2) {
                for (int x = 0; x < w; x += 2) {
                    int p = bmp.getPixel(x, y);
                    int lum = (int) (0.299 * ((p >> 16) & 0xff)
                            + 0.587 * ((p >> 8) & 0xff)
                            + 0.114 * (p & 0xff));
                    if (lum < 80) dark++;
                    if (prev >= 0) edgeSum += Math.abs(lum - prev);
                    prev = lum;
                    total++;
                }
            }
            bmp.recycle();
            into.putInt("darkPct", total > 0 ? (dark * 100 / total) : 0);
            into.putInt("avgEdge", total > 1 ? (int) (edgeSum / (total - 1)) : 0);
        } catch (Exception ignored) {
        }
    }

    private void clearOldPageRenders(File dir) {
        File[] stale = dir.listFiles((d, name) -> name.startsWith("frameclip_page_"));
        if (stale == null) return;
        for (File file : stale) {
            //noinspection ResultOfMethodCallIgnored
            file.delete();
        }
    }

    private File findLatestScreenshot() {
        File latest = newestImageIn(primaryScreenshotDir());
        if (latest != null) {
            return latest;
        }

        for (File dir : fallbackScreenshotDirs()) {
            File found = newestImageIn(dir);
            if (found != null && (latest == null || found.lastModified() > latest.lastModified())) {
                latest = found;
            }
        }
        return latest;
    }

    private File primaryScreenshotDir() {
        File root = Environment.getExternalStorageDirectory();
        return new File(root, "SCREENSHOT");
    }

    private List<File> fallbackScreenshotDirs() {
        File root = Environment.getExternalStorageDirectory();
        return Arrays.asList(
                new File(root, "Screenshot"),
                new File(root, "Screenshots"),
                new File(root, "PICTURES/SCREENSHOT"),
                new File(root, "Pictures/Screenshot"),
                new File(root, "Pictures/Screenshots"),
                new File(root, "DCIM/SCREENSHOT"),
                new File(root, "DCIM/Screenshots")
        );
    }

    private String imageTraitKey(File file) {
        String name = file.getName().toLowerCase(Locale.US);
        long modifiedBucket = file.lastModified() / 1000;
        return name + "|" + file.length() + "|" + modifiedBucket;
    }

    private File screenshotTarget(String path) {
        if (path == null || path.isEmpty()) return null;
        File candidate = new File(path);
        if (!candidate.exists() || !candidate.isFile() || !isImage(candidate)) return null;

        if (isInsideDir(candidate, primaryScreenshotDir())) {
            return candidate;
        }
        for (File dir : fallbackScreenshotDirs()) {
            if (isInsideDir(candidate, dir)) {
                return candidate;
            }
        }
        return null;
    }

    private boolean isInsideDir(File file, File dir) {
        try {
            String filePath = file.getCanonicalPath();
            String dirPath = dir.getCanonicalPath();
            return filePath.equals(dirPath) || filePath.startsWith(dirPath + File.separator);
        } catch (Exception ignored) {
            String filePath = file.getAbsolutePath();
            String dirPath = dir.getAbsolutePath();
            return filePath.equals(dirPath) || filePath.startsWith(dirPath + File.separator);
        }
    }

    private void collectImages(File dir, ArrayList<File> out, Set<String> seen) {
        if (dir == null || !dir.exists() || !dir.isDirectory()) {
            return;
        }

        ArrayDeque<File> queue = new ArrayDeque<>();
        queue.add(dir);
        int visited = 0;

        while (!queue.isEmpty() && visited < MAX_SCAN_FILES_PER_DIR) {
            File current = queue.removeFirst();
            visited++;
            File[] children = current.listFiles();
            if (children == null) continue;
            Arrays.sort(children, Comparator.comparingLong(File::lastModified).reversed());
            for (File child : children) {
                if (child.isDirectory()) {
                    queue.add(child);
                } else if (isImage(child) && !child.getName().startsWith("frameclip_page_")) {
                    String key;
                    try {
                        key = child.getCanonicalPath();
                    } catch (Exception ignored) {
                        key = child.getAbsolutePath();
                    }
                    if (seen.add(key)) {
                        out.add(child);
                    }
                }
            }
        }
    }

    private File newestImageIn(File dir) {
        if (dir == null || !dir.exists() || !dir.isDirectory()) {
            return null;
        }

        File latest = null;
        ArrayDeque<File> queue = new ArrayDeque<>();
        queue.add(dir);
        int visited = 0;

        while (!queue.isEmpty() && visited < MAX_SCAN_FILES_PER_DIR) {
            File current = queue.removeFirst();
            visited++;
            File[] children = current.listFiles();
            if (children == null) continue;
            Arrays.sort(children, Comparator.comparingLong(File::lastModified).reversed());
            for (File child : children) {
                if (child.isDirectory()) {
                    queue.add(child);
                } else if (isImage(child) && !child.getName().startsWith("frameclip_page_")) {
                    if (latest == null || child.lastModified() > latest.lastModified()) {
                        latest = child;
                    }
                }
            }
        }

        return latest;
    }

    private boolean isImage(File file) {
        String name = file.getName().toLowerCase(Locale.US);
        return name.endsWith(".png") || name.endsWith(".jpg") || name.endsWith(".jpeg") || name.endsWith(".webp");
    }

    private File getOutputDir() {
        File root = Environment.getExternalStorageDirectory();
        return new File(root, "MyStyle/FrameClip");
    }

    private void showSelectionOverlay() {
        final WindowManager windowManager = (WindowManager) reactContext.getSystemService(Context.WINDOW_SERVICE);
        if (windowManager == null) {
            throw new IllegalStateException("WindowManager unavailable");
        }

        if (activeOverlay != null) {
            try {
                windowManager.removeView(activeOverlay);
            } catch (Exception ignored) {
            }
            activeOverlay = null;
        }

        SelectionOverlayView overlay = new SelectionOverlayView(reactContext, rect -> {
            saveSelection(rect);
            Toast.makeText(reactContext, "FrameClip rectangle saved", Toast.LENGTH_SHORT).show();
            overlayRemoveLater(windowManager);
        });

        int type;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            type = WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY;
        } else {
            type = WindowManager.LayoutParams.TYPE_PHONE;
        }

        WindowManager.LayoutParams params = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.MATCH_PARENT,
                WindowManager.LayoutParams.MATCH_PARENT,
                type,
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                        | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
                        | WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
                android.graphics.PixelFormat.TRANSLUCENT
        );
        params.gravity = Gravity.TOP | Gravity.LEFT;
        activeOverlay = overlay;
        windowManager.addView(overlay, params);
    }

    private void overlayRemoveLater(WindowManager windowManager) {
        SelectionOverlayView overlay = activeOverlay;
        if (overlay == null) return;
        overlay.postDelayed(() -> {
            if (activeOverlay == overlay) {
                try {
                    windowManager.removeView(overlay);
                } catch (Exception ignored) {
                }
                activeOverlay = null;
            }
        }, 1600);
    }

    private void saveSelection(RectF rect) {
        try {
            File outDir = getOutputDir();
            if (!outDir.exists()) outDir.mkdirs();
            File out = new File(outDir, "selection_test.json");
            FileWriter writer = new FileWriter(out, false);
            try {
                writer.write("{"
                        + "\"left\":" + Math.round(rect.left) + ","
                        + "\"top\":" + Math.round(rect.top) + ","
                        + "\"right\":" + Math.round(rect.right) + ","
                        + "\"bottom\":" + Math.round(rect.bottom) + ","
                        + "\"width\":" + Math.round(rect.width()) + ","
                        + "\"height\":" + Math.round(rect.height()) + ","
                        + "\"timestamp\":" + System.currentTimeMillis()
                        + "}");
            } finally {
                writer.close();
            }
        } catch (Exception ignored) {
        }
    }

    private WritableMap imageInfo(File file) throws Exception {
        BitmapFactory.Options opts = new BitmapFactory.Options();
        opts.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(file.getAbsolutePath(), opts);
        if (opts.outWidth <= 0 || opts.outHeight <= 0) {
            throw new Exception("Could not read image dimensions");
        }

        WritableMap result = Arguments.createMap();
        result.putString("path", file.getAbsolutePath());
        result.putString("uri", "file://" + file.getAbsolutePath());
        result.putString("name", file.getName());
        result.putDouble("modified", file.lastModified());
        result.putInt("width", opts.outWidth);
        result.putInt("height", opts.outHeight);
        return result;
    }

    private int clamp(int value, int min, int max) {
        return Math.max(min, Math.min(value, max));
    }

    private interface SelectionCompleteListener {
        void onComplete(RectF rect);
    }

    private static class SelectionOverlayView extends View {
        private final Paint pathPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint rectPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint textPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Path path = new Path();
        private final RectF bounds = new RectF();
        private final SelectionCompleteListener listener;
        private boolean drawing = false;
        private boolean completed = false;
        private float minX;
        private float minY;
        private float maxX;
        private float maxY;

        SelectionOverlayView(Context context, SelectionCompleteListener listener) {
            super(context);
            this.listener = listener;
            setWillNotDraw(false);
            setBackgroundColor(Color.TRANSPARENT);

            pathPaint.setColor(Color.BLACK);
            pathPaint.setStyle(Paint.Style.STROKE);
            pathPaint.setStrokeWidth(5f);
            pathPaint.setStrokeCap(Paint.Cap.ROUND);
            pathPaint.setStrokeJoin(Paint.Join.ROUND);

            rectPaint.setColor(Color.BLACK);
            rectPaint.setStyle(Paint.Style.STROKE);
            rectPaint.setStrokeWidth(6f);

            textPaint.setColor(Color.BLACK);
            textPaint.setTextSize(32f);
            textPaint.setFakeBoldText(true);
        }

        @Override
        public boolean onTouchEvent(MotionEvent event) {
            float x = event.getX();
            float y = event.getY();
            switch (event.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    completed = false;
                    drawing = true;
                    path.reset();
                    path.moveTo(x, y);
                    minX = maxX = x;
                    minY = maxY = y;
                    invalidate();
                    return true;
                case MotionEvent.ACTION_MOVE:
                    if (!drawing) return true;
                    path.lineTo(x, y);
                    include(x, y);
                    invalidate();
                    return true;
                case MotionEvent.ACTION_UP:
                case MotionEvent.ACTION_CANCEL:
                    if (!drawing) return true;
                    drawing = false;
                    include(x, y);
                    bounds.set(minX, minY, maxX, maxY);
                    completed = bounds.width() > 8f && bounds.height() > 8f;
                    invalidate();
                    if (completed) listener.onComplete(new RectF(bounds));
                    return true;
                default:
                    return true;
            }
        }

        private void include(float x, float y) {
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
        }

        @Override
        protected void onDraw(Canvas canvas) {
            super.onDraw(canvas);
            if (!drawing && !completed) {
                canvas.drawText("Draw around the target area", 32f, 56f, textPaint);
                return;
            }
            canvas.drawPath(path, pathPaint);
            if (drawing) {
                canvas.drawRect(minX, minY, maxX, maxY, rectPaint);
            } else if (completed) {
                canvas.drawRect(bounds, rectPaint);
                canvas.drawText("Selection saved", bounds.left, Math.max(56f, bounds.top - 18f), textPaint);
            }
        }
    }
}
