import { Button, Dropdown, DropdownItem, DropdownMenu, DropdownTrigger } from "@heroui/react";
import type { Key } from "react";
import type { ThemePref } from "../hooks/useTheme";
import { t } from "../i18n";
import type { UiKey } from "../i18n";

function GearIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="h-4 w-4"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="h-4 w-4"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="5" />
      <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="h-4 w-4"
      aria-hidden="true"
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function MonitorIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="h-4 w-4"
      aria-hidden="true"
    >
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="h-4 w-4 shrink-0"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  );
}

const THEME_OPTIONS: readonly ThemePref[] = ["system", "light", "dark"];

const THEME_ICONS: Record<ThemePref, typeof SunIcon> = {
  system: MonitorIcon,
  light: SunIcon,
  dark: MoonIcon,
};

const THEME_LABEL_KEYS: Record<ThemePref, UiKey> = {
  system: "theme.system",
  light: "theme.light",
  dark: "theme.dark",
};

function isThemePref(key: Key): key is ThemePref {
  return key === "system" || key === "light" || key === "dark";
}

export function Header({
  online,
  ingestPercent,
  onOpenSettings,
  onOpenSearch,
  theme,
  setTheme,
}: {
  online: boolean;
  ingestPercent: number | null;
  onOpenSettings: () => void;
  onOpenSearch: () => void;
  theme: ThemePref;
  setTheme: (theme: ThemePref) => void;
}) {
  const ThemeIcon = THEME_ICONS[theme];
  return (
    <header className="flex flex-wrap items-center gap-3 border-b-2 border-foreground px-4 py-3">
      <h1 className="text-lg font-semibold">Swiss Legal RAG</h1>
      <span
        data-testid="backend-status"
        title={online ? t("health.online") : t("health.offline")}
        className={`h-2.5 w-2.5 rounded-full ${online ? "bg-success" : "bg-danger"}`}
      />
      <div className="flex flex-1 justify-center">
        <button
          type="button"
          aria-label={t("search.openPalette")}
          onClick={onOpenSearch}
          className="flex w-full max-w-md items-center gap-2 rounded-lg border border-divider px-3 py-1.5 text-sm text-foreground-400 transition-colors hover:border-foreground-400 hover:text-foreground"
        >
          <SearchIcon />
          <span className="flex-1 text-left">{t("search.placeholder")}</span>
          <kbd className="hidden shrink-0 rounded border border-divider px-1.5 py-0.5 text-xs text-foreground-400 lg:inline">
            {t("search.shortcut")}
          </kbd>
        </button>
      </div>
      <Dropdown>
        <DropdownTrigger>
          <Button
            size="sm"
            variant="light"
            aria-label={`${t("theme.label")}: ${t(THEME_LABEL_KEYS[theme])}`}
            className="ml-auto min-w-0 px-2 text-foreground"
          >
            <ThemeIcon />
          </Button>
        </DropdownTrigger>
        <DropdownMenu
          aria-label={t("theme.label")}
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={new Set([theme])}
          onAction={(key) => {
            if (isThemePref(key)) setTheme(key);
          }}
        >
          {THEME_OPTIONS.map((option) => (
            <DropdownItem key={option}>{t(THEME_LABEL_KEYS[option])}</DropdownItem>
          ))}
        </DropdownMenu>
      </Dropdown>
      <Button
        size="sm"
        variant="light"
        aria-label={
          ingestPercent !== null
            ? `${t("settings.title")}, ${ingestPercent}% embedded`
            : t("settings.title")
        }
        className="min-w-0 px-2 text-foreground"
        onPress={onOpenSettings}
      >
        <GearIcon />
        {ingestPercent !== null && <span className="ml-1 text-xs">{ingestPercent}%</span>}
      </Button>
    </header>
  );
}
