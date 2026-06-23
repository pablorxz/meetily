'use client';

import { useCallback, useEffect, useRef } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { useRecordingState } from '@/contexts/RecordingStateContext';

const RECORDING_PILL_LABEL = 'recording-pill';
const RECORDING_PILL_ROUTE = 'recording-pill.html';

export default function RecordingPillWindowManager() {
  const { isRecording } = useRecordingState();
  const pillWindowRef = useRef<WebviewWindow | null>(null);

  const getPillWindow = useCallback(async () => {
    const existing = await WebviewWindow.getByLabel(RECORDING_PILL_LABEL);

    if (existing) {
      pillWindowRef.current = existing;
      return existing;
    }

    const pillWindow = new WebviewWindow(RECORDING_PILL_LABEL, {
      url: RECORDING_PILL_ROUTE,
      title: 'Meetily recording controls',
      width: 238,
      height: 86,
      minWidth: 238,
      minHeight: 86,
      maxWidth: 238,
      maxHeight: 86,
      center: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      decorations: false,
      transparent: true,
      shadow: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      visible: false,
      focus: false,
    });

    pillWindowRef.current = pillWindow;
    return pillWindow;
  }, []);

  const showPillWindow = useCallback(async () => {
    try {
      const pillWindow = await getPillWindow();
      await pillWindow.setAlwaysOnTop(true);
      await pillWindow.show();
    } catch (error) {
      console.error('[RecordingPillWindowManager] Failed to show pill window:', error);
    }
  }, [getPillWindow]);

  const hidePillWindow = useCallback(async () => {
    try {
      const pillWindow = pillWindowRef.current ?? await WebviewWindow.getByLabel(RECORDING_PILL_LABEL);
      await pillWindow?.hide();
    } catch (error) {
      console.error('[RecordingPillWindowManager] Failed to hide pill window:', error);
    }
  }, []);

  useEffect(() => {
    if (!isRecording) {
      hidePillWindow();
      return;
    }

    showPillWindow();

    const mainWindow = getCurrentWindow();
    const intervalId = window.setInterval(async () => {
      try {
        if (await mainWindow.isMinimized()) {
          await showPillWindow();
        }
      } catch (error) {
        console.error('[RecordingPillWindowManager] Failed to inspect main window state:', error);
      }
    }, 700);

    return () => window.clearInterval(intervalId);
  }, [hidePillWindow, isRecording, showPillWindow]);

  return null;
}
