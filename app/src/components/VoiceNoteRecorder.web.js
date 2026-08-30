import React, { useState, useRef, useEffect } from 'react';
import { RecorderButton } from './VoiceNoteRecorder.shared';

const MAX_SECONDS_DEFAULT = 60;

export default function VoiceNoteRecorder({ onRecorded, maxSeconds = MAX_SECONDS_DEFAULT }) {
  const [isRecording, setIsRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef(null);
  const startTimeRef = useRef(null);
  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const isRecordingRef = useRef(false);

  // Best-effort cleanup if the user navigates away mid-recording: stop the
  // timer and the recording session itself (not just the visible timer), so
  // the mic isn't left active after the component is gone. We skip calling
  // onRecorded here — nobody is listening for it anymore since the
  // component is unmounting — and stop the media stream tracks ourselves
  // since that normally happens inside the (now-skipped) onstop handler.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (isRecordingRef.current && recorderRef.current) {
        recorderRef.current.onstop = null;
        try {
          recorderRef.current.stop();
        } catch (e) {
          // already stopped/inactive — nothing to do
        }
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  const stop = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    setIsRecording(false);
    isRecordingRef.current = false;
    if (recorderRef.current) recorderRef.current.stop();
  };

  const start = async () => {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      window.alert('Please allow microphone access to record a voice note.');
      return;
    }
    streamRef.current = stream;

    const recorder = new MediaRecorder(stream);
    const chunks = [];
    recorder.ondataavailable = (e) => chunks.push(e.data);
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: 'audio/webm' });
      const url = URL.createObjectURL(blob);
      const durationSeconds = Math.round((Date.now() - startTimeRef.current) / 1000);
      onRecorded(url, durationSeconds);
      stream.getTracks().forEach((t) => t.stop());
    };
    recorderRef.current = recorder;

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
    recorder.start();
  };

  return <RecorderButton isRecording={isRecording} elapsed={elapsed} maxSeconds={maxSeconds} onPress={isRecording ? stop : start} />;
}
