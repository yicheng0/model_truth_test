import type { LucideIcon } from "lucide-react";

export function StatCard({ label, value, detail, icon: Icon, tone = "blue" }: { label: string; value: string | number; detail: string; icon: LucideIcon; tone?: string }) {
  return (
    <div className={`stat-card stat-${tone}`}>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        <small>{detail}</small>
      </div>
      <Icon size={22} aria-hidden="true" />
    </div>
  );
}

