/**
 * Preload Script - Renderer ↔ Main 프로세스 IPC 브릿지
 *
 * contextBridge로 안전하게 electronAPI를 renderer에 노출.
 * renderer에서 window.electronAPI.xxx() 형태로 호출.
 */
import { contextBridge, ipcRenderer } from 'electron';

export interface ElectronAPI {
  startServer: () => Promise<void>;
  stopServer: () => Promise<void>;
  getStatus: () => Promise<string>;
  getLogs: () => Promise<string[]>;
  onStatusChanged: (callback: (status: string) => void) => void;
  onLog: (callback: (line: string) => void) => void;
  removeAllListeners: () => void;
}

contextBridge.exposeInMainWorld('electronAPI', {
  startServer: () => ipcRenderer.invoke('server:start'),
  stopServer: () => ipcRenderer.invoke('server:stop'),
  getStatus: () => ipcRenderer.invoke('server:status'),
  getLogs: () => ipcRenderer.invoke('server:logs'),

  onStatusChanged: (callback: (status: string) => void) => {
    ipcRenderer.on('server:status-changed', (_event, status: string) => {
      callback(status);
    });
  },

  onLog: (callback: (line: string) => void) => {
    ipcRenderer.on('server:log', (_event, line: string) => {
      callback(line);
    });
  },

  removeAllListeners: () => {
    ipcRenderer.removeAllListeners('server:status-changed');
    ipcRenderer.removeAllListeners('server:log');
  },
} satisfies ElectronAPI);
