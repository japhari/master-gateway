import { getConfiguration } from '../helper/initialize.helper';

export class ConfigService {
    async loadConfig(): Promise<any> {
        return getConfiguration();
    }

    async findSubQueue(queueName: string): Promise<{ config: any; queue: any | undefined }> {
        const config = await this.loadConfig();
        const queue = (config.subQueues || []).find((q: any) => q.queueName === queueName);
        return { config, queue };
    }

    async findPubQueue(queueName: string): Promise<{ config: any; queue: string | undefined }> {
        const config = await this.loadConfig();
        const queue = (config.pubQueues || []).find((q: string) => q === queueName);
        return { config, queue };
    }

    async findSynchronousPath(pathKey: string): Promise<{ config: any; destination: any | undefined }> {
        const config = await this.loadConfig();
        const destination = (config.synchronousPath || []).find((v: any) => v.sourcePath === pathKey);
        return { config, destination };
    }

  async findSynchronousPathTwo(pathKey: string): Promise<{ config: any; destination: any | undefined }> {
    const config = await this.loadConfig();
    const destination = (config.synchronousPathTwo || []).find((v: any) => v.sourcePath === pathKey);
    return { config, destination };
  }

  async findSynchronousPull(pathKey: string): Promise<{ config: any; destination: any | undefined }> {
    const config = await this.loadConfig();
    const destination = (config.synchronousPullRequest || []).find((v: any) => v.sourcePath === pathKey);
    return { config, destination };
  }

  async getGovesbSettings(): Promise<{ config: any; govesb: Record<string, any> }> {
    const config = await this.loadConfig();
    return { config, govesb: config?.govesb || {} };
  }
}

export const configService = new ConfigService();


