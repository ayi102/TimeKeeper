import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Gate the whole app behind a Supabase Auth session. The tablet logs in once and
 * stays signed in (kiosk); admin screens add the PIN on top (see admin-auth).
 *
 * Unauthenticated: API calls get 401 JSON; page requests redirect to /login.
 * Before Supabase env is configured, non-production requests pass through so the
 * app is runnable locally; production fails closed.
 */
export async function middleware(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const path = request.nextUrl.pathname;
  const isPublic = path.startsWith("/login") || path.startsWith("/auth");

  if (!url || !key) {
    if (process.env.NODE_ENV !== "production") return NextResponse.next();
    return path.startsWith("/api")
      ? NextResponse.json({ ok: false, message: "server auth not configured" }, { status: 503 })
      : NextResponse.next();
  }

  let response = NextResponse.next({ request });
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options: any }[]) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  const { data: { user } } = await supabase.auth.getUser();
  if (!user && !isPublic) {
    if (path.startsWith("/api")) {
      return NextResponse.json({ ok: false, message: "auth required" }, { status: 401 });
    }
    const redirect = request.nextUrl.clone();
    redirect.pathname = "/login";
    return NextResponse.redirect(redirect);
  }
  return response;
}

export const config = {
  // Run on everything except Next internals and static asset files.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:ogg|mp3|m4a|wav|jpg|jpeg|png|svg|ico|css|js)$).*)"],
};
