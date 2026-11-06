import { createStore, useStore } from "./createStore";

const HISTORY = 60;

interface TrafficState {
  /** 当前速度,字节/秒 */
  up: number;
  down: number;
  totalUp: number;
  totalDown: number;
  /** 最近一分钟的下行、上行速度 */
  downHistory: number[];
  upHistory: number[];
}

const EMPTY: TrafficState = {
  up: 0,
  down: 0,
  totalUp: 0,
  totalDown: 0,
  downHistory: [],
  upHistory: [],
};

export const trafficStore = createStore<TrafficState>(EMPTY);
export const useTraffic = () => useStore(trafficStore);

export function pushTraffic(up: number, down: number) {
  trafficStore.set((s) => ({
    up,
    down,
    totalUp: s.totalUp + up,
    totalDown: s.totalDown + down,
    downHistory: [...s.downHistory, down].slice(-HISTORY),
    upHistory: [...s.upHistory, up].slice(-HISTORY),
  }));
}

export function resetTraffic() {
  trafficStore.set(EMPTY);
}
