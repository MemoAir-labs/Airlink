import { colorForId } from "@memo-air/react";
import { cn } from "@memo-air/react/ui";

const sizes = {
  sm: "h-5 w-5 rounded text-[10px]",
  md: "h-9 w-9 rounded-lg text-sm",
  lg: "h-14 w-14 rounded-xl text-xl",
};

// A person is their initial and an agent is ✦, on the same per-id colour their cursor and name
// use everywhere else, so one glance ties a message to a cursor.
export function Avatar({
  id,
  name,
  kind,
  size = "md",
}: {
  id: string;
  name: string;
  kind: "human" | "agent";
  size?: keyof typeof sizes;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 select-none items-center justify-center font-semibold text-white",
        sizes[size]
      )}
      style={{ backgroundColor: colorForId(id) }}
    >
      {kind === "agent" ? "✦" : name.charAt(0).toUpperCase()}
    </span>
  );
}
