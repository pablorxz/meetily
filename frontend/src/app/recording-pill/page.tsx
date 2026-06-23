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
  frequency_bands?: number[];
}

interface AudioLevelUpdate {
  levels: AudioLevelData[];
  frequency_bands?: number[];
}

function formatElapsedTime(seconds: number) {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
  }

  return `${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
}

function normalizeFrequencyBands(bands?: number[]) {
  if (!bands || bands.length < BAR_COUNT) return null;

  return Array.from({ length: BAR_COUNT }, (_, index) => (
    Math.max(0, Math.min(1, bands[index] ?? 0))
  ));
}

function buildLevelFallbackBands(rmsLevel: number, peakLevel: number) {
  const rms = Math.max(0, Math.min(1, rmsLevel));
  const peak = Math.max(rms, Math.min(1, peakLevel));
  const level = Math.max(0.12, Math.min(1, rms * 2.7 + peak * 0.35));

  return Array.from({ length: BAR_COUNT }, (_, index) => {
    const emphasis = index === 2 || index === 3 ? 1 : 0.72;
    const taper = index === 0 || index === 5 ? 0.58 : emphasis;
    return Math.max(0.12, Math.min(1, level * taper));
  });
}

function combineFrequencyBands(levels: AudioLevelData[]) {
  const combined = Array.from({ length: BAR_COUNT }, () => 0);
  let foundBands = false;

  for (const level of levels) {
    const bands = normalizeFrequencyBands(level.frequency_bands);
    if (!bands) continue;

    foundBands = true;
    for (let index = 0; index < BAR_COUNT; index += 1) {
      combined[index] = Math.sqrt(combined[index] ** 2 + bands[index] ** 2);
    }
  }

  if (!foundBands) return null;

  return combined.map(level => Math.max(0, Math.min(1, level)));
}

function smoothBarLevels(previous: number[], next: number[]) {
  return next.map((level, index) => {
    const current = previous[index] ?? 0;
    const attack = level > current ? 0.7 : 0.32;
    return current * (1 - attack) + level * attack;
  });
}

export default function RecordingPillPage() {
  const {
    activeDuration,
    isProcessing,
    isRecording,
    isPaused,
    isSaving,
    isStopping,
    recordingDuration,
  } = useRecordingState();
  const [bars, setBars] = useState(() => Array.from({ length: BAR_COUNT }, () => 0.12));
  const [isBusy, setIsBusy] = useState(false);
  const [isStopRequested, setIsStopRequested] = useState(false);

  const isDisabled = isBusy || isStopping || !isRecording;
  const isFinalizing = isStopRequested || isStopping || isProcessing || isSaving;
  const elapsedText = isFinalizing ? 'saving' : formatElapsedTime(recordingDuration ?? activeDuration ?? 0);

  const quietBars = useMemo(() => (
    [0.1, 0.12, 0.1, 0.13, 0.11, 0.1]
  ), []);

  useEffect(() => {
    if (!isRecording || isPaused) {
      setBars(quietBars);
      return;
    }

    const intervalId = window.setInterval(() => {
      setBars(previous => previous.map((level, index) => {
        const floor = quietBars[index] ?? 0.1;
        return Math.max(floor, level * 0.78);
      }));
    }, 110);

    return () => window.clearInterval(intervalId);
  }, [isPaused, isRecording, quietBars]);

  useEffect(() => {
    if (!isRecording && !isStopping && !isProcessing && !isSaving && !isBusy) {
      setIsStopRequested(false);
    }
  }, [isBusy, isProcessing, isRecording, isSaving, isStopping]);

  useEffect(() => {
    const currentWindow = getCurrentWindow();
    const currentWebview = getCurrentWebview();

    currentWindow.setShadow(false).catch((error) => {
      console.error('[RecordingPill] Failed to disable window shadow:', error);
    });

    currentWindow.setBackgroundColor([0, 0, 0, 0]).catch((error) => {
      console.error('[RecordingPill] Failed to set transparent window background:', error);
    });

    currentWebview.setBackgroundColor([0, 0, 0, 0]).catch((error) => {
      console.error('[RecordingPill] Failed to set transparent webview background:', error);
    });

    let unlisten: (() => void) | undefined;

    listen<AudioLevelUpdate>('audio-levels', (event) => {
      if (!isRecording || isPaused) return;

      const levels = event.payload.levels ?? [];
      const rootBands = normalizeFrequencyBands(event.payload.frequency_bands);
      const levelBands = rootBands ?? combineFrequencyBands(levels);

      if (levelBands) {
        setBars(previous => smoothBarLevels(previous, levelBands));
        return;
      }

      if (!levels.length) return;

      const loudest = levels.reduce((best, current) => (
        current.peak_level > best.peak_level ? current : best
      ), levels[0]);
      setBars(previous => smoothBarLevels(
        previous,
        buildLevelFallbackBands(loudest.rms_level, loudest.peak_level),
      ));
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
    setIsStopRequested(true);
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
      setIsStopRequested(false);
    } finally {
      setIsBusy(false);
    }
  }, [isDisabled, restoreMainWindow]);

  return (
    <div className="h-screen w-screen overflow-hidden rounded-full bg-transparent p-px">
      <div className="flex h-full w-full select-none items-center rounded-full border border-gray-300 bg-white bg-clip-padding pl-2 pr-1.5 shadow-none">
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
          className="mr-1.5 grid h-7 w-3 shrink-0 cursor-grab grid-cols-2 place-items-center gap-x-0.5 gap-y-0.5 rounded-full active:cursor-grabbing"
        >
          {Array.from({ length: 6 }).map((_, index) => (
            <span key={index} className="h-[3px] w-[3px] rounded-full bg-gray-300" />
          ))}
        </button>

        <button
          type="button"
          aria-label={isPaused ? 'Resume recording' : 'Pause recording'}
          title={isPaused ? 'Resume recording' : 'Pause recording'}
          disabled={isDisabled}
          onClick={togglePause}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-[2.5px] border-gray-300 bg-white text-gray-600 transition-colors hover:border-gray-400 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-55"
        >
          {isPaused ? <Play size={11} fill="currentColor" /> : <Pause size={12} strokeWidth={2.8} />}
        </button>

        <button
          type="button"
          aria-label="Stop recording"
          title="Stop recording"
          disabled={isDisabled}
          onClick={stopRecording}
          className="ml-1.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-red-500 text-white transition-colors hover:bg-red-600 disabled:cursor-not-allowed disabled:bg-red-300"
        >
          <Square size={12} fill="currentColor" strokeWidth={2.3} />
        </button>

        <div className="ml-2 flex h-8 w-9 shrink-0 flex-col items-center justify-center gap-0.5 pr-1" aria-label={`Elapsed recording time ${elapsedText}`}>
          <div className="flex h-5 w-full items-center justify-between" aria-hidden="true">
            {bars.map((level, index) => (
              <span
                key={index}
                className={`w-[3px] rounded-full transition-all duration-150 ${isPaused ? 'bg-red-300' : 'bg-red-500'}`}
                style={{
                  height: `${Math.round(5 + level * 15)}px`,
                  opacity: isPaused ? 0.65 : 1,
                }}
              />
            ))}
          </div>
          <span className="w-full text-center font-mono text-[9px] leading-none text-gray-500 tabular-nums">
            {elapsedText}
          </span>
        </div>
      </div>
    </div>
  );
}
