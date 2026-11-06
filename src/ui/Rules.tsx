import { useEffect, useMemo, useState } from "react";
import { allNodes, loadRules, selectedNode, setActiveRules, useProfiles } from "../store/profiles";
import {
  chooseGroupMember,
  chooseNode,
  fetchGroupStates,
  reconnectIfOnline,
  useConnection,
} from "../store/connection";
import { updateSettings, useSettings } from "../store/settings";
import { compileRules, ruleCounts } from "../rules/compile";
import { ProxyGroup } from "../rules/types";
import { Empty, PageHeader, Row, Switch } from "./controls";
import { groupLabel, nodeLabel } from "./region";

function memberName(member: string) {
  const upper = member.toUpperCase();
  if (upper === "DIRECT") return "直连";
  if (upper === "REJECT" || upper === "REJECT-DROP") return "拦截";
  const label = nodeLabel(member);
  return [label.name, ...label.tags].join(" ");
}

const GROUP_KIND: Record<string, string> = {
  "url-test": "自动选择延迟最低",
  fallback: "自动选择可用节点",
  "load-balance": "自动选择",
};

function GroupRow({
  group,
  count,
  choice,
  now,
  primary,
}: {
  group: ProxyGroup;
  count: number;
  choice: string | undefined;
  now: string | undefined;
  primary: boolean;
}) {
  const hint = [
    primary ? "主策略组,和节点页的选择相同" : GROUP_KIND[group.type],
    count ? `${count} 条规则` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  if (group.type !== "select") {
    return (
      <Row title={groupLabel(group.name)} hint={hint}>
        <span className="group-now">{now ? memberName(now) : "连接后显示"}</span>
      </Row>
    );
  }

  const current = choice ?? (primary ? selectedNode()?.name : undefined) ?? now ?? group.members[0];
  // 主策略组里可以选到列表之外的本地节点
  const members = group.members.includes(current) ? group.members : [current, ...group.members];

  function pick(member: string) {
    const node = primary ? allNodes().find((n) => n.name === member) : undefined;
    void (node ? chooseNode(node.id) : chooseGroupMember(group.name, member));
  }

  return (
    <Row title={groupLabel(group.name)} hint={hint}>
      <select
        className="select"
        value={current}
        aria-label={groupLabel(group.name)}
        onChange={(e) => pick(e.target.value)}
      >
        {members.map((member) => (
          <option key={member} value={member}>
            {memberName(member)}
          </option>
        ))}
      </select>
    </Row>
  );
}

function CustomRules() {
  const { customRules } = useSettings();
  const { status } = useConnection();
  const [text, setText] = useState(customRules.join("\n"));
  const [dirty, setDirty] = useState(false);
  const lines = useMemo(() => text.split("\n"), [text]);
  const { runs, skipped } = useMemo(() => compileRules(lines), [lines]);
  const valid = runs.reduce((sum, run) => sum + run.count, 0);
  const bad = Object.values(skipped).reduce((sum, n) => sum + n, 0);

  function save() {
    updateSettings({ customRules: lines.map((l) => l.trim()).filter(Boolean) });
    setDirty(false);
    void reconnectIfOnline();
  }

  return (
    <section className="panel panel-pad">
      <div className="section-title">自定义规则</div>
      <div className="section-hint">
        优先于订阅规则,一行一条,写法和 Clash 相同,例如 DOMAIN-SUFFIX,example.com,DIRECT
      </div>
      <textarea
        className="textarea"
        rows={5}
        spellCheck={false}
        value={text}
        placeholder={"DOMAIN-SUFFIX,example.com,DIRECT\nIP-CIDR,203.0.113.0/24,REJECT,no-resolve"}
        onChange={(e) => {
          setText(e.target.value);
          setDirty(true);
        }}
      />
      <div className="section-foot">
        <span className={bad ? "muted warn" : "muted"}>
          {valid} 条有效{bad ? `,${bad} 条无法识别:${Object.keys(skipped)[0]}` : ""}
        </span>
        <button className="btn" disabled={!dirty} onClick={save}>
          {status === "on" ? "保存并重连" : "保存"}
        </button>
      </div>
    </section>
  );
}

export function Rules() {
  const { profiles, rules } = useProfiles();
  const settings = useSettings();
  const { status } = useConnection();
  const [states, setStates] = useState<Record<string, string>>({});
  const active = settings.activeRules;
  const bundle = active ? rules[active] : null;

  useEffect(() => {
    if (active) void loadRules(active);
  }, [active]);

  useEffect(() => {
    if (status !== "on") {
      setStates({});
      return;
    }
    const refresh = () => fetchGroupStates().then(setStates).catch(() => {});
    void refresh();
    const timer = setInterval(refresh, 4000);
    return () => clearInterval(timer);
  }, [status, active, settings.groupChoices]);

  const counts = useMemo(() => (bundle ? ruleCounts(bundle.runs) : {}), [bundle]);
  const sources = profiles.filter((p) => p.ruleCount > 0);
  const skipped = bundle ? Object.entries(bundle.skipped) : [];
  const skippedTotal = skipped.reduce((sum, [, n]) => sum + n, 0);
  // 订阅自带国内分流,或者兜底就是直连时,这个开关不起作用
  const coversCn = useMemo(
    () =>
      !bundle ||
      bundle.final?.toUpperCase() === "DIRECT" ||
      bundle.runs.some((run) => (run.match.rule_set as string[] | undefined)?.includes("geoip-cn")),
    [bundle],
  );

  return (
    <div className="page">
      <PageHeader title="规则" />
      <section className="panel">
        <Row
          title="规则来源"
          hint={
            bundle
              ? `${bundle.total} 条规则,${bundle.groups.length} 个策略组`
              : "国内网站和 IP 直连,其余走节点"
          }
        >
          <select
            className="select"
            value={active ?? ""}
            aria-label="规则来源"
            onChange={(e) => {
              void setActiveRules(e.target.value || null).then(reconnectIfOnline);
            }}
          >
            <option value="">内置:绕过大陆</option>
            {sources.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
        </Row>
        {!coversCn && (
          <Row title="国内网站直连" hint="这份订阅没有国内规则,没覆盖到的国内网站和 IP 不走节点">
            <Switch
              label="国内网站直连"
              checked={settings.cnDirect}
              onChange={(cnDirect) => {
                updateSettings({ cnDirect });
                void reconnectIfOnline();
              }}
            />
          </Row>
        )}
        {skippedTotal > 0 && (
          <Row
            title={`跳过 ${skippedTotal} 项`}
            hint={skipped.map(([reason, n]) => `${reason}(${n})`).join("、")}
          >
            <span />
          </Row>
        )}
      </section>

      {bundle && bundle.groups.length > 0 && (
        <section className="panel">
          <div className="panel-title">策略组</div>
          {bundle.groups.map((group) => (
            <GroupRow
              key={group.name}
              group={group}
              count={counts[group.name] ?? 0}
              choice={settings.groupChoices[group.name]}
              now={states[group.name]}
              primary={group.name === bundle.primary}
            />
          ))}
        </section>
      )}

      {!sources.length && !bundle && (
        <Empty title="订阅里的规则和策略组会显示在这里" />
      )}

      <CustomRules />
    </div>
  );
}
