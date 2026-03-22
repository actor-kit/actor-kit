import { describe, it, expect } from "vitest";
import { createAccessToken, getCallerFromToken } from "../../packages/actor-kit/src/auth/auth";

const SECRET = "test-secret-at-least-32-chars-long!!";

describe("auth", () => {
  describe("createAccessToken", () => {
    it("creates a valid JWT string", async () => {
      const token = await createAccessToken({
        actorType: "todo-list",
        actorId: "todo-123",
        callerId: "user-456",
        callerType: "user",
        secret: SECRET,
      });

      expect(typeof token).toBe("string");
      expect(token.split(".")).toHaveLength(3); // header.payload.signature
    });

    it("creates tokens for service callerType", async () => {
      const token = await createAccessToken({
        actorType: "zone",
        actorId: "zone-north",
        callerId: "matchmaker",
        callerType: "service",
        secret: SECRET,
      });

      expect(typeof token).toBe("string");
    });

    it("supports custom expiry", async () => {
      const token = await createAccessToken({
        actorType: "todo-list",
        actorId: "todo-123",
        callerId: "user-456",
        callerType: "user",
        secret: SECRET,
        expiresIn: "1h",
      });

      expect(typeof token).toBe("string");
    });
  });

  describe("getCallerFromToken", () => {
    it("extracts caller and callerType from valid token", async () => {
      const token = await createAccessToken({
        actorType: "todo-list",
        actorId: "todo-123",
        callerId: "user-456",
        callerType: "user",
        secret: SECRET,
      });

      const result = await getCallerFromToken(token, "todo-list", "todo-123", SECRET);
      expect(result.caller).toBe("user-456");
      expect(result.callerType).toBe("user");
    });

    it("extracts service callerType", async () => {
      const token = await createAccessToken({
        actorType: "zone",
        actorId: "zone-north",
        callerId: "matchmaker",
        callerType: "service",
        secret: SECRET,
      });

      const result = await getCallerFromToken(token, "zone", "zone-north", SECRET);
      expect(result.caller).toBe("matchmaker");
      expect(result.callerType).toBe("service");
    });

    it("rejects token with wrong actorType", async () => {
      const token = await createAccessToken({
        actorType: "todo-list",
        actorId: "todo-123",
        callerId: "user-456",
        callerType: "user",
        secret: SECRET,
      });

      await expect(
        getCallerFromToken(token, "zone", "todo-123", SECRET),
      ).rejects.toThrow();
    });

    it("rejects token with wrong actorId", async () => {
      const token = await createAccessToken({
        actorType: "todo-list",
        actorId: "todo-123",
        callerId: "user-456",
        callerType: "user",
        secret: SECRET,
      });

      await expect(
        getCallerFromToken(token, "todo-list", "wrong-id", SECRET),
      ).rejects.toThrow();
    });

    it("rejects token with wrong secret", async () => {
      const token = await createAccessToken({
        actorType: "todo-list",
        actorId: "todo-123",
        callerId: "user-456",
        callerType: "user",
        secret: SECRET,
      });

      await expect(
        getCallerFromToken(token, "todo-list", "todo-123", "wrong-secret-that-is-long-enough!!"),
      ).rejects.toThrow();
    });

    it("rejects expired token", async () => {
      const token = await createAccessToken({
        actorType: "todo-list",
        actorId: "todo-123",
        callerId: "user-456",
        callerType: "user",
        secret: SECRET,
        expiresIn: "0s",
      });

      // Wait a tick for expiry
      await new Promise((r) => setTimeout(r, 10));

      await expect(
        getCallerFromToken(token, "todo-list", "todo-123", SECRET),
      ).rejects.toThrow();
    });
  });
});
