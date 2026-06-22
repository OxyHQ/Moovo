import { useRef, useState } from "react";
import { Modal, View, Pressable, StyleSheet } from "react-native";
import {
  CameraView,
  useCameraPermissions,
  type BarcodeScanningResult,
  type BarcodeSettings,
} from "expo-camera";
import { X } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { decodeQrPayload, type ScanLeg } from "@/lib/job-codes";

/**
 * Full-screen QR scanner for proving a job leg.
 *
 * Renders an `expo-camera` `CameraView` restricted to QR barcodes (web uses
 * getUserMedia automatically). Each detected QR is parsed with
 * {@link decodeQrPayload}; a scan is accepted ONLY when it decodes AND its
 * embedded `jobId` + `leg` match the leg the courier is currently proving — a
 * mismatched or foreign QR shows an inline hint and keeps scanning. On a valid
 * match it fires `onScanned(code)` once (guarded against duplicate frames) and
 * the parent closes the scanner.
 */

interface QrScannerProps {
  /** Whether the scanner overlay is shown. */
  visible: boolean;
  /** The job the courier is proving (the scanned QR must match this id). */
  jobId: string;
  /** The leg being proved (the scanned QR must match this leg). */
  leg: ScanLeg;
  /** Fired once with the plaintext code when a matching QR is scanned. */
  onScanned: (code: string) => void;
  /** Fired when the courier dismisses the scanner without scanning. */
  onClose: () => void;
}

/** The QR barcode types the camera should detect. */
const BARCODE_SETTINGS: BarcodeSettings = { barcodeTypes: ["qr"] };

export function QrScanner({ visible, jobId, leg, onScanned, onClose }: QrScannerProps) {
  const [permission, requestPermission] = useCameraPermissions();
  const [hint, setHint] = useState<string | null>(null);

  // Guard against the camera firing the same QR across several frames before the
  // parent unmounts the scanner.
  const handledRef = useRef(false);

  const legLabel = leg === "pickup" ? "pickup" : "delivery";

  const handleScanned = (result: BarcodeScanningResult) => {
    if (handledRef.current) return;
    const decoded = decodeQrPayload(result.data);
    if (!decoded) {
      setHint("That QR isn't a Moovo job code.");
      return;
    }
    if (decoded.jobId !== jobId || decoded.leg !== leg) {
      setHint("This QR is for a different job or leg.");
      return;
    }
    handledRef.current = true;
    onScanned(decoded.code);
  };

  const handleClose = () => {
    handledRef.current = false;
    setHint(null);
    onClose();
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={handleClose}>
      <View className="flex-1 bg-black">
        {permission?.granted ? (
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={BARCODE_SETTINGS}
            onBarcodeScanned={handleScanned}
          />
        ) : (
          <View className="flex-1 items-center justify-center gap-4 px-8">
            <Text className="text-center text-base text-white">
              {permission?.canAskAgain === false
                ? "Camera access is blocked. Enable it in settings to scan QR codes."
                : "Moovo Go needs camera access to scan the QR code."}
            </Text>
            {permission?.canAskAgain !== false ? (
              <Button onPress={requestPermission}>
                <Text className="font-semibold text-primary-foreground">
                  Allow camera
                </Text>
              </Button>
            ) : null}
          </View>
        )}

        {/* Framing guide + instruction overlay (pointer-events pass through to
            the camera; only the close button + retry are interactive). */}
        <View pointerEvents="box-none" className="absolute inset-0 items-center justify-center">
          <View className="h-64 w-64 rounded-3xl border-2 border-white/80" />
          <Text className="mt-6 px-8 text-center text-base font-medium text-white">
            Scan the {legLabel} QR code
          </Text>
          {hint ? (
            <Text className="mt-2 px-8 text-center text-sm text-amber-300">{hint}</Text>
          ) : null}
        </View>

        <Pressable
          onPress={handleClose}
          accessibilityRole="button"
          accessibilityLabel="Close scanner"
          className="absolute right-5 top-14 h-11 w-11 items-center justify-center rounded-full bg-black/50"
        >
          {/* The scanner surface is always a dark camera feed, so the close
              glyph is always white regardless of the app theme. */}
          <X size={24} color="#ffffff" />
        </Pressable>
      </View>
    </Modal>
  );
}
