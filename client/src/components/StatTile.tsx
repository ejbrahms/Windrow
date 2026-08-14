interface StatTileProps {
  label: string;
  value: string;
  sub?: string;
}

export function StatTile({ label, value, sub }: StatTileProps) {
  return (
    <div className="stat-tile">
      <div className="label">{label}</div>
      <div className="value tabular">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}
