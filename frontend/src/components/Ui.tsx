"use client";
import { useEffect, useState } from "react";

export const API = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8000";

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${API}${path}`, init);
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()) as T;
}

export const Badge = ({ children, c = "bg-slate-100 text-slate-700 ring-slate-200" }: { children: React.ReactNode; c?: string }) => (
  <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${c}`}>{children}</span>
);

export const Card = ({ children, className = "" }: { children: React.ReactNode; className?: string }) => (
  <div className={`rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[0_1px_3px_rgba(15,23,42,0.04)] transition hover:shadow-md ${className}`}>{children}</div>
);

export const H = ({ children }: { children: React.ReactNode }) => (
  <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">{children}</h2>
);

export function useToast() {
  const [msg, setMsg] = useState("");
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(""), 3500);
    return () => clearTimeout(t);
  }, [msg]);
  const node = msg ? <div className="fixed bottom-6 right-6 z-30 max-w-sm rounded-xl bg-slate-900 px-4 py-3 text-sm text-white shadow-lg">{msg}</div> : null;
  return [node, setMsg] as const;
}

export const btn = "rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-700 disabled:opacity-50";
export const btn2 = "rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium transition hover:bg-slate-50 disabled:opacity-50";