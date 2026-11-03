// Native (iOS/Android app) QR scanner. Same props and behaviour as the web
// ProductScanner.js: continuous camera, same-code cooldown, buzz on accept,
// never calls the API. expo-camera does the decoding.
//
// <ProductScanner onCode={(raw) => void} paused={bool} />
//   paused unmounts the CameraView, which releases the camera.
import React, { useEffect, useRef, useState } from 'react';
import { View, StyleSheet, Linking } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { createScanCooldown, SCANNER_COPY } from './scanCooldown';
import { playAcceptFeedback } from './scanFeedback';
import ScannerMessage from './ScannerMessage';
import ScannerFrame from './ScannerFrame';
import { Colors } from '../../constants/theme';

const SCANNER_SETTINGS = { barcodeTypes: ['qr'] };

export default function ProductScanner({ onCode, paused = false, children, style }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [torchOn, setTorchOn] = useState(false);
  const onCodeRef = useRef(onCode);
  onCodeRef.current = onCode;
  const cooldownRef = useRef(null);
  if (!cooldownRef.current) cooldownRef.current = createScanCooldown();
  const askedRef = useRef(false);

  // First visit: ask straight away instead of showing a button first.
  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain && !askedRef.current) {
      askedRef.current = true;
      requestPermission();
    }
  }, [permission, requestPermission]);

  useEffect(() => {
    if (paused) setTorchOn(false);
    else cooldownRef.current.hold();
  }, [paused]);

  const retry = async () => {
    const res = await requestPermission();
    if (res && !res.granted && !res.canAskAgain) {
      try { await Linking.openSettings(); } catch (e) { /* no settings link */ }
    }
  };

  const handleScanned = ({ data }) => {
    if (paused) return;
    if (cooldownRef.current.accept(typeof data === 'string' ? data : '')) {
      playAcceptFeedback();
      if (onCodeRef.current) onCodeRef.current(data);
    }
  };

  let body = null;
  if (!permission) {
    body = <ScannerMessage loading text={SCANNER_COPY.starting} />;
  } else if (!permission.granted) {
    body = <ScannerMessage icon="lock-closed-outline" text={SCANNER_COPY.blockedNative} onRetry={retry} />;
  } else if (!paused) {
    body = (
      <>
        <CameraView
          style={StyleSheet.absoluteFillObject}
          facing="back"
          enableTorch={torchOn}
          barcodeScannerSettings={SCANNER_SETTINGS}
          onBarcodeScanned={handleScanned}
        />
        <ScannerFrame showTorch torchOn={torchOn} onToggleTorch={() => setTorchOn((v) => !v)} />
      </>
    );
  }

  return (
    <View style={[styles.container, style]}>
      {body}
      {permission && permission.granted ? children : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.black, overflow: 'hidden' },
});
