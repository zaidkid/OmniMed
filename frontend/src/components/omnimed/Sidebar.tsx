"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Activity, BrainCircuit, Home, Search, Settings, UserRound } from "lucide-react";
import { API } from "../Ui"; // adjust path to match your project

const links = [
  { label: "Clinical Workspace", href: "/", icon: Home },
  { label: "Evidence Search", href: "/evidence", icon: Search },
  { label: "Patient Library", href: "/documents", icon: UserRound },
  { label: "Settings", href: "/settings", icon: Settings },
];

const DOT = { true: undefined, false: { background: "#ef4444" }, null: { background: "#9ca3af" } };

export default function Sidebar() {
  const pathname = usePathname();
  const [up, setUp] = useState<boolean | null>(null);

  useEffect(() => {
    const check = () =>
      document.visibilityState === "visible" &&
      fetch(`${API}/health`, { cache: "no-store", signal: AbortSignal.timeout(5000) })
        .then((r) => setUp(r.ok))
        .catch(() => setUp(false));
    check();
    const id = setInterval(check, 15000);
    document.addEventListener("visibilitychange", check);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", check);
    };
  }, []);

  return (
    <aside className="omni-sidebar">
      <Link href="/" className="omni-brand">
        <div className="omni-brand-icon"><BrainCircuit size={25} /></div>
        <div>
          <div className="omni-brand-name">OmniMed</div>
          <div className="omni-brand-subtitle">Clinical AI Copilot</div>
        </div>
      </Link>

      <nav className="omni-nav">
        {links.map(({ label, href, icon: Icon }) => {
          const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <Link key={href} href={href} className={`omni-nav-link ${active ? "active" : ""}`}>
              <Icon size={17} strokeWidth={1.9} />
              <span>{label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="omni-sidebar-bottom">
        <div className="omni-sidebar-divider" />
        <div className="omni-sidebar-status">
          <Activity size={16} />
          <span>System Status</span>
          <span className="omni-live-dot" style={DOT[String(up) as keyof typeof DOT]} />
        </div>
        <div className="omni-version">OMNIMED · DEVELOPMENT</div>
      </div>
    </aside>
  );
}