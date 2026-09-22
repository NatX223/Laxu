import { PrismaClient } from "@prisma/client";

export const db = new PrismaClient();

/// Slot allocation and any other read-modify-write on shared rows goes through
/// db.$transaction(...) -- see src/services/allocator.ts, which additionally
/// takes a row lock, because a transaction alone does not stop two concurrent
/// open-position requests from reading the same `free` slot.
export type Db = typeof db;
