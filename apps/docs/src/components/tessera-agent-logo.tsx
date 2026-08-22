import { useId } from "react";
import type { SVGProps } from "react";

type TesseraAgentLogoProps = SVGProps<SVGSVGElement> & {
  title?: string;
};

export function TesseraAgentLogo({ title, ...props }: TesseraAgentLogoProps) {
  const id = useId();
  const clipId = `${id}-clip`;
  const gradientId = `${id}-gradient`;

  return (
    <svg
      aria-hidden={title ? undefined : true}
      fill="none"
      role={title ? "img" : undefined}
      viewBox="0 0 46 45"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      {title ? <title>{title}</title> : null}
      <g clipPath={`url(#${clipId})`}>
        <rect
          fill="var(--tessera-logo-surface, #1f2123)"
          height="42.1667"
          rx="8.58333"
          width="42.1667"
          x="1.91667"
          y="1.27507"
        />
        <rect
          height="42.1667"
          rx="8.58333"
          stroke={`url(#${gradientId})`}
          strokeWidth="1.83333"
          width="42.1667"
          x="1.91667"
          y="1.27507"
        />
        <path
          clipRule="evenodd"
          d="M24.7382 10.5321C24.9545 9.5721 24.3515 8.61857 23.3915 8.40234C22.4315 8.1861 21.478 8.78903 21.2618 9.74902C20.4689 13.2689 19.4423 15.5137 17.8942 17.0937C16.3503 18.6694 14.0874 19.7874 10.3906 20.6202C9.43061 20.8364 8.82769 21.79 9.04394 22.75C9.26019 23.7099 10.2137 24.3129 11.1737 24.0966C15.1934 23.1911 18.2155 21.8576 20.4396 19.5877C22.6594 17.3221 23.8834 14.3271 24.7382 10.5321ZM35.6094 24.0966C36.5694 23.8804 37.1723 22.9268 36.9561 21.9668C36.7398 21.0069 35.7863 20.4039 34.8263 20.6202C31.0313 21.475 28.0363 22.6991 25.7707 24.9189C23.5008 27.1429 22.1673 30.165 21.2618 34.1847C21.0455 35.1447 21.6485 36.0982 22.6084 36.3145C23.5684 36.5307 24.522 35.9278 24.7382 34.9678C25.571 31.271 26.689 29.0081 28.2647 27.4643C29.8447 25.9162 32.0895 24.8895 35.6094 24.0966Z"
          fill="var(--tessera-logo-glyph, #fff)"
          fillRule="evenodd"
          opacity="0.5"
        />
        <path
          clipRule="evenodd"
          d="M24.7382 9.74902C24.522 8.78903 23.5685 8.1861 22.6085 8.40234C21.6485 8.61857 21.0455 9.5721 21.2618 10.5321C22.1166 14.3271 23.3406 17.3221 25.5604 19.5877C27.7845 21.8576 30.8066 23.1911 34.8263 24.0966C35.7863 24.3129 36.7398 23.7099 36.9561 22.75C37.1723 21.79 36.5694 20.8364 35.6094 20.6202C31.9126 19.7874 29.6497 18.6694 28.1058 17.0937C26.5577 15.5137 25.5311 13.2689 24.7382 9.74902ZM11.1737 20.6201C10.2137 20.4039 9.26019 21.0068 9.04394 21.9668C8.82769 22.9268 9.43061 23.8803 10.3906 24.0965C14.0874 24.9293 16.3503 26.0473 17.8942 27.623C19.4423 29.203 20.4689 31.4479 21.2618 34.9677C21.478 35.9277 22.4315 36.5306 23.3915 36.3144C24.3515 36.0982 24.9545 35.1446 24.7382 34.1846C23.8834 30.3897 22.6594 27.3947 20.4396 25.1291C18.2155 22.8591 15.1934 21.5256 11.1737 20.6201Z"
          fill="var(--tessera-logo-glyph, #fff)"
          fillRule="evenodd"
        />
      </g>
      <rect
        height="44.1375"
        rx="9.56875"
        stroke="var(--tessera-logo-outline, rgb(0 0 0 / 0.6))"
        strokeWidth="0.1375"
        width="44.1375"
        x="0.93125"
        y="0.289648"
      />
      <defs>
        <linearGradient
          gradientUnits="userSpaceOnUse"
          id={gradientId}
          x1="23"
          x2="23"
          y1="0.358398"
          y2="44.3584"
        >
          <stop stopColor="var(--tessera-logo-border-start, #2e3032)" />
          <stop offset="1" stopColor="var(--tessera-logo-border-end, #101214)" />
        </linearGradient>
        <clipPath id={clipId}>
          <rect fill="#fff" height="44" rx="9.5" width="44" x="1" y="0.358398" />
        </clipPath>
      </defs>
    </svg>
  );
}
