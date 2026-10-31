"use client";

import { createContext, useContext } from "react";

export const AnswerThreadContext = createContext<string | undefined>(undefined);
export function useAnswerThreadId() { return useContext(AnswerThreadContext); }
