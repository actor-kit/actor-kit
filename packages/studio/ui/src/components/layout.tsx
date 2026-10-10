import { Link, Outlet } from "@tanstack/react-router";

export function Layout() {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800 px-4 sm:px-6 py-3 flex items-center gap-4">
        <Link to="/" className="font-bold text-lg text-white hover:text-zinc-300">
          Actor Kit Studio
        </Link>
      </header>
      <main className="px-4 py-6 sm:p-6">
        <Outlet />
      </main>
    </div>
  );
}
