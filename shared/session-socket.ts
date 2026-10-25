import type { OxyServices } from '@oxy.so/core';
import { io } from 'socket.io-client';

/** App-owned Socket.IO lifecycle; Oxy owns authentication, refresh and account epochs. */
export function createSessionSocket(oxy: OxyServices, baseURL: string) {
  const linked = oxy.createLinkedClient({ baseURL });
  const epoch = linked.client.getSessionEpoch();
  const controller = new AbortController();
  let disposed = false;
  let unwatch: (() => void) | undefined;
  const isCurrent = () => !disposed && linked.client.getSessionEpoch() === epoch;
  const socket = io(baseURL, {
    autoConnect: false,
    forceNew: true,
    transports: ['websocket', 'polling'],
    auth: (callback) => {
      void linked.getAccessToken(baseURL, { signal: controller.signal }).then(
        (token) => {
          if (isCurrent()) callback({ token });
        },
        () => dispose(),
      );
    },
  });
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    controller.abort();
    unwatch?.();
    socket.removeAllListeners();
    socket.disconnect();
    linked.dispose();
  };
  unwatch = linked.client.addTokenChangeListener(() => {
    if (!isCurrent()) dispose();
  });
  return {
    socket,
    isCurrent,
    connect() {
      if (isCurrent()) socket.connect();
    },
    dispose,
  };
}
