import { isMultiplier, nodeLabel } from "./region";

export function RegionBadge({ code, title }: { code: string | null; title?: string }) {
  return (
    <span className="region" title={title}>
      {code ?? "–"}
    </span>
  );
}

export function NodeName({ name }: { name: string }) {
  const label = nodeLabel(name);
  return (
    <>
      <RegionBadge code={label.code} title={label.region ?? undefined} />
      <span className="node-name">{label.name}</span>
      {label.tags.map((tag) => (
        <span key={tag} className={isMultiplier(tag) ? "tag tag-rate" : "tag"}>
          {tag}
        </span>
      ))}
    </>
  );
}
