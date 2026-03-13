// @ts-ignore - TypeScript declarations may be outdated
import { createRequestHandler, logDevReady } from "@remix-run/cloudflare";
import * as build from "@remix-run/dev/server-build";
import { DurableObject } from "cloudflare:workers";
import { SignJWT, jwtVerify } from "jose";

const JWT_SECRET = "your-secret-key"; // Move this to your env variables
const ACCESS_TOKEN_COOKIE_KEY = "access-token";
const REFRESH_TOKEN_COOKIE_KEY = "refresh-token";

if (process.env.NODE_ENV === "development") {
  // @ts-ignore - TypeScript declarations may be outdated
  logDevReady(build);
}

const handleRemixRequest = createRequestHandler(build);

export class Remix extends DurableObject<Env> {
  async fetch(request: Request) {
    let userId: string;
    let sessionId: string;
    const pageSessionId = crypto.randomUUID();
    let newAccessToken: string | undefined;
    let newRefreshToken: string | undefined;

    const accessToken = this.getCookie(request, ACCESS_TOKEN_COOKIE_KEY);
    const refreshToken = this.getCookie(request, REFRESH_TOKEN_COOKIE_KEY);

    if (accessToken) {
      const payload = await this.verifyToken(accessToken);
      if (payload) {
        userId = payload.userId;
        sessionId = payload.sessionId;
      } else {
        [userId, sessionId, newAccessToken, newRefreshToken] =
          await this.createNewUserSession();
      }
    } else if (refreshToken) {
      const payload = await this.verifyToken(refreshToken);
      if (payload) {
        userId = payload.userId;
        sessionId = crypto.randomUUID();
        newAccessToken = await this.createAccessToken(userId, sessionId);
        newRefreshToken = await this.createRefreshToken(userId);
      } else {
        [userId, sessionId, newAccessToken, newRefreshToken] =
          await this.createNewUserSession();
      }
    } else {
      [userId, sessionId, newAccessToken, newRefreshToken] =
        await this.createNewUserSession();
    }

    const response = await handleRemixRequest(request, {
      env: this.env,
      userId,
      sessionId,
      pageSessionId,
    });

    if (newAccessToken) {
      response.headers.append(
        "Set-Cookie",
        `${ACCESS_TOKEN_COOKIE_KEY}=${newAccessToken}; HttpOnly; Secure; SameSite=Strict; Max-Age=900; Path=/`
      );
    }
    if (newRefreshToken) {
      response.headers.append(
        "Set-Cookie",
        `${REFRESH_TOKEN_COOKIE_KEY}=${newRefreshToken}; HttpOnly; Secure; SameSite=Strict; Max-Age=604800; Path=/`
      );
    }

    return response;
  }

  private getCookie(request: Request, name: string): string | undefined {
    const cookieHeader = request.headers.get("Cookie");
    if (cookieHeader) {
      const cookies = cookieHeader
        .split(";")
        .map((cookie) => cookie.trim().split("="));
      const cookie = cookies.find(([key]) => key === name);
      return cookie ? cookie[1] : undefined;
    }
    return undefined;
  }

  private async verifyToken(token: string) {
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

  private async createAccessToken(userId: string, sessionId: string) {
    return await new SignJWT({ userId, sessionId })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("15m")
      .sign(new TextEncoder().encode(JWT_SECRET));
  }

  private async createRefreshToken(userId: string) {
    return await new SignJWT({ userId })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("7d")
      .sign(new TextEncoder().encode(JWT_SECRET));
  }

  private async createNewUserSession(): Promise<
    [string, string, string, string]
  > {
    const userId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const accessToken = await this.createAccessToken(userId, sessionId);
    const refreshToken = await this.createRefreshToken(userId);
    return [userId, sessionId, accessToken, refreshToken];
  }
}
