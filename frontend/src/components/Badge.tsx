export function Badge({ children, tone = "neutral" }: { children: string; tone?: "neutral" | "green" | "amber" | "red" | "blue" | "purple" }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

