'use client';

import { useCallback, useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { useRecordingState } from '@/contexts/RecordingStateContext';

const RECORDING_PILL_LABEL = 'recording-pill';
const RECORDING_PILL_ROUTE = '/recording-pill';

export default function RecordingPillWindowManager() {
  const { isRecording } = useRecordingState();
  const isRecordingRef = useRef(isRecording);
  const hiddenMainForRecordingRef = useRef(false);
  const pillWindowRef = useRef<WebviewWindow | null>(null);

  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

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

  const restoreMainWindow = useCallback(async () => {
    const mainWindow = getCurrentWindow();

    try {
      await mainWindow.show();

      if (await mainWindow.isMinimized()) {
        await mainWindow.unminimize();
      }

      await mainWindow.setFocus();
      hiddenMainForRecordingRef.current = false;
      await hidePillWindow();
    } catch (error) {
      console.error('[RecordingPillWindowManager] Failed to restore main window:', error);
    }
  }, [hidePillWindow]);

  useEffect(() => {
    let unlistenClose: (() => void) | undefined;
    const mainWindow = getCurrentWindow();

    mainWindow.onCloseRequested(async (event) => {
      if (!isRecordingRef.current) {
        return;
      }

      event.preventDefault();
      hiddenMainForRecordingRef.current = true;
      await showPillWindow();
      await mainWindow.hide();
    }).then((unlisten) => {
      unlistenClose = unlisten;
    });

    return () => {
      unlistenClose?.();
    };
  }, [showPillWindow]);

  useEffect(() => {
    let unlistenRestore: (() => void) | undefined;

    listen('recording-pill-restore-main', restoreMainWindow).then((unlisten) => {
      unlistenRestore = unlisten;
    });

    return () => {
      unlistenRestore?.();
    };
  }, [restoreMainWindow]);

  useEffect(() => {
    if (!isRecording) {
      hidePillWindow();

      if (hiddenMainForRecordingRef.current) {
        restoreMainWindow();
      }

      return;
    }

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
  }, [hidePillWindow, isRecording, restoreMainWindow, showPillWindow]);

  return null;
}
