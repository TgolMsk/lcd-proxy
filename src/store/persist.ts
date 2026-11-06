import { storeWrite } from "../api/backend";
import { notify } from "./notice";

/**
 * 按文件防抖写盘。数据分文件存放,改设置只写 settings.json,
 * 不用把几十个节点和上万条规则再写一遍。
 */
const pending = new Map<string, () => string>();
let timer: ReturnType<typeof setTimeout> | null = null;
let blocked = false;

/** 数据读取失败时停止写入,不能用空数据覆盖还能抢救的文件 */
export function blockWrites() {
  blocked = true;
}

export function queueWrite(name: string, serialize: () => string, delay = 400) {
  if (blocked) return;
  pending.set(name, serialize);
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void flushWrites(), delay);
}

/** 立即写盘并等待完成(提权重启、退出前用) */
export async function flushWrites(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const jobs = [...pending.entries()];
  pending.clear();
  await Promise.all(
    jobs.map(async ([name, serialize]) => {
      try {
        await storeWrite(name, serialize());
      } catch (e) {
        notify(`保存 ${name} 失败:${e}`, "error");
      }
    }),
  );
}
