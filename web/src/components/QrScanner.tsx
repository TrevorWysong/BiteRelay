// A camera viewfinder that reads QR codes: the platform's BarcodeDetector
// where there is one, jsQR (loaded only then) where there isn't. The camera
// runs while the viewfinder is mounted -- a React 19 ref callback starts it
// and its cleanup stops every track.
import { useCallback, useState } from "react";
import { CameraOff } from "lucide-react";

/// The slice of the Barcode Detection API this uses.
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}
declare global {
  interface Window {
    BarcodeDetector?: new (options: { formats: string[] }) => BarcodeDetectorLike;
  }
}

/// How often a frame is checked, at most.
const SCAN_INTERVAL_MS = 120;

/// `onScan` is called with each code read until the scanner unmounts; keep
/// it stable (`useCallback`), as a new one restarts the camera.
export function QrScanner({ onScan }: { onScan: (text: string) => void }) {
  const [problem, setProblem] = useState<string | null>(null);

  const viewfinder = useCallback(
    (node: HTMLVideoElement | null) => {
      if (!node) return;
      const video = node;
      let stopped = false;
      let stream: MediaStream | null = null;
      let timer = 0;
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d", { willReadFrequently: true });

      async function decoder(): Promise<(video: HTMLVideoElement) => Promise<string | null>> {
        if (window.BarcodeDetector) {
          const detector = new window.BarcodeDetector({ formats: ["qr_code"] });
          return async (frame) => (await detector.detect(frame))[0]?.rawValue ?? null;
        }
        const { default: jsQR } = await import("jsqr");
        return async (frame) => {
          if (!context || !frame.videoWidth) return null;
          // Downscaled: plenty for a code that fills the frame, and fast.
          const scale = Math.min(1, 640 / frame.videoWidth);
          canvas.width = Math.round(frame.videoWidth * scale);
          canvas.height = Math.round(frame.videoHeight * scale);
          context.drawImage(frame, 0, 0, canvas.width, canvas.height);
          const image = context.getImageData(0, 0, canvas.width, canvas.height);
          return jsQR(image.data, image.width, image.height, { inversionAttempts: "dontInvert" })?.data ?? null;
        };
      }

      async function start() {
        try {
          if (!navigator.mediaDevices?.getUserMedia) throw new Error("unsupported");
          stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
          if (stopped) return stream.getTracks().forEach((t) => t.stop());
          video.srcObject = stream;
          await video.play();
          const read = await decoder();
          const tick = async () => {
            if (stopped) return;
            if (video.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA) {
              const text = await read(video).catch(() => null);
              if (text && !stopped) onScan(text);
            }
            timer = window.setTimeout(tick, SCAN_INTERVAL_MS);
          };
          void tick();
        } catch (err) {
          if (stopped) return;
          const denied = err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "SecurityError");
          setProblem(denied ? "Camera access is off for Relay. Allow it in your settings, or type the code instead." : "This device's camera isn't available. Type the code instead.");
        }
      }
      void start();

      return () => {
        stopped = true;
        window.clearTimeout(timer);
        stream?.getTracks().forEach((t) => t.stop());
      };
    },
    [onScan],
  );

  if (problem) {
    return (
      <div className="flex aspect-square w-full flex-col items-center justify-center gap-3 rounded-3xl bg-ink-100 p-6 text-center dark:bg-ink-800">
        <CameraOff size={28} className="text-ink-400" />
        <p className="text-sm text-ink-600 dark:text-ink-300">{problem}</p>
      </div>
    );
  }
  return (
    <div className="relative aspect-square w-full overflow-hidden rounded-3xl bg-black">
      <video ref={viewfinder} muted playsInline className="h-full w-full object-cover" />
      {/* The target: four corners and a sweeping line. */}
      <div className="pointer-events-none absolute inset-[14%]">
        {["top-0 left-0 border-t-4 border-l-4 rounded-tl-2xl", "top-0 right-0 border-t-4 border-r-4 rounded-tr-2xl", "bottom-0 left-0 border-b-4 border-l-4 rounded-bl-2xl", "bottom-0 right-0 border-b-4 border-r-4 rounded-br-2xl"].map((corner) => (
          <span key={corner} className={`absolute h-10 w-10 border-white ${corner}`} />
        ))}
        <span className="absolute inset-x-3 top-1/2 h-0.5 animate-[scanline_2s_ease-in-out_infinite] rounded-full bg-relay-400 shadow-[0_0_12px_2px] shadow-relay-400/70" />
      </div>
      <p className="absolute inset-x-0 bottom-4 text-center text-xs font-semibold text-white/90 drop-shadow">Point at the code on the customer's screen</p>
    </div>
  );
}
