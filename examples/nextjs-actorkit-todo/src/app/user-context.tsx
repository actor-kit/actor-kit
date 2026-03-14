"use client";

import { createContext, type ReactNode } from "react";

export const UserContext = createContext<string>("");

export const UserProvider = ({
  children,
  userId,
}: {
  children: ReactNode;
  userId: string;
}) => {
  return <UserContext.Provider value={userId}>{children}</UserContext.Provider>;
};
