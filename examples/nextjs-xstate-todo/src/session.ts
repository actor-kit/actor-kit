// utils/session.ts
import { headers } from "next/headers";

export async function getUserId() {
  // First, try to get the user ID from the headers
  const headersList = headers();
  const userId = headersList.get("x-user-id");

  if (!userId) {
    throw new Error("User ID not found");
  }

  return userId;
}
