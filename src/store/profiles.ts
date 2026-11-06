import {
  fetchUrl,
  storeDelete,
  storeRead,
  storeRetire,
  storeWrite,
  StoreFile,
} from "../api/backend";
import {
  parseInterval,
  parseProfile,
  parseUsage,
  profileName,
  Usage,
} from "../api/subscription";
import { Node, nodeId, unsupportedReason } from "../parser/types";
import { RuleBundle } from "../rules/types";
import { createStore, useStore } from "./createStore";
import { notify } from "./notice";
import { blockWrites, queueWrite } from "./persist";
import {
  applyTheme,
  DEFAULT_SETTINGS,
  Settings,
  settingsStore,
  Theme,
  updateSettings,
} from "./settings";

/**
 * 配置:一份订阅或本地节点。
 * 元数据在 profiles.json,节点和规则在 profiles/<id>.nodes.json、<id>.rules.json,
 * 规则按需加载,上万条规则不会拖慢启动。
 */
export interface Profile {
  id: string;
  name: string;
  kind: "local" | "remote";
  url?: string;
  updatedAt?: number;
  nodeCount: number;
  ruleCount: number;
  usage?: Usage;
  /** 自动更新间隔,小时 */
  intervalHours?: number;
  webPage?: string;
  lastError?: string;
}

interface ProfilesState {
  profiles: Profile[];
  nodes: Record<string, Node[]>;
  rules: Record<string, RuleBundle | undefined>;
  /** 正在刷新的配置 id */
  refreshing: Record<string, boolean>;
  loaded: boolean;
}

export const LOCAL_ID = "local";
const V1_SUBSCRIPTION_ID = "sub-v1";
const DEFAULT_INTERVAL_HOURS = 24;

export const profilesStore = createStore<ProfilesState>({
  profiles: [],
  nodes: {},
  rules: {},
  refreshing: {},
  loaded: false,
});

export const useProfiles = () => useStore(profilesStore);

const nodesFile = (id: string) => `profiles/${id}.nodes.json`;
const rulesFile = (id: string) => `profiles/${id}.rules.json`;

function saveProfiles() {
  queueWrite("profiles.json", () =>
    JSON.stringify({ version: 2, profiles: profilesStore.get().profiles }, null, 2),
  );
}

function localProfile(nodeCount = 0): Profile {
  return { id: LOCAL_ID, name: "本地节点", kind: "local", nodeCount, ruleCount: 0 };
}

function patchProfile(id: string, patch: Partial<Profile>) {
  profilesStore.set((s) => ({
    profiles: s.profiles.map((p) => (p.id === id ? { ...p, ...patch } : p)),
  }));
  saveProfiles();
}

function parseJson<T>(file: StoreFile | null, name: string): T | null {
  if (!file) return null;
  if (file.recovered) notify(`${name} 已损坏,已从备份恢复`, "error");
  return JSON.parse(file.content) as T;
}

// ---- 旧版数据迁移 ----

interface V1State {
  subscriptionUrl?: string;
  nodes?: Node[];
  selectedId?: string | null;
  theme?: Theme;
  tunMode?: boolean;
}

/**
 * 旧版把所有东西放在 state.json,分不清节点来自订阅还是手动添加,
 * 所以全部先放进本地节点,订阅首次刷新成功后再去掉重复项。
 * settings.json 最后写:中途崩溃时下次启动会重新迁移。
 */
async function migrateV1(): Promise<boolean> {
  const file = await storeRead("state.json");
  const old = parseJson<V1State>(file, "state.json");
  if (!old) return false;

  const nodes = (Array.isArray(old.nodes) ? old.nodes : []).map((n) => ({ ...n, fromV1: true }));
  const profiles: Profile[] = [localProfile(nodes.length)];
  const url = old.subscriptionUrl?.trim();
  if (url) {
    profiles.push({
      id: V1_SUBSCRIPTION_ID,
      name: "订阅",
      kind: "remote",
      url,
      nodeCount: 0,
      ruleCount: 0,
    });
  }
  await storeWrite(nodesFile(LOCAL_ID), JSON.stringify(nodes));
  await storeWrite("profiles.json", JSON.stringify({ version: 2, profiles }, null, 2));
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    theme: old.theme === "light" || old.theme === "dark" ? old.theme : "system",
    tun: !!old.tunMode,
    selected: old.selectedId ?? null,
  };
  await storeWrite("settings.json", JSON.stringify(settings, null, 2));
  await storeRetire("state.json", "state.v1.json");
  return true;
}

// ---- 启动 ----

export async function loadAll(): Promise<void> {
  try {
    const existing = await storeRead("settings.json");
    const settingsFile = existing ?? ((await migrateV1()) ? await storeRead("settings.json") : null);
    const saved = parseJson<Partial<Settings>>(settingsFile, "settings.json");
    settingsStore.set({ ...DEFAULT_SETTINGS, ...saved, version: 2 });

    const stored = parseJson<{ profiles: Profile[] }>(
      await storeRead("profiles.json"),
      "profiles.json",
    );
    const profiles = stored?.profiles ?? [];
    if (!profiles.some((p) => p.id === LOCAL_ID)) profiles.unshift(localProfile());

    const nodes: Record<string, Node[]> = {};
    await Promise.all(
      profiles.map(async (profile) => {
        const list = parseJson<Node[]>(await storeRead(nodesFile(profile.id)), profile.name);
        nodes[profile.id] = list ?? [];
      }),
    );
    profilesStore.set({ profiles, nodes });

    const active = settingsStore.get().activeRules;
    if (active) await loadRules(active);
  } catch (e) {
    blockWrites();
    notify(`读取本地数据失败,已停止保存以保护原文件:${e}`, "error");
  } finally {
    applyTheme(settingsStore.get().theme);
    profilesStore.set({ loaded: true });
  }
}

/** 按需加载规则。文件不见了不算错误,当成没有规则 */
export async function loadRules(id: string): Promise<RuleBundle | null> {
  const cached = profilesStore.get().rules[id];
  if (cached) return cached;
  const bundle = parseJson<RuleBundle>(await storeRead(rulesFile(id)), "规则");
  if (bundle) profilesStore.set((s) => ({ rules: { ...s.rules, [id]: bundle } }));
  return bundle;
}

// ---- 节点 ----

/** 规则来源的节点排在最前:策略组按名字找成员,同名时要用这份订阅自己的节点 */
export function allNodes(): Node[] {
  const { profiles, nodes } = profilesStore.get();
  const { activeRules } = settingsStore.get();
  const active = profiles.filter((p) => p.id === activeRules);
  const others = profiles.filter((p) => p.id !== activeRules);
  return [...active, ...others].flatMap((p) => nodes[p.id] ?? []);
}

export function selectedNode(): Node | null {
  const { selected } = settingsStore.get();
  return allNodes().find((n) => n.id === selected) ?? null;
}

/** 没选中节点时选第一个可用的。主策略组选了别的成员(比如自动测速组)时不动 */
export function ensureSelection() {
  const { activeRules, groupChoices } = settingsStore.get();
  if (selectedNode()) return;
  const primary = activeRules ? profilesStore.get().rules[activeRules]?.primary : null;
  if (primary && groupChoices[primary]) return;
  const first = allNodes().find((n) => !unsupportedReason(n));
  updateSettings({ selected: first?.id ?? null });
}

function setNodes(id: string, list: Node[]) {
  profilesStore.set((s) => ({ nodes: { ...s.nodes, [id]: list } }));
  queueWrite(nodesFile(id), () => JSON.stringify(profilesStore.get().nodes[id] ?? []));
  patchProfile(id, { nodeCount: list.length });
}

export function deleteNode(id: string) {
  const { nodes } = profilesStore.get();
  for (const [profileId, list] of Object.entries(nodes)) {
    if (list.some((n) => n.id === id)) setNodes(profileId, list.filter((n) => n.id !== id));
  }
  ensureSelection();
}

/** 手动添加节点:按 id 去重,返回新增数量 */
export function addLocalNodes(fresh: Node[]): number {
  const existing = profilesStore.get().nodes[LOCAL_ID] ?? [];
  const ids = new Set(allNodes().map((n) => n.id));
  const added = fresh.filter((n) => !ids.has(n.id));
  if (added.length) setNodes(LOCAL_ID, [...existing, ...added]);
  ensureSelection();
  return added.length;
}

const nodeKey = (n: Node) => `${n.protocol}|${n.server}|${n.port}`;

/** 去掉迁移来的节点里和订阅重复的,选中项跟到订阅里的同一节点 */
function dropV1Duplicates(fresh: Node[]) {
  const local = profilesStore.get().nodes[LOCAL_ID] ?? [];
  const byKey = new Map(fresh.map((n) => [nodeKey(n), n]));
  const kept = local.filter((n) => !(n.fromV1 && byKey.has(nodeKey(n))));
  if (kept.length === local.length) return;
  const { selected } = settingsStore.get();
  const removed = local.find((n) => n.id === selected && !kept.includes(n));
  if (removed) updateSettings({ selected: byKey.get(nodeKey(removed))!.id });
  setNodes(LOCAL_ID, kept);
}

/** 节点 id 随内容变化(比如机场换了密码),选中项按名称跟过去 */
function keepSelection(old: Node[], fresh: Node[]) {
  const { selected } = settingsStore.get();
  const before = old.find((n) => n.id === selected);
  if (!before || fresh.some((n) => n.id === selected)) return;
  const same = fresh.find((n) => n.name === before.name);
  updateSettings({ selected: same?.id ?? null });
}

// ---- 配置 ----

function storeParsed(id: string, nodes: Node[], rules: RuleBundle | null) {
  const old = profilesStore.get().nodes[id] ?? [];
  keepSelection(old, nodes);
  // 只有旧版那份订阅的节点才混在本地节点里。别的订阅和手动节点同服务器时不算重复
  if (id === V1_SUBSCRIPTION_ID) dropV1Duplicates(nodes);
  setNodes(id, nodes);
  if (rules) {
    profilesStore.set((s) => ({ rules: { ...s.rules, [id]: rules } }));
    queueWrite(rulesFile(id), () => JSON.stringify(profilesStore.get().rules[id] ?? null));
  } else {
    profilesStore.set((s) => ({ rules: { ...s.rules, [id]: undefined } }));
    void storeDelete(rulesFile(id));
    if (settingsStore.get().activeRules === id) updateSettings({ activeRules: null });
  }
  patchProfile(id, { ruleCount: rules?.total ?? 0 });
  // 第一份带规则的订阅自动启用,之后不替用户改
  if (rules?.total && !settingsStore.get().activeRules) updateSettings({ activeRules: id });
  ensureSelection();
}

const download = (url: string) => fetchUrl(url).then((r) => r.body);

/** 刷新订阅。失败时保留旧节点和规则,错误记在配置上 */
export async function refreshProfile(id: string, silent = false): Promise<boolean> {
  const profile = profilesStore.get().profiles.find((p) => p.id === id);
  if (!profile?.url) return false;
  profilesStore.set((s) => ({ refreshing: { ...s.refreshing, [id]: true } }));
  try {
    const fetched = await fetchUrl(profile.url);
    const parsed = await parseProfile(fetched.body, download);
    if (!parsed.nodes.length) {
      const hint = parsed.errors.length ? `${parsed.errors.length} 个节点解析失败` : "内容为空";
      throw new Error(`没有解析出节点(${hint})`);
    }
    storeParsed(id, parsed.nodes, parsed.rules);
    const name = profile.id === V1_SUBSCRIPTION_ID || profile.name === "订阅"
      ? profileName(profile.url, fetched.title, fetched.disposition)
      : profile.name;
    patchProfile(id, {
      name,
      updatedAt: Date.now(),
      usage: parseUsage(fetched.userInfo) ?? profile.usage,
      intervalHours: parseInterval(fetched.updateInterval) ?? profile.intervalHours,
      webPage: fetched.webPage ?? profile.webPage,
      lastError: undefined,
    });
    if (!silent) {
      const unusable = parsed.nodes.filter((n) => unsupportedReason(n)).length;
      notify(
        `${name}:${parsed.nodes.length} 个节点` +
          (parsed.rules?.total ? `,${parsed.rules.total} 条规则` : "") +
          (unusable ? `,${unusable} 个节点内核不支持` : ""),
      );
    }
    return true;
  } catch (e) {
    patchProfile(id, { lastError: String(e) });
    if (!silent) notify(`更新失败:${e}`, "error");
    return false;
  } finally {
    profilesStore.set((s) => ({ refreshing: { ...s.refreshing, [id]: false } }));
  }
}

/** 刷新到期的订阅。启动时和之后每小时调用一次 */
export async function refreshDueProfiles(): Promise<void> {
  const now = Date.now();
  for (const profile of profilesStore.get().profiles) {
    if (profile.kind !== "remote") continue;
    const hours = profile.intervalHours ?? DEFAULT_INTERVAL_HOURS;
    if (!profile.updatedAt || now - profile.updatedAt >= hours * 3_600_000) {
      await refreshProfile(profile.id, true);
    }
  }
}

function newProfileId(seed: string): string {
  return `p${nodeId(seed + Date.now()).slice(1)}`;
}

export async function addSubscription(url: string): Promise<string | null> {
  const existing = profilesStore.get().profiles.find((p) => p.url === url);
  if (existing) {
    await refreshProfile(existing.id);
    return existing.id;
  }
  const id = newProfileId(url);
  let host = "订阅";
  try {
    host = new URL(url).hostname;
  } catch {
    /* 下载时会给出明确错误 */
  }
  const profile: Profile = { id, name: "订阅", kind: "remote", url, nodeCount: 0, ruleCount: 0 };
  profilesStore.set((s) => ({
    profiles: [...s.profiles, profile],
    nodes: { ...s.nodes, [id]: [] },
  }));
  saveProfiles();
  const ok = await refreshProfile(id);
  if (!ok) {
    // 第一次就失败多半是链接填错,不留下一个空配置
    await deleteProfile(id);
    notify(`${host} 添加失败`, "error");
    return null;
  }
  return id;
}

export async function deleteProfile(id: string): Promise<void> {
  const { profiles, nodes, rules } = profilesStore.get();
  if (id === LOCAL_ID) return;
  const removed = nodes[id] ?? [];
  const remainingNodes = { ...nodes };
  delete remainingNodes[id];
  const remainingRules = { ...rules };
  delete remainingRules[id];
  profilesStore.set({
    profiles: profiles.filter((p) => p.id !== id),
    nodes: remainingNodes,
    rules: remainingRules,
  });
  saveProfiles();
  const { selected, activeRules } = settingsStore.get();
  updateSettings({
    selected: removed.some((n) => n.id === selected) ? null : selected,
    activeRules: activeRules === id ? null : activeRules,
  });
  ensureSelection();
  await Promise.all([storeDelete(nodesFile(id)), storeDelete(rulesFile(id))]);
}

export function renameProfile(id: string, name: string) {
  const trimmed = name.trim();
  if (trimmed) patchProfile(id, { name: trimmed });
}

export async function setActiveRules(id: string | null) {
  if (id) await loadRules(id);
  updateSettings({ activeRules: id });
}

/**
 * 粘贴导入:http 链接当订阅;Clash 配置建一份不带链接的配置,保留分组和规则;
 * 分享链接和 sing-box 配置的节点进本地节点。
 */
export async function importText(text: string): Promise<void> {
  const body = text.trim();
  if (!body) return;
  const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.every((l) => /^https?:\/\//i.test(l))) {
    for (const url of lines) await addSubscription(url);
    return;
  }
  const parsed = await parseProfile(body, download);
  if (!parsed.nodes.length) {
    throw new Error(
      parsed.errors.length ? `全部无法解析:${parsed.errors[0]}` : "没有可导入的内容",
    );
  }
  if (parsed.rules) {
    const id = newProfileId(body.slice(0, 200));
    const profile: Profile = {
      id,
      name: "导入的配置",
      kind: "local",
      updatedAt: Date.now(),
      nodeCount: 0,
      ruleCount: 0,
    };
    profilesStore.set((s) => ({ profiles: [...s.profiles, profile] }));
    saveProfiles();
    storeParsed(id, parsed.nodes, parsed.rules);
    notify(`已导入 ${parsed.nodes.length} 个节点,${parsed.rules.total} 条规则`);
    return;
  }
  const added = addLocalNodes(parsed.nodes);
  const repeated = parsed.nodes.length - added;
  notify(
    `新增 ${added} 个节点` +
      (repeated ? `,${repeated} 个已存在` : "") +
      (parsed.errors.length ? `,${parsed.errors.length} 条解析失败` : ""),
  );
}
