export class RateLimiter {
  private buckets: Map<string, { tokens: number; lastRefill: number }>;
  private maxTokens: number;
  private refillRateMs: number;

  constructor(maxTokens: number, windowMs: number) {
    this.buckets = new Map();
    this.maxTokens = maxTokens;
    this.refillRateMs = windowMs / maxTokens;
  }

  check(playerId: string): boolean {
    const now = Date.now();
    const bucket = this.buckets.get(playerId);

    if (!bucket) {
      this.buckets.set(playerId, { tokens: this.maxTokens - 1, lastRefill: now });
      return true;
    }

    const elapsed = now - bucket.lastRefill;
    const tokensToAdd = elapsed / this.refillRateMs;

    if (tokensToAdd > 0) {
      bucket.tokens = Math.min(bucket.tokens + tokensToAdd, this.maxTokens);
      bucket.lastRefill = now;
    }

    if (bucket.tokens <= 0) {
      return false;
    }

    bucket.tokens -= 1;
    return true;
  }

  reset(playerId: string): void {
    this.buckets.delete(playerId);
  }
}
