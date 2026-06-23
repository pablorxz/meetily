'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { appDataDir } from '@tauri-apps/api/path';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { Pause, Play, Square } from 'lucide-react';
import { useRecordingState } from '@/contexts/RecordingStateContext';

const BAR_COUNT = 6;

interface AudioLevelData {
  rms_level: number;
  peak_level: number;
}

interface AudioLevelUpdate {
  levels: AudioLevelData[];
}

function buildBarLevels(seed: number) {
  return Array.from({ length: BAR_COUNT }, (_, index) => {
    const wave = Math.sin(seed * (0.9 + index * 0.11) + index * 1.35);
    const secondary = Math.sin(seed * 0.37 + index * 0.73);
    return 0.22 + Math.abs(wave) * 0.58 + Math.max(0, secondary) * 0.2;
  });
}

function buildAudioBarLevels(rmsLevel: number, peakLevel: number) {
  const rms = Math.max(0, Math.min(1, rmsLevel));
  const peak = Math.max(rms, Math.min(1, peakLevel));
  const level = Math.max(0.12, Math.min(1, rms * 2.7 + peak * 0.35));

  return Array.from({ length: BAR_COUNT }, (_, index) => {
    const emphasis = index === 2 || index === 3 ? 1 : 0.72;
    const taper = index === 0 || index === 5 ? 0.58 : emphasis;
    const motion = 0.82 + Math.sin(Date.now() / 125 + index * 0.9) * 0.18;
    return Math.max(0.16, Math.min(1, level * taper * motion));
  });
}

export default function RecordingPillPage() {
  const { isRecording, isPaused, isStopping } = useRecordingState();
  const [bars, setBars] = useState(() => buildBarLevels(0.4));
  const [isBusy, setIsBusy] = useState(false);
  const [hasRecentAudioLevels, setHasRecentAudioLevels] = useState(false);

  const isDisabled = isBusy || isStopping || !isRecording;

  const quietBars = useMemo(() => (
    [0.22, 0.34, 0.26, 0.4, 0.28, 0.32]
  ), []);

  useEffect(() => {
    if (!isRecording || isPaused) {
      setBars(quietBars);
      setHasRecentAudioLevels(false);
      return;
    }

    const intervalId = window.setInterval(() => {
      if (hasRecentAudioLevels) {
        setHasRecentAudioLevels(false);
        return;
      }

      setBars(buildBarLevels(Date.now() / 230));
    }, 110);

    return () => window.clearInterval(intervalId);
  }, [hasRecentAudioLevels, isPaused, isRecording, quietBars]);

  useEffect(() => {
    const currentWindow = getCurrentWindow();
    const currentWebview = getCurrentWebview();

    currentWindow.setShadow(false).catch((error) => {
      console.error('[RecordingPill] Failed to disable window shadow:', error);
    });

    currentWebview.setBackgroundColor(null).catch((error) => {
      console.error('[RecordingPill] Failed to set transparent background:', error);
    });

    let unlisten: (() => void) | undefined;

    listen<AudioLevelUpdate>('audio-levels', (event) => {
      if (!isRecording || isPaused) return;

      const levels = event.payload.levels ?? [];
      if (!levels.length) return;

      const loudest = levels.reduce((best, current) => (
        current.peak_level > best.peak_level ? current : best
      ), levels[0]);

      setHasRecentAudioLevels(true);
      setBars(buildAudioBarLevels(loudest.rms_level, loudest.peak_level));
    }).then((listener) => {
      unlisten = listener;
    }).catch((error) => {
      console.error('[RecordingPill] Failed to listen for audio levels:', error);
    });

    return () => {
      unlisten?.();
    };
  }, [isPaused, isRecording]);

  const startDragging = useCallback(async () => {
    try {
      await getCurrentWindow().startDragging();
    } catch (error) {
      console.error('[RecordingPill] Failed to drag window:', error);
    }
  }, []);

  const restoreMainWindow = useCallback(async () => {
    const mainWindow = await WebviewWindow.getByLabel('main');
    const pillWindow = getCurrentWindow();

    try {
      if (mainWindow) {
        await mainWindow.show();

        if (await mainWindow.isMinimized()) {
          await mainWindow.unminimize();
        }

        await mainWindow.setFocus();
      }

      await pillWindow.hide();
    } catch (error) {
      console.error('[RecordingPill] Failed to restore main window:', error);
    }
  }, []);

  const togglePause = useCallback(async () => {
    if (isDisabled) return;

    setIsBusy(true);
    try {
      await invoke(isPaused ? 'resume_recording' : 'pause_recording');
    } catch (error) {
      console.error('[RecordingPill] Failed to toggle pause:', error);
    } finally {
      setIsBusy(false);
    }
  }, [isDisabled, isPaused]);

  const stopRecording = useCallback(async () => {
    if (isDisabled) return;

    setIsBusy(true);
    try {
      await restoreMainWindow();
      await new Promise(resolve => window.setTimeout(resolve, 250));

      const dataDir = await appDataDir();
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const savePath = `${dataDir}/recording-${timestamp}.wav`;

      await invoke('stop_recording', {
        args: {
          save_path: savePath,
        },
      });
      await emit('recording-stop-complete', true);
    } catch (error) {
      console.error('[RecordingPill] Failed to stop recording:', error);
    } finally {
      setIsBusy(false);
    }
  }, [isDisabled, restoreMainWindow]);

  return (
    <div className="flex h-screen w-screen items-center justify-center overflow-hidden bg-transparent">
      <div className="flex h-14 w-[200px] select-none items-center rounded-full border border-gray-200 bg-white pl-3 pr-2 shadow-[0_10px_24px_rgba(15,23,42,0.18)]">
        <button
          type="button"
          data-tauri-drag-region
          aria-label="Move recording controls"
          title="Drag to move"
          onMouseDown={(event) => {
            if (event.button === 0) {
              startDragging();
            }
          }}
          onDoubleClick={restoreMainWindow}
          className="mr-2 grid h-8 w-4 shrink-0 cursor-grab grid-cols-2 place-items-center gap-x-0.5 gap-y-1 rounded-full active:cursor-grabbing"
        >
          {Array.from({ length: 6 }).map((_, index) => (
            <span key={index} className="h-1 w-1 rounded-full bg-gray-300" />
          ))}
        </button>

        <button
          type="button"
          aria-label={isPaused ? 'Resume recording' : 'Pause recording'}
          title={isPaused ? 'Resume recording' : 'Pause recording'}
          disabled={isDisabled}
          onClick={togglePause}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-[3px] border-gray-300 bg-white text-gray-600 transition-colors hover:border-gray-400 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-55"
        >
          {isPaused ? <Play size={16} fill="currentColor" /> : <Pause size={17} strokeWidth={2.7} />}
        </button>

        <button
          type="button"
          aria-label="Stop recording"
          title="Stop recording"
          disabled={isDisabled}
          onClick={stopRecording}
          className="ml-2.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-500 text-white transition-colors hover:bg-red-600 disabled:cursor-not-allowed disabled:bg-red-300"
        >
          <Square size={17} fill="currentColor" strokeWidth={2.2} />
        </button>

        <div className="ml-3 mr-1 flex h-9 w-[48px] shrink-0 items-center justify-between pr-1.5" aria-hidden="true">
          {bars.map((level, index) => (
            <span
              key={index}
              className={`w-1.5 rounded-full transition-all duration-150 ${isPaused ? 'bg-red-300' : 'bg-red-500'}`}
              style={{
                height: `${Math.round(8 + level * 24)}px`,
                opacity: isPaused ? 0.65 : 1,
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
