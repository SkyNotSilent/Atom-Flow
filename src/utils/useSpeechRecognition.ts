import { useState, useRef, useCallback, useEffect } from 'react';

const isSupported =
  typeof navigator !== 'undefined' &&
  typeof navigator.mediaDevices !== 'undefined' &&
  typeof navigator.mediaDevices.getUserMedia === 'function';

export function useSpeechRecognition() {
  const [isRecording, setIsRecording] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const isRecordingRef = useRef(false);

  const cleanup = useCallback(() => {
    isRecordingRef.current = false;
    setIsRecording(false);

    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (wsRef.current) {
      if (wsRef.current.readyState === WebSocket.OPEN) {
        try {
          wsRef.current.send(JSON.stringify({ type: 'stop' }));
        } catch { /* ignore */ }
      }
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  const startRecording = useCallback(async () => {
    if (!isSupported) return;

    setError(null);
    setTranscript('');

    // Get microphone access
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError('请允许麦克风权限');
      return;
    }
    streamRef.current = stream;

    // Connect WebSocket
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/api/asr`);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    let accumulatedText = '';

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.error) {
          setError(msg.error);
          return;
        }
        if (msg.text !== undefined) {
          // For result_type=single with show_utterances=true:
          // Each message contains the current utterance text
          // We accumulate definite utterances and show the latest interim
          if (msg.utterances && msg.utterances.length > 0) {
            const utterance = msg.utterances[msg.utterances.length - 1];
            if (utterance.definite) {
              accumulatedText += utterance.text;
              setTranscript(accumulatedText);
            } else {
              // Show accumulated + current interim
              setTranscript(accumulatedText + utterance.text);
            }
          } else if (msg.text) {
            setTranscript(msg.text);
          }
        }
      } catch { /* ignore non-JSON */ }
    };

    ws.onerror = () => {
      setError('语音识别连接失败');
      cleanup();
    };

    ws.onclose = () => {
      // Only cleanup if we're still supposed to be recording
      if (isRecordingRef.current) {
        cleanup();
      }
    };

    // Wait for WS to open before starting audio
    ws.onopen = () => {
      // Set up AudioContext to capture PCM at 16kHz
      const audioCtx = new AudioContext({ sampleRate: 16000 });
      audioCtxRef.current = audioCtx;

      const source = audioCtx.createMediaStreamSource(stream);
      // Buffer size 4096 at 16kHz ≈ 256ms chunks
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (e) => {
        if (!isRecordingRef.current || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

        const float32 = e.inputBuffer.getChannelData(0);
        // Convert Float32 [-1,1] to Int16
        const int16 = new Int16Array(float32.length);
        for (let i = 0; i < float32.length; i++) {
          const s = Math.max(-1, Math.min(1, float32[i]));
          int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        wsRef.current.send(int16.buffer);
      };

      source.connect(processor);
      processor.connect(audioCtx.destination);

      isRecordingRef.current = true;
      setIsRecording(true);
    };
  }, [cleanup]);

  const stopRecording = useCallback(() => {
    cleanup();
  }, [cleanup]);

  const resetTranscript = useCallback(() => {
    setTranscript('');
    setError(null);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      isRecordingRef.current = false;
      cleanup();
    };
  }, [cleanup]);

  return { isRecording, transcript, isSupported, error, startRecording, stopRecording, resetTranscript };
}
