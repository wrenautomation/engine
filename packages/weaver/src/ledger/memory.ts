/** A ledger in memory: tests and dry runs. */
import { type Filter, type Ledger, matches, type YieldFilter, yieldRows } from "./ledger.js";
import { byTime, type LedgerRecord } from "./records.js";

export class MemoryLedger implements Ledger {
  readonly records: LedgerRecord[] = [];
  async append(record: LedgerRecord): Promise<void> {
    this.records.push(record);
  }
  async trace(run: string): Promise<LedgerRecord[]> {
    return this.scan({ run });
  }
  async scan(filter: Filter = {}): Promise<LedgerRecord[]> {
    return this.records.filter((r) => matches(r, filter)).sort(byTime);
  }
  async yield(filter: YieldFilter = {}) {
    return yieldRows(this.records, filter);
  }
}
