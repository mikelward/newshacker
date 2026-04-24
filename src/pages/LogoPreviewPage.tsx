import { Link } from 'react-router-dom';
import './LogoPreviewPage.css';

type LogoRenderer = () => JSX.Element;

interface LogoConcept {
  id: string;
  name: string;
  description: string;
  render: LogoRenderer;
}

// All logos render into a 512x512 viewBox so CSS alone controls display size.
// Each concept is self-contained — background, glyph, everything — so the
// preview tile doesn't have to composite anything on top.

function CurrentLogo() {
  return (
    <svg
      viewBox="0 0 512 512"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Current logo: circle with letter n"
    >
      <circle cx="256" cy="256" r="250" fill="#ff6600" />
      <text
        x="50%"
        y="50%"
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"
        fontWeight="700"
        fontSize="360"
        fill="#ffffff"
      >
        n
      </text>
    </svg>
  );
}

function KeycapLogo() {
  return (
    <svg
      viewBox="0 0 512 512"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Keyboard keycap with letter n"
    >
      <rect width="512" height="512" rx="96" fill="#ff6600" />
      {/* Keycap base (darker lip — reads as the side of the cap). */}
      <rect
        x="76"
        y="96"
        width="360"
        height="340"
        rx="36"
        fill="#c94e00"
      />
      {/* Keycap top (the surface your finger presses). Pulled up and in
          so the darker base peeks out as a lip along the bottom and
          sides. */}
      <rect
        x="96"
        y="108"
        width="320"
        height="296"
        rx="28"
        fill="#ffffff"
      />
      <text
        x="256"
        y="268"
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
        fontWeight="700"
        fontSize="240"
        fill="#1a1a1a"
      >
        n
      </text>
    </svg>
  );
}

function TerminalLogo() {
  return (
    <svg
      viewBox="0 0 512 512"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Terminal prompt with blinking cursor"
    >
      <rect width="512" height="512" rx="96" fill="#ff6600" />
      {/* Chevron prompt. Drawn as a polyline so the stroke joins cleanly. */}
      <polyline
        points="150,176 260,256 150,336"
        fill="none"
        stroke="#ffffff"
        strokeWidth="56"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Cursor block to the right of the prompt. */}
      <rect x="300" y="208" width="86" height="104" fill="#ffffff" />
    </svg>
  );
}

function PhoneFrameLogo() {
  return (
    <svg
      viewBox="0 0 512 512"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Phone screen displaying letter n"
    >
      <rect width="512" height="512" rx="96" fill="#ff6600" />
      {/* Phone body. */}
      <rect
        x="136"
        y="56"
        width="240"
        height="400"
        rx="36"
        fill="#ffffff"
      />
      {/* Screen. */}
      <rect
        x="156"
        y="96"
        width="200"
        height="320"
        rx="12"
        fill="#1a1a1a"
      />
      {/* Speaker slot. */}
      <rect x="236" y="74" width="40" height="6" rx="3" fill="#ff6600" />
      {/* Home indicator. */}
      <rect x="216" y="430" width="80" height="8" rx="4" fill="#1a1a1a" />
      <text
        x="256"
        y="256"
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"
        fontWeight="700"
        fontSize="200"
        fill="#ff6600"
      >
        n
      </text>
    </svg>
  );
}

function NotchedLogo() {
  return (
    <svg
      viewBox="0 0 512 512"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Letter n with speaker slot above"
    >
      <rect width="512" height="512" rx="96" fill="#ff6600" />
      {/* Tiny speaker slot — the only hint this is a phone. */}
      <rect x="216" y="112" width="80" height="12" rx="6" fill="#ffffff" />
      <text
        x="256"
        y="312"
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"
        fontWeight="700"
        fontSize="320"
        fill="#ffffff"
      >
        n
      </text>
    </svg>
  );
}

function PixelNewsLogo() {
  return (
    <svg
      viewBox="0 0 512 512"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Folded newspaper corner with pixelated edge"
    >
      <rect width="512" height="512" rx="96" fill="#ff6600" />
      {/* Newspaper body. */}
      <path
        d="M112,112 H352 L400,160 V400 H112 Z"
        fill="#ffffff"
      />
      {/* Folded corner — stepped pixels. Darker than the body so the
          fold reads as a shadow/underside. */}
      <path
        d="M352,112 V160 H400 L352,112 Z"
        fill="#c94e00"
      />
      {/* Headline bars. */}
      <rect x="144" y="200" width="224" height="24" rx="4" fill="#1a1a1a" />
      <rect x="144" y="248" width="192" height="12" rx="4" fill="#828282" />
      <rect x="144" y="276" width="208" height="12" rx="4" fill="#828282" />
      <rect x="144" y="304" width="160" height="12" rx="4" fill="#828282" />
      <rect x="144" y="344" width="224" height="12" rx="4" fill="#828282" />
      <rect x="144" y="372" width="176" height="12" rx="4" fill="#828282" />
    </svg>
  );
}

const CONCEPTS: LogoConcept[] = [
  {
    id: 'current',
    name: 'Current (baseline)',
    description:
      'The shipped favicon — circle with a bold n. Included so each concept has something to be compared against.',
    render: CurrentLogo,
  },
  {
    id: 'keycap',
    name: 'Keycap n',
    description:
      'Keeps the n but renders it on a keyboard keycap. Reads as "computers" / "typing" without needing to say so. Risks skeuomorphism at very small sizes.',
    render: KeycapLogo,
  },
  {
    id: 'terminal',
    name: 'Terminal prompt',
    description:
      'A chevron prompt and a block cursor — pure "hacker" glyph, no letter. Loudest tech signal of the set; drops brand continuity with the name.',
    render: TerminalLogo,
  },
  {
    id: 'phone-frame',
    name: 'Phone frame',
    description:
      'A literal phone with n on the screen. Says "mobile" clearly in marketing sizes; at 32×32 the bezel collapses into a rounded rectangle already provided by the app-icon mask.',
    render: PhoneFrameLogo,
  },
  {
    id: 'notched',
    name: 'Notched n',
    description:
      'Single speaker slot above the n. Keeps the brand letter, nods at "phone", survives favicon scale better than the full bezel.',
    render: NotchedLogo,
  },
  {
    id: 'pixel-news',
    name: 'Folded paper',
    description:
      'Newspaper with a folded corner — leans into the "news" half of the name. No letter; reads as a document more than a tech mark.',
    render: PixelNewsLogo,
  },
];

const DISPLAY_SIZES = [
  { key: 'lg', label: '512' },
  { key: 'md', label: '128' },
  { key: 'sm', label: '32' },
] as const;

export function LogoPreviewPage() {
  return (
    <article className="logo-preview">
      <h1 className="logo-preview__title">Logo concepts</h1>
      <p className="logo-preview__lede">
        Draft marks for newshacker, each rendered at 512, 128, and 32 px so
        we can see how it holds up at favicon scale. Nothing here is
        shipped — the current favicon is the first card as a baseline.
      </p>

      <div className="logo-preview__grid">
        {CONCEPTS.map((concept) => (
          <section
            key={concept.id}
            className="logo-preview__card"
            aria-labelledby={`logo-${concept.id}-heading`}
          >
            <h2
              id={`logo-${concept.id}-heading`}
              className="logo-preview__name"
            >
              {concept.name}
            </h2>
            <div className="logo-preview__sizes">
              {DISPLAY_SIZES.map((size) => (
                <div
                  key={size.key}
                  className={`logo-preview__tile logo-preview__tile--${size.key}`}
                >
                  {concept.render()}
                  <span className="logo-preview__size-label">
                    {size.label}
                  </span>
                </div>
              ))}
            </div>
            <p className="logo-preview__description">{concept.description}</p>
          </section>
        ))}
      </div>

      <p className="logo-preview__back">
        <Link to="/top">← Back to Top</Link>
      </p>
    </article>
  );
}
