// ViewSpec types (from pipelex-agent --view output)
export interface ViewSpecNode {
    id: string;
    label?: string;
    kind?: string;
    status?: string;
    position?: { x: number; y: number };
    ui?: { badges?: string[] };
    inspector?: { pipe_type?: string; pipe_code?: string };
}

export interface ViewSpecEdge {
    id: string;
    source: string;
    target: string;
    kind?: string;
    label?: string;
    animated?: boolean;
}

export interface ViewSpec {
    nodes: ViewSpecNode[];
    edges: ViewSpecEdge[];
}

// GraphSpec types (from pipelex-agent --view output)
export interface GraphSpecNodeIoItem {
    name?: string;
    digest?: string;
    concept?: string;
    content_type?: string;
}

export interface GraphSpecNodeIo {
    inputs?: GraphSpecNodeIoItem[];
    outputs?: GraphSpecNodeIoItem[];
}

export interface GraphSpecNode {
    id: string;
    pipe_code?: string;
    pipe_type?: string;
    status?: string;
    io?: GraphSpecNodeIo;
}

export interface GraphSpecEdge {
    id?: string;
    source: string;
    target: string;
    kind: string;
    label?: string;
    source_stuff_digest?: string;
    target_stuff_digest?: string;
}

export interface GraphSpec {
    nodes: GraphSpecNode[];
    edges: GraphSpecEdge[];
}

// Dataflow analysis result
export interface DataflowAnalysis {
    stuffRegistry: Record<string, { name?: string; concept?: string; contentType?: string }>;
    stuffProducers: Record<string, string>;
    stuffConsumers: Record<string, string[]>;
    controllerNodeIds: Set<string>;
    childNodeIds: Set<string>;
    containmentTree: Record<string, string[]>;
}

// Graph configuration passed from the extension
export interface GraphConfig {
    direction?: string;
    showControllers?: boolean;
    nodesep?: number;
    ranksep?: number;
    edgeType?: string;
    initialZoom?: number | null;
    panToTop?: boolean;
    paletteColors?: Record<string, string>;
}

// Label descriptors — plain objects, no React dependency.
// GraphViewer maps these to React elements at render time.
export type LabelDescriptor =
    | { kind: 'pipe'; label: string; isFailed: boolean }
    | { kind: 'stuff'; label: string; concept: string }
    | {
          kind: 'orchestration';
          label: string;
          status: string;
          typeText: string;
          badge: string;
      };

// ReactFlow node used in our graph
export interface GraphNode {
    id: string;
    type: string;
    data: {
        labelDescriptor?: LabelDescriptor;
        label?: any;
        nodeData?: any;
        isPipe: boolean;
        isStuff: boolean;
        isController?: boolean;
        labelText: string;
        pipeCode?: string;
        pipeType?: string;
    };
    position: { x: number; y: number };
    style?: Record<string, any>;
    parentNode?: string;
    extent?: string;
    selected?: boolean;
}

// ReactFlow edge used in our graph
export interface GraphEdge {
    id: string;
    source: string;
    target: string;
    type: string;
    animated?: boolean;
    label?: string;
    labelStyle?: Record<string, any>;
    labelBgStyle?: Record<string, any>;
    labelBgPadding?: number[];
    labelBgBorderRadius?: number;
    style?: Record<string, any>;
    markerEnd?: { type: string; color: string };
    _batchEdge?: boolean;
    _crossGroup?: boolean;
}

export interface GraphData {
    nodes: GraphNode[];
    edges: GraphEdge[];
}

// Layout config subset used by getLayoutedElements
export interface LayoutConfig {
    nodesep?: number;
    ranksep?: number;
}

// Controller padding constants (shared between layout and controller modules)
export const CONTROLLER_PADDING_X = 40;
export const CONTROLLER_PADDING_TOP = 48;
export const CONTROLLER_PADDING_BOTTOM = 20;

// Default marker type string (avoids ReactFlow dependency in pure modules)
export const ARROW_CLOSED_MARKER = 'arrowclosed';
