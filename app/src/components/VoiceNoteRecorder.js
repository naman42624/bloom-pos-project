import React, { useState, useRef, useEffect } from 'react';
import { Alert } from 'react-native';
import { useAudioRecorder, RecordingPresets, AudioModule } from 'expo-audio';
import { RecorderButton } from './VoiceNoteRecorder.shared';

const MAX_SECONDS_DEFAULT = 60;

export default function VoiceNoteRecorder({ onRecorded, maxSeconds = MAX_SECONDS_DEFAULT }) {
  const [isRecording, setIsRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef(null);
  const startTimeRef = useRef(null);
  const isRecordingRef = useRef(false);
  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);

  // Best-effort cleanup if the user navigates away mid-recording: stop the
  // timer so it doesn't keep firing against an unmounted component. We also
  // attempt to stop the recording session itself, but effects in React
  // clean up in declaration order, not reverse — so expo-audio's own
  // internal cleanup (registered inside useAudioRecorder(), called above)
  // already runs its release() on the native object BEFORE this effect's
  // cleanup runs. release() is presumed to already handle session teardown;
  // the stop() call below is just a defensive extra attempt on top of that,
  // and must never throw (a JSI-backed native object may reject use after
  // release, possibly synchronously) or it would crash the unmount.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (isRecordingRef.current) {
        try {
          audioRecorder.stop()?.catch?.(() => {});
        } catch {
          // already released by expo-audio's own internal cleanup — this
          // call is a defensive best-effort, not the primary teardown
          // mechanism.
        }
      }
    };
  }, [audioRecorder]);

  const stop = async () => {
    if (timerRef.current) clearInterval(timerRef.current);
    setIsRecording(false);
    isRecordingRef.current = false;
    const durationSeconds = Math.round((Date.now() - startTimeRef.current) / 1000);
    await audioRecorder.stop();
    if (audioRecorder.uri) onRecorded(audioRecorder.uri, durationSeconds);
  };

  const start = async () => {
    const { granted } = await AudioModule.requestRecordingPermissionsAsync();
    if (!granted) {
      Alert.alert('Microphone permission needed', 'Please allow microphone access to record a voice note.');
      return;
    }

    setElapsed(0);
    startTimeRef.current = Date.now();
    setIsRecording(true);
    isRecordingRef.current = true;
    timerRef.current = setInterval(() => {
      setElapsed((e) => {
        const next = e + 1;
        if (next >= maxSeconds) stop();
        return next;
      });
    }, 1000);
    await audioRecorder.prepareToRecordAsync();
    audioRecorder.record();
  };

  return <RecorderButton isRecording={isRecording} elapsed={elapsed} maxSeconds={maxSeconds} onPress={isRecording ? stop : start} />;
}
