"use client";
import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "danger" | "ghost";
const VARIANTS: Record<Variant, string> = {
  primary: "glow-accent bg-accent font-bold text-on-accent hover:bg-accent-hi disabled:bg-accent/25 disabled:text-soft disabled:shadow-none",
  secondary: "glass border border-line bg-surface text-ink hover:bg-surface-2 disabled:text-faint",
  danger: "glass border border-danger-line bg-surface text-danger hover:bg-danger-bg disabled:text-danger/50",
  ghost: "text-accent hover:bg-accent/10 disabled:text-faint",
};

export function Button({ variant = "primary", className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      {...props}
      className={`inline-flex min-h-10 items-center justify-center rounded-full px-4 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed ${VARIANTS[variant]} ${className}`}
    />
  );
}

type Tone = "slate" | "red" | "amber" | "green" | "indigo" | "purple";
const TONES: Record<Tone, string> = {
  slate: "bg-surface-2 text-soft",
  red: "bg-danger-bg text-danger",
  amber: "bg-warn-bg text-warn",
  green: "bg-ok-bg text-ok",
  indigo: "bg-accent/15 text-accent",
  purple: "bg-violet-bg text-violet",
};

export function Badge({ tone = "slate", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${TONES[tone]}`}>{children}</span>;
}

export function Card({ title, actions, children, className = "" }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`glass rounded-3xl border border-line bg-surface p-5 ${className}`}>
      {(title || actions) && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          {title && <h2 className="text-base font-extrabold text-ink">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export const inputClass =
  "w-full rounded-2xl border border-line bg-surface px-4 py-2.5 text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent";

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-ink">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-2xl border border-danger-line bg-danger-bg px-4 py-2 text-sm text-danger">
      {message}
    </p>
  );
}
