"use client";

const STORAGE_KEY = "theme";

export function ThemeToggle() {
  const toggle = () => {
    const root = document.documentElement;
    const next = root.classList.contains("light") ? "dark" : "light";
    root.classList.remove("light", "dark");
    root.classList.add(next);
    localStorage.setItem(STORAGE_KEY, next);
  };
  return (
    <button type="button" className="theme-toggle" onClick={toggle} aria-label="Toggle color theme">
      ◐
    </button>
  );
}
