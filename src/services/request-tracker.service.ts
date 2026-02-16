type RequestStatus = 'QUEUED' | 'FORWARDED' | 'FAILED';

type RequestRecord = {
  requestId: string;
  status: RequestStatus;
  queueName?: string;
  targetUrl?: string;
  method?: string;
  createdAt: string;
  updatedAt: string;
  error?: {
    code?: string;
    message?: string;
    status?: number;
  };
};

class RequestTrackerService {
  private readonly records = new Map<string, RequestRecord>();
  private readonly maxRecords = 5000;

  markQueued(input: {
    requestId: string;
    queueName?: string;
    targetUrl?: string;
    method?: string;
  }): void {
    const now = new Date().toISOString();
    this.records.set(input.requestId, {
      requestId: input.requestId,
      status: 'QUEUED',
      queueName: input.queueName,
      targetUrl: input.targetUrl,
      method: input.method,
      createdAt: now,
      updatedAt: now,
    });
    this.compact();
  }

  markForwarded(requestId: string, details?: { targetUrl?: string; method?: string }): void {
    const existing = this.records.get(requestId);
    const now = new Date().toISOString();
    this.records.set(requestId, {
      requestId,
      status: 'FORWARDED',
      queueName: existing?.queueName,
      targetUrl: details?.targetUrl ?? existing?.targetUrl,
      method: details?.method ?? existing?.method,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    this.compact();
  }

  markFailed(
    requestId: string,
    error: { code?: string; message?: string; status?: number },
    details?: { targetUrl?: string; method?: string },
  ): void {
    const existing = this.records.get(requestId);
    const now = new Date().toISOString();
    this.records.set(requestId, {
      requestId,
      status: 'FAILED',
      queueName: existing?.queueName,
      targetUrl: details?.targetUrl ?? existing?.targetUrl,
      method: details?.method ?? existing?.method,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      error,
    });
    this.compact();
  }

  get(requestId: string): RequestRecord | undefined {
    return this.records.get(requestId);
  }

  private compact(): void {
    if (this.records.size <= this.maxRecords) return;
    const overflow = this.records.size - this.maxRecords;
    const keys = this.records.keys();
    for (let i = 0; i < overflow; i++) {
      const key = keys.next().value;
      if (!key) break;
      this.records.delete(key);
    }
  }
}

export const requestTrackerService = new RequestTrackerService();
