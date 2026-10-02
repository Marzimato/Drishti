/**
 * Browser platform helpers: camera, location, and image encoding.
 *
 * Kept apart from React and from the measurement core so the core stays testable
 * in plain Node, and so the places that depend on device capabilities are all in
 * one file.
 */

import type { RgbaImage } from '../../core/vision/image';
import type { GeoFix } from '../../core/record/record';

/* -------------------------------------------------------------------- camera */

export interface CameraHandle {
  stream: MediaStream;
  track: MediaStreamTrack;
  /** What the browser actually granted, which is often not what was requested. */
  settings: MediaTrackSettings;
  stop: () => void;
}

export function cameraSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}

/**
 * Opens the rear camera at the highest resolution the device will give us.
 *
 * Resolution matters here: the reference patches are ~12 x 7 mm, and the more
 * pixels land on each one the better the averaging beats sensor noise.
 *
 * We keep auto-exposure and auto-white-balance ON (continuous). An earlier version
 * forced them to 'manual' on the theory that auto-white-balance fights the colour
 * cast the card exists to measure. That was a mistake in practice: setting
 * exposureMode to 'manual' without also supplying an exposure time or ISO leaves
 * the camera frozen at a driver default — on several phones a short, dark one — so
 * the preview came in badly underexposed with no auto-metering to recover it. The
 * card-based colour correction already removes the white-balance cast
 * mathematically, so there is nothing to gain by crippling the camera's exposure to
 * do it optically. Correct exposure matters far more: a dark frame loses real
 * signal that no amount of correction can recover.
 */
export async function startCamera(): Promise<CameraHandle> {
  if (!cameraSupported()) {
    throw new Error(
      'This browser cannot access the camera. Use a recent Chrome, Edge or Safari over HTTPS.',
    );
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 2560 },
      height: { ideal: 1440 },
    },
    audio: false,
  });

  const track = stream.getVideoTracks()[0];
  if (!track) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error('The camera provided no video track.');
  }

  await preferContinuousProcessing(track);

  return {
    stream,
    track,
    settings: track.getSettings(),
    stop: () => stream.getTracks().forEach((t) => t.stop()),
  };
}

/**
 * Nudges exposure, white balance and focus to their *continuous* (auto) modes.
 *
 * This is a no-op on most devices, which already default to continuous — it exists
 * only to undo a previous mistake on any device that might otherwise linger in a
 * manual mode, and to prefer continuous focus so the card stays sharp as the phone
 * is moved. Never forces 'manual': doing so without an accompanying value is what
 * caused the dark-frame bug. Best-effort, never throws.
 */
async function preferContinuousProcessing(track: MediaStreamTrack): Promise<void> {
  try {
    const capabilities = track.getCapabilities?.() as
      | { exposureMode?: string[]; whiteBalanceMode?: string[]; focusMode?: string[] }
      | undefined;
    if (!capabilities) return;

    const advanced: Record<string, unknown>[] = [];
    if (capabilities.exposureMode?.includes('continuous')) {
      advanced.push({ exposureMode: 'continuous' });
    }
    if (capabilities.whiteBalanceMode?.includes('continuous')) {
      advanced.push({ whiteBalanceMode: 'continuous' });
    }
    if (capabilities.focusMode?.includes('continuous')) {
      advanced.push({ focusMode: 'continuous' });
    }
    if (advanced.length === 0) return;

    await track.applyConstraints({ advanced } as MediaTrackConstraints);
  } catch {
    // Unsupported on this device. The camera keeps its own defaults, which is fine.
  }
}

/* ------------------------------------------------------------- frame capture */

export interface CapturedFrame {
  image: RgbaImage;
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
}

/** Copies the current video frame into a canvas and extracts its pixels. */
export function grabFrame(video: HTMLVideoElement): CapturedFrame {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) {
    throw new Error('The camera has not produced a frame yet. Wait a moment and try again.');
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Could not obtain a 2D drawing context.');

  context.drawImage(video, 0, 0, width, height);
  const imageData = context.getImageData(0, 0, width, height);

  return {
    image: { width, height, data: imageData.data },
    canvas,
    width,
    height,
  };
}

/** Loads a user-selected image file, for testing without a camera. */
export async function loadImageFile(file: File): Promise<CapturedFrame> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Could not obtain a 2D drawing context.');
  context.drawImage(bitmap, 0, 0);
  bitmap.close();

  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  return {
    image: { width: canvas.width, height: canvas.height, data: imageData.data },
    canvas,
    width: canvas.width,
    height: canvas.height,
  };
}

export interface EncodedImage {
  blob: Blob;
  bytes: Uint8Array;
  mimeType: string;
  width: number;
  height: number;
}

/**
 * Encodes a canvas to bytes.
 *
 * The hash stored in the record is taken over *these* bytes, the ones actually
 * retained, so the digest always matches the artefact a reviewer can open. Hashing
 * the raw sensor pixels instead would produce a digest nobody could reproduce from
 * the stored file.
 */
export async function encodeCanvas(
  canvas: HTMLCanvasElement,
  mimeType = 'image/jpeg',
  quality = 0.92,
): Promise<EncodedImage> {
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, mimeType, quality),
  );
  if (!blob) throw new Error('Could not encode the captured image.');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { blob, bytes, mimeType, width: canvas.width, height: canvas.height };
}

/** Draws an RgbaImage into a fresh canvas, for the rectified card view. */
export function rgbaImageToCanvas(image: RgbaImage): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not obtain a 2D drawing context.');
  const data = new Uint8ClampedArray(image.data);
  context.putImageData(new ImageData(data, image.width, image.height), 0, 0);
  return canvas;
}

/* ------------------------------------------------------------------ location */

export interface LocationOutcome {
  fix: GeoFix | null;
  unavailableReason?: string;
}

/**
 * Requests a single position fix.
 *
 * Failure is a normal outcome, not an error: basements, vehicles and denied
 * permissions all happen. The reason is recorded in the signed record so the log
 * shows *why* a location is missing rather than leaving a silent blank.
 */
export async function getLocation(timeoutMs = 10000): Promise<LocationOutcome> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    return { fix: null, unavailableReason: 'This device does not provide location services.' };
  }

  return new Promise<LocationOutcome>((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        resolve({
          fix: {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracyMetres: position.coords.accuracy,
            altitudeMetres: position.coords.altitude ?? null,
            fixedAt: new Date(position.timestamp).toISOString(),
          },
        });
      },
      (error) => {
        const reasons: Record<number, string> = {
          1: 'Location permission was denied.',
          2: 'No position could be determined at this location.',
          3: 'Locating the device timed out.',
        };
        resolve({
          fix: null,
          unavailableReason: reasons[error.code] ?? `Location unavailable: ${error.message}`,
        });
      },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 },
    );
  });
}

/* --------------------------------------------------------------------- misc */

export function downloadText(filename: string, contents: string, mimeType = 'text/plain'): void {
  const blob = new Blob([contents], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function platformLabel(): string {
  if (typeof navigator === 'undefined') return 'unknown';
  return navigator.userAgent.slice(0, 120);
}

export function isSecureContextOk(): boolean {
  if (typeof window === 'undefined') return false;
  return window.isSecureContext;
}
