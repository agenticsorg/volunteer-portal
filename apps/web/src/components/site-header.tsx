import Image from "next/image";
import Link from "next/link";

const NAV_LINKS = [
  { href: "/", label: "Home" },
  { href: "/projects", label: "Projects" },
  { href: "/privacy", label: "Privacy" },
];

/**
 * Matches agentics.org's nav pattern exactly: logo left, mono-font
 * bold links right with an animated underline on hover, in a fixed
 * `h-16` container.
 */
export function SiteHeader() {
  return (
    <header className="border-b border-border bg-background">
      <nav
        className="container mx-auto flex h-16 items-center justify-between px-4 sm:px-6"
        aria-label="Main navigation"
      >
        <Link href="/" className="flex items-center gap-2 transition-opacity hover:opacity-80" aria-label="Agentics Foundation Volunteer Portal Home">
          <Image
            src="/agentics-logo.svg"
            alt="Agentics Foundation"
            width={597}
            height={232}
            priority
            className="h-7 w-auto sm:h-8"
          />
          <span className="hidden font-sans text-sm font-semibold tracking-wide text-muted-foreground sm:inline">
            Volunteer Portal
          </span>
        </Link>
        <ul className="flex items-center gap-6 sm:gap-8">
          {NAV_LINKS.map((link) => (
            <li key={link.href}>
              <Link
                href={link.href}
                className="group relative py-1 font-mono text-sm font-bold text-foreground transition-colors duration-200 hover:text-primary"
              >
                {link.label}
                <span className="absolute -bottom-0.5 left-0 h-0.5 w-0 bg-primary transition-all duration-300 group-hover:w-full" />
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </header>
  );
}
