import { createHmac } from 'crypto';

export class JwtService {
  private readonly hmacSecret: string;
  constructor(secret = process.env.HMAC_SECRET || 'dev-secret') {
    this.hmacSecret = secret;
  }

  signPayload(data: any): string {
    return createHmac('sha256', this.hmacSecret)
      .update(JSON.stringify(data))
      .digest('hex');
  }

  verifyPayload(input: { signedData: any; signature: string }): boolean {
    if (!input || typeof input !== 'object') return false;
    if (!input.signature) return false;
    const expected = this.signPayload(input.signedData);
    return expected === input.signature;
  }
}

export const jwtService = new JwtService();


