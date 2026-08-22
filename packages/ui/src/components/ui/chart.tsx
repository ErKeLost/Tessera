import type { ComponentProps, CSSProperties, ReactNode } from "react";

export type ChartConfig = Readonly<Record<string, Readonly<{
  color: string;
  label?: ReactNode;
}>>>;

export type ChartContainerProps = Omit<ComponentProps<"div">, "children"> & Readonly<{
  children: ReactNode;
  config: ChartConfig;
}>;

export function ChartContainer({
  children,
  className,
  config,
  style,
  ...props
}: ChartContainerProps) {
  const colorVariables = Object.fromEntries(
    Object.entries(config).map(([key, value]) => [`--color-${safeCssName(key)}`, value.color]),
  ) as CSSProperties;

  return (
    <div
      className={className === undefined ? "og-chart-container" : `og-chart-container ${className}`}
      data-chart={JSON.stringify(config)}
      data-slot="chart"
      style={{ ...colorVariables, ...style }}
      {...props}
    >
      {children}
    </div>
  );
}

function safeCssName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}
