import { useId } from "react";
import type { SVGProps } from "react";

type TesseraAgentLogoProps = SVGProps<SVGSVGElement> & {
  title?: string;
};

export function TesseraAgentLogo({ title, ...props }: TesseraAgentLogoProps) {
  const id = useId();
  const darkGradientId = `${id}-dark`;
  const lightGradientId = `${id}-light`;
  const shadowId = `${id}-shadow`;

  return (
    <svg
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      viewBox="0 0 512 512"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      {title ? <title>{title}</title> : null}
      <defs>
        <linearGradient id={darkGradientId} x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stopColor="#3a3a3a" />
          <stop offset="1" stopColor="#050505" />
        </linearGradient>
        <linearGradient id={lightGradientId} x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#d8d8d8" />
        </linearGradient>
        <filter height="160%" id={shadowId} width="160%" x="-30%" y="-30%">
          <feDropShadow dx="0" dy="10" floodOpacity=".16" stdDeviation="12" />
        </filter>
      </defs>
      <g filter={`url(#${shadowId})`}>
        <path
          d="M126 365V185c0-35 14-63 40-88l83-78c13-12 34-3 34 15v271c0 17-14 31-31 31H157c-17 0-31-14-31-31Z"
          fill={`url(#${darkGradientId})`}
        />
        <path
          d="M145 365l125-126c15-15 39-15 54 0l91 91c14 14 4 38-16 38H160c-17 0-25-18-15-31Z"
          fill={`url(#${lightGradientId})`}
        />
      </g>
    </svg>
  );
}
