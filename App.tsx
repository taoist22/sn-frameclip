import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  ActivityIndicator,
  AppState,
  Image,
  NativeModules,
  PanResponder,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import {
  FileUtils,
  PluginCommAPI,
  PluginDocAPI,
  PluginFileAPI,
  PluginManager,
  PluginNoteAPI,
} from 'sn-plugin-lib';

type PageImage = {
  path: string;
  uri: string;
  name: string;
  width: number;
  height: number;
  pageIndex: number;
  pageCount: number;
};

type CropResult = {
  path: string;
  uri: string;
  width: number;
  height: number;
};

type CropRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type ImageInfo = {
  path: string;
  uri: string;
  name: string;
  width: number;
  height: number;
};

type FrameClipNativeModule = {
  getLatestClip(): Promise<CropResult | null>;
  listClips(): Promise<ImageInfo[]>;
  deleteClip(path: string): Promise<boolean>;
  renderPdfPage(filePath: string, pageNum: number): Promise<PageImage>;
  newRenderTarget(): Promise<string>;
  readImageInfo(path: string): Promise<ImageInfo>;
  cropImage(
    sourcePath: string,
    left: number,
    top: number,
    width: number,
    height: number,
    contrast: number,
    threshold: number,
    reusePath: string,
  ): Promise<CropResult>;
};

const FrameClipNative = NativeModules.FrameClipNative as FrameClipNativeModule;

function baseName(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Renders the page through the SDK, recording exactly what happened at each step
// so failures are visible on screen instead of silently falling back.
async function renderPage(
  path: string,
  pageNum: number,
  pageCount: number,
): Promise<{image: PageImage | null; log: string[]}> {
  const log: string[] = [`render @ ${new Date().toLocaleTimeString()}`];

  const toPage = (info: ImageInfo): PageImage => ({
    path: info.path,
    uri: info.uri,
    name: baseName(path),
    width: info.width,
    height: info.height,
    pageIndex: pageNum,
    pageCount,
  });

  // Output size for the renderers, scaled up for crisp crops (long edge capped).
  let size: {width: number; height: number} | null = null;
  try {
    const sizeRes = (await PluginFileAPI.getPageSize(path, pageNum)) as any;
    if (sizeRes?.success && sizeRes.result?.width > 0) {
      const w = sizeRes.result.width;
      const h = sizeRes.result.height;
      // Render at native page size (never upscale) — upscaled buffers can
      // produce a degenerate gradient. Only cap if a page is very large.
      const scale = Math.min(1, 3000 / Math.max(w, h));
      size = {width: Math.round(w * scale), height: Math.round(h * scale)};
      log.push(`getPageSize ${w}×${h} → render ${size.width}×${size.height}`);
    } else {
      log.push(`getPageSize failed: ${sizeRes?.error?.message ?? 'no size'}`);
    }
  } catch (e) {
    log.push(`getPageSize threw: ${errMsg(e)}`);
  }

  // 1) DOC renderer — the correct path for PDFs.
  if (size) {
    try {
      const target = await FrameClipNative.newRenderTarget();
      const gen = (await PluginDocAPI.generateDocImage(
        path,
        pageNum,
        target,
        size,
      )) as any;
      log.push(
        `generateDocImage success=${gen?.success} result=${gen?.result}${
          gen?.error ? ' err=' + gen.error.message : ''
        }`,
      );
      if (gen?.success && gen.result) {
        const info = (await FrameClipNative.readImageInfo(target)) as any;
        return {
          image: toPage(info),
          log: [
            ...log,
            `fileCheck darkPct=${info.darkPct}% avgEdge=${info.avgEdge}`,
            'rendered via DOC',
          ],
        };
      }
    } catch (e) {
      log.push(`generateDocImage threw: ${errMsg(e)}`);
    }
  }

  // 2) NOTE renderer (in case the file is actually a note).
  try {
    const target = await FrameClipNative.newRenderTarget();
    const gen = (await PluginFileAPI.generateNotePng({
      notePath: path,
      page: pageNum,
      times: 2,
      pngPath: target,
      type: 1,
    })) as any;
    log.push(
      `generateNotePng success=${gen?.success} result=${gen?.result}${
        gen?.error ? ' err=' + gen.error.message : ''
      }`,
    );
    if (gen?.success && gen.result) {
      const info = (await FrameClipNative.readImageInfo(target)) as any;
      return {
        image: toPage(info),
        log: [
          ...log,
          `fileCheck darkPct=${info.darkPct}% avgEdge=${info.avgEdge}`,
          'rendered via NOTE',
        ],
      };
    }
  } catch (e) {
    log.push(`generateNotePng threw: ${errMsg(e)}`);
  }

  // 3) pdfium fallback (page geometry is right, content may be wrong for some PDFs).
  try {
    const r = await FrameClipNative.renderPdfPage(path, pageNum);
    if (r) {
      return {
        image: {...r, name: baseName(path), pageCount: pageCount || r.pageCount},
        log: [...log, 'rendered via pdfium (fallback — content may be wrong)'],
      };
    }
    log.push('renderPdfPage returned null');
  } catch (e) {
    log.push(`renderPdfPage threw: ${errMsg(e)}`);
  }

  return {image: null, log};
}

// Supernote writes system screenshots here (user-confirmed on Manta). The
// screenshot feature works inside EPUBs — which can't be render-cropped because
// they reflow (no fixed page) — so cropping a screenshot is the way to pull an
// image out of an EPUB. The crop pipeline already accepts any source path, so a
// screenshot just becomes another PageImage feeding the same crop UI.
const SCREENSHOT_DIR = '/storage/emulated/0/SCREENSHOT';
const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;
const MAX_SCREENSHOTS = 24;

// List recent screenshots newest-first, resolving each to an ImageInfo (with the
// dimensions/uri the crop UI and thumbnails need). Defensive about the SDK's
// loose return shapes; never throws (returns [] + a diagnostic log instead).
async function listScreenshots(): Promise<{shots: ImageInfo[]; log: string[]}> {
  const log: string[] = [`screenshots @ ${new Date().toLocaleTimeString()}`];
  if (!FileUtils?.listFiles) {
    return {shots: [], log: [...log, 'FileUtils.listFiles unavailable']};
  }
  let raw: any;
  try {
    const list = (await FileUtils.listFiles(SCREENSHOT_DIR)) as any;
    raw = Array.isArray(list) ? list : list?.result;
  } catch (e) {
    return {shots: [], log: [...log, `listFiles threw: ${errMsg(e)}`]};
  }
  if (!Array.isArray(raw)) {
    return {shots: [], log: [...log, `listFiles returned no array (${typeof raw})`]};
  }
  const paths = raw
    .map((item: any) => (typeof item === 'string' ? item : item?.path))
    .filter((p: unknown): p is string => typeof p === 'string' && IMAGE_EXT.test(p))
    // Screenshots are timestamp-named, so reverse-lexical ≈ newest first.
    .sort((a: string, b: string) => baseName(b).localeCompare(baseName(a)));
  log.push(`found ${paths.length} image file(s)`);

  const shots: ImageInfo[] = [];
  for (const path of paths.slice(0, MAX_SCREENSHOTS)) {
    try {
      const info = (await FrameClipNative.readImageInfo(path)) as any;
      if (info?.width > 0 && info?.height > 0) {
        shots.push({
          path,
          uri: info.uri,
          name: baseName(path),
          width: info.width,
          height: info.height,
        });
      }
    } catch (e) {
      log.push(`readImageInfo failed for ${baseName(path)}: ${errMsg(e)}`);
    }
  }
  log.push(`resolved ${shots.length} screenshot(s)`);
  return {shots, log};
}

const MIN_CROP = 80;
const MOVE_STEP = 24;
const SIZE_STEP = 48;

// Tone box row (Kobo-style). Each box maps to a native (contrast, threshold)
// pair passed to cropImage: contrast is a darken multiplier pivoted at white
// (1.0 = untouched, -1 = auto-pick from the crop); threshold drives 1-bit B/W
// (0 = off, -1 = auto cutoff). Left→right the contrast boxes get darker.
type ToneKey = 'auto' | 'off' | 'c1' | 'c2' | 'c3' | 'c4' | 'bw';
type Tone = {key: ToneKey; label: string; contrast: number; threshold: number};
const TONES: Tone[] = [
  {key: 'auto', label: 'Auto', contrast: -1, threshold: 0},
  {key: 'off', label: 'Off', contrast: 1.0, threshold: 0},
  {key: 'c1', label: '1', contrast: 1.5, threshold: 0},
  {key: 'c2', label: '2', contrast: 2.1, threshold: 0},
  {key: 'c3', label: '3', contrast: 3.0, threshold: 0},
  {key: 'c4', label: '4', contrast: 4.2, threshold: 0},
  {key: 'bw', label: 'B/W', contrast: 1.0, threshold: -1},
];

function defaultCrop(image: PageImage): CropRect {
  const width = Math.round(image.width * 0.62);
  const height = Math.round(image.height * 0.36);
  return {
    left: Math.round((image.width - width) / 2),
    top: Math.round((image.height - height) / 2),
    width,
    height,
  };
}

function clampCrop(crop: CropRect, image: PageImage): CropRect {
  const width = Math.max(MIN_CROP, Math.min(crop.width, image.width));
  const height = Math.max(MIN_CROP, Math.min(crop.height, image.height));
  return {
    left: Math.max(0, Math.min(crop.left, image.width - width)),
    top: Math.max(0, Math.min(crop.top, image.height - height)),
    width,
    height,
  };
}

export default function App(): React.JSX.Element {
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState<PageImage | null>(null);
  const [latestClip, setLatestClip] = useState<CropResult | null>(null);
  const [clips, setClips] = useState<ImageInfo[]>([]);
  const [screenshots, setScreenshots] = useState<ImageInfo[]>([]);
  const [selectedClip, setSelectedClip] = useState<ImageInfo | null>(null);
  const [pendingDelete, setPendingDelete] = useState(false);
  const [currentPath, setCurrentPath] = useState('');
  const [crop, setCrop] = useState<CropRect | null>(null);
  const [tone, setTone] = useState<ToneKey>('off');
  const [saved, setSaved] = useState<CropResult | null>(null);
  const [message, setMessage] = useState('');
  const [stage, setStage] = useState<'crop' | 'saved'>('crop');
  const [previewBox, setPreviewBox] = useState({width: 1, height: 1});
  const [diag, setDiag] = useState<string[]>([]);
  const [showDiag, setShowDiag] = useState(false);
  const window = useWindowDimensions();
  // Device-aware: the Nomad (≈1404px wide) has far less room than the Manta
  // (≈1920px), so on the smaller screen we shrink chrome to free up the page.
  const compact = window.width < 1500;

  const resizeStart = useRef<CropRect | null>(null);
  const drawStart = useRef<{x: number; y: number} | null>(null);
  // E-ink can't keep up with a redraw per touch event; throttle live updates.
  const lastMoveAt = useRef(0);
  const DRAW_THROTTLE_MS = 80;

  const isNoteContext = /\.note$/i.test(currentPath);
  const isPdfContext = /\.pdf$/i.test(currentPath);

  const load = useCallback(async () => {
    setLoading(true);
    setBusy(false);
    setSaved(null);
    setMessage('');
    setStage('crop');
    setPage(null);
    setCrop(null);
    setTone('off');
    setClips([]);
    setScreenshots([]);
    setSelectedClip(null);
    setPendingDelete(false);
    setDiag([]);
    try {
      const pathRes = (await PluginCommAPI.getCurrentFilePath()) as any;
      const path = pathRes?.success && pathRes.result ? pathRes.result : '';
      setCurrentPath(path);

      const clip = await FrameClipNative.getLatestClip();
      setLatestClip(clip);

      if (/\.pdf$/i.test(path)) {
        const pageRes = (await PluginCommAPI.getCurrentPageNum()) as any;
        const pageNum =
          pageRes?.success && typeof pageRes.result === 'number' ? pageRes.result : 0;

        let pageCount = 0;
        try {
          const totalRes = (await PluginDocAPI.getCurrentTotalPages()) as any;
          if (totalRes?.success && typeof totalRes.result === 'number') {
            pageCount = totalRes.result;
          }
        } catch {}

        const {image, log} = await renderPage(path, pageNum, pageCount);
        setDiag(log);
        setPage(image);
        // Start with NO box: the user draws where they want, then fine-tunes
        // with the buttons. This removes the drag-to-move vs. drag-to-draw
        // responder conflict entirely (only the draw gesture lives on the page).
        setCrop(null);
        if (!image) {
          setMessage('Could not render this PDF page.\n' + log.join('\n'));
        }
      } else if (/\.note$/i.test(path)) {
        let list: ImageInfo[] = [];
        try {
          list = await FrameClipNative.listClips();
        } catch {}
        setClips(list);
        setSelectedClip(list[0] ?? null);
        setMessage(
          list.length
            ? 'Tap a clip below, then Insert it onto this page.'
            : 'No clips yet. Open a PDF, capture a region, then come back here.',
        );
      } else {
        // Not a PDF (correct render path) and not a note (insert path). This is
        // where EPUBs land: render-crop is impossible (reflowable, no fixed
        // page), so offer the screenshot route — crop an image out of a
        // screenshot of the page instead.
        const {shots, log} = await listScreenshots();
        setDiag(log);
        setScreenshots(shots);
        setMessage(
          shots.length
            ? 'Tap a screenshot to crop an image from it (e.g. a picture in an EPUB).'
            : `No screenshots found in ${SCREENSHOT_DIR}.\nTake a screenshot of the page, then tap Reload.`,
        );
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Drop the rendered page and any selection so a reopen can never show stale
  // content. Leaves a clean "tap Reload" screen if no auto-reload fires.
  const resetTransient = useCallback(() => {
    setBusy(false);
    setSaved(null);
    setStage('crop');
    setPage(null);
    setCrop(null);
    setTone('off');
    setClips([]);
    setScreenshots([]);
    setSelectedClip(null);
    setPendingDelete(false);
    setDiag([]);
    setMessage('Tap Reload to render the current page.');
    setLoading(false);
  }, []);

  // The plugin's JS context persists across open/close, so a plain mount effect
  // won't re-run when the panel is reopened. Re-render on onStart; on onStop,
  // clear state so the next open never shows the previous selection/image.
  useEffect(() => {
    const sub = PluginManager.addPluginLifeListener?.({
      onStart: () => {
        load();
      },
      onStop: () => {
        resetTransient();
      },
    });
    return () => {
      try {
        sub?.remove?.();
      } catch {}
    };
  }, [load, resetTransient]);

  // Backup reopen trigger: some Supernote builds don't deliver onStart when the
  // view is merely re-shown. Reload whenever the app returns to the foreground.
  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') {
        load();
      }
    });
    return () => {
      try {
        sub.remove();
      } catch {}
    };
  }, [load]);

  const display = useMemo(() => {
    if (!page) return {width: 1, height: 1, scale: 1};
    // Until the preview area's onLayout reports its real size, fall back to a
    // window-derived estimate. Without this the first render collapses to 1×1:
    // the page looks blank, and any crop drawn at scale 1 maps to a tiny slice
    // of the source (a "zoomed in" capture). onLayout then refines this.
    const boxW = previewBox.width > 1 ? previewBox.width : window.width - 12;
    const boxH = previewBox.height > 1 ? previewBox.height : window.height * 0.66;
    const scale = Math.min(boxW / page.width, boxH / page.height);
    return {
      width: Math.round(page.width * scale),
      height: Math.round(page.height * scale),
      scale,
    };
  }, [previewBox, page, window.width, window.height]);

  const frameStyle = useMemo(() => {
    if (!crop) return null;
    return {
      left: crop.left * display.scale,
      top: crop.top * display.scale,
      width: crop.width * display.scale,
      height: crop.height * display.scale,
    };
  }, [crop, display.scale]);

  const updateCrop = useCallback(
    (updater: (current: CropRect) => CropRect) => {
      setCrop(current => {
        if (!current || !page) return current;
        return clampCrop(updater(current), page);
      });
    },
    [page],
  );

  const moveBy = useCallback(
    (dx: number, dy: number) => {
      updateCrop(current => ({
        ...current,
        left: current.left + dx,
        top: current.top + dy,
      }));
    },
    [updateCrop],
  );

  const resizeBy = useCallback(
    (dw: number, dh: number) => {
      updateCrop(current => ({
        ...current,
        width: current.width + dw,
        height: current.height + dh,
      }));
    },
    [updateCrop],
  );

  const resizeResponder = useMemo(() => {
    const apply = (dx: number, dy: number) => {
      const start = resizeStart.current;
      if (!start || !page) return;
      setCrop(
        clampCrop(
          {
            ...start,
            width: start.width + dx / display.scale,
            height: start.height + dy / display.scale,
          },
          page,
        ),
      );
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        resizeStart.current = crop;
        lastMoveAt.current = 0;
      },
      onPanResponderMove: (_, gesture) => {
        const now = Date.now();
        if (now - lastMoveAt.current < DRAW_THROTTLE_MS) return;
        lastMoveAt.current = now;
        apply(gesture.dx, gesture.dy);
      },
      onPanResponderRelease: (_, gesture) => {
        apply(gesture.dx, gesture.dy); // exact final size
        resizeStart.current = null;
      },
    });
  }, [crop, display.scale, page]);

  // Drag anywhere on the page to draw (or redraw) the crop rectangle. With no
  // move layer competing for the touch, this is the only page gesture, so it
  // fires reliably wherever the pen lands. The corner handle still wins for
  // resize because it sits on top at that point.
  const drawResponder = useMemo(() => {
    const apply = (dx: number, dy: number) => {
      const start = drawStart.current;
      if (!start || !page) return;
      const ax = start.x;
      const ay = start.y;
      const bx = start.x + dx;
      const by = start.y + dy;
      setCrop(
        clampCrop(
          {
            left: Math.min(ax, bx) / display.scale,
            top: Math.min(ay, by) / display.scale,
            width: Math.abs(bx - ax) / display.scale,
            height: Math.abs(by - ay) / display.scale,
          },
          page,
        ),
      );
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: evt => {
        drawStart.current = {
          x: evt.nativeEvent.locationX,
          y: evt.nativeEvent.locationY,
        };
        lastMoveAt.current = 0;
      },
      onPanResponderMove: (_, gesture) => {
        if (!drawStart.current || !page) return;
        if (Math.abs(gesture.dx) + Math.abs(gesture.dy) < 6) return; // ignore taps
        const now = Date.now();
        if (now - lastMoveAt.current < DRAW_THROTTLE_MS) return;
        lastMoveAt.current = now;
        apply(gesture.dx, gesture.dy);
      },
      onPanResponderRelease: (_, gesture) => {
        apply(gesture.dx, gesture.dy); // exact final box
        drawStart.current = null;
      },
    });
  }, [display.scale, page]);

  // Re-render a different page of the same PDF without leaving the plugin, so a
  // multi-page document can be mined for several clips in one session. Clears the
  // crop (draw-first) since the old rectangle is meaningless on a new page.
  const renderAtPage = useCallback(
    async (pageNum: number) => {
      if (!page || busy) return;
      if (pageNum < 0 || pageNum >= page.pageCount) return;
      setBusy(true);
      setMessage('');
      try {
        const {image, log} = await renderPage(currentPath, pageNum, page.pageCount);
        setDiag(log);
        setCrop(null);
        if (image) {
          setPage(image);
        } else {
          setMessage('Could not render that page.\n' + log.join('\n'));
        }
      } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    },
    [busy, currentPath, page],
  );

  // Load a chosen screenshot into the crop UI as a single-page PageImage. The
  // crop pipeline (handleCapture/cropImage) reads page.path, so the screenshot
  // file becomes the crop source directly — no render step needed.
  const useScreenshot = useCallback(
    (shot: ImageInfo) => {
      if (busy) return;
      setPage({
        path: shot.path,
        uri: shot.uri,
        name: shot.name,
        width: shot.width,
        height: shot.height,
        pageIndex: 0,
        pageCount: 1,
      });
      setCrop(null);
      setStage('crop');
      setMessage('');
    },
    [busy],
  );

  const handleCapture = useCallback(async () => {
    if (!page || !crop || busy) return;
    const t = TONES.find(x => x.key === tone) ?? TONES[1];
    setBusy(true);
    setMessage('');
    try {
      const result = await FrameClipNative.cropImage(
        page.path,
        crop.left,
        crop.top,
        crop.width,
        crop.height,
        t.contrast,
        t.threshold,
        '',
      );
      setSaved(result);
      setLatestClip(result);
      setStage('saved');
      setMessage('Clip saved.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [busy, tone, crop, page]);

  // Re-derive the saved clip at a new tone. The source is the pristine page
  // render and we overwrite the same file (reusePath), so switching tones never
  // compounds and never leaves orphan files.
  const applyTone = useCallback(
    async (key: ToneKey) => {
      if (!page || !crop || !saved || busy || key === tone) return;
      const t = TONES.find(x => x.key === key);
      if (!t) return;
      setBusy(true);
      try {
        const result = await FrameClipNative.cropImage(
          page.path,
          crop.left,
          crop.top,
          crop.width,
          crop.height,
          t.contrast,
          t.threshold,
          saved.path,
        );
        setTone(key);
        // Same file path, so bust the Image cache to force a redraw of the preview.
        setSaved({...result, uri: `${result.uri}?v=${Date.now()}`});
        setLatestClip(result);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    },
    [busy, crop, page, saved, tone],
  );

  const insertPath = useCallback(
    async (path?: string) => {
      if (!path || busy) return;
      setBusy(true);
      setMessage('');
      try {
        const result = await PluginNoteAPI.insertImage(path);
        if ((result as any)?.success) {
          setMessage('Inserted into note.');
          setTimeout(() => PluginManager.closePluginView(), 450);
        } else {
          setMessage(
            (result as any)?.error?.message ?? 'Insert is only available from a note.',
          );
        }
      } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    },
    [busy],
  );

  // Two-tap delete from the gallery (first tap arms, second confirms), so a clip
  // can't vanish on a stray touch. Refreshes the list and reselects afterward.
  const handleDeleteSelected = useCallback(async () => {
    if (!selectedClip || busy) return;
    if (!pendingDelete) {
      setPendingDelete(true);
      return;
    }
    setBusy(true);
    try {
      await FrameClipNative.deleteClip(selectedClip.path);
      const list = await FrameClipNative.listClips();
      setClips(list);
      setSelectedClip(list[0] ?? null);
      setPendingDelete(false);
      setMessage(list.length ? 'Clip deleted.' : 'No clips left.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [busy, pendingDelete, selectedClip]);

  const close = useCallback(() => {
    resetTransient();
    PluginManager.closePluginView();
  }, [resetTransient]);

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="dark-content" />
      <View style={styles.header}>
        <Text style={styles.title}>FrameClip</Text>
        <Pressable style={styles.smallButton} onPress={close}>
          <Text style={styles.smallButtonText}>Close</Text>
        </Pressable>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#111" />
        </View>
      ) : !page ? (
        isNoteContext && clips.length > 0 ? (
          <View style={styles.galleryView}>
            <Text style={styles.message}>{message}</Text>
            <ScrollView contentContainerStyle={styles.galleryGrid}>
              {clips.map(clip => {
                const active = selectedClip?.path === clip.path;
                return (
                  <Pressable
                    key={clip.path}
                    style={[styles.thumb, active && styles.thumbSelected]}
                    onPress={() => {
                      setSelectedClip(clip);
                      setPendingDelete(false);
                    }}>
                    <Image
                      source={{uri: clip.uri}}
                      style={styles.thumbImage}
                      resizeMode="contain"
                    />
                  </Pressable>
                );
              })}
            </ScrollView>
            <View style={styles.galleryActions}>
              <Pressable
                style={[
                  styles.primaryButton,
                  (busy || !selectedClip) && styles.disabledButton,
                ]}
                disabled={busy || !selectedClip}
                onPress={() => insertPath(selectedClip?.path)}>
                <Text style={styles.primaryButtonText}>
                  {busy ? 'Inserting...' : 'Insert Selected'}
                </Text>
              </Pressable>
              <Pressable
                style={[
                  pendingDelete ? styles.dangerButton : styles.secondaryButton,
                  (busy || !selectedClip) && styles.disabledButton,
                ]}
                disabled={busy || !selectedClip}
                onPress={handleDeleteSelected}>
                <Text
                  style={
                    pendingDelete
                      ? styles.dangerButtonText
                      : styles.secondaryButtonText
                  }>
                  {pendingDelete ? 'Tap to confirm' : 'Delete'}
                </Text>
              </Pressable>
              <Pressable style={styles.secondaryButton} onPress={load}>
                <Text style={styles.secondaryButtonText}>Reload</Text>
              </Pressable>
            </View>
          </View>
        ) : screenshots.length > 0 ? (
          <View style={styles.galleryView}>
            <Text style={styles.message}>{message}</Text>
            <ScrollView contentContainerStyle={styles.galleryGrid}>
              {screenshots.map(shot => (
                <Pressable
                  key={shot.path}
                  style={styles.thumb}
                  disabled={busy}
                  onPress={() => useScreenshot(shot)}>
                  <Image
                    source={{uri: shot.uri}}
                    style={styles.thumbImage}
                    resizeMode="contain"
                  />
                </Pressable>
              ))}
            </ScrollView>
            <View style={styles.galleryActions}>
              <Pressable style={styles.secondaryButton} onPress={load}>
                <Text style={styles.secondaryButtonText}>Reload</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <View style={styles.center}>
            <Text style={styles.message}>{message}</Text>
            <Pressable style={styles.secondaryButton} onPress={load}>
              <Text style={styles.secondaryButtonText}>Reload</Text>
            </Pressable>
            {diag.length > 0 && (
              <Pressable onPress={() => setShowDiag(v => !v)}>
                <Text style={styles.diagToggle}>
                  {showDiag ? '▾ hide diagnostics' : '▸ diagnostics'}
                </Text>
              </Pressable>
            )}
            {showDiag && diag.length > 0 && (
              <View style={styles.diagBox}>
                {diag.map((line, i) => (
                  <Text key={i} style={styles.diagText}>
                    {line}
                  </Text>
                ))}
              </View>
            )}
          </View>
        )
      ) : (
        <>
          <View style={styles.metaRow}>
            <Text style={styles.meta} numberOfLines={1}>
              {page.name} — page {page.pageIndex + 1} of {page.pageCount} ({page.width}×
              {page.height})
            </Text>
            {stage === 'crop' && page.pageCount > 1 && (
              <>
                <Pressable
                  style={[
                    styles.pageNavButton,
                    (busy || page.pageIndex <= 0) && styles.disabledButton,
                  ]}
                  disabled={busy || page.pageIndex <= 0}
                  onPress={() => renderAtPage(page.pageIndex - 1)}>
                  <Text style={styles.pageNavText}>‹ Prev</Text>
                </Pressable>
                <Pressable
                  style={[
                    styles.pageNavButton,
                    (busy || page.pageIndex >= page.pageCount - 1) &&
                      styles.disabledButton,
                  ]}
                  disabled={busy || page.pageIndex >= page.pageCount - 1}
                  onPress={() => renderAtPage(page.pageIndex + 1)}>
                  <Text style={styles.pageNavText}>Next ›</Text>
                </Pressable>
              </>
            )}
          </View>

          {stage === 'crop' ? (
            <>
              <View
                style={[styles.previewArea, {margin: compact ? 4 : 8}]}
                onLayout={event => {
                  const {width, height} = event.nativeEvent.layout;
                  setPreviewBox({width, height});
                }}>
                <View
                  {...drawResponder.panHandlers}
                  style={[
                    styles.imageWrap,
                    {width: display.width, height: display.height},
                  ]}>
                  <Image
                    source={{uri: page.uri}}
                    style={styles.image}
                    resizeMode="contain"
                  />
                  {frameStyle && (
                    <>
                      <View
                        style={[
                          styles.frameLine,
                          styles.frameTop,
                          {
                            left: frameStyle.left,
                            top: frameStyle.top,
                            width: frameStyle.width,
                          },
                        ]}
                      />
                      <View
                        style={[
                          styles.frameLine,
                          styles.frameBottom,
                          {
                            left: frameStyle.left,
                            top: frameStyle.top + frameStyle.height,
                            width: frameStyle.width,
                          },
                        ]}
                      />
                      <View
                        style={[
                          styles.frameLine,
                          styles.frameLeft,
                          {
                            left: frameStyle.left,
                            top: frameStyle.top,
                            height: frameStyle.height,
                          },
                        ]}
                      />
                      <View
                        style={[
                          styles.frameLine,
                          styles.frameRight,
                          {
                            left: frameStyle.left + frameStyle.width,
                            top: frameStyle.top,
                            height: frameStyle.height,
                          },
                        ]}
                      />
                      <View
                        {...resizeResponder.panHandlers}
                        style={[
                          styles.resizeHandle,
                          {
                            left: frameStyle.left + frameStyle.width - 20,
                            top: frameStyle.top + frameStyle.height - 20,
                          },
                        ]}>
                        <Text style={styles.resizeHandleText}>⤡</Text>
                      </View>
                    </>
                  )}
                </View>
              </View>

              <View style={[styles.controls, compact && {gap: 5}]}>
                <Text style={[styles.hint, compact && {fontSize: 12}]}>
                  {crop
                    ? 'Drag the corner to resize · buttons to fine-tune · drag elsewhere to redraw.'
                    : 'Draw a box around the area to capture, then fine-tune with the buttons.'}
                </Text>
                <View style={styles.row}>
                  <Pressable
                    style={styles.controlButton}
                    onPress={() => moveBy(0, -MOVE_STEP)}>
                    <Text style={styles.controlText}>Up</Text>
                  </Pressable>
                  <Pressable
                    style={styles.controlButton}
                    onPress={() => moveBy(-MOVE_STEP, 0)}>
                    <Text style={styles.controlText}>Left</Text>
                  </Pressable>
                  <Pressable
                    style={styles.controlButton}
                    onPress={() => moveBy(MOVE_STEP, 0)}>
                    <Text style={styles.controlText}>Right</Text>
                  </Pressable>
                  <Pressable
                    style={styles.controlButton}
                    onPress={() => moveBy(0, MOVE_STEP)}>
                    <Text style={styles.controlText}>Down</Text>
                  </Pressable>
                </View>
                <View style={styles.row}>
                  <Pressable
                    style={styles.controlButton}
                    onPress={() => resizeBy(-SIZE_STEP, 0)}>
                    <Text style={styles.controlText}>Narrower</Text>
                  </Pressable>
                  <Pressable
                    style={styles.controlButton}
                    onPress={() => resizeBy(SIZE_STEP, 0)}>
                    <Text style={styles.controlText}>Wider</Text>
                  </Pressable>
                  <Pressable
                    style={styles.controlButton}
                    onPress={() => resizeBy(0, -SIZE_STEP)}>
                    <Text style={styles.controlText}>Shorter</Text>
                  </Pressable>
                  <Pressable
                    style={styles.controlButton}
                    onPress={() => resizeBy(0, SIZE_STEP)}>
                    <Text style={styles.controlText}>Taller</Text>
                  </Pressable>
                  <Pressable
                    style={styles.controlButton}
                    onPress={() => page && setCrop(defaultCrop(page))}>
                    <Text style={styles.controlText}>Reset</Text>
                  </Pressable>
                </View>
                <Pressable
                  style={[
                    styles.primaryButton,
                    (busy || !crop) && styles.disabledButton,
                  ]}
                  disabled={busy || !crop}
                  onPress={handleCapture}>
                  <Text style={styles.primaryButtonText}>
                    {busy ? 'Saving...' : !crop ? 'Draw a box first' : 'Capture Clip'}
                  </Text>
                </Pressable>
                {diag.length > 0 && (
                  <Pressable onPress={() => setShowDiag(v => !v)}>
                    <Text style={styles.diagToggle}>
                      {showDiag ? '▾ hide diagnostics' : '▸ diagnostics'}
                    </Text>
                  </Pressable>
                )}
                {showDiag && diag.length > 0 && (
                  <View style={styles.diagBox}>
                    {diag.map((line, i) => (
                      <Text key={i} style={styles.diagText}>
                        {line}
                      </Text>
                    ))}
                  </View>
                )}
              </View>
            </>
          ) : (
            <View style={styles.savedView}>
              {saved && (
                <Image
                  key={saved.uri}
                  source={{uri: saved.uri}}
                  style={styles.savedImage}
                  resizeMode="contain"
                />
              )}
              {saved && (
                <View style={styles.contrastRow}>
                  <Text style={styles.contrastLabel}>Tone</Text>
                  {TONES.map(t => (
                    <Pressable
                      key={t.key}
                      style={[
                        styles.contrastBox,
                        t.key === tone && styles.contrastBoxActive,
                      ]}
                      disabled={busy}
                      onPress={() => applyTone(t.key)}>
                      <Text
                        style={[
                          styles.contrastBoxText,
                          t.key === tone && styles.contrastBoxTextActive,
                        ]}>
                        {t.label}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              )}
              <Text style={styles.message}>
                Clip saved. Capture another region (or page), or open a note and
                insert your clips from the gallery.
              </Text>
              <View style={styles.row}>
                <Pressable
                  style={[styles.primaryButton, busy && styles.disabledButton]}
                  disabled={busy}
                  onPress={() => {
                    setStage('crop');
                    setCrop(null);
                  }}>
                  <Text style={styles.primaryButtonText}>Capture Another</Text>
                </Pressable>
                <Pressable style={styles.secondaryButton} onPress={close}>
                  <Text style={styles.secondaryButtonText}>Done</Text>
                </Pressable>
              </View>
            </View>
          )}

          {!!message && stage === 'crop' && (
            <Text style={styles.footerMessage}>{message}</Text>
          )}
        </>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#f7f7f4',
  },
  header: {
    minHeight: 58,
    paddingHorizontal: 18,
    borderBottomWidth: 1,
    borderBottomColor: '#d9d9d2',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: '#111',
  },
  smallButton: {
    minHeight: 38,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: '#222',
    justifyContent: 'center',
  },
  smallButtonText: {
    color: '#111',
    fontSize: 15,
    fontWeight: '600',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 18,
    padding: 28,
  },
  message: {
    color: '#222',
    fontSize: 16,
    lineHeight: 23,
    textAlign: 'center',
  },
  metaRow: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#deded8',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  meta: {
    flex: 1,
    fontSize: 13,
    color: '#555',
  },
  pageNavButton: {
    minHeight: 38,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: '#222',
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pageNavText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#111',
  },
  previewArea: {
    flex: 1,
    margin: 6,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#ecece7',
    borderWidth: 1,
    borderColor: '#d4d4cc',
  },
  imageWrap: {
    position: 'relative',
    overflow: 'hidden',
    backgroundColor: '#fff',
  },
  image: {
    width: '100%',
    height: '100%',
  },
  frameLine: {
    position: 'absolute',
    zIndex: 2,
    backgroundColor: '#111',
  },
  frameTop: {
    height: 3,
  },
  frameBottom: {
    height: 3,
  },
  frameLeft: {
    width: 3,
  },
  frameRight: {
    width: 3,
  },
  resizeHandle: {
    position: 'absolute',
    width: 40,
    height: 40,
    borderWidth: 3,
    borderColor: '#111',
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 3,
  },
  resizeHandleText: {
    fontSize: 18,
    fontWeight: '700',
    color: '#111',
  },
  diagToggle: {
    textAlign: 'center',
    color: '#777',
    fontSize: 12,
    paddingVertical: 2,
  },
  controls: {
    paddingHorizontal: 14,
    paddingBottom: 8,
    gap: 6,
  },
  hint: {
    textAlign: 'center',
    color: '#555',
    fontSize: 13,
  },
  diagBox: {
    marginTop: 4,
    padding: 8,
    backgroundColor: '#f0f0ea',
    borderWidth: 1,
    borderColor: '#d4d4cc',
  },
  diagText: {
    color: '#444',
    fontSize: 11,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  controlButton: {
    minWidth: 78,
    minHeight: 38,
    paddingHorizontal: 6,
    borderWidth: 1,
    borderColor: '#222',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
  },
  controlText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#111',
  },
  primaryButton: {
    minHeight: 44,
    minWidth: 150,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#111',
  },
  primaryButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  secondaryButton: {
    minHeight: 48,
    minWidth: 150,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#111',
    backgroundColor: '#fff',
  },
  secondaryButtonText: {
    color: '#111',
    fontSize: 16,
    fontWeight: '700',
  },
  disabledButton: {
    opacity: 0.5,
  },
  // Armed "confirm delete" state. On grayscale e-ink a color won't read, so we
  // flip to a filled button to make the armed state unmistakable.
  dangerButton: {
    minHeight: 48,
    minWidth: 150,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#111',
    borderWidth: 1,
    borderColor: '#111',
  },
  dangerButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  savedView: {
    flex: 1,
    padding: 18,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
  },
  savedImage: {
    width: '90%',
    height: '55%',
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#ddd',
  },
  contrastRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    flexWrap: 'wrap',
    gap: 6,
  },
  contrastLabel: {
    fontSize: 14,
    color: '#555',
    marginRight: 4,
  },
  contrastBox: {
    minWidth: 48,
    minHeight: 40,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: '#222',
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  contrastBoxActive: {
    backgroundColor: '#111',
  },
  contrastBoxText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#111',
  },
  contrastBoxTextActive: {
    color: '#fff',
  },
  galleryView: {
    flex: 1,
    padding: 14,
    gap: 12,
  },
  galleryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    justifyContent: 'center',
    paddingBottom: 8,
  },
  thumb: {
    width: 150,
    height: 150,
    borderWidth: 1,
    borderColor: '#cfcfc8',
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 4,
  },
  thumbSelected: {
    borderColor: '#111',
    borderWidth: 3,
  },
  thumbImage: {
    width: '100%',
    height: '100%',
  },
  galleryActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  footerMessage: {
    paddingHorizontal: 18,
    paddingBottom: 10,
    color: '#333',
    fontSize: 14,
    textAlign: 'center',
  },
});
