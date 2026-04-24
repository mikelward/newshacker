import type { ReactNode, SVGProps } from 'react';

// Material Symbols Outlined — Apache 2.0, Google. viewBox 0 -960 960 960,
// fill-based paths that take `color` via currentColor.
const MS_VIEWBOX = '0 -960 960 960';

type IconProps = Omit<SVGProps<SVGSVGElement>, 'viewBox' | 'fill' | 'children'>;

function MaterialIcon({
  children,
  width = 28,
  height = 28,
  ...rest
}: IconProps & { children: ReactNode }) {
  return (
    <svg
      viewBox={MS_VIEWBOX}
      fill="currentColor"
      width={width}
      height={height}
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export function DoneFilledIcon(props: IconProps) {
  return (
    <MaterialIcon {...props}>
      <path d="M480-80q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm-56-216 280-280-56-56-224 224-114-114-56 56 170 170Z" />
    </MaterialIcon>
  );
}

export function HeartFilledIcon(props: IconProps) {
  return (
    <MaterialIcon {...props}>
      <path d="m480-120-58-52q-101-91-167-157T150-447.5Q111-500 95.5-544T80-634q0-94 63-157t157-63q52 0 99 22t81 62q34-40 81-62t99-22q94 0 157 63t63 157q0 46-15.5 90T810-447.5Q771-395 705-329T538-172l-58 52Z" />
    </MaterialIcon>
  );
}

export function VisibilityOffIcon(props: IconProps) {
  return (
    <MaterialIcon {...props}>
      <path d="m644-428-58-58q9-47-27-88t-93-32l-58-58q17-8 34.5-12t37.5-4q75 0 127.5 52.5T660-500q0 20-4 37.5T644-428Zm128 126-58-56q38-29 67.5-63.5T832-500q-50-101-143.5-160.5T480-720q-29 0-57 4t-55 12l-62-62q41-17 84-25.5t90-8.5q151 0 269 83.5T920-500q-23 59-60.5 109.5T772-302Zm20 246L624-222q-35 11-70.5 16.5T480-200q-151 0-269-83.5T40-500q21-53 53-98.5t73-81.5L56-792l56-56 736 736-56 56ZM222-624q-29 26-53 57t-41 67q50 101 143.5 160.5T480-280q20 0 39-2.5t39-5.5l-36-38q-11 3-21 4.5t-21 1.5q-75 0-127.5-52.5T300-500q0-11 1.5-21t4.5-21l-84-82Zm319 93Zm-151 75Z" />
    </MaterialIcon>
  );
}
