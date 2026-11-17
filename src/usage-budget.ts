export interface BudgetSnapshot {
  used: number;
  limit: number;
  remaining: number;
  exhausted: boolean;
  /** ISO timestamp of the next local midnight, when the counter resets. */
  resetAt: string;
}

/** A per-day usage cap (audio seconds, characters) that resets at local midnight. */
export class DailyBudget {
  private used = 0;
  private dayKey = "";
  private warned = false;

  constructor(
    private readonly label: string,
    private readonly limit: number,
    private readonly unit: string,
  ) {
    this.rollOver();
  }

  add(amount: number): void {
    this.rollOver();
    this.used += amount;
    if (this.used >= this.limit) {
      console.error(`[${this.label}] daily budget exhausted: ${Math.round(this.used)}/${this.limit} ${this.unit}`);
    } else if (!this.warned && this.used >= this.limit * 0.8) {
      this.warned = true;
      console.error(`[${this.label}] 80% of daily budget used: ${Math.round(this.used)}/${this.limit} ${this.unit}`);
    }
  }

  get exhausted(): boolean {
    this.rollOver();
    return this.used >= this.limit;
  }

  snapshot(): BudgetSnapshot {
    this.rollOver();
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    return {
      used: this.used,
      limit: this.limit,
      remaining: Math.max(0, this.limit - this.used),
      exhausted: this.used >= this.limit,
      resetAt: tomorrow.toISOString(),
    };
  }

  private rollOver(): void {
    const today = new Date().toDateString();
    if (today !== this.dayKey) {
      this.dayKey = today;
      this.used = 0;
      this.warned = false;
    }
  }
}
