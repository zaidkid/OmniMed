"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  Activity,
  Bell,
  BookOpen,
  Check,
  ChevronDown,
  ClipboardList,
  Eye,
  FileText,
  LogOut,
  RefreshCw,
  Settings,
  Search,
  ShieldCheck,
  Stethoscope,
  UserRound,
  X,
} from "lucide-react";
import { API } from "./Ui";

const nav = [
  ["Clinical Brief", "/?tab=Clinical%20Brief", Activity],
  ["Care Plan", "/?tab=Care%20Plan", ClipboardList],
  ["Watch", "/?tab=Watch", Eye],
  ["Reassessment", "/reassessment", RefreshCw],
  ["Documents", "/documents", FileText],
  ["Evidence", "/evidence", BookOpen],
  ["Settings", "/settings", Settings],
] as const;

const PROFILE_CSS = `
.omni-profile{position:relative;display:flex;align-items:center}
.omni-profile-trigger{width:40px;height:40px;border:1px solid transparent;border-radius:50%;background:#2376f5;color:#fff;display:flex;align-items:center;justify-content:center;gap:3px;cursor:pointer;font:inherit;transition:background .15s,box-shadow .15s}
.omni-profile-trigger:hover,.omni-profile-trigger[aria-expanded="true"]{background:#1459ce;box-shadow:0 0 0 4px #e8f1ff}
.omni-profile-initials{font-size:12px;font-weight:800;letter-spacing:-.03em}
.omni-profile-menu{position:absolute;z-index:100;right:0;top:calc(100% + 12px);width:260px;padding:8px;background:#fff;border:1px solid #e1e9f3;border-radius:15px;box-shadow:0 14px 40px rgba(23,37,84,.14);color:#172554;animation:omni-profile-in .14s ease-out}
.omni-profile-user{display:flex;align-items:center;gap:11px;padding:12px 10px 14px}
.omni-profile-large-avatar{width:43px;height:43px;flex-shrink:0;border-radius:50%;display:grid;place-items:center;background:#e8f1ff;color:#2376f5;font-size:13px;font-weight:800}
.omni-profile-name{font-size:13px;font-weight:750;color:#172554;line-height:1.5}
.omni-profile-role{font-size:11px;color:#718096;margin-top:2px}
.omni-profile-divider{height:1px;background:#edf1f7;margin:4px 2px}
.omni-profile-link{width:100%;min-height:39px;padding:0 10px;border:0;border-radius:9px;background:transparent;display:flex;align-items:center;gap:10px;text-decoration:none;color:#40516c;font:inherit;font-size:12px;font-weight:600;text-align:left;cursor:pointer;transition:background .15s,color .15s}
.omni-profile-link:hover{background:#f3f7ff;color:#2376f5}
.omni-profile-link svg{flex-shrink:0}
.omni-profile-link.danger{color:#dc2626}
.omni-profile-link.danger:hover{background:#fff1f2}
.omni-profile-link:disabled{opacity:.45;cursor:not-allowed}
.omni-profile-link:disabled:hover{background:transparent;color:#dc2626}
.omni-profile-hint{padding:7px 10px 4px;color:#94a3b8;font-size:10px;line-height:1.5}
@keyframes omni-profile-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}
@media(max-width:560px){.omni-profile-menu{right:-5px;width:min(260px,calc(100vw - 28px))}}
@media(prefers-reduced-motion:reduce){.omni-profile-menu{animation:none}}
`;

export default function Shell({
  children,
}: {
  children: React.ReactNode;
}) {
  const path = usePathname();
  const router = useRouter();

  const [online, setOnline] = useState<boolean | null>(null);
  const [q, setQ] = useState("");
  const [profileOpen, setProfileOpen] = useState(false);

  const profileRef = useRef<HTMLDivElement>(null);
  const profileButtonRef = useRef<HTMLButtonElement>(null);

  // Check backend availability.
  useEffect(() => {
    let mounted = true;

    fetch(`${API}/health`)
      .then((r) => {
        if (mounted) setOnline(r.ok);
      })
      .catch(() => {
        if (mounted) setOnline(false);
      });

    return () => {
      mounted = false;
    };
  }, []);

  // Close the profile menu when clicking outside or pressing Escape.
  useEffect(() => {
    if (!profileOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (
        profileRef.current &&
        !profileRef.current.contains(event.target as Node)
      ) {
        setProfileOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setProfileOpen(false);
        profileButtonRef.current?.focus();
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [profileOpen]);

  const active = (label: string, href: string) => {
    const base = href.split("?")[0];

    return base === "/"
      ? path === "/" &&
          (new URLSearchParams(
            typeof window !== "undefined" ? window.location.search : ""
          ).get("tab") || "Clinical Brief") === label
      : path.startsWith(base);
  };

  const handleSearch = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    if (q.trim()) {
      router.push(`/evidence?q=${encodeURIComponent(q.trim())}`);
    }
  };

  const closeProfile = () => setProfileOpen(false);

  return (
    <div className="omni-app">
      <style>{PROFILE_CSS}</style>

      <aside className="omni-sidebar">
        <Link href="/" className="omni-brand">
          <div className="omni-brand-icon">
            <Stethoscope size={20} />
          </div>

          <div>
            <div className="omni-brand-name">OMNIMED</div>
            <div className="omni-brand-subtitle">
              Clinical Intelligence
            </div>
          </div>
        </Link>

        <nav className="omni-nav" aria-label="Main navigation">
          {nav.map(([label, href, Icon]) => (
            <Link
              key={label}
              href={href}
              title={label}
              className={`omni-nav-link ${
                active(label, href) ? "active" : ""
              }`}
            >
              <Icon size={16} />
              <span>{label}</span>
            </Link>
          ))}
        </nav>

        <div className="omni-sidebar-bottom">
          <div className="omni-sidebar-divider" />

          <div className="omni-sidebar-status">
            <span>System status</span>
            <span
              className="omni-live-dot"
              style={{
                background:
                  online === null
                    ? "#eab308"
                    : online
                      ? "#10b981"
                      : "#ef4444",
              }}
            />
          </div>

          <div className="omni-version">
            OMNIMED · CLINICAL PLATFORM
          </div>
        </div>
      </aside>

      <div className="omni-app-main">
        <header className="omni-topbar">
          <form className="omni-top-search" onSubmit={handleSearch}>
            <Search size={15} />

            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search clinical evidence..."
              aria-label="Search clinical evidence"
            />

            <span className="omni-shortcut">Enter</span>
          </form>

          <div className="omni-top-right">
            <span className="omni-top-patient">
              <Activity size={14} />
              OMNI-DEMO-001
            </span>

            <span
              className="omni-top-online"
              style={
                online === false
                  ? {
                      borderColor: "#fecaca",
                      background: "#fff1f2",
                      color: "#b91c1c",
                    }
                  : online === null
                    ? {
                        borderColor: "#fde68a",
                        background: "#fffbeb",
                        color: "#92400e",
                      }
                    : undefined
              }
            >
              <span
                className="omni-status-dot"
                style={{
                  background:
                    online === null
                      ? "#eab308"
                      : online
                        ? "#10b981"
                        : "#ef4444",
                }}
              />

              {online === null
                ? "Checking"
                : online
                  ? "Backend online"
                  : "Backend offline"}
            </span>

            <Link
              href="/settings"
              className="omni-icon-button"
              aria-label="Notifications and settings"
              title="Notifications and settings"
            >
              <Bell size={17} />
            </Link>

            {/* Logged-in user profile menu */}
            <div className="omni-profile" ref={profileRef}>
              <button
                ref={profileButtonRef}
                type="button"
                className="omni-profile-trigger"
                title="Open user profile"
                aria-label="Open user profile menu"
                aria-haspopup="menu"
                aria-expanded={profileOpen}
                onClick={() => setProfileOpen((open) => !open)}
              >
                <span className="omni-profile-initials">ZK</span>
                <ChevronDown size={12} />
              </button>

              {profileOpen && (
                <div
                  className="omni-profile-menu"
                  role="menu"
                  aria-label="User profile"
                >
                  <div className="omni-profile-user">
                    <div className="omni-profile-large-avatar">
                      ZK
                    </div>

                    <div>
                      <div className="omni-profile-name">
                        Zaid Kidwai
                      </div>
                      <div className="omni-profile-role">
                        Clinical Administrator
                      </div>
                    </div>
                  </div>

                  <div className="omni-profile-divider" />

                  <Link
                    href="/settings?section=profile"
                    className="omni-profile-link"
                    role="menuitem"
                    onClick={closeProfile}
                  >
                    <UserRound size={16} />
                    <span>My Profile</span>
                  </Link>

                  <Link
                    href="/settings"
                    className="omni-profile-link"
                    role="menuitem"
                    onClick={closeProfile}
                  >
                    <Settings size={16} />
                    <span>Account Settings</span>
                  </Link>

                  <Link
                    href="/settings?section=security"
                    className="omni-profile-link"
                    role="menuitem"
                    onClick={closeProfile}
                  >
                    <ShieldCheck size={16} />
                    <span>Security</span>
                  </Link>

                  <div className="omni-profile-divider" />

                  <button
                    type="button"
                    className="omni-profile-link danger"
                    role="menuitem"
                    disabled
                    title="Connect your authentication sign-out handler first"
                  >
                    <LogOut size={16} />
                    <span>Sign out</span>
                  </button>

                  <div className="omni-profile-hint">
                    Sign out will be available when authentication is
                    connected.
                  </div>
                </div>
              )}
            </div>
          </div>
        </header>

        <main className="omni-content">{children}</main>
      </div>
    </div>
  );
}
