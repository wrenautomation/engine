/** Record ids: ULIDs, time-ordered and unique per writer. A test passes a counter instead. */
import { monotonicFactory } from "ulid";

export type Ids = () => string;

export const ulids = (): Ids => monotonicFactory();

/** `a-000001`, `a-000002`, ...: readable ids for tests. */
export const countingIds = (prefix = "r"): Ids => {
  let n = 0;
  return () => `${prefix}-${String(++n).padStart(6, "0")}`;
};
