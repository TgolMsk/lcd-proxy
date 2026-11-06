import { createStore, useStore } from "./createStore";

export type NoticeKind = "info" | "error";

export interface Notice {
  id: number;
  text: string;
  kind: NoticeKind;
}

export const noticeStore = createStore<{ notices: Notice[] }>({ notices: [] });
let nextId = 1;

export const useNotices = () => useStore(noticeStore);

export function dismissNotice(id: number) {
  noticeStore.set((s) => ({ notices: s.notices.filter((n) => n.id !== id) }));
}

/** 右下角提示。普通提示自动消失,错误留到用户关掉 */
export function notify(text: string, kind: NoticeKind = "info") {
  const id = nextId++;
  noticeStore.set((s) => ({ notices: [...s.notices.slice(-3), { id, text, kind }] }));
  if (kind === "info") setTimeout(() => dismissNotice(id), 4000);
}
