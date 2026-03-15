// Ambient declarations for CDN UMD globals loaded via <script> tags in graph.html.
// These are NOT npm imports — they exist on `window` at runtime.

declare const React: {
    createElement(type: any, props?: any, ...children: any[]): any;
    useState<T>(initial: T | (() => T)): [T, (v: T | ((prev: T) => T)) => void];
    useEffect(effect: () => void | (() => void), deps?: any[]): void;
    useCallback<T extends (...args: any[]) => any>(callback: T, deps: any[]): T;
    useRef<T>(initial: T): { current: T };
    useMemo<T>(factory: () => T, deps: any[]): T;
};

declare const ReactDOM: {
    createRoot(container: Element): {
        render(element: any): void;
        unmount(): void;
    };
};

declare const dagre: {
    graphlib: {
        Graph: new () => {
            setDefaultEdgeLabel(fn: () => Record<string, unknown>): void;
            setGraph(opts: Record<string, unknown>): void;
            setNode(id: string, opts: Record<string, unknown>): void;
            setEdge(source: string, target: string, opts?: Record<string, unknown>): void;
            node(id: string): { x: number; y: number; width: number; height: number };
        };
    };
    layout(graph: ReturnType<typeof dagre.graphlib.Graph['prototype']['setGraph']> extends void ? any : any): void;
};

// ReactFlow UMD exposes either window.ReactFlow or window.ReactFlowRenderer
declare const ReactFlowRenderer: Record<string, any> | undefined;

interface VsCodeApi {
    postMessage(msg: any): void;
    getState(): any;
    setState(state: any): void;
}
declare function acquireVsCodeApi(): VsCodeApi;
