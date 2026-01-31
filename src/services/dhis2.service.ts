import { httpService } from './http.service';

export class Dhis2Service {
  async getAnalytics(url: string, username?: string, password?: string): Promise<any> {
    return httpService.getValues(url, username, password);
  }
}

export const dhis2Service = new Dhis2Service();


