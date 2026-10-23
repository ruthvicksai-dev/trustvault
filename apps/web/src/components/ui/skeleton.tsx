import { cn } from "cn"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-2xl bg-muted/90 border border-border/40", className)}
      {...props}
    />
  )
}

export { Skeleton }
