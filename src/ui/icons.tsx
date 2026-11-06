import { ReactNode } from "react";

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const HomeIcon = () => (
  <Icon>
    <path d="M8 2.2v5.6" />
    <path d="M11.8 4.2a5.6 5.6 0 1 1-7.6 0" />
  </Icon>
);

export const NodesIcon = () => (
  <Icon>
    <circle cx="8" cy="8" r="6" />
    <path d="M2 8h12M8 2c1.8 1.7 2.6 3.7 2.6 6S9.8 12.3 8 14c-1.8-1.7-2.6-3.7-2.6-6S6.2 3.7 8 2Z" />
  </Icon>
);

export const RulesIcon = () => (
  <Icon>
    <path d="M3 3v10M3 8h6.500M3 3h6.500M3 13h6.5" />
    <circle cx="11.5" cy="3" r="1.5" />
    <circle cx="11.5" cy="8" r="1.5" />
    <circle cx="11.5" cy="13" r="1.5" />
  </Icon>
);

export const ProfilesIcon = () => (
  <Icon>
    <path d="M3 2.500h7l3 3v8H3z" />
    <path d="M10 2.500v3h3M5.5 8.500h5M5.5 11h5" />
  </Icon>
);

export const LogsIcon = () => (
  <Icon>
    <path d="M2.5 3.500h11v9h-11z" />
    <path d="m5 6.5 2 1.5-2 1.500M8.5 10H11" />
  </Icon>
);

export const SettingsIcon = () => (
  <Icon>
    <path d="M3 4.500h6M13 4.500h-1M3 11.500h1M7 11.500h6" />
    <circle cx="10.5" cy="4.5" r="1.5" />
    <circle cx="5.5" cy="11.5" r="1.5" />
  </Icon>
);

export const RefreshIcon = () => (
  <Icon>
    <path d="M13 8a5 5 0 1 1-1.5-3.500L13 6" />
    <path d="M13 2.500V6H9.5" />
  </Icon>
);

export const PlusIcon = () => (
  <Icon>
    <path d="M8 3v10M3 8h10" />
  </Icon>
);

export const TrashIcon = () => (
  <Icon>
    <path d="M3 4.500h10M6.5 4.500V3h3v1.500M4.5 4.500l.5 8.500h6l.5-8.5" />
  </Icon>
);

export const SearchIcon = () => (
  <Icon>
    <circle cx="7" cy="7" r="4.5" />
    <path d="m10.5 10.5 3 3" />
  </Icon>
);

export const BoltIcon = () => (
  <Icon>
    <path d="M8.5 2 3.5 9H8l-.5 5 5-7H8z" />
  </Icon>
);

export const LinkIcon = () => (
  <Icon>
    <path d="M9.5 2.500h4v4M13.5 2.5 8 8M12 9.500V13H3V4h3.5" />
  </Icon>
);

export const CloseIcon = () => (
  <Icon>
    <path d="m4 4 8 8M12 4l-8 8" />
  </Icon>
);
