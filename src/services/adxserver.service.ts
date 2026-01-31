import { httpService } from './http.service';

export class AdxServerService {
  async postData(url: string, payload: any, username?: string, password?: string): Promise<any> {
    return httpService.post(url, payload, username || null, password || null);
  }
}

export const adxServerService = new AdxServerService();


