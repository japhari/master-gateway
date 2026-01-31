import * as fs from 'fs';
import * as path from 'path';
import { createPrivateKey, createPublicKey, KeyObject } from 'crypto';
import { sendViaGovesb } from '../govesb/govesb-client';
import { configService } from './config.service';

interface GovEsbConnectorConfig {
    clientPrivateKey: string;
    govesbPublicKey: string;
    clientId: string;
    clientSecret: string;
    accessTokenUri: string;
    pushRequestUrl?: string;
    responseRequestUrl?: string;
    asyncRequestUrl?: string;
}

export class GovesbService {
    private readonly projectRoot = path.resolve(__dirname, '..', '..');
    private connectorConfig?: GovEsbConnectorConfig;
    private connectorConfigPromise?: Promise<GovEsbConnectorConfig>;

    async send(serviceCode: string, payload: any, config?: Record<string, any>): Promise<any> {
        if (!serviceCode) {
            throw new Error('Missing GOVESB service code');
        }
        const connectorConfig = await this.ensureConnectorConfig();
        return sendViaGovesb({
            serviceCode,
            payload,
            config: { ...connectorConfig, ...(config || {}) },
        });
    }

    async sendWithPushCode(pathKey: string, payload: any): Promise<any> {
        const { destination } = await configService.findSynchronousPathTwo(pathKey);
        if (!destination) {
            throw new Error(`No synchronousPathTwo entry found for ${pathKey}`);
        }
        this.assertDestinationReady(destination, pathKey);

        const serviceCode = destination.apiCode;
        if (!serviceCode) {
            throw new Error(`Entry ${pathKey} missing apiCode`);
        }
        if (!destination.apiPushCode) {
            throw new Error(`Entry ${pathKey} missing apiPushCode`);
        }

        const body = {
            ...this.normalizePayload(payload),
            pushCode: destination.apiPushCode,
            apiCode: destination.apiCode,
        };
        return this.send(serviceCode, body);
    }

    async sendWithConnectionCode(pathKey: string, payload: any): Promise<any> {
        const { destination } = await configService.findSynchronousPull(pathKey);
        if (!destination) {
            throw new Error(`No synchronousPullRequest entry found for ${pathKey}`);
        }
        this.assertDestinationReady(destination, pathKey);

        const serviceCode = destination.apiCode;
        if (!serviceCode) {
            throw new Error(`Entry ${pathKey} missing apiCode`);
        }
        if (!destination.connectionCode) {
            throw new Error(`Entry ${pathKey} missing connectionCode`);
        }

        const body = {
            ...this.normalizePayload(payload),
            apiCode: destination.apiCode,
            connectionCode: destination.connectionCode,
        };
        return this.send(serviceCode, body);
    }

    invalidateConnectorCache(): void {
        this.connectorConfig = undefined;
        this.connectorConfigPromise = undefined;
    }

    private async ensureConnectorConfig(): Promise<GovEsbConnectorConfig> {
        if (this.connectorConfig) {
            return this.connectorConfig;
        }
        if (this.connectorConfigPromise) {
            return this.connectorConfigPromise;
        }

        this.connectorConfigPromise = this.buildConnectorConfig()
            .then((config) => {
                this.connectorConfig = config;
                this.connectorConfigPromise = undefined;
                return config;
            })
            .catch((err) => {
                this.connectorConfigPromise = undefined;
                throw err;
            });
        return this.connectorConfigPromise;
    }

    private async buildConnectorConfig(): Promise<GovEsbConnectorConfig> {
        const { govesb } = await configService.getGovesbSettings();

        const clientPrivateKey = this.pickValue('CLIENT_PRIVATE_KEY', 'clientPrivateKey', govesb);
        const govesbPublicKey = this.pickValue('GOVESB_PUBLIC_KEY', 'govesbPublicKey', govesb);
        const clientId = this.pickValue('CLIENT_ID', 'clientId', govesb);
        const clientSecret = this.pickValue('CLIENT_SECRET', 'clientSecret', govesb);
        const accessTokenUri =
            this.pickValue('ACCESS_TOKEN_URL', 'accessTokenUri', govesb) ||
            this.pickValue('ACCESS_TOKEN_URI', 'accessTokenUri', govesb);
        const pushRequestUrl = this.pickValue('PUSH_REQUEST', 'pushRequestUrl', govesb);
        const responseRequestUrl = this.pickValue('RESPONSE_REQUEST', 'responseRequestUrl', govesb);
        const asyncRequestUrl = this.pickValue('ASYNC_REQUEST', 'asyncRequestUrl', govesb);

        const requiredEntries: Array<[string, string | undefined]> = [
            ['clientPrivateKey', clientPrivateKey],
            ['govesbPublicKey', govesbPublicKey],
            ['clientId', clientId],
            ['clientSecret', clientSecret],
            ['accessTokenUri', accessTokenUri],
        ];
        const missing = requiredEntries
            .filter(([, value]) => !value)
            .map(([key]) => key);
        if (missing.length) {
            throw new Error(`Missing GOVESB configuration values: ${missing.join(', ')}`);
        }

        return {
            // Keep raw values (base64 or PEM) for govesb-connector-js,
            // but validate that they contain a supported EC key.
            clientPrivateKey: this.resolveKeyMaterial(clientPrivateKey, 'private'),
            govesbPublicKey: this.resolveKeyMaterial(govesbPublicKey, 'public'),
            clientId: clientId as string,
            clientSecret: clientSecret as string,
            accessTokenUri: accessTokenUri as string,
            pushRequestUrl: pushRequestUrl || undefined,
            responseRequestUrl: responseRequestUrl || undefined,
            asyncRequestUrl: asyncRequestUrl || undefined,
        };
    }

    private pickValue(envKey: string, configKey: string, govesb: Record<string, any>): string | undefined {
        const envValue = process.env[envKey];
        if (envValue && envValue.toString().trim().length) {
            return envValue.toString().trim();
        }
        const cfgValue = govesb?.[configKey];
        if (typeof cfgValue === 'string' && cfgValue.trim().length) {
            return cfgValue.trim();
        }
        return undefined;
    }

    private resolveKeyMaterial(value: string | undefined, kind: 'private' | 'public'): string {
        if (!value) {
            throw new Error('Missing key material');
        }
        const trimmed = value.trim();
        if (!trimmed) {
            throw new Error('Missing key material');
        }

        // If the value already looks like PEM, validate as-is.
        // Otherwise assume it's raw base64 DER (as provided by GOVESB UI)
        // and wrap it in PEM only for validation purposes.
        const pemForValidation = trimmed.includes('-----BEGIN')
            ? trimmed
            : this.toPemFormat(trimmed, kind);

        this.validateKeyMaterial(pemForValidation, kind);

        // Return the original trimmed value so downstream libraries like
        // govesb-connector-js can consume the expected base64 format.
        return trimmed;
    }

    private normalizePayload(payload: any): Record<string, any> | any[] {
        if (payload && typeof payload === 'object') {
            return payload;
        }
        if (payload === undefined || payload === null) {
            return {};
        }
        return { esbBody: payload };
    }

    private assertDestinationReady(destination: any, pathKey: string): void {
        if (destination.status && destination.status !== 'RUN') {
            throw new Error(`Entry ${pathKey} is disabled (status=${destination.status})`);
        }
        if (destination.channelHttpMethod && destination.channelHttpMethod !== 'POST') {
            throw new Error(`Entry ${pathKey} must use POST channelHttpMethod for this route`);
        }
    }

    private toPemFormat(body: string, kind: 'private' | 'public'): string {
        const normalized = body.replace(/\s+/g, '');
        if (!normalized) {
            throw new Error('Empty key body');
        }
        const chunks = normalized.match(/.{1,64}/g) || [normalized];
        const header =
            kind === 'private' ? '-----BEGIN EC PRIVATE KEY-----' : '-----BEGIN PUBLIC KEY-----';
        const footer = kind === 'private' ? '-----END EC PRIVATE KEY-----' : '-----END PUBLIC KEY-----';
        return `${header}\n${chunks.join('\n')}\n${footer}`;
    }

    private validateKeyMaterial(pem: string, kind: 'private' | 'public'): void {
        try {
            const key: KeyObject =
                kind === 'private' ? createPrivateKey(pem) : createPublicKey(pem);
            if (key.asymmetricKeyType !== 'ec') {
                throw new Error('Key is not using an EC curve');
            }
            const curve = (key.asymmetricKeyDetails as { namedCurve?: string } | undefined)?.namedCurve;
            const allowedCurves = ['prime256v1', 'secp256k1'];
            if (curve && !allowedCurves.includes(curve)) {
                throw new Error(
                    `Unsupported EC curve ${curve}. Expected one of: ${allowedCurves.join(', ')}.`,
                );
            }
        } catch (error: any) {
            throw new Error(`Invalid ${kind} key material: ${error?.message || error}`);
        }
    }
}

export const govesbService = new GovesbService();