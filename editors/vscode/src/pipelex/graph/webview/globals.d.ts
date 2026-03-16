interface VsCodeApi {
    postMessage(msg: any): void;
    getState(): any;
    setState(state: any): void;
}
declare function acquireVsCodeApi(): VsCodeApi;
