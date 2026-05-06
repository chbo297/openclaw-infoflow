/**
 * Ambient types when `@baidu/infoflow-sdk-nodejs` is not installed (e.g. public npm).
 * Install the SDK from Baidu's registry to use `connectionMode: "websocket"`.
 */
declare module "@baidu/infoflow-sdk-nodejs" {
  export class WSClient {
    constructor(options: Record<string, unknown>);
    on(event: string, handler: (...args: unknown[]) => void): void;
    connect(): Promise<void>;
    disconnect(): void;
  }
}
