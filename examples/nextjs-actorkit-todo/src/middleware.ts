import { SignJWT, jwtVerify } from "jose";
import { NextRequest, NextResponse } from "next/server";

const JWT_SECRET = "your-secret-key"; // move to your env
const ACCESS_TOKEN_COOKIE_KEY = "access-token";
const REFRESH_TOKEN_COOKIE_KEY = "refresh-token";

export async function middleware(request: NextRequest) {
  const requestHeaders = new Headers(request.headers);

  let userId: string | undefined;
  let sessionId: string | undefined;
  let newAccessToken: string | undefined;
  let newRefreshToken: string | undefined;

  const accessToken = request.cookies.get(ACCESS_TOKEN_COOKIE_KEY)?.value;
  const refreshToken = request.cookies.get(REFRESH_TOKEN_COOKIE_KEY)?.value;

  if (accessToken) {
    const payload = await verifyToken(accessToken);
    if (payload) {
      userId = payload.userId;
      sessionId = payload.sessionId;
    }
  }

  if (!userId && refreshToken) {
    const payload = await verifyToken(refreshToken);
    if (payload) {
      userId = payload.userId;
      sessionId = payload.sessionId;
      newAccessToken = await createAccessToken(userId, sessionId);
    }
  }

  if (!userId || !sessionId) {
    userId = uuidv4();
    sessionId = uuidv4();
    newAccessToken = await createAccessToken(userId, sessionId);
    newRefreshToken = await createRefreshToken(userId, sessionId);
  }

  // Set headers
  requestHeaders.set("x-session-id", sessionId);
  requestHeaders.set("x-user-id", userId);
  requestHeaders.set("x-page-session-id", uuidv4());
  requestHeaders.set("x-url", request.url);

  // Create the response
  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });

  // Set new tokens as cookies if they were created
  if (newAccessToken) {
    response.cookies.set(ACCESS_TOKEN_COOKIE_KEY, newAccessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 15 * 60, // 15 minutes
      path: "/",
    });
  }

  if (newRefreshToken) {
    response.cookies.set(REFRESH_TOKEN_COOKIE_KEY, newRefreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 7 * 24 * 60 * 60, // 7 days
      path: "/",
    });
  }

  return response;
}

function uuidv4() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0,
      v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

async function createAccessToken(userId: string, sessionId: string) {
  return await new SignJWT({ userId, sessionId })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("15m")
    .sign(new TextEncoder().encode(JWT_SECRET));
}

async function createRefreshToken(userId: string, sessionId: string) {
  return await new SignJWT({ userId, sessionId })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("7d")
    .sign(new TextEncoder().encode(JWT_SECRET));
}

async function verifyToken(token: string) {
  try {
    const verified = await jwtVerify(
      token,
      new TextEncoder().encode(JWT_SECRET)
    );
    return verified.payload as { userId: string; sessionId: string };
  } catch {
    return null;
  }
}
